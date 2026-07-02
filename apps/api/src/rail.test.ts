import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  circleClient,
  createCreatureWallet,
  seedFromTreasury,
  signAuthorization,
  verify,
  settle,
  gatewayAvailable,
} from './rail.js';

// Load apps/api/.env.local for this integration test (gitignored; prod uses Railway env).
const envPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.env.local');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
  }
}
const hasArcEnv = !!(
  process.env.CIRCLE_API_KEY &&
  process.env.ARC_RPC &&
  process.env.TREASURY_PRIVATE_KEY &&
  process.env.PLATFORM_ADDRESS
);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Real Arc/Circle integration — runs only where the env is present (skipped in CI without creds).
describe.skipIf(!hasArcEnv)('1.3 rail — real Arc/Circle integration', () => {
  const circle = hasArcEnv ? circleClient() : null;
  const payTo = process.env.PLATFORM_ADDRESS ?? '0x0';
  let creature: { walletId: string; address: `0x${string}` };

  beforeAll(async () => {
    const ws = await circle!.createWalletSet({ name: 'lateo-rail-test' });
    creature = await createCreatureWallet(circle!, ws.data!.walletSet!.id);
    await seedFromTreasury('0.05', creature.address); // TREASURY funds the creature (ADR-0016)
    for (let i = 0; i < 20 && (await gatewayAvailable(creature.address)) === 0n; i++) await sleep(3000);
    expect(await gatewayAvailable(creature.address)).toBeGreaterThan(0n);
  }, 90_000);

  it('a Circle wallet (no local key) signs EIP-3009 accepted by verify (payer = creature)', async () => {
    const auth = await signAuthorization(circle!, {
      walletId: creature.walletId,
      address: creature.address,
      payTo,
      amount: 100n,
    });
    const v = await verify(auth);
    expect(v.isValid).toBe(true);
    expect(v.payer?.toLowerCase()).toBe(creature.address.toLowerCase());
  });

  it('VOID: verify without settle moves NO value (creature available unchanged)', async () => {
    const before = await gatewayAvailable(creature.address);
    const auth = await signAuthorization(circle!, {
      walletId: creature.walletId,
      address: creature.address,
      payTo,
      amount: 100n,
    });
    await verify(auth); // authorize, then DO NOT settle = void
    expect(await gatewayAvailable(creature.address)).toBe(before);
  });

  it('SETTLE captures (creature available drops) and DOUBLE settle → nonce_already_used (INV-4)', async () => {
    const before = await gatewayAvailable(creature.address);
    const auth = await signAuthorization(circle!, {
      walletId: creature.walletId,
      address: creature.address,
      payTo,
      amount: 100n,
    });
    const s = await settle(auth);
    expect(s.success).toBe(true);
    expect(typeof s.transaction).toBe('string'); // settleId (batched; not a 0x hash — SPIKE-1b)
    expect(await gatewayAvailable(creature.address)).toBe(before - 100n); // value moved

    const again = await settle(auth); // capture-once
    expect(again.success).toBe(false);
    expect(again.errorReason).toBe('nonce_already_used');

    console.log(`[rail] settleId=${s.transaction} creature=${creature.address}`);
  }, 30_000);
});

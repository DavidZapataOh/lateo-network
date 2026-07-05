import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { makePool } from './db.js';
import { migrate, resetDb, createCreature, postCredit } from './ledger.js';
import { balancesOn } from './balances.js';
import { createPassiveBurnRail } from './passiveBurn.js';
import type { SignedAuthorization, SettleResult } from './rail.js';

// Injected doubles (unit): prove the void-on-failure semantics without touching Circle. The REAL
// materialization is covered by metabolism.rail.test.ts.
const signOk = async (): Promise<SignedAuthorization> => ({ payload: {}, requirements: {} }) as SignedAuthorization;
const settleFail = async (): Promise<SettleResult> => ({
  success: false,
  errorReason: 'Connect Timeout Error gateway-api-testnet.circle.com',
  transaction: '',
  network: 'arc',
});
const settleOk = async (): Promise<SettleResult> => ({ success: true, transaction: '0xsettled', network: 'arc' });

let pool: pg.Pool;
beforeAll(async () => {
  pool = makePool();
  await migrate(pool);
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await resetDb(pool);
});

function rail(id: string, over: Partial<Parameters<typeof createPassiveBurnRail>[0]>): ReturnType<typeof createPassiveBurnRail> {
  return createPassiveBurnRail({
    circle: {} as never,
    pool,
    creatureId: id,
    walletId: 'w',
    address: '0x0000000000000000000000000000000000000001',
    horno: '0x00000000000000000000000000000000000000FF',
    signAuthorization: signOk,
    ...over,
  });
}

describe('passive burn — atomic materialize (INV-4: settled xor voided, never dangling pending)', () => {
  it('a settle failure VOIDS the pending burn (no phantom pending) and rethrows', async () => {
    const id = await createCreature(pool, { walletAddress: '0xA', serviceType: 'url-to-json' });
    await postCredit(pool, { creatureId: id, kind: 'feed', amount: 100_000n });
    await expect(rail(id, { settle: settleFail }).materialize(30_000n)).rejects.toThrow(/settle failed/);
    // the crux: NO phantom pending is left to falsely depress live/runway
    const b = await balancesOn(pool, id);
    expect(b.pending).toBe(0n);
    expect(b.settled).toBe(100_000n); // the burn never happened — balance intact, burn retries later
    const rows = await pool.query<{ status: string }>(`select status from ledger_entries where kind='burn_passive'`);
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0]!.status).toBe('void'); // voided, not stuck pending
  });

  it('repeated failures never accumulate phantom pending (the days-long blip case)', async () => {
    const id = await createCreature(pool, { walletAddress: '0xB', serviceType: 'url-to-json' });
    await postCredit(pool, { creatureId: id, kind: 'feed', amount: 100_000n });
    const r = rail(id, { settle: settleFail });
    for (let i = 0; i < 5; i++) await r.materialize(10_000n).catch(() => undefined);
    expect((await balancesOn(pool, id)).pending).toBe(0n); // 5 blips -> 0 phantom pending
  });

  it('success still settles cleanly (pending -> settled), no false void', async () => {
    const id = await createCreature(pool, { walletAddress: '0xC', serviceType: 'url-to-json' });
    await postCredit(pool, { creatureId: id, kind: 'feed', amount: 100_000n });
    const out = await rail(id, { settle: settleOk }).materialize(40_000n);
    expect(out.settleId).toBe('0xsettled');
    const b = await balancesOn(pool, id);
    expect(b.settled).toBe(60_000n); // 100k − 40k burned
    expect(b.pending).toBe(0n);
  });
});

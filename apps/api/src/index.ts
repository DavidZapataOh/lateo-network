import { makePool } from './db.js';
import { migrate } from './ledger.js';
import { createServer, type ServerOptions } from './server.js';
import { fundedByTreasury, onchainFunding } from './provenance.js';
import { circleClient, createCreatureWallet, seedFromTreasury, gatewayAvailable } from './rail.js';
import { reconcileWorld } from './reconcile.js';

const pool = makePool();
const port = Number(process.env.PORT ?? 3000);
// The anti-wash provenance set (2.5): derived FROM THE CHAIN at boot and refreshed periodically.
// Shared by reference — the server reads whatever the latest derivation put in it.
const funded = new Set<string>();

// The spawn/feed rail (real Circle + treasury) — enabled only when the env is present, so the
// server still boots read-only in dev environments without credentials.
function actionsFromEnv(): ServerOptions['actions'] {
  if (!process.env.CIRCLE_API_KEY || !process.env.TREASURY_PRIVATE_KEY) return undefined;
  const circle = circleClient();
  let walletSetId = process.env.CIRCLE_WALLET_SET_ID;
  return {
    rail: {
      async provisionWallet(): Promise<{ walletId: string; address: `0x${string}` }> {
        if (!walletSetId) {
          const ws = await circle.createWalletSet({ name: 'lateo-world' });
          walletSetId = ws.data!.walletSet!.id;
          console.log(`[lateo] created wallet set ${walletSetId} (set CIRCLE_WALLET_SET_ID to reuse)`);
        }
        return createCreatureWallet(circle, walletSetId);
      },
      seed: async (address, amountUsdc): Promise<void> => {
        await seedFromTreasury(amountUsdc, address);
      },
      gatewayAvailable,
    },
    seedUsdc: '0.05',
    seedAtomic: 50_000n,
    feedUsdc: '0.02',
    feedAtomic: 20_000n,
    graceSeconds: Number(process.env.GRACE_SECONDS ?? 30),
  };
}

const server = createServer(pool, {
  // The World stream projects runway with this burn rate (atomic/s). 0 -> no burn (runway Infinity).
  world: { burnRatePerSec: BigInt(process.env.WORLD_BURN_RATE_ATOMIC_PER_SEC ?? '0') },
  fundedByTreasury: funded,
  actions: actionsFromEnv(),
});

async function refreshProvenance(): Promise<void> {
  const T = process.env.TREASURY_ADDRESS;
  const rpc = process.env.ARC_RPC;
  if (!T || !rpc) return; // stats then report organic over an empty exclusion set — dev mode only
  try {
    const events = await onchainFunding([T], { rpcUrl: rpc, fromBlock: BigInt(process.env.PROVENANCE_FROM_BLOCK ?? '0') });
    const next = fundedByTreasury([T], events);
    funded.clear();
    for (const w of next) funded.add(w);
    funded.add(T.toLowerCase()); // the treasury itself is never organic
    console.log(`[lateo] provenance refreshed: ${funded.size} treasury-funded wallets excluded`);
  } catch (e) {
    console.error('[lateo] provenance refresh failed (stats keep last set):', String(e).slice(0, 200));
  }
}
void refreshProvenance();
setInterval(() => void refreshProvenance(), 10 * 60 * 1000);

// 3.4 reconciliation job: read-only over value; upserts the per-creature marker the panel reads.
// Fail-safe by design: RPC down -> 'reconciling', never a false ✓; discrepancies are for humans.
async function runReconciliation(): Promise<void> {
  try {
    const verdicts = await reconcileWorld(pool, { gatewayAvailable });
    const n = { reconciled: 0, reconciling: 0, discrepancy: 0 };
    for (const v of verdicts) n[v.status]++;
    console.log(`[lateo] reconciliation: ✓${n.reconciled} ~${n.reconciling} ✗${n.discrepancy}`);
  } catch (e) {
    console.error('[lateo] reconciliation run failed (markers keep last state):', String(e).slice(0, 200));
  }
}
void runReconciliation();
setInterval(() => void runReconciliation(), 5 * 60 * 1000);

await migrate(pool); // idempotent schema — a fresh lateo_world boots ready

server.listen(port, () => {
  console.log(`[lateo] api listening on :${port}`);
});

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
let seedQueue: Promise<void> = Promise.resolve();

function actionsFromEnv(): ServerOptions['actions'] {
  if (!process.env.CIRCLE_API_KEY || !process.env.TREASURY_PRIVATE_KEY) return undefined;
  const circle = circleClient();
  // Single-flight wallet-set init: N concurrent spawns must share ONE set (the 5-concurrent derisk
  // caught the check-then-act race creating one set per spawn).
  let walletSetIdP: Promise<string> | undefined = process.env.CIRCLE_WALLET_SET_ID
    ? Promise.resolve(process.env.CIRCLE_WALLET_SET_ID)
    : undefined;
  return {
    rail: {
      async provisionWallet(): Promise<{ walletId: string; address: `0x${string}` }> {
        walletSetIdP ??= circle.createWalletSet({ name: 'lateo-world' }).then((ws) => {
          const id = ws.data!.walletSet!.id;
          console.log(`[lateo] created wallet set ${id} (set CIRCLE_WALLET_SET_ID to reuse)`);
          return id;
        });
        return createCreatureWallet(circle, await walletSetIdP);
      },
      // SERIALIZED treasury queue: concurrent depositFor from the SAME treasury EOA collide on the
      // nonce (proven live by the 5-concurrent derisk: 1 of 5 landed, 4 lost). One at a time —
      // spawns still respond instantly (seeding is background), and at 10 spawns/hour the queue
      // never builds. The chain of promises never breaks: a failed seed doesn't block the next.
      seed: (address, amountUsdc): Promise<void> => {
        const run = seedQueue.then(() => seedFromTreasury(amountUsdc, address)).then(() => undefined);
        seedQueue = run.catch(() => undefined);
        return run;
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

// THE THINKING SWITCH (ACTORS=1, David's deliberate call): OFF -> creatures serve and get fed but
// never think and never burn (no LLM cost, no deaths). ON -> the world lives: pulse, passive burn,
// gated thoughts under the world budget. Flipping it is a restart with the env var — never implicit.
const burnRate = BigInt(process.env.WORLD_BURN_RATE_ATOMIC_PER_SEC ?? '0');
let worldActors: import('./actors.js').WorldActors | undefined;

const server = createServer(pool, {
  // The World stream projects runway with this burn rate (atomic/s). 0 -> no burn (runway Infinity).
  world: { burnRatePerSec: burnRate },
  fundedByTreasury: funded,
  actions: actionsFromEnv(),
  webDist: process.env.WEB_DIST, // production: serve the built world page from this same service
  onDemand: (ev) => {
    if (ev.kind === 'sale') worldActors?.onSale(ev.creatureId); // a real sale wakes the seller's brain
  },
});

if (process.env.ACTORS === '1') {
  const { startWorldActors } = await import('./actors.js');
  worldActors = startWorldActors(pool, circleClient(), {
    burnRatePerSec: burnRate,
    graceSeconds: Number(process.env.GRACE_SECONDS ?? 3600),
    thoughtsPerDay: Number(process.env.WORLD_THOUGHTS_PER_DAY ?? 2000), // ≈ $4/day hard ceiling in-code
  });
  console.log('[lateo] ACTORS=1 — the world THINKS (gate + world budget + Console limit active)');
} else {
  console.log('[lateo] actors OFF — creatures serve but do not think or burn (flip with ACTORS=1)');
}

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
    const { verdicts, conservation } = await reconcileWorld(pool, { gatewayAvailable });
    const n = { reconciled: 0, reconciling: 0, discrepancy: 0 };
    for (const v of verdicts) n[v.status]++;
    console.log(
      `[lateo] reconciliation: ✓${n.reconciled} ~${n.reconciling} ✗${n.discrepancy} | ` +
        `INV-3 aggregate: ${conservation.status} (off=${conservation.offChainTotal} on=${conservation.onChainTotal} unexplained=${conservation.unexplained})`,
    );
    if (conservation.status === 'discrepancy') {
      console.error('[lateo] INV-3 VIOLATION SUSPECTED — value created/destroyed. HUMAN EYES NOW.');
    }
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

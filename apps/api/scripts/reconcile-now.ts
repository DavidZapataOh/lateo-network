// Run ONE reconciliation pass on demand (the server also runs it every 5 min). Upserts the per-
// creature marker the panel reads, so a real settled creature flips to `reconciled ✓` immediately.
//   npx tsx scripts/reconcile-now.ts [idPrefix]
import { makePool } from '../src/db.js';
import { reconcileWorld } from '../src/reconcile.js';
import { gatewayAvailable } from '../src/rail.js';

const only = process.argv[2];
const pool = makePool();
const { verdicts, conservation } = await reconcileWorld(pool, { gatewayAvailable });
for (const v of verdicts) {
  if (only && !v.creatureId.startsWith(only)) continue;
  console.log(`${v.creatureId.slice(0, 8)} -> ${v.status}`);
}
console.log(`conservation: ${conservation.status} (off=${conservation.offChainTotal} on=${conservation.onChainTotal})`);
await pool.end();

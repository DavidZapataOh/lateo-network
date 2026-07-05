import { makePool } from './db.js';
import { createServer } from './server.js';
import { fundedByTreasury, onchainFunding } from './provenance.js';

const pool = makePool();
const port = Number(process.env.PORT ?? 3000);
// The anti-wash provenance set (2.5): derived FROM THE CHAIN at boot and refreshed periodically.
// Shared by reference — the server reads whatever the latest derivation put in it.
const funded = new Set<string>();
const server = createServer(pool, {
  // The World stream projects runway with this burn rate (atomic/s). 0 -> no burn (runway Infinity).
  world: { burnRatePerSec: BigInt(process.env.WORLD_BURN_RATE_ATOMIC_PER_SEC ?? '0') },
  fundedByTreasury: funded,
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

server.listen(port, () => {
  console.log(`[lateo] api listening on :${port}`);
});

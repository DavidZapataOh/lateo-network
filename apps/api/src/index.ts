import { makePool } from './db.js';
import { createServer } from './server.js';

const pool = makePool();
const port = Number(process.env.PORT ?? 3000);
const server = createServer(pool, {
  // The World stream projects runway with this burn rate (atomic/s). 0 -> no burn (runway Infinity).
  world: { burnRatePerSec: BigInt(process.env.WORLD_BURN_RATE_ATOMIC_PER_SEC ?? '0') },
});

server.listen(port, () => {
  console.log(`[lateo] api listening on :${port}`);
});

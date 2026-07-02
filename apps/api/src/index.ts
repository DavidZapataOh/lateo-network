import { makePool } from './db.js';
import { createServer } from './server.js';

const pool = makePool();
const port = Number(process.env.PORT ?? 3000);
const server = createServer(pool);

server.listen(port, () => {
  console.log(`[lateo] api listening on :${port}`);
});

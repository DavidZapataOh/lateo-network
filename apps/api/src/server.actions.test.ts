import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import pg from 'pg';
import { makePool } from './db.js';
import { createServer } from './server.js';
import { migrate, resetDb } from './ledger.js';
import type { SpawnRail } from './spawn.js';

// Unit rail double (explicitly marked): the real spawn was proven live against Circle/Arc.
const instantRail: SpawnRail = {
  async provisionWallet() {
    return { walletId: 'w', address: `0x${Math.random().toString(16).slice(2).padEnd(40, '0')}` as `0x${string}` };
  },
  async seed() {},
  async gatewayAvailable() {
    return 0n;
  },
};

let pool: pg.Pool;
let server: http.Server;
let base: string;
beforeAll(async () => {
  pool = makePool();
  await migrate(pool);
  server = createServer(pool, {
    actions: {
      rail: instantRail,
      seedUsdc: '0.05',
      seedAtomic: 50_000n,
      feedUsdc: '0.02',
      feedAtomic: 20_000n,
      graceSeconds: 30,
      maxSpawnsPerWindow: 3, // tight cap for the test
      spawnWindowS: 3600,
    },
  });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await pool.end();
});
beforeEach(async () => {
  await resetDb(pool);
});

describe('spawn rate cap — the treasury cannot be drained by a curl loop', () => {
  it('allows up to the cap, then 429s (creatures stop being created)', async () => {
    const spawn = (): Promise<Response> =>
      fetch(`${base}/spawn`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect((await spawn()).status).toBe(201);
    expect((await spawn()).status).toBe(201);
    expect((await spawn()).status).toBe(201);
    const blocked = await spawn(); // 4th within the window
    expect(blocked.status).toBe(429);
    const n = await pool.query<{ n: string }>('select count(*) n from creatures');
    expect(n.rows[0]!.n).toBe('3'); // the cap held: no junk creature, no treasury spend
  });
});

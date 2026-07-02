import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import pg from 'pg';
import { makePool } from './db.js';
import { createServer } from './server.js';
import { migrate, resetDb, createCreature } from './ledger.js';
import type { DemandEvent } from './demand.js';

let pool: pg.Pool;
let server: http.Server;
let base: string;
let demand: DemandEvent[];

beforeAll(async () => {
  pool = makePool();
  await migrate(pool);
  server = createServer(pool, { onDemand: (ev) => demand.push(ev) });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await pool.end();
});
beforeEach(async () => {
  await resetDb(pool);
  demand = [];
});

describe('2.3 — client-incoming demand event carries context (feeds the 30% decision evidence)', () => {
  it('a 402 on an alive creature emits an arrival event with {service, amount, timing}', async () => {
    const id = await createCreature(pool, { walletAddress: '0xA', serviceType: 'summary-with-citations' });
    await fetch(`${base}/c/${id}`, { method: 'POST' });
    expect(demand).toHaveLength(1);
    const ev = demand[0]!;
    expect(ev.creatureId).toBe(id);
    expect(ev.kind).toBe('arrival');
    expect(ev.service).toBe('summary-with-citations'); // context: WHAT is demanded
    expect(ev.amount).toBe(1000n); // context: at WHAT price (the quote)
    expect(typeof ev.at).toBe('number'); // context: WHEN (timing -> demand rate)
  });

  it('non-alive creatures emit NO demand (dead/agonizing are not demand signals)', async () => {
    const dead = await createCreature(pool, { walletAddress: '0xD', serviceType: 'url-to-json' });
    await pool.query(`update creatures set state='dead' where id=$1`, [dead]);
    await fetch(`${base}/c/${dead}`, { method: 'POST' });
    expect(demand).toHaveLength(0);
  });
});

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import pg from 'pg';
import { makePool } from './db.js';
import { createServer } from './server.js';
import { migrate, resetDb, createCreature, balances } from './ledger.js';
import { transitionCreature, readLifeState } from './lifecycle.js';

let pool: pg.Pool;
let server: http.Server;
let base: string;

beforeAll(async () => {
  pool = makePool();
  await migrate(pool);
  server = createServer(pool);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});
beforeEach(async () => {
  await resetDb(pool);
});

const GRACE = 10;
async function makeAgonizing(id: string): Promise<void> {
  await transitionCreature(pool, { creatureId: id, runway: 0, grace: GRACE, now: 100 });
}
async function makeDead(id: string): Promise<void> {
  await transitionCreature(pool, { creatureId: id, runway: 0, grace: GRACE, now: 100 });
  await transitionCreature(pool, { creatureId: id, runway: 0, grace: GRACE, now: 200 });
}

describe('2.1 T3 — GET /creatures state gate', () => {
  it('lists creatures labeled alive/agonizing/dead from state', async () => {
    const a = await createCreature(pool, { walletAddress: '0xA', serviceType: 'url-to-json' });
    const g = await createCreature(pool, { walletAddress: '0xG', serviceType: 'url-to-json' });
    const d = await createCreature(pool, { walletAddress: '0xD', serviceType: 'summary-with-citations' });
    await makeAgonizing(g);
    await makeDead(d);

    const res = await fetch(`${base}/creatures`);
    expect(res.status).toBe(200);
    const list = (await res.json()) as Array<{ id: string; state: string }>;
    const byId = new Map(list.map((c) => [c.id, c.state]));
    expect(byId.get(a)).toBe('alive');
    expect(byId.get(g)).toBe('agonizing');
    expect(byId.get(d)).toBe('dead');
  });

  it('negative: a dead creature is NOT labeled alive (tombstone still listed)', async () => {
    const d = await createCreature(pool, { walletAddress: '0xD', serviceType: 'url-to-json' });
    await makeDead(d);
    const list = (await (await fetch(`${base}/creatures`)).json()) as Array<{ id: string; state: string }>;
    const entry = list.find((c) => c.id === d);
    expect(entry).toBeDefined();
    expect(entry!.state).toBe('dead');
    expect(entry!.state).not.toBe('alive');
  });
});

describe('2.1 T4 — POST /c/{id} state gate (no capture on non-alive)', () => {
  it('agonizing -> rejects service WITHOUT 402 and WITHOUT capturing anything (0 entries, Δ0)', async () => {
    const g = await createCreature(pool, { walletAddress: '0xG', serviceType: 'url-to-json' });
    await makeAgonizing(g);
    const before = await balances(pool, g);
    const res = await fetch(`${base}/c/${g}`, { method: 'POST' });
    expect(res.status).toBe(409); // rejected, not 402 (no payment offered)
    expect(res.status).not.toBe(402);
    expect(await balances(pool, g)).toEqual(before); // Δ0 — nothing captured
    const entries = await pool.query('select count(*)::int as n from ledger_entries where creature_id=$1', [g]);
    expect(entries.rows[0].n).toBe(0);
  });

  it('dead -> 410 Gone, NO payment (0 entries, Δ0)', async () => {
    const d = await createCreature(pool, { walletAddress: '0xD', serviceType: 'url-to-json' });
    await makeDead(d);
    const before = await balances(pool, d);
    const res = await fetch(`${base}/c/${d}`, { method: 'POST' });
    expect(res.status).toBe(410);
    expect(await balances(pool, d)).toEqual(before);
    const entries = await pool.query('select count(*)::int as n from ledger_entries where creature_id=$1', [d]);
    expect(entries.rows[0].n).toBe(0);
    expect((await readLifeState(pool, d)).state).toBe('dead');
  });

  it('alive -> 402 with a full quote {price, nonce(bytes32), ttlS, requirements} (ADR-0007)', async () => {
    const a = await createCreature(pool, { walletAddress: '0xA', serviceType: 'url-to-json' });
    const res = await fetch(`${base}/c/${a}`, { method: 'POST' });
    expect(res.status).toBe(402);
    const q = (await res.json()) as {
      price: string;
      nonce: string;
      ttlS: number;
      requirements: { asset: string; amount: string; payTo: string; network: string };
    };
    expect(q.price).toBe('1000'); // default creature price
    expect(q.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect(q.ttlS).toBeGreaterThan(0);
    expect(q.requirements.amount).toBe('1000');
    expect(q.requirements.payTo).toBe('0xA'); // income pays THIS creature
    expect(q.requirements.network).toBe('eip155:5042002');
  });

  it('two 402s on the same creature yield distinct nonces', async () => {
    const a = await createCreature(pool, { walletAddress: '0xA', serviceType: 'url-to-json' });
    const n1 = ((await (await fetch(`${base}/c/${a}`, { method: 'POST' })).json()) as { nonce: string }).nonce;
    const n2 = ((await (await fetch(`${base}/c/${a}`, { method: 'POST' })).json()) as { nonce: string }).nonce;
    expect(n1).not.toBe(n2);
  });
});

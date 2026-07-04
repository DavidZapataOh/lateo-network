import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import pg from 'pg';
import { makePool } from './db.js';
import { createServer } from './server.js';
import { migrate, resetDb, createCreature, postCredit } from './ledger.js';

let pool: pg.Pool;
let server: http.Server;
let base: string;

beforeAll(async () => {
  pool = makePool();
  await migrate(pool);
  server = createServer(pool, { world: { burnRatePerSec: 10_000n, intervalMs: 100 } });
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

interface SseEvent {
  event: string;
  data: Array<{ id: string; state: string; liveAtomic: string; runwaySeconds: number }>;
}

// Read the first `n` SSE events off GET /world/stream, then close the connection.
function readSse(url: string, n: number): Promise<SseEvent[]> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let buf = '';
      const events: SseEvent[] = [];
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buf += chunk;
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const ev = /event: (.*)/.exec(frame)?.[1];
          const data = /data: (.*)/.exec(frame)?.[1];
          if (ev && data) events.push({ event: ev, data: JSON.parse(data) as SseEvent['data'] });
          if (events.length >= n) {
            req.destroy();
            resolve(events);
            return;
          }
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

describe('3.1 T3 — World SSE stream (read-model over server→client)', () => {
  it('emits an initial snapshot then one delta per pulse', async () => {
    const a = await createCreature(pool, { walletAddress: '0xA', serviceType: 'url-to-json' });
    await postCredit(pool, { creatureId: a, kind: 'feed', amount: 100_000n });

    const events = await readSse(`${base}/world/stream`, 3);
    expect(events.map((e) => e.event)).toEqual(['snapshot', 'delta', 'delta']);
    const one = events[0]!.data.find((c) => c.id === a)!;
    expect(one.liveAtomic).toBe('100000'); // bigint serialized as string
    expect(one.runwaySeconds).toBe(10);
    expect(one.state).toBe('alive');
  });

  it('the stream only reads — it does not mutate the ledger', async () => {
    const a = await createCreature(pool, { walletAddress: '0xA', serviceType: 'url-to-json' });
    await postCredit(pool, { creatureId: a, kind: 'feed', amount: 100_000n });
    const before = (await pool.query<{ n: string }>('select count(*) n from ledger_entries')).rows[0]!.n;
    await readSse(`${base}/world/stream`, 4); // stream through several pulses
    const after = (await pool.query<{ n: string }>('select count(*) n from ledger_entries')).rows[0]!.n;
    expect(after).toBe(before);
  });

  it('POST /world/stream -> 405 (a read-model exposes no write vector)', async () => {
    const res = await fetch(`${base}/world/stream`, { method: 'POST' });
    expect(res.status).toBe(405);
  });
});

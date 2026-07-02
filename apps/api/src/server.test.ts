import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import pg from 'pg';
import { makePool } from './db.js';
import { createServer } from './server.js';

let pool: pg.Pool;
let server: http.Server;
let base: string;

beforeAll(async () => {
  pool = makePool();
  server = createServer(pool);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

describe('1.0 scaffolding — verification harness', () => {
  it('smoke: the runner runs from scratch', () => {
    expect(1 + 1).toBe(2);
  });

  it('GET /health → 200 with a REAL Postgres (SELECT 1)', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', db: 'ok' });
  });

  it('unknown route → 404', async () => {
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
  });
});

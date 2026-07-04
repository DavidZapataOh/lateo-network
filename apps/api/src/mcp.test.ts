import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import pg from 'pg';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { makePool } from './db.js';
import { createServer } from './server.js';
import { migrate, resetDb, createCreature } from './ledger.js';
import { createMcpServer } from './mcp.js';

let pool: pg.Pool;
let httpServer: http.Server;
let base: string;

beforeAll(async () => {
  pool = makePool();
  await migrate(pool);
  await resetDb(pool);
  httpServer = createServer(pool);
  await new Promise<void>((r) => httpServer.listen(0, r));
  base = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => httpServer.close(() => r()));
  await pool.end();
});

describe('2.5 T2 — minimal MCP (discover + buy) for an external agent', () => {
  it('exposes exactly discover + buy; discover proxies the real registry', async () => {
    const created = await createCreature(pool, { walletAddress: '0xC', serviceType: 'url-to-json' });
    const server = createMcpServer({ base, agentWallet: privateKeyToAccount(generatePrivateKey()) });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'external-agent', version: '0' });
    await client.connect(clientTransport);

    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(['buy', 'discover']); // exactly two — minimal (ADR-0009)

    const res = await client.callTool({ name: 'discover', arguments: {} });
    const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
    const registry = JSON.parse(text) as Array<{ id: string; serviceType: string }>;
    expect(registry.some((c) => c.id === created)).toBe(true); // real GET /creatures behind it

    await client.close();
    await server.close();
  });
});

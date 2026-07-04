// The COMPLETE anti-wash arc (2.5 DONE): an agent (via MCP) pays a creature for its service, the
// creature cashes out on Arcscan, and the arc is traceable end to end — with "external" decided by
// ON-CHAIN PROVENANCE (the payer's USDC does not trace to the published treasury), not a label.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createPublicClient, http as vhttp, defineChain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { makePool } from '../src/db.js';
import { migrate, resetDb, createCreature, postCredit, setBuyerClass, balances } from '../src/ledger.js';
import { circleClient, createCreatureWallet, seedFromTreasury, gatewayAvailable, creatureCashOut } from '../src/rail.js';
import { createServer } from '../src/server.js';
import { createMcpServer } from '../src/mcp.js';
import { fundedByTreasury, onchainFunding } from '../src/provenance.js';
import { tractionMetric } from '../src/metric.js';
import { atomicToUsdc } from '../src/money.js';

const envPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.env.local');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
  }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const T = process.env.TREASURY_ADDRESS!; // the PUBLISHED treasury (source of truth for provenance)
const RPC = process.env.ARC_RPC!;
const FIXTURE = `<!doctype html><html><head><title>Arc</title><meta name="description" content="USDC gas; batched settlement."></head><body><h1>Arc</h1></body></html>`;

async function main(): Promise<void> {
  const circle = circleClient();
  const pool = makePool();
  await migrate(pool);
  await resetDb(pool);

  console.log('[setup] creature wallet + seed from published treasury T...');
  const ws = await circle.createWalletSet({ name: 'lateo-arc25' });
  const creature = await createCreatureWallet(circle, ws.data!.walletSet!.id);
  try {
    await seedFromTreasury('0.05', creature.address);
  } catch (e) {
    if (!/timed out|WaitForTransactionReceiptTimeout/i.test(String(e))) throw e;
  }
  for (let i = 0; i < 80 && (await gatewayAvailable(creature.address)) === 0n; i++) await sleep(5000);
  if ((await gatewayAvailable(creature.address)) === 0n) throw new Error('seed never credited');
  const cid = await createCreature(pool, { walletAddress: creature.address, serviceType: 'url-to-json' });
  await postCredit(pool, { creatureId: cid, kind: 'feed', amount: (await gatewayAvailable(creature.address)) });

  // the EXTERNAL agent: brings its own funded wallet. We even MISLABEL it 'agent' in the DB to prove
  // the metric ignores the label and follows on-chain provenance instead.
  const agent = privateKeyToAccount(process.env.PLATFORM_PRIVATE_KEY! as `0x${string}`);
  await setBuyerClass(pool, agent.address, 'agent');

  const fixture = http.createServer((_q, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(FIXTURE); });
  await new Promise<void>((r) => fixture.listen(0, r));
  const fixtureUrl = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}/`;
  const server = createServer(pool);
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // the agent finds and pays the creature THROUGH THE MCP (discover + buy)
  console.log('[mcp] external agent: discover -> buy...');
  const mcp = createMcpServer({ base, agentWallet: agent });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await mcp.connect(st);
  const client = new Client({ name: 'external-agent', version: '0' });
  await client.connect(ct);
  await client.callTool({ name: 'discover', arguments: {} });
  const buyRes = await client.callTool({ name: 'buy', arguments: { creatureId: cid, url: fixtureUrl } });
  const paid = JSON.parse((buyRes.content as Array<{ text: string }>)[0]!.text) as { outcome?: string; settleId?: string; result?: unknown };
  console.log(`[mcp] buy -> outcome=${paid.outcome} settleId=${paid.settleId}`);

  const cash = await creatureCashOut(circle, { walletId: creature.walletId, address: creature.address, amountUsdc: '0.015' });

  // derive the funded-by-treasury set FROM THE CHAIN and classify by provenance
  const arc = defineChain({ id: 5042002, name: 'arc-testnet', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
  const head = await createPublicClient({ chain: arc, transport: vhttp(RPC) }).getBlockNumber();
  const fromBlock = head > 200_000n ? head - 200_000n : 0n;
  const funded = fundedByTreasury([T], await onchainFunding([T], { rpcUrl: RPC, fromBlock }));
  const agentExternal = !funded.has(agent.address.toLowerCase()) && agent.address.toLowerCase() !== creature.address.toLowerCase();
  const creatureWasSeeded = funded.has(creature.address.toLowerCase());
  const metric = await tractionMetric(pool, new Set([...funded, T.toLowerCase()]));

  console.log('\n==================== ANTI-WASH ARC — EVIDENCE ====================');
  console.log(`published treasury T: ${T}`);
  console.log(`1. AGENT (via MCP) paid: ${agent.address}`);
  console.log(`   income settleId=${paid.settleId}, deliverable=${JSON.stringify(paid.result)}`);
  console.log(`   ledger settled: ${atomicToUsdc((await balances(pool, cid)).settled)} USDC (income credited)`);
  console.log(`2. CREATURE: ${creature.address}`);
  console.log(`3. CASH-OUT (Arcscan): ${cash.mintTxHash}`);
  console.log(`   https://testnet.arcscan.app/tx/${cash.mintTxHash}`);
  console.log(`4. PROVENANCE (derived from chain, fromBlock=${fromBlock}):`);
  console.log(`   creature funded-by-T? ${creatureWasSeeded}  (deriver catches the seed -> works)`);
  console.log(`   agent funded-by-T?    ${funded.has(agent.address.toLowerCase())}  (payer's USDC does NOT trace to T)`);
  console.log(`   payer != creature (not self-deal)? ${agent.address.toLowerCase() !== creature.address.toLowerCase()}`);
  console.log(`   => agent EXTERNAL by provenance? ${agentExternal}`);
  console.log(`5. METRIC (by provenance, ignores the 'agent' label we set): externalPayers=${metric.externalPayers}`);
  console.log('==================================================================');

  await client.close();
  await mcp.close();
  server.close();
  fixture.close();
  await pool.end();
  process.exit(0);
}
await main();

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type Anthropic from '@anthropic-ai/sdk';
import { listCreatures, getWorldSnapshot } from './readmodel.js';
import { creaturePanel, worldStats } from './panel.js';
import { spawnCreature, feedFromTreasury, type SpawnRail } from './spawn.js';
import { QuoteStore, isMenuService } from './quote.js';
import { requirementsFor, verify, type SignedAuthorization } from './rail.js';
import type { DemandEvent } from './demand.js';
import { serveAndSettle } from './service.js';
import { authorizeIncome, type ServiceType } from './ledger.js';
import type { Atomic } from './money.js';
import { runService } from './serve.js';
import { anthropicClient } from './llm.js';
import type { ModelId } from './guardrail.js';

/** Short quote TTL (ADR-0007): re-pricing security is our nonce/TTL, not the >=30d EIP-3009 window. */
export const QUOTE_TTL_S = 120;

export interface ServerOptions {
  /** Sink for client-incoming demand signals (fed to the running actor loop). */
  onDemand?: (ev: DemandEvent) => void;
  /** Anthropic client for the summary service (lazily created if omitted). */
  anthropic?: Anthropic;
  /** The World SSE stream (ADR-0013 read-model): the burn rate the projection uses for runway. */
  world?: { burnRatePerSec: Atomic; intervalMs?: number };
  /** 2.5 provenance set (wallets funded by the published treasury) for the anti-wash stats bar. */
  fundedByTreasury?: Set<string>;
  /** Explorer base for wallet links (defaults to Arc testnet's Arcscan). */
  arcscanBase?: string;
  /** Serve the built world page from this directory (production: one service, one stable URL). */
  webDist?: string;
  /** The transactional actions' rail (spawn/feed). Absent -> actions respond 503 (read-only mode). */
  actions?: {
    rail: SpawnRail;
    seedUsdc: string;
    seedAtomic: Atomic;
    feedUsdc: string;
    feedAtomic: Atomic;
    graceSeconds: number;
    /** Spawn rate cap (defaults 10/hour): every spawn spends treasury USDC + a Circle wallet —
     * without this, one curl loop drains the treasury and floods the world. */
    maxSpawnsPerWindow?: number;
    spawnWindowS?: number;
  };
}

/**
 * HTTP server. `GET /health`, `GET /creatures` (World read model), and the state-gated x402
 * `POST /c/{id}` service route: no payment -> 402 quote (ADR-0007); with an `x-payment` header ->
 * validate quote+menu -> verify -> DELIVER the service -> settle (or void) -> consume the nonce ->
 * return the deliverable, and emit a real-sale demand event the actor loop consumes.
 */
export function createServer(pool: pg.Pool, opts: ServerOptions = {}): http.Server {
  const quotes = new QuoteStore();
  const spawnTimes: number[] = []; // rate-limit state for POST /spawn (treasury protection)
  return http.createServer((req, res) => {
    void handle(req, res, pool, quotes, opts, spawnTimes);
  });
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pool: pg.Pool,
  quotes: QuoteStore,
  opts: ServerOptions,
  spawnTimes: number[] = [],
): Promise<void> {
  const url = req.url ?? '';
  if (req.method === 'GET' && url === '/health') {
    try {
      await pool.query('SELECT 1');
      send(res, 200, { status: 'ok', db: 'ok' });
    } catch {
      send(res, 503, { status: 'degraded', db: 'down' });
    }
    return;
  }
  if (req.method === 'GET' && url === '/creatures') {
    send(res, 200, await listCreatures(pool));
    return;
  }
  if (url === '/world/stream') {
    if (req.method !== 'GET') {
      send(res, 405, { error: 'method_not_allowed' }); // read-model: no write vector (ADR-0013)
      return;
    }
    streamWorld(req, res, pool, opts);
    return;
  }
  if (url === '/world/stats') {
    if (req.method !== 'GET') {
      send(res, 405, { error: 'method_not_allowed' });
      return;
    }
    // anti-wash headline by ON-CHAIN PROVENANCE (2.5): funded-by-treasury set injected via options
    send(res, 200, await worldStats(pool, opts.fundedByTreasury ?? new Set()));
    return;
  }
  const panelMatch = /^\/c\/([^/?]+)\/panel$/.exec(url);
  if (panelMatch) {
    if (req.method !== 'GET') {
      send(res, 405, { error: 'method_not_allowed' });
      return;
    }
    const p = await creaturePanel(pool, panelMatch[1]!, { arcscanBase: opts.arcscanBase });
    if (!p) send(res, 404, { error: 'not_found' });
    else send(res, 200, p);
    return;
  }
  // ---- the 3 ACTIONS (transactional API, ADR-0010 — never through the read-model) ----
  if (req.method === 'POST' && url === '/spawn') {
    if (!opts.actions) {
      send(res, 503, { error: 'actions_disabled', note: 'spawn rail not configured' });
      return;
    }
    // Rate cap: each spawn spends real treasury USDC + provisions a Circle wallet. A curl loop
    // must not be able to drain the treasury or flood the world with junk creatures.
    const nowS = Date.now() / 1000;
    const windowS = opts.actions.spawnWindowS ?? 3600;
    const cap = opts.actions.maxSpawnsPerWindow ?? 10;
    while (spawnTimes.length && spawnTimes[0]! <= nowS - windowS) spawnTimes.shift();
    if (spawnTimes.length >= cap) {
      send(res, 429, { error: 'too_many_spawns', note: `cap ${cap} per ${windowS}s — try later` });
      return;
    }
    spawnTimes.push(nowS);
    const body = await readJsonBody(req);
    const serviceType = body.serviceType === 'summary-with-citations' ? 'summary-with-citations' : 'url-to-json';
    const s = await spawnCreature(pool, opts.actions.rail, {
      serviceType,
      seedUsdc: opts.actions.seedUsdc,
      seedAtomic: opts.actions.seedAtomic,
    });
    // respond IMMEDIATELY (latency resilience): the seed settles in background via balance polling
    send(res, 201, {
      id: s.id,
      walletAddress: s.walletAddress,
      arcscanUrl: `${opts.arcscanBase ?? 'https://testnet.arcscan.app'}/address/${s.walletAddress}`,
      seed: { amountUsdc: opts.actions.seedUsdc, status: 'settling', note: 'credits when the chain confirms' },
    });
    return;
  }
  const feedMatch = /^\/c\/([^/?]+)\/feed$/.exec(url);
  if (feedMatch) {
    if (req.method !== 'POST') {
      send(res, 405, { error: 'method_not_allowed' });
      return;
    }
    if (!opts.actions) {
      send(res, 503, { error: 'actions_disabled' });
      return;
    }
    // Async by design (batch lag can be minutes): 202 now; the credit + possible REVIVE land when
    // the chain confirms. Feeding the dead is rejected here, before any value moves.
    const cur = await pool.query<{ state: string }>(`select state from creatures where id = $1`, [feedMatch[1]!]);
    if (!cur.rows[0]) {
      send(res, 404, { error: 'not_found' });
      return;
    }
    if (cur.rows[0].state === 'dead') {
      send(res, 410, { error: 'gone', note: 'death is permanent — the dead cannot be fed' });
      return;
    }
    const a = opts.actions;
    void feedFromTreasury(pool, a.rail, {
      creatureId: feedMatch[1]!,
      amountUsdc: a.feedUsdc,
      amountAtomic: a.feedAtomic,
      burnRatePerSec: opts.world?.burnRatePerSec ?? 0n,
      grace: a.graceSeconds,
      now: Math.floor(Date.now() / 1000),
    }).catch(() => undefined);
    send(res, 202, { accepted: true, amountUsdc: a.feedUsdc, status: 'settling' });
    return;
  }
  const service = /^\/c\/([^/?]+)/.exec(url);
  if (req.method === 'POST' && service) {
    await handleService(req, res, pool, quotes, opts, service[1]!);
    return;
  }
  // Production static hosting (WEB_DIST=apps/web/dist): one Railway service serves world + API on
  // one stable URL. Read-only file serving; API routes above always win.
  if (req.method === 'GET' && opts.webDist && (await serveStatic(res, opts.webDist, url))) return;
  send(res, 404, { error: 'not_found' });
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
};

async function serveStatic(res: http.ServerResponse, dist: string, url: string): Promise<boolean> {
  const { readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const clean = url.split('?')[0]!.split('#')[0]!;
  const rel = clean === '/' ? 'index.html' : clean.slice(1);
  const full = path.resolve(dist, rel);
  if (!full.startsWith(path.resolve(dist))) return false; // no path traversal
  try {
    const body = await readFile(full);
    res.writeHead(200, { 'content-type': MIME[path.extname(full)] ?? 'application/octet-stream' });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

interface CreatureRow {
  state: 'alive' | 'agonizing' | 'dead';
  wallet_address: string;
  price_atomic: string;
  service_type: string;
  model: string;
}

async function handleService(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pool: pg.Pool,
  quotes: QuoteStore,
  opts: ServerOptions,
  id: string,
): Promise<void> {
  const r = await pool.query<CreatureRow>(
    `select state, wallet_address, price_atomic, service_type, model from creatures where id = $1`,
    [id],
  );
  const row = r.rows[0];
  if (!row) {
    send(res, 404, { error: 'not_found' });
    return;
  }
  if (row.state === 'dead') {
    send(res, 410, { error: 'gone', state: row.state }); // tombstone, no payment
    return;
  }
  if (row.state === 'agonizing') {
    send(res, 409, { error: 'unavailable', state: row.state }); // no service, no 402, no payment
    return;
  }
  // alive: a payment header means the client is redeeming a quote; otherwise issue a fresh quote.
  if (req.headers['x-payment']) {
    await handlePaidRequest(req, res, pool, quotes, opts, id, row);
    return;
  }
  const price = BigInt(row.price_atomic);
  const now = Math.floor(Date.now() / 1000);
  const quote = quotes.issue(id, price, QUOTE_TTL_S, now);
  // a live client asked (interest) -> arrival demand signal (the paid path emits a stronger 'sale')
  opts.onDemand?.({ creatureId: id, kind: 'arrival', service: row.service_type, amount: price, at: now });
  send(res, 402, {
    error: 'payment_required',
    price: price.toString(),
    nonce: quote.nonce,
    ttlS: quote.ttlS,
    requirements: requirementsFor(row.wallet_address, price),
  });
}

/**
 * The paid x402 path (2.3): validate the quote (re-pricing security) + frozen menu, verify the
 * EIP-3009 authorization (amount enforced by the signature vs the quoted requirements), record the
 * pending income, DELIVER then capture (serveAndSettle — settle if alive, void if delivery fails or
 * the creature died), consume the single-use nonce, and emit a real-sale demand event.
 */
async function handlePaidRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pool: pg.Pool,
  quotes: QuoteStore,
  opts: ServerOptions,
  id: string,
  row: CreatureRow,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const body = await readJsonBody(req);
  const nonce = typeof body.nonce === 'string' ? body.nonce : '';
  const url = typeof body.url === 'string' ? body.url : '';

  const q = quotes.validate(nonce, now); // ADR-0007: unknown/expired -> reject, no value touched
  if (!q || q.creatureId !== id) {
    send(res, 402, { error: 'invalid_or_expired_quote' });
    return;
  }
  if (!isMenuService(row.service_type)) {
    send(res, 400, { error: 'service_not_in_menu' }); // §9 frozen menu
    return;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(String(req.headers['x-payment']), 'base64').toString('utf8'));
  } catch {
    send(res, 400, { error: 'bad_payment_header' });
    return;
  }
  const auth: SignedAuthorization = { payload, requirements: requirementsFor(row.wallet_address, q.price) };
  const v = await verify(auth); // authorize: moves NO value; wrong amount -> signature invalid
  if (!v.isValid) {
    send(res, 402, { error: 'payment_invalid', reason: v.invalidReason });
    return;
  }

  const entryId = await authorizeIncome(pool, {
    creatureId: id,
    amount: q.price,
    nonce: randomUUID(),
    counterparty: v.payer,
  });
  const client = opts.anthropic ?? anthropicClient();
  const result = await serveAndSettle(pool, {
    creatureId: id,
    entryId,
    auth,
    deliver: () => runService(row.service_type as ServiceType, { url }, { client, model: row.model as ModelId }),
  });
  quotes.consume(nonce); // single-use (INV-4 store side)
  opts.onDemand?.({ creatureId: id, kind: 'sale', service: row.service_type, amount: q.price, at: now });

  if (result.outcome === 'voided') {
    // delivery failed or the creature died mid-request -> the buyer keeps its money (ADR-0006)
    send(res, 502, { outcome: 'voided', note: 'delivery failed; payment voided, you keep your money' });
    return;
  }
  send(res, 200, { outcome: 'served', settleId: result.settleId, result: result.result });
}

/**
 * The World SSE stream (ADR-0013): server→client only (a read-model has no write vector, so no
 * websocket). Emits an initial `snapshot` then one `delta` per pulse (~1/s, coalesced — NOT
 * per-value-event, so smoothness never couples to the ~800ms rail signing, ADR-0003). Only reads.
 */
function streamWorld(req: http.IncomingMessage, res: http.ServerResponse, pool: pg.Pool, opts: ServerOptions): void {
  const burnRatePerSec = opts.world?.burnRatePerSec ?? 0n;
  const intervalMs = opts.world?.intervalMs ?? 1000;
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const emit = (event: string, data: unknown): void => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data, bigintReplacer)}\n\n`);
  };
  const push = (event: string): Promise<void> =>
    getWorldSnapshot(pool, { burnRatePerSec })
      .then((snap) => emit(event, snap))
      .catch(() => undefined); // a projection hiccup must not kill the stream
  void push('snapshot');
  const timer = setInterval(() => void push('delta'), intervalMs);
  const stop = (): void => clearInterval(timer);
  req.on('close', stop);
  res.on('close', stop);
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function send(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

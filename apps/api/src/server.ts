import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type Anthropic from '@anthropic-ai/sdk';
import { listCreatures } from './readmodel.js';
import { QuoteStore, isMenuService } from './quote.js';
import { requirementsFor, verify, type SignedAuthorization } from './rail.js';
import type { DemandEvent } from './demand.js';
import { serveAndSettle } from './service.js';
import { authorizeIncome, type ServiceType } from './ledger.js';
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
}

/**
 * HTTP server. `GET /health`, `GET /creatures` (World read model), and the state-gated x402
 * `POST /c/{id}` service route: no payment -> 402 quote (ADR-0007); with an `x-payment` header ->
 * validate quote+menu -> verify -> DELIVER the service -> settle (or void) -> consume the nonce ->
 * return the deliverable, and emit a real-sale demand event the actor loop consumes.
 */
export function createServer(pool: pg.Pool, opts: ServerOptions = {}): http.Server {
  const quotes = new QuoteStore();
  return http.createServer((req, res) => {
    void handle(req, res, pool, quotes, opts);
  });
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pool: pg.Pool,
  quotes: QuoteStore,
  opts: ServerOptions,
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
  const service = /^\/c\/([^/?]+)/.exec(url);
  if (req.method === 'POST' && service) {
    await handleService(req, res, pool, quotes, opts, service[1]!);
    return;
  }
  send(res, 404, { error: 'not_found' });
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

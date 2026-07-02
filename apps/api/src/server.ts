import http from 'node:http';
import type pg from 'pg';
import { listCreatures } from './readmodel.js';
import { QuoteStore } from './quote.js';
import { requirementsFor } from './rail.js';

/** Short quote TTL (ADR-0007): re-pricing security is our nonce/TTL, not the >=30d EIP-3009 window. */
export const QUOTE_TTL_S = 120;

/**
 * HTTP server. `GET /health`, `GET /creatures` (World read model), and the state-gated x402
 * `POST /c/{id}` service route: alive -> 402 with a {price, nonce, ttl} quote (ADR-0007). The
 * paid-request path (verify -> serve -> settle/void) lands with the services (2.3 tasks 6-11).
 */
export function createServer(pool: pg.Pool): http.Server {
  const quotes = new QuoteStore();
  return http.createServer((req, res) => {
    void handle(req, res, pool, quotes);
  });
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pool: pg.Pool,
  quotes: QuoteStore,
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
    await handleService(res, pool, quotes, service[1]!);
    return;
  }
  send(res, 404, { error: 'not_found' });
}

interface CreatureRow {
  state: 'alive' | 'agonizing' | 'dead';
  wallet_address: string;
  price_atomic: string;
}

/**
 * State gate (ADR-0006) + quote (ADR-0007): dead -> 410 Gone (no payment); agonizing -> 409, no
 * quote (no service, no payment); alive -> 402 with a {price, nonce, ttl} quote and Arc payment
 * requirements. Non-alive paths capture nothing.
 */
async function handleService(
  res: http.ServerResponse,
  pool: pg.Pool,
  quotes: QuoteStore,
  id: string,
): Promise<void> {
  const r = await pool.query<CreatureRow>(
    `select state, wallet_address, price_atomic from creatures where id = $1`,
    [id],
  );
  const row = r.rows[0];
  if (!row) {
    send(res, 404, { error: 'not_found' });
    return;
  }
  if (row.state === 'dead') {
    send(res, 410, { error: 'gone', state: row.state });
    return;
  }
  if (row.state === 'agonizing') {
    send(res, 409, { error: 'unavailable', state: row.state }); // no service, no 402, no payment
    return;
  }
  // alive: issue a fresh quote (price fixed by the creature) with a short-lived nonce.
  const price = BigInt(row.price_atomic);
  const now = Math.floor(Date.now() / 1000);
  const quote = quotes.issue(id, price, QUOTE_TTL_S, now);
  send(res, 402, {
    error: 'payment_required',
    price: price.toString(),
    nonce: quote.nonce,
    ttlS: quote.ttlS,
    requirements: requirementsFor(row.wallet_address, price),
  });
}

function send(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

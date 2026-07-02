import http from 'node:http';
import type pg from 'pg';
import { listCreatures } from './readmodel.js';
import { readLifeState } from './lifecycle.js';

/**
 * HTTP server. `GET /health`, `GET /creatures` (World read model), and the state-gated
 * `POST /c/{id}` service route. The real quote/serve/capture flow is 2.3/2.5.
 */
export function createServer(pool: pg.Pool): http.Server {
  return http.createServer((req, res) => {
    void handle(req, res, pool);
  });
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pool: pg.Pool,
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
    await handleService(res, pool, service[1]!);
    return;
  }
  send(res, 404, { error: 'not_found' });
}

/**
 * State gate (ADR-0006): alive admits the service route (402 Payment Required — the real
 * quote/serve/capture is 2.3/2.5); agonizing rejects with NO payment offered (409); dead is
 * a tombstone (410 Gone). Non-alive paths capture nothing.
 */
async function handleService(res: http.ServerResponse, pool: pg.Pool, id: string): Promise<void> {
  let state;
  try {
    state = (await readLifeState(pool, id)).state;
  } catch {
    send(res, 404, { error: 'not_found' });
    return;
  }
  if (state === 'dead') {
    send(res, 410, { error: 'gone', state });
    return;
  }
  if (state === 'agonizing') {
    send(res, 409, { error: 'unavailable', state }); // agonizing: no service, no 402, no payment
    return;
  }
  send(res, 402, { error: 'payment_required', state }); // alive: service requires payment
}

function send(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

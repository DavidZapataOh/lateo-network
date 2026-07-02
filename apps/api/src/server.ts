import http from 'node:http';
import type pg from 'pg';

/**
 * Minimal HTTP server (1.0). Only `GET /health` — checks the Postgres connection.
 * The rest of the routes (rail, service, world) arrive in later slices.
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
  if (req.method === 'GET' && req.url === '/health') {
    try {
      await pool.query('SELECT 1');
      send(res, 200, { status: 'ok', db: 'ok' });
    } catch {
      send(res, 503, { status: 'degraded', db: 'down' });
    }
    return;
  }
  send(res, 404, { error: 'not_found' });
}

function send(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

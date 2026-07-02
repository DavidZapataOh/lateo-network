import pg from 'pg';

const { Pool } = pg;

/**
 * Postgres pool. Uses DATABASE_URL when present; otherwise the PG* env vars
 * (PGHOST/PGPORT/PGUSER/PGDATABASE) — so the local test cluster (socket) and
 * Railway (DATABASE_URL) both work without special-casing.
 */
export function makePool(): pg.Pool {
  const url = process.env.DATABASE_URL;
  return url ? new Pool({ connectionString: url }) : new Pool();
}

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type pg from 'pg';
import { makePool } from './db.js';
import { migrate, resetDb, createCreature, postCredit, authorizeBurn } from './ledger.js';
import { getWorldSnapshot } from './readmodel.js';

type Queryable = Pick<pg.Pool, 'query'>;

let pool: pg.Pool;
beforeAll(async () => {
  pool = makePool();
  await migrate(pool);
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await resetDb(pool);
});

describe('3.1 T1 — World snapshot projection (read-only)', () => {
  it('projects live balance, runway, and last activity per creature', async () => {
    const a = await createCreature(pool, { walletAddress: '0xA', serviceType: 'url-to-json' });
    await postCredit(pool, { creatureId: a, kind: 'feed', amount: 100_000n }); // 0.10 USDC
    const [one] = await getWorldSnapshot(pool, { burnRatePerSec: 10_000n }); // -> runway 100k/10k = 10s
    expect(one!.liveAtomic).toBe(100_000n);
    expect(one!.runwaySeconds).toBe(10);
    expect(one!.state).toBe('alive');
    expect(one!.lastActivityAt).not.toBeNull();
  });

  it('a creature with no ledger yet projects live=0, runway=0, lastActivity=null', async () => {
    await createCreature(pool, { walletAddress: '0xA', serviceType: 'url-to-json' });
    const [one] = await getWorldSnapshot(pool, { burnRatePerSec: 10_000n });
    expect(one!.liveAtomic).toBe(0n);
    expect(one!.runwaySeconds).toBe(0);
    expect(one!.lastActivityAt).toBeNull();
  });

  it('pending burn discounts live (the honest balance drives the light)', async () => {
    const a = await createCreature(pool, { walletAddress: '0xA', serviceType: 'url-to-json' });
    await postCredit(pool, { creatureId: a, kind: 'feed', amount: 100_000n });
    await authorizeBurn(pool, { creatureId: a, kind: 'burn_passive', amount: 40_000n, nonce: 'n1' });
    const [one] = await getWorldSnapshot(pool, { burnRatePerSec: 10_000n });
    expect(one!.liveAtomic).toBe(60_000n); // 100k − 40k pending
    expect(one!.runwaySeconds).toBe(6);
  });
});

// The purity guard is the whole point (ADR-0013): the World has NO write path, so it CANNOT violate
// INV-1..4. Two independent checks, both proven to bite.
const SRC = join(dirname(fileURLToPath(import.meta.url)), 'readmodel.ts');
function valueImportSpecifiers(src: string): string[] {
  return src
    .split('\n')
    .filter((l) => /^\s*import\b/.test(l) && !/^\s*import\s+type\b/.test(l))
    .map((l) => /from\s+['"]([^'"]+)['"]/.exec(l)?.[1] ?? '');
}

describe('3.1 T2 — read-model purity: static import boundary (BITES)', () => {
  it('never imports the rail, and never value-imports the ledger writer', () => {
    const src = readFileSync(SRC, 'utf8');
    expect(src).not.toMatch(/from\s+['"]\.\/rail(\.js)?['"]/); // rail forbidden in ANY form
    const values = valueImportSpecifiers(src);
    expect(values).not.toContain('./ledger.js'); // ledger only as `import type` (writers never)
    expect(values).not.toContain('./ledger');
  });

  it('BITES: the scanner flags a forbidden writer import', () => {
    // Proof the rule discriminates: a source that value-imports the ledger writer IS caught, so the
    // real test above would fail if someone wired a writer into the read-model.
    const tainted = `import { postCredit } from './ledger.js';\n${readFileSync(SRC, 'utf8')}`;
    expect(valueImportSpecifiers(tainted)).toContain('./ledger.js');
  });
});

// A pool proxy that throws on any write statement — proves the read-model issues only reads at runtime.
function readOnlyGuard(real: pg.Pool): { pool: Queryable; writes: () => number } {
  let writes = 0;
  const pool = new Proxy(real, {
    get(target, prop, receiver): unknown {
      if (prop === 'query') {
        return (text: unknown, ...rest: unknown[]): unknown => {
          const sql = String(typeof text === 'string' ? text : (text as { text?: string })?.text ?? '');
          if (/^\s*(insert|update|delete|truncate|alter|create|drop|merge)\b/i.test(sql)) {
            writes++;
            throw new Error(`read-only violation: write reached the read-model: ${sql.slice(0, 40)}`);
          }
          return (target.query as (...a: unknown[]) => unknown)(text, ...rest);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as unknown as pg.Pool;
  return { pool, writes: () => writes };
}

describe('3.1 T2 — read-model purity: dynamic 0-mutations (BITES)', () => {
  it('driving the snapshot 25× through a write-detecting pool performs 0 writes', async () => {
    const a = await createCreature(pool, { walletAddress: '0xA', serviceType: 'url-to-json' });
    await postCredit(pool, { creatureId: a, kind: 'feed', amount: 100_000n });
    const g = readOnlyGuard(pool);
    for (let i = 0; i < 25; i++) await getWorldSnapshot(g.pool, { burnRatePerSec: 10_000n });
    expect(g.writes()).toBe(0);
  });

  it('BITES: the guard actually catches a write (so 0 above is meaningful)', async () => {
    const a = await createCreature(pool, { walletAddress: '0xA', serviceType: 'url-to-json' });
    const g = readOnlyGuard(pool);
    await expect(postCredit(g.pool, { creatureId: a, kind: 'feed', amount: 1n })).rejects.toThrow(/read-only/);
    expect(g.writes()).toBe(1);
  });
});

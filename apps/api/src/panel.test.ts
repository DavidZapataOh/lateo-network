import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';
import { makePool } from './db.js';
import { migrate, resetDb, createCreature, postCredit, authorizeBurn, setBuyerClass } from './ledger.js';
import { balancesOn } from './balances.js';
import { creaturePanel, worldStats, DEFAULT_ARCSCAN_BASE } from './panel.js';
import { transitionCreature } from './lifecycle.js';
import type { Reconciliation } from './reconciliation.js';

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

const W = '0xAbCd000000000000000000000000000000000001';
async function creature(wallet = W): Promise<string> {
  return createCreature(pool, { walletAddress: wallet, serviceType: 'url-to-json' });
}

describe('3.3 T1 — honest balance in the panel, byte-identical to the 1.1 query', () => {
  it('settled/pending/live match balancesOn exactly (never counts pending as settled)', async () => {
    const id = await creature();
    await postCredit(pool, { creatureId: id, kind: 'income', amount: 1000n, settleId: 's1' });
    await postCredit(pool, { creatureId: id, kind: 'feed', amount: 500n });
    await postCredit(pool, { creatureId: id, kind: 'income', amount: 200n }); // settled income
    await authorizeBurn(pool, { creatureId: id, kind: 'burn_passive', amount: 300n, nonce: 'n1' }); // pending
    const p = (await creaturePanel(pool, id))!;
    const b = await balancesOn(pool, id); // the canonical arithmetic
    expect(p.balances.settledAtomic).toBe(b.settled.toString()); // 1700
    expect(p.balances.pendingAtomic).toBe(b.pending.toString()); // 300
    expect(p.balances.liveAtomic).toBe(b.live.toString()); // 1400
    expect(p.balances.settledAtomic).toBe('1700'); // and the numbers themselves are right
    expect(p.balances.pendingAtomic).toBe('300');
  });
});

describe('3.3 T2 — the wallet link goes to THIS creature’s real address (ADR-0008)', () => {
  it('arcscan_url is exactly base/address/<wallet>', async () => {
    const id = await creature();
    const p = (await creaturePanel(pool, id))!;
    expect(p.arcscanUrl).toBe(`${DEFAULT_ARCSCAN_BASE}/address/${W}`);
    const custom = (await creaturePanel(pool, id, { arcscanBase: 'https://x.test' }))!;
    expect(custom.arcscanUrl).toBe(`https://x.test/address/${W}`);
  });
});

describe('3.3 T3 — ledger history is ISOLATED per creature (INV-1 in the view)', () => {
  it('A’s panel shows exactly A’s entries, none of B’s', async () => {
    const a = await creature('0xA000000000000000000000000000000000000001');
    const b = await creature('0xB000000000000000000000000000000000000002');
    await postCredit(pool, { creatureId: a, kind: 'feed', amount: 100n });
    await postCredit(pool, { creatureId: b, kind: 'feed', amount: 999n });
    await postCredit(pool, { creatureId: a, kind: 'income', amount: 50n, counterparty: '0xPayer' });
    const p = (await creaturePanel(pool, a))!;
    expect(p.entries).toHaveLength(2);
    expect(p.entries.map((e) => e.amountAtomic)).toEqual(['100', '50']); // ordered, only A's
    expect(p.entries.some((e) => e.amountAtomic === '999')).toBe(false); // B never leaks in
  });
});

describe('3.3 T4 — reconciled ✓ is READ from 3.4, never invented here', () => {
  const rec = (status: 'reconciled' | 'discrepancy'): Reconciliation => ({
    creatureId: 'x',
    ledgerSettled: 100n,
    onchainAvailable: status === 'reconciled' ? 100n : 55n,
    status,
    settleIds: ['s-1'],
  });

  it('✓ only when 3.4 says reconciled; an injected discrepancy turns it OFF; absent = null', async () => {
    const id = await creature();
    expect((await creaturePanel(pool, id, { reconciliation: rec('reconciled') }))!.reconciled).toBe(true);
    expect((await creaturePanel(pool, id, { reconciliation: rec('discrepancy') }))!.reconciled).toBe(false);
    expect((await creaturePanel(pool, id))!.reconciled).toBeNull(); // not yet run — no fabricated ✓
  });
});

describe('3.3 T5/T6 — the stats bar: base numbers + the anti-wash headline that BITES', () => {
  it('counts creatures by state and only SETTLED value as moved', async () => {
    const a = await creature('0xA000000000000000000000000000000000000001');
    await creature('0xB000000000000000000000000000000000000002');
    await postCredit(pool, { creatureId: a, kind: 'feed', amount: 1000n });
    await authorizeBurn(pool, { creatureId: a, kind: 'burn_passive', amount: 400n, nonce: 'p1' }); // pending
    const dying = await creature('0xC000000000000000000000000000000000000003');
    await transitionCreature(pool, { creatureId: dying, runway: 0, grace: 10, now: 1000 });
    await transitionCreature(pool, { creatureId: dying, runway: 0, grace: 10, now: 1011 }); // real death
    const s = await worldStats(pool, new Set());
    expect(s.creatures).toBe(3);
    expect(s.alive).toBe(2);
    expect(s.dead).toBe(1);
    expect(s.usdcMovedAtomic).toBe('1000'); // pending burn NOT moved (task 5 bite)
  });

  it('BITES HARD: 3 organic + 5 treasury-funded (one MISLABELED agent) -> headline 3, seeded 5', async () => {
    const c = await creature();
    const organic = ['0xEa01', '0xEa02', '0xEa03'];
    const seeded = ['0xSd01', '0xSd02', '0xSd03', '0xSd04', '0xSd05'];
    for (const payer of [...organic, ...seeded]) {
      await postCredit(pool, { creatureId: c, kind: 'income', amount: 10n, counterparty: payer });
    }
    await setBuyerClass(pool, '0xSd03', 'agent'); // the lie: a treasury-funded wallet labeled agent
    const funded = new Set(seeded.map((s) => s.toLowerCase()));
    const s = await worldStats(pool, funded);
    expect(s.organicPayers).toBe(3); // NOT 8, NOT 4 — provenance, never the label
    expect(s.treasuryFundedPayers).toBe(5); // reported separately, never inflating the headline
  });

  it('property: no treasury-funded wallet ever reaches the organic headline, whatever its label', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 4 }),
        fc.integer({ min: 0, max: 4 }),
        fc.constantFrom('agent', 'human', 'seed'),
        async (nOrganic, nSeeded, label) => {
          await resetDb(pool);
          const c = await creature();
          for (let i = 0; i < nOrganic; i++)
            await postCredit(pool, { creatureId: c, kind: 'income', amount: 1n, counterparty: `0xEa${i}` });
          const funded = new Set<string>();
          for (let i = 0; i < nSeeded; i++) {
            const w = `0xSd${i}`;
            funded.add(w.toLowerCase());
            await postCredit(pool, { creatureId: c, kind: 'income', amount: 1n, counterparty: w });
            await setBuyerClass(pool, w, label as 'agent' | 'human' | 'seed');
          }
          const s = await worldStats(pool, funded);
          expect(s.organicPayers).toBe(nOrganic);
          expect(s.treasuryFundedPayers).toBe(nSeeded);
        },
      ),
      { numRuns: 8 },
    );
  });
});

describe('3.3 T7 — purity: the panel is a read-model with NO write path (BITES)', () => {
  it('static: panel.ts only imports readers (balances/metric) and TYPES — never the ledger writers or rail', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'panel.ts'), 'utf8');
    const valueImports = src
      .split('\n')
      .filter((l) => /^\s*import\b/.test(l) && !/^\s*import\s+type\b/.test(l))
      .map((l) => /from\s+['"]([^'"]+)['"]/.exec(l)?.[1] ?? '');
    expect(valueImports).not.toContain('./ledger.js'); // the write API is unreachable from here
    expect(src).not.toMatch(/from\s+['"]\.\/rail(\.js)?['"]/);
  });

  it('dynamic: rendering panel + stats through a write-detecting pool performs 0 writes', async () => {
    const id = await creature();
    await postCredit(pool, { creatureId: id, kind: 'feed', amount: 100n });
    let writes = 0;
    const guarded = new Proxy(pool, {
      get(t, prop, r): unknown {
        if (prop === 'query') {
          return (text: unknown, ...rest: unknown[]): unknown => {
            const sql = String(typeof text === 'string' ? text : ((text as { text?: string })?.text ?? ''));
            if (/^\s*(insert|update|delete|truncate|alter|create|drop)\b/i.test(sql)) {
              writes++;
              throw new Error('write reached the read-model');
            }
            return (t.query as (...a: unknown[]) => unknown)(text, ...rest);
          };
        }
        return Reflect.get(t, prop, r);
      },
    }) as pg.Pool;
    for (let i = 0; i < 10; i++) {
      await creaturePanel(guarded, id);
      await worldStats(guarded, new Set(['0xseed']));
    }
    expect(writes).toBe(0);
    // and the guard itself bites: a write through it throws
    await expect(postCredit(guarded, { creatureId: id, kind: 'feed', amount: 1n })).rejects.toThrow(/read-model/);
    expect(writes).toBe(1);
  });
});

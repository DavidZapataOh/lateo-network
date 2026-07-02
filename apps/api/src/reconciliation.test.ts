import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { makePool } from './db.js';
import {
  migrate,
  resetDb,
  createCreature,
  postCredit,
  authorizeBurn,
  settleAuthorization,
} from './ledger.js';
import { reconcileCreature } from './reconciliation.js';

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

async function earnerWithSettledState(): Promise<string> {
  const id = await createCreature(pool, { walletAddress: '0xEARN', serviceType: 'url-to-json' });
  // earned income, settled with a settleId (the thread to the chain)
  await postCredit(pool, { creatureId: id, kind: 'income', amount: 1000n, settleId: 'settle-income-1' });
  // a burn authorized then settled with its own settleId
  const a = await authorizeBurn(pool, { creatureId: id, kind: 'burn_active', amount: 300n, nonce: 'rk1' });
  await settleAuthorization(pool, a.id!, 'settle-burn-1');
  return id; // ledger settled net = 700
}

describe('1.3 reconciliation — settleId ties the ledger to the chain (ADR-0012 / INV-3)', () => {
  it('reconciled when on-chain available matches the ledger settled net', async () => {
    const id = await earnerWithSettledState();
    const r = await reconcileCreature(pool, id, 700n);
    expect(r.ledgerSettled).toBe(700n);
    expect(r.status).toBe('reconciled');
    expect(r.settleIds).toEqual(['settle-income-1', 'settle-burn-1']); // the threads
  });

  // BITES: a divergent on-chain value must raise a discrepancy, not pass silently.
  it('discrepancy when on-chain diverges from the ledger', async () => {
    const id = await earnerWithSettledState();
    const r = await reconcileCreature(pool, id, 500n); // chain says 500, ledger says 700
    expect(r.status).toBe('discrepancy');
  });

  // BITES: a settled ledger entry with NO on-chain backing (missing) is a discrepancy (INV-3).
  it('discrepancy when the settled value is missing on-chain', async () => {
    const id = await earnerWithSettledState();
    const r = await reconcileCreature(pool, id, 0n);
    expect(r.status).toBe('discrepancy');
  });
});

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fc from 'fast-check';
import pg from 'pg';
import { makePool } from './db.js';
import { migrate, resetDb, createCreature, postCredit, setBuyerClass } from './ledger.js';
import { tractionMetric } from './metric.js';

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

const CREATURE_WALLET = '0xCreature0000000000000000000000000000C0DE';
async function creature(): Promise<string> {
  return createCreature(pool, { walletAddress: CREATURE_WALLET, serviceType: 'url-to-json' });
}
async function income(cid: string, payer: string): Promise<void> {
  await postCredit(pool, { creatureId: cid, kind: 'income', amount: 100n, counterparty: payer });
}

describe('2.5 T4/T5/T6 — traction metric by ON-CHAIN PROVENANCE, never the label', () => {
  it('an external payer (not self-deal, not funded-by-T) counts', async () => {
    const cid = await creature();
    await income(cid, '0xAgentAAAA');
    expect((await tractionMetric(pool, new Set())).externalPayers).toBe(1);
  });

  it('self-deal (payer == creature wallet) is excluded (on-chain)', async () => {
    const cid = await creature();
    await income(cid, CREATURE_WALLET);
    const m = await tractionMetric(pool, new Set());
    expect(m.externalPayers).toBe(0);
    expect(m.selfDealExcluded).toBe(1);
  });

  it('a payer funded by the treasury is excluded by PROVENANCE', async () => {
    const cid = await creature();
    await income(cid, '0xSeed1111');
    const m = await tractionMetric(pool, new Set(['0xseed1111']));
    expect(m.externalPayers).toBe(0);
    expect(m.treasuryFundedExcluded).toBe(1);
  });

  it('BITES: a treasury-funded wallet MISLABELED class=agent is STILL excluded (provenance > label)', async () => {
    const cid = await creature();
    await income(cid, '0xSeed1111');
    await setBuyerClass(pool, '0xSeed1111', 'agent'); // lie in the DB label
    const funded = new Set(['0xseed1111']);
    expect((await tractionMetric(pool, funded)).externalPayers).toBe(0); // provenance wins

    // reclassifying the label does NOT change the number (the metric never reads class)
    await setBuyerClass(pool, '0xSeed1111', 'seed');
    expect((await tractionMetric(pool, funded)).externalPayers).toBe(0);
  });

  it('what DOES change the number is on-chain provenance, not the label', async () => {
    const cid = await creature();
    await income(cid, '0xWallet2222');
    await setBuyerClass(pool, '0xWallet2222', 'seed'); // labeled seed...
    expect((await tractionMetric(pool, new Set())).externalPayers).toBe(1); // ...but not funded-by-T -> external
    expect((await tractionMetric(pool, new Set(['0xwallet2222']))).externalPayers).toBe(0); // fund it from T -> excluded
  });

  it('property: a payer in the funded-by-T set NEVER counts as external, for any label', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('agent', 'human', 'seed'),
        async (label) => {
          await resetDb(pool);
          const cid = await creature();
          await income(cid, '0xSeedZZZZ');
          await setBuyerClass(pool, '0xSeedZZZZ', label as 'agent' | 'human' | 'seed');
          expect((await tractionMetric(pool, new Set(['0xseedzzzz']))).externalPayers).toBe(0);
        },
      ),
      { numRuns: 6 },
    );
  });
});

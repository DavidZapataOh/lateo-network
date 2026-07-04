import type pg from 'pg';

export interface Traction {
  /** THE published number: distinct external agent-payers (not self-deal, not funded-by-treasury). */
  externalPayers: number;
  /** Excluded because payer == the creature's own wallet (self-deal, on-chain). */
  selfDealExcluded: number;
  /** Excluded because the payer's USDC traces to the treasury (provenance, on-chain). */
  treasuryFundedExcluded: number;
}

/**
 * The traction metric (ADR-0009 v2). "External" is decided by ON-CHAIN PROVENANCE: a payer counts
 * only if it is NOT the creature's own wallet (self-deal) AND its address is NOT in
 * `fundedByTreasury` (its USDC does not trace to the published treasury). The query JOINs the ledger
 * against the creatures' wallets and the on-chain funded-set — it NEVER references the `buyers.class`
 * label. Anyone who rebuilds `fundedByTreasury` from Arcscan gets the same number (trustless).
 */
export async function tractionMetric(pool: pg.Pool, fundedByTreasury: Set<string>): Promise<Traction> {
  const funded = [...fundedByTreasury].map((a) => a.toLowerCase());
  const r = await pool.query<{ external: string; self_deal: string; treasury: string }>(
    `with paid as (
       select lower(le.counterparty) as payer, lower(c.wallet_address) as creature_wallet
       from ledger_entries le
       join creatures c on c.id = le.creature_id
       where le.kind = 'income' and le.status = 'settled' and le.counterparty is not null
     )
     select
       count(distinct payer) filter (where payer <> creature_wallet and not (payer = any($1))) as external,
       count(distinct payer) filter (where payer = creature_wallet) as self_deal,
       count(distinct payer) filter (where payer <> creature_wallet and payer = any($1)) as treasury
     from paid`,
    [funded],
  );
  const row = r.rows[0]!;
  return {
    externalPayers: Number(row.external),
    selfDealExcluded: Number(row.self_deal),
    treasuryFundedExcluded: Number(row.treasury),
  };
}

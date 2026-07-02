import type pg from 'pg';
import { settle, type SignedAuthorization } from './rail.js';
import { readLifeState, transitionCreature, type LifeState } from './lifecycle.js';
import { settleAuthorization, voidAuthorization, postCredit } from './ledger.js';
import type { Atomic } from './money.js';

export interface DeliverResult {
  outcome: 'settled' | 'voided';
  settleId?: string;
}

/**
 * The value-touching heart of ADR-0006: at DELIVERY, decide by the creature's state in that instant.
 * - alive  -> SETTLE (capture): the rail captures the buyer's authorization; ledger pending->settled.
 * - non-alive (agonizing/dead) -> VOID (no-settle): the rail is NEVER settled, so the buyer keeps its
 *   money (Δ0); ledger pending->void. A voided authorization can never later appear settled (INV-4).
 */
export async function deliverOrVoid(
  pool: pg.Pool,
  args: { creatureId: string; entryId: number; auth: SignedAuthorization },
): Promise<DeliverResult> {
  const { state } = await readLifeState(pool, args.creatureId);
  if (state === 'alive') {
    const s = await settle(args.auth); // rail capture
    if (!s.success) throw new Error('settle failed: ' + (s.errorReason ?? 'unknown'));
    await settleAuthorization(pool, args.entryId, s.transaction); // ledger pending->settled
    return { outcome: 'settled', settleId: s.transaction };
  }
  // non-alive: do NOT settle the rail (buyer keeps its money) + record the void
  await voidAuthorization(pool, args.entryId);
  return { outcome: 'voided' };
}

export interface FeedResult {
  fed: boolean;
  state: LifeState;
}

/**
 * Feeding = an unconditional capture that can REVIVE a creature — but only during agony (ADR-0004/0006):
 * - dead -> REJECTED: no capture (the rail is never settled), no revive. Death is permanent.
 * - alive/agonizing -> capture the feed (real settle) + record it settled, then re-evaluate the state.
 *   agonizing + runway>0 -> alive (revive); alive stays alive. `runway` is injected here (the burn-rate
 *   clock is 2.2); after a feed it is naturally positive.
 */
export async function feedCreature(
  pool: pg.Pool,
  args: { creatureId: string; auth: SignedAuthorization; amount: Atomic; runway: number; grace: number; now: number },
): Promise<FeedResult> {
  const { state } = await readLifeState(pool, args.creatureId);
  if (state === 'dead') return { fed: false, state: 'dead' }; // permanent death: no feed, no capture

  const s = await settle(args.auth); // real unconditional capture
  if (!s.success) throw new Error('feed settle failed: ' + (s.errorReason ?? 'unknown'));
  await postCredit(pool, {
    creatureId: args.creatureId,
    kind: 'feed',
    amount: args.amount,
    settleId: s.transaction,
  });
  const next = await transitionCreature(pool, {
    creatureId: args.creatureId,
    runway: args.runway,
    grace: args.grace,
    now: args.now,
  });
  return { fed: true, state: next.state };
}

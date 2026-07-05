import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import type { Atomic } from './money.js';
import type { PassiveBurnRail } from './metabolism.js';
import { authorizeBurn, settleAuthorization, voidAuthorization } from './ledger.js';
import { signAuthorization as realSign, settle as realSettle } from './rail.js';

type Circle = Parameters<typeof realSign>[0];

/**
 * The REAL passive-burn rail (slice 2.2, task 3): materializes accumulated passive burn as ONE
 * authorization creature -> Horno via 1.1 + 1.3:
 *   authorizeBurn (pending, honest-balance/INV-2 check) -> creature signs EIP-3009 (payer=creature,
 *   payTo=Horno) -> settle (capture) -> ledger pending->settled, settleId recorded.
 * This is the ONLY place passive burn touches the rail; the pulse never signs (SPIKE-4/ADR-0003).
 */
export function createPassiveBurnRail(deps: {
  circle: Circle;
  pool: pg.Pool;
  creatureId: string;
  walletId: string;
  address: `0x${string}`;
  horno: string;
  // Injectable for tests; default to the real rail. Lets us prove void-on-failure without a network.
  signAuthorization?: typeof realSign;
  settle?: typeof realSettle;
}): PassiveBurnRail {
  const sign = deps.signAuthorization ?? realSign;
  const settle = deps.settle ?? realSettle;
  return {
    async materialize(amount: Atomic): Promise<{ settleId: string }> {
      const auth = await authorizeBurn(deps.pool, {
        creatureId: deps.creatureId,
        kind: 'burn_passive',
        amount,
        nonce: randomUUID(),
      });
      if (!auth.ok) throw new Error('passive burn authorize failed: ' + (auth.reason ?? 'unknown'));
      // ATOMIC: from here the auth is `pending`. Either it fully settles, or we VOID it — never a
      // dangling pending (a Circle timeout mid-burn would otherwise pile up phantom pending that
      // falsely depresses live/runway). INV-4: the auth is settled xor voided, exactly once.
      try {
        const signed = await sign(deps.circle, {
          walletId: deps.walletId,
          address: deps.address,
          payTo: deps.horno,
          amount,
        });
        const s = await settle(signed);
        if (!s.success) throw new Error('passive burn settle failed: ' + (s.errorReason ?? 'unknown'));
        await settleAuthorization(deps.pool, auth.id!, s.transaction);
        return { settleId: s.transaction };
      } catch (e) {
        await voidAuthorization(deps.pool, auth.id!).catch(() => undefined); // best-effort unwind
        throw e; // the accrued burn stays in the metabolism and retries next cadence (nothing lost)
      }
    },
  };
}

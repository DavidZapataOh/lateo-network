import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import type { Atomic } from './money.js';
import type { PassiveBurnRail } from './metabolism.js';
import { authorizeBurn, settleAuthorization } from './ledger.js';
import { signAuthorization, settle } from './rail.js';

type Circle = Parameters<typeof signAuthorization>[0];

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
}): PassiveBurnRail {
  return {
    async materialize(amount: Atomic): Promise<{ settleId: string }> {
      const auth = await authorizeBurn(deps.pool, {
        creatureId: deps.creatureId,
        kind: 'burn_passive',
        amount,
        nonce: randomUUID(),
      });
      if (!auth.ok) throw new Error('passive burn authorize failed: ' + (auth.reason ?? 'unknown'));
      const signed = await signAuthorization(deps.circle, {
        walletId: deps.walletId,
        address: deps.address,
        payTo: deps.horno,
        amount,
      });
      const s = await settle(signed);
      if (!s.success) throw new Error('passive burn settle failed: ' + (s.errorReason ?? 'unknown'));
      await settleAuthorization(deps.pool, auth.id!, s.transaction);
      return { settleId: s.transaction };
    },
  };
}

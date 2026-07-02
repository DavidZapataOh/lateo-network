import type pg from 'pg';
import { StandardMerkleTree } from '@openzeppelin/merkle-tree';
import type { Atomic } from './money.js';

/**
 * The SUBSTANCE of the attestation contract (ADR-0015): a third-party-verifiable commitment.
 *
 * A public leaf per creature: [creatureId, settled, pending]. The epoch commitment is the
 * OpenZeppelin StandardMerkleTree root over these leaves. Because the leaves are PUBLIC and the
 * tree format is a documented standard, ANYONE can rebuild the root from the published leaves and
 * compare it to `rootOf(epoch)` on-chain — verifiability WITHOUT trusting our backend. This is the
 * difference between real attestation and an opaque hash only we could recompute (which ADR-0015
 * forbids by name).
 */
export type Leaf = [string, Atomic, Atomic];

/** OZ leaf encoding for [creatureId, settled, pending]. Part of the public verification spec. */
export const LEAF_ENCODING = ['string', 'uint256', 'uint256'] as const;

const SNAPSHOT_SQL = `
  select c.id as creature_id,
    coalesce(sum(e.amount_atomic) filter (where e.status='settled' and e.kind in ('income','feed')),0)
    - coalesce(sum(e.amount_atomic) filter (where e.status='settled' and e.kind in ('burn_passive','burn_active')),0) as settled,
    coalesce(sum(e.amount_atomic) filter (where e.status='pending' and e.kind in ('burn_passive','burn_active')),0) as pending
  from creatures c
  left join ledger_entries e on e.creature_id = c.id
  group by c.id`;

/** The public per-creature snapshot — the exact data published so anyone can rebuild the root. */
export async function snapshotLeaves(pool: pg.Pool): Promise<Leaf[]> {
  const r = await pool.query<{ creature_id: string; settled: string; pending: string }>(SNAPSHOT_SQL);
  return r.rows.map((row) => [row.creature_id, BigInt(row.settled), BigInt(row.pending)]);
}

/** Build the StandardMerkleTree from public leaves. Order-independent + reproducible by anyone. */
export function treeOfLeaves(leaves: Leaf[]): StandardMerkleTree<Leaf> {
  return StandardMerkleTree.of(leaves, [...LEAF_ENCODING]);
}

/** The epoch commitment root — this is what gets published on-chain via `appendEpoch`. */
export function rootOfLeaves(leaves: Leaf[]): string {
  return treeOfLeaves(leaves).root;
}

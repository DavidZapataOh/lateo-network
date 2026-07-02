import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { StandardMerkleTree } from '@openzeppelin/merkle-tree';
import pg from 'pg';
import { makePool } from './db.js';
import { migrate, resetDb, createCreature, postCredit, authorizeBurn } from './ledger.js';
import { snapshotLeaves, rootOfLeaves, treeOfLeaves, LEAF_ENCODING, type Leaf } from './attestation.js';

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

// A small world with known settled/pending per creature.
async function seedWorld(): Promise<void> {
  const a = await createCreature(pool, { walletAddress: '0xA', serviceType: 'url-to-json' });
  await postCredit(pool, { creatureId: a, kind: 'income', amount: 1000n });
  await authorizeBurn(pool, { creatureId: a, kind: 'burn_active', amount: 300n, nonce: 'a1' }); // pending 300
  const b = await createCreature(pool, { walletAddress: '0xB', serviceType: 'summary-with-citations' });
  await postCredit(pool, { creatureId: b, kind: 'feed', amount: 500n });
  const c = await createCreature(pool, { walletAddress: '0xC', serviceType: 'url-to-json' });
  await postCredit(pool, { creatureId: c, kind: 'income', amount: 2000n });
  await authorizeBurn(pool, { creatureId: c, kind: 'burn_passive', amount: 1000n, nonce: 'c1' });
}

describe('1.2 attestation — third-party-verifiable commitment (ADR-0015, the substance)', () => {
  it('deterministic: same snapshot → same root', async () => {
    await seedWorld();
    const r1 = rootOfLeaves(await snapshotLeaves(pool));
    const r2 = rootOfLeaves(await snapshotLeaves(pool));
    expect(r1).toBe(r2);
    expect(r1).toMatch(/^0x[0-9a-f]{64}$/);
  });

  // THE guard (ADR-0015): a third party with ONLY the published leaves (no DB) rebuilds the same root.
  it('THIRD-PARTY: rebuild the root from ONLY the published leaves (no DB access) → matches on-chain root', async () => {
    await seedWorld();
    const onchainRoot = rootOfLeaves(await snapshotLeaves(pool)); // what we commit via appendEpoch

    // Simulate publishing leaves as JSON (bigint→string) and a third party parsing them back:
    const published = await snapshotLeaves(pool);
    const wire = JSON.stringify(published, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
    const parsed: Leaf[] = (JSON.parse(wire) as [string, string, string][]).map((l) => [
      l[0],
      BigInt(l[1]),
      BigInt(l[2]),
    ]);
    const rebuiltByThirdParty = rootOfLeaves(parsed);

    expect(rebuiltByThirdParty).toBe(onchainRoot); // verifiable WITHOUT trusting our backend
  });

  it('order-independent: shuffling the leaves → same root (no DB row-order dependence)', async () => {
    await seedWorld();
    const leaves = await snapshotLeaves(pool);
    expect(rootOfLeaves([...leaves].reverse())).toBe(rootOfLeaves(leaves));
  });

  // BITES: if the commitment were opaque/meaningless this would not hold — tampering must move the root.
  it('tamper-evident: changing one creature’s settled changes the root', async () => {
    await seedWorld();
    const leaves = await snapshotLeaves(pool);
    const root = rootOfLeaves(leaves);
    const tampered: Leaf[] = leaves.map((l, i) => (i === 0 ? [l[0], l[1] + 1n, l[2]] : l));
    expect(rootOfLeaves(tampered)).not.toBe(root);
  });

  it('inclusion proof: a third party proves a creature is in the committed set (and a wrong leaf fails)', async () => {
    await seedWorld();
    const tree = treeOfLeaves(await snapshotLeaves(pool));
    let checked = 0;
    for (const [i, leaf] of tree.entries()) {
      const proof = tree.getProof(i);
      expect(StandardMerkleTree.verify(tree.root, [...LEAF_ENCODING], leaf, proof)).toBe(true);
      const wrong: Leaf = [leaf[0], (leaf[1] as bigint) + 1n, leaf[2] as bigint];
      expect(StandardMerkleTree.verify(tree.root, [...LEAF_ENCODING], wrong, proof)).toBe(false);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  // The commitment is MEANINGFUL: a third party can check INV-2 (honest balance) from the public leaves.
  it('meaningful: settled ≥ pending is verifiable per creature from the public leaves (INV-2)', async () => {
    await seedWorld();
    for (const [, settled, pending] of await snapshotLeaves(pool)) {
      expect(settled - pending).toBeGreaterThanOrEqual(0n);
    }
  });
});

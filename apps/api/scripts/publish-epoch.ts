// Ops script: build the epoch commitment root from a ledger snapshot (the root that
// LateoAttestation.appendEpoch publishes on-chain). Prints ROOT + the public LEAVES so a third
// party can rebuild and verify. Requires PG env (the ledger) — throwaway seed data for the demo.
import { makePool } from '../src/db.js';
import { migrate, resetDb, createCreature, postCredit, authorizeBurn } from '../src/ledger.js';
import { snapshotLeaves, rootOfLeaves } from '../src/attestation.js';

const pool = makePool();
await migrate(pool);
await resetDb(pool);

const a = await createCreature(pool, { walletAddress: '0xA', serviceType: 'url-to-json' });
await postCredit(pool, { creatureId: a, kind: 'income', amount: 1000n });
await authorizeBurn(pool, { creatureId: a, kind: 'burn_active', amount: 300n, nonce: 'epoch-a1' });
const b = await createCreature(pool, { walletAddress: '0xB', serviceType: 'summary-with-citations' });
await postCredit(pool, { creatureId: b, kind: 'feed', amount: 500n });

const leaves = await snapshotLeaves(pool);
const root = rootOfLeaves(leaves);
console.log('ROOT ' + root);
console.log('LEAVES ' + JSON.stringify(leaves, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
await pool.end();

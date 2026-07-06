// On-cue death for the LIVE continuous take. Drives a REAL bright creature through the REAL state
// machine (alive -> agonizing -> dead, grace expired under the machine's own clock) so the World
// page plays its 4-beat death + world-dim EXACTLY when you fire this. Mirrors death-capture.ts, but
// for a live take you trigger it by hand at the right narration beat. Nothing is hand-painted: the
// rules decide from runway<=0 + grace (same path the passive world uses).
//   Rehearse the target (no transition):  npx tsx apps/api/scripts/death-cue.ts --pick
//   Kill on cue (auto brightest alive):   npx tsx apps/api/scripts/death-cue.ts
//   Kill a specific one / slower agony:    npx tsx apps/api/scripts/death-cue.ts <creatureId> --agony-ms=5000
import { makePool } from '../src/db.js';
import { transitionCreature } from '../src/lifecycle.js';

const API = process.env.LATEO_API ?? 'http://127.0.0.1:3900';
const GRACE = Number(process.env.GRACE_SECONDS ?? 30);
const argv = process.argv.slice(2);
const pickOnly = argv.includes('--pick');
const agonyMs = Number(argv.find((a) => a.startsWith('--agony-ms='))?.split('=')[1] ?? 4000);
const explicitId = argv.find((a) => /^[0-9a-f-]{36}$/i.test(a));

interface Wire { id: string; state: string }
interface Panel { balances: { liveAtomic: string }; walletAddress: string }

/** Pick the brightest ALIVE creature (highest live balance) — the death must hit a bright one. */
async function brightestAlive(): Promise<string> {
  const creatures = (await (await fetch(`${API}/creatures`)).json()) as Wire[];
  const alive = creatures.filter((c) => c.state === 'alive');
  if (alive.length === 0) throw new Error('no ALIVE creatures to kill — seed the world first');
  let best: { id: string; live: bigint; wallet: string } | null = null;
  for (const c of alive) {
    const p = (await (await fetch(`${API}/c/${c.id}/panel`)).json()) as Panel;
    const live = BigInt(p.balances.liveAtomic);
    if (best === null || live > best.live) best = { id: c.id, live, wallet: p.walletAddress };
  }
  console.log(
    `brightest alive: ${best!.id.slice(0, 8)}  live=${(Number(best!.live) / 1e6).toFixed(4)} USDC  wallet=${best!.wallet.slice(0, 12)}…`,
  );
  return best!.id;
}

const id = explicitId ?? (await brightestAlive());
if (pickOnly) {
  console.log('--pick: target identified, no transition fired. Fire the real one without --pick.');
  process.exit(0);
}

const pool = makePool();
const now = Math.floor(Date.now() / 1000);
console.log(`[death-cue] ${id.slice(0, 8)} -> AGONY (flicker rojo)`);
await transitionCreature(pool, { creatureId: id, runway: 0, grace: GRACE, now });
await new Promise((r) => setTimeout(r, agonyMs));
console.log(`[death-cue] ${id.slice(0, 8)} -> DEAD (grace expired — el cuerpo cae a ceniza)`);
await transitionCreature(pool, { creatureId: id, runway: 0, grace: GRACE, now: now + GRACE + 1 });
await pool.end();
console.log('[death-cue] done — mira el Mundo reproducir la muerte.');

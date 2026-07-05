// DE-RISK: 5 CONCURRENT spawns against the real platform (real Circle wallets, real treasury
// seeds) — the cold-link stress test BEFORE 5 strangers hit it at once. Reports: response codes &
// latency, wallet uniqueness, rate-limit behavior, and per-creature seed credit timing (poll).
//   npx tsx scripts/derisk-spawn5.ts [base]
const BASE = process.argv[2] ?? 'http://127.0.0.1:3900';
const N = 5;

interface SpawnRes {
  id?: string;
  walletAddress?: string;
  error?: string;
}

const t0 = Date.now();
console.log(`[derisk] firing ${N} CONCURRENT spawns at ${BASE} ...`);
const results = await Promise.all(
  Array.from({ length: N }, async (_, i) => {
    const started = Date.now();
    const res = await fetch(`${BASE}/spawn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ serviceType: i % 2 ? 'summary-with-citations' : 'url-to-json' }),
    });
    const body = (await res.json()) as SpawnRes;
    return { i, status: res.status, ms: Date.now() - started, ...body };
  }),
);

for (const r of results) {
  console.log(`  #${r.i}: ${r.status} in ${r.ms}ms  id=${r.id?.slice(0, 8) ?? '-'}  wallet=${r.walletAddress ?? r.error}`);
}
const ok = results.filter((r) => r.status === 201);
const wallets = new Set(ok.map((r) => r.walletAddress));
console.log(`[derisk] 201s: ${ok.length}/${N} · unique wallets: ${wallets.size}/${ok.length}`);
if (ok.length !== N) console.log('[derisk] WARNING: not all spawns passed — inspect statuses above');
if (wallets.size !== ok.length) console.log('[derisk] FATAL: wallet collision!');

// follow every seed to credit (the batch takes minutes; poll each creature's panel)
console.log('[derisk] following the 5 seeds to on-chain credit (this takes minutes)...');
const pending = new Map(ok.map((r) => [r.id!, r.walletAddress!]));
const creditedAt = new Map<string, number>();
const DEADLINE = 20 * 60 * 1000;
while (pending.size && Date.now() - t0 < DEADLINE) {
  await new Promise((r) => setTimeout(r, 10_000));
  for (const [id] of [...pending]) {
    const p = (await (await fetch(`${BASE}/c/${id}/panel`)).json()) as { balances?: { settledAtomic: string } };
    if (p.balances && p.balances.settledAtomic !== '0') {
      creditedAt.set(id, Date.now() - t0);
      pending.delete(id);
      console.log(`  ✓ ${id.slice(0, 8)} credited ${p.balances.settledAtomic} at t+${Math.round(creditedAt.get(id)! / 1000)}s`);
    }
  }
}
console.log('\n==================== DERISK VERDICT ====================');
console.log(`spawns 201: ${ok.length}/${N} · unique wallets: ${wallets.size}`);
console.log(`seeds credited: ${creditedAt.size}/${ok.length}${pending.size ? ` · STILL DARK: ${[...pending.keys()].map((s) => s.slice(0, 8)).join(', ')}` : ''}`);
const times = [...creditedAt.values()].map((v) => Math.round(v / 1000));
if (times.length) console.log(`credit times (s): ${times.join(', ')}`);
console.log('========================================================');
process.exit(pending.size === 0 && ok.length === N && wallets.size === N ? 0 : 1);

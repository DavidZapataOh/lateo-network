// The World page (ADR-0013): a pure read-model client. It opens the SSE stream, keeps the latest
// REAL snapshot (no synthetic data — every light is a creature row in the ledger), and paints it
// with renderWorld on a requestAnimationFrame loop. It never writes; EventSource auto-reconnects
// and the server re-sends a fresh snapshot on connect (stale-proof re-sync).
import { renderWorld, layout, DEFAULT_RENDER_CONFIG, type WorldCreature, type Ctx2D } from './render.js';
import { DEFAULT_LIGHT_CONFIG } from './stateToLight.js';
import { bootstrap, observe, type PhaseState } from './deathPhase.js';

/** The SSE wire shape (bigints as strings; Infinity runway serializes to null). */
interface WireCreature {
  id: string;
  state: 'alive' | 'agonizing' | 'dead';
  liveAtomic: string;
  runwaySeconds: number | null;
  lastActivityAt: number | null;
}

let snapshot: WorldCreature[] = [];
// Death phase tracking (3.2): first sight of a creature -> bootstrap (a past death is just a
// tombstone; the page never replays drama nobody watched); every later delta -> observe, so a death
// that happens IN FRONT of the viewer plays its 4-beat sequence anchored at the observed moment.
// Reduced-motion: no sequence — an instant, faithful landing on the same terminal phase.
const deaths = new Map<string, PhaseState>();
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function apply(e: MessageEvent): void {
  const rows = JSON.parse(e.data as string) as WireCreature[];
  const nowSec = performance.now() / 1000; // same clock the render loop queries phases with
  for (const r of rows) {
    const prev = deaths.get(r.id);
    if (prev === undefined || reducedMotion) deaths.set(r.id, bootstrap(r.state));
    else deaths.set(r.id, observe(prev, r.state, nowSec));
  }
  snapshot = rows.map((r) => ({
    id: r.id,
    state: r.state,
    runwaySeconds: r.runwaySeconds ?? Infinity, // JSON has no Infinity
    lastActivityAt: r.lastActivityAt,
  }));
}

// PERF BENCH MODE ONLY (?bench=N): synthetic creatures to measure the ~150 frame budget (3.1 T6).
// Never used for the demo — the demo world is ALWAYS the real read-model stream below.
const benchN = Number(new URLSearchParams(window.location.search).get('bench') ?? '0');
if (benchN > 0) {
  const states = ['alive', 'alive', 'alive', 'agonizing', 'dead'] as const;
  snapshot = Array.from({ length: benchN }, (_, i) => ({
    id: `bench-${i}`,
    state: states[i % states.length]!,
    runwaySeconds: (i * 37) % 900,
    lastActivityAt: i % 3 === 0 ? Date.now() / 1000 : null,
  }));
} else {
  const stream = new EventSource('/world/stream');
  stream.addEventListener('snapshot', apply);
  stream.addEventListener('delta', apply);
}

const canvas = document.getElementById('world') as HTMLCanvasElement;
// The real 2D context satisfies Ctx2D structurally except fillStyle's CanvasPattern arm (unused here).
const ctx = canvas.getContext('2d') as unknown as Ctx2D;

function fit(): void {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(window.innerWidth * dpr);
  canvas.height = Math.floor(window.innerHeight * dpr);
}
fit();
window.addEventListener('resize', fit);

// Presentation scale: creatures live minutes-to-hours, so "full bright" = 10 minutes of runway.
const cfg = {
  ...DEFAULT_RENDER_CONFIG,
  light: { ...DEFAULT_LIGHT_CONFIG, fullRunwaySeconds: 600 },
  baseRadius: 22,
  motionScale: reducedMotion ? 0 : 1, // cosmetic drift is motion; the palette/dim are not
};

function frame(): void {
  // ONE clock everywhere: phase observations (deaths) and the render both read performance.now(),
  // so a death's beats anchor exactly at the observed moment.
  const t = performance.now() / 1000;
  renderWorld(ctx, snapshot, { width: canvas.width, height: canvas.height }, t, cfg, deaths);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---- 3.3 chrome: anti-wash stats bar + creature detail panel (GET-only — a read-model never
// mutates value; the create/feed/buy actions live on the transactional API, ADR-0010/0013) -------
interface StatsDto {
  creatures: number;
  alive: number;
  agonizing: number;
  dead: number;
  usdcMovedAtomic: string;
  organicPayers: number;
  treasuryFundedPayers: number;
  selfDealExcluded: number;
}
interface PanelDto {
  id: string;
  serviceType: string;
  state: string;
  walletAddress: string;
  arcscanUrl: string;
  balances: { settledAtomic: string; pendingAtomic: string; liveAtomic: string };
  reconciled: boolean | null;
  entries: Array<{ kind: string; amountAtomic: string; counterparty: string | null; status: string; settleId: string | null; createdAt: string }>;
}

const usdc = (atomic: string): string => (Number(atomic) / 1_000_000).toFixed(6).replace(/0+$/, '').replace(/\.$/, '.0');
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const statsEl = document.getElementById('stats')!;
async function refreshStats(): Promise<void> {
  try {
    const s = (await (await fetch('/world/stats')).json()) as StatsDto;
    // the HEADLINE is organic-by-provenance (2.5): treasury-funded reported apart, never inflating it
    statsEl.innerHTML =
      `<span><b>${s.creatures}</b> creatures</span>` +
      `<span><b>${s.alive}</b> alive · <b>${s.agonizing}</b> agonizing · <b>${s.dead}</b> dead</span>` +
      `<span><b>${usdc(s.usdcMovedAtomic)}</b> USDC moved</span>` +
      `<span class="organic"><b>${s.organicPayers}</b> organic payers <span title="external by on-chain provenance: wallets whose USDC does not trace to the published treasury">(by provenance)</span></span>` +
      `<span><b>${s.treasuryFundedPayers}</b> treasury-funded (excluded)</span>`;
  } catch {
    /* stats hiccups never break the world */
  }
}
void refreshStats();
setInterval(() => void refreshStats(), 5000);

const panelEl = document.getElementById('panel')!;
function closePanel(): void {
  panelEl.classList.remove('open');
  if (window.location.hash) history.replaceState(null, '', ' ');
}
async function openPanel(id: string): Promise<void> {
  const res = await fetch(`/c/${id}/panel`);
  if (!res.ok) return;
  const p = (await res.json()) as PanelDto;
  const rec =
    p.reconciled === null
      ? '<span class="muted">not yet reconciled</span>'
      : p.reconciled
        ? '<span class="ok">reconciled ✓ (ledger = on-chain)</span>'
        : '<span class="warn">discrepancy ✗</span>';
  const entries = p.entries
    .slice(-30)
    .reverse()
    .map(
      (e) =>
        `<tr><td>${esc(e.kind)}</td><td>${usdc(e.amountAtomic)}</td><td>${esc(e.status)}</td>` +
        `<td class="muted">${e.settleId ? esc(e.settleId.slice(0, 8)) : ''}</td></tr>`,
    )
    .join('');
  const actions =
    p.state === 'dead'
      ? `<div class="muted" style="margin-top:10px">death is permanent — no actions remain</div>`
      : `<div>` +
        `<button class="action" data-action="feed" data-creature="${esc(p.id)}">feed 0.02 USDC</button>` +
        `<button class="action" data-action="buy" data-creature="${esc(p.id)}">buy service (x402)</button>` +
        `</div>`;
  panelEl.innerHTML =
    `<button class="close" aria-label="close">×</button>` +
    `<h2>creature ${esc(p.id.slice(0, 8))}</h2>` +
    `<div>${esc(p.serviceType)} · <b>${esc(p.state)}</b></div>` +
    `<div style="margin-top:10px">wallet (on-chain identity):<br><a href="${esc(p.arcscanUrl)}" target="_blank" rel="noreferrer">${esc(p.walletAddress)}</a></div>` +
    `<table>` +
    `<tr><td>settled <span class="ok">✓ on-chain</span></td><td><b>${usdc(p.balances.settledAtomic)}</b> USDC</td></tr>` +
    `<tr><td>pending <span class="muted">(next batch)</span></td><td>${usdc(p.balances.pendingAtomic)} USDC</td></tr>` +
    `<tr><td>live = settled − pending</td><td><b>${usdc(p.balances.liveAtomic)}</b> USDC</td></tr>` +
    `</table>` +
    `<div style="margin-top:8px">${rec}</div>` +
    actions +
    `<div style="margin-top:12px" class="muted">ledger (latest first)</div>` +
    `<table>${entries}</table>`;
  panelEl.classList.add('open');
  panelEl.querySelector('.close')!.addEventListener('click', closePanel);
}

// click a being -> its panel (hit-test against the same deterministic layout the render uses)
canvas.addEventListener('click', (ev) => {
  const dpr = window.devicePixelRatio || 1;
  const x = ev.clientX * dpr;
  const y = ev.clientY * dpr;
  const pts = layout(snapshot.map((c) => c.id), canvas.width, canvas.height);
  const hitR = cfg.baseRadius * 4;
  let best: { id: string; d: number } | null = null;
  snapshot.forEach((c, i) => {
    const d = Math.hypot(pts[i]!.x - x, pts[i]!.y - y);
    if (d < hitR && (best === null || d < best.d)) best = { id: c.id, d };
  });
  if (best !== null) {
    const chosen = best as { id: string; d: number };
    history.replaceState(null, '', `#c=${chosen.id}`);
    void openPanel(chosen.id);
  } else {
    closePanel();
  }
});

// deep link: /#c=<id> opens the panel directly (also how evidence captures target a creature)
const hashId = /^#c=(.+)$/.exec(window.location.hash)?.[1];
if (hashId) void openPanel(hashId);

// ---- the 3 ACTIONS (they hit the TRANSACTIONAL API — the read-model above never mutates) -------
const toastEl = document.getElementById('toast')!;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(html: string, ms = 12000): void {
  toastEl.innerHTML = html;
  toastEl.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.style.display = 'none'), ms);
}

// CREATE — the judge's flow: spawn your own creature; it is born dark with a REAL Circle wallet
// and lights up when its treasury seed lands on-chain (latency-resilient by design).
const spawnBtn = document.getElementById('spawn') as HTMLButtonElement;
spawnBtn.addEventListener('click', () => {
  void (async () => {
    spawnBtn.disabled = true;
    spawnBtn.textContent = '✦ provisioning wallet…';
    try {
      const res = await fetch('/spawn', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ serviceType: 'url-to-json' }),
      });
      const s = (await res.json()) as { id?: string; walletAddress?: string; arcscanUrl?: string; error?: string };
      if (!res.ok || !s.id) {
        toast(`spawn failed: ${esc(s.error ?? String(res.status))}`);
        return;
      }
      toast(
        `born: <b>creature ${esc(s.id.slice(0, 8))}</b> · real wallet ` +
          `<a href="${esc(s.arcscanUrl ?? '#')}" target="_blank" rel="noreferrer">${esc(s.walletAddress ?? '')}</a>` +
          `<br>seed settling on-chain — it lights up when the money lands`,
        20000,
      );
      history.replaceState(null, '', `#c=${s.id}`);
      void openPanel(s.id);
    } finally {
      spawnBtn.disabled = false;
      spawnBtn.textContent = '✦ spawn a creature';
    }
  })();
});

// FEED + BUY live inside the panel — wired via event delegation on data-action buttons.
panelEl.addEventListener('click', (ev) => {
  const btn = (ev.target as HTMLElement).closest('button.action') as HTMLButtonElement | null;
  if (!btn) return;
  const id = btn.dataset.creature!;
  if (btn.dataset.action === 'feed') {
    void (async () => {
      const res = await fetch(`/c/${id}/feed`, { method: 'POST' });
      const r = (await res.json()) as { accepted?: boolean; amountUsdc?: string; error?: string; note?: string };
      if (res.status === 410) toast(`the dead cannot be fed — death is permanent`);
      else if (r.accepted) toast(`feeding ${esc(r.amountUsdc ?? '')} USDC — credits when the chain confirms (revives if agonizing)`);
      else toast(`feed failed: ${esc(r.error ?? 'unknown')}`);
    })();
  }
  if (btn.dataset.action === 'buy') {
    void (async () => {
      // show the REAL x402 quote (this is the agents' door — the MCP buy tool pays it end to end)
      const res = await fetch(`/c/${id}`, { method: 'POST' });
      const q = (await res.json()) as { price?: string; nonce?: string; error?: string; state?: string };
      if (res.status === 402 && q.price) {
        toast(
          `x402 quote — price <b>${usdc(q.price)} USDC</b> · nonce <span class="muted">${esc(q.nonce ?? '')}</span>` +
            `<br>agents pay this via the LATEO MCP <b>buy</b> tool (x402 sign → verify → settle)`,
          16000,
        );
      } else {
        toast(`no quote: ${esc(q.error ?? String(res.status))} (${esc(q.state ?? '')})`);
      }
    })();
  }
});

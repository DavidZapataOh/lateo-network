// The LATEO creature body (design brief §4b): ONE pixel-art being that expresses every state via
// posture / eyes / crown-flame / palette — never different sprites per creature or state family.
// Pure DATA + functions (no canvas, no DOM): grids are index matrices, the palette is computed from
// vitality on the SAME blackbody ramp the world already uses. Skill rules honored: silhouette first,
// ≤10 indexed colors, 1px consistent outline, light from the heart (the creature IS its own light
// source — highlights bloom from the center-top where the flame lives, shadows pool at the base),
// hard edges, integer scaling only (the renderer's job).
//
// Index legend: 0 transparent · 1 outline · 2 body shadow (base) · 3 body mid · 4 body light
// (heart-lit) · 5 eye · 6 flame outer · 7 flame core
export type SpriteState = 'alive' | 'agonizing' | 'dead';

export interface RGB {
  r: number;
  g: number;
  b: number;
}

const W = 16;

// ---- BODY GRIDS (16 wide; the drop sits on the last row) -----------------------------------
// Alive: upright teardrop, eyes open, chest lit from the heart. Slight asymmetry = character.
const BODY_ALIVE = [
  '......1111......',
  '.....144431.....',
  '....14444431....',
  '...1444444431...',
  '...1443443431...', // brow line — eyes come next
  '..144453453431..', // eyes open (5), catching the heart light
  '..144453453431..',
  '..14443443341...', // little smile-shadow under the eyes
  '..14433333341...',
  '.1443333333341..',
  '.1433333333331..',
  '.1433333333231..',
  '.1233333332231..', // shadow pools at the base (light is above, never pillow)
  '..12233322321...',
  '...112222211....',
  '.....11111......',
];

// Agonizing: the same being, sunk 2px, eyes squinted to lines, body sagging wider at the base.
const BODY_AGONY = [
  '................',
  '................',
  '......1111......',
  '....11444411....',
  '...1443344331...',
  '..14455345531...', // eyes as tired half-lines
  '..14433333331...',
  '..14333333331...',
  '.1433333333231..',
  '.1433333332231..',
  '.1233333322311..',
  '.122333322231...',
  '.1222332222311..',
  '..122222222211..',
  '...1122222111...',
  '.....111111.....',
];

// Dead: collapsed into an ash mound — the ORGANIC tombstone. Eyes closed (soft lines), no flame.
const BODY_DEAD = [
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '......1111......',
  '....11222211....',
  '...1225225221...', // closed eyes: two quiet lines in the ash
  '..122222222221..',
  '.12222222222221.',
  '.12222222222221.',
  '.12222222222221.',
  '..111111111111..',
];

const GRIDS: Record<SpriteState, string[]> = {
  alive: BODY_ALIVE,
  agonizing: BODY_AGONY,
  dead: BODY_DEAD,
};

/** Parse a grid row-strings into a W×H index matrix (throws on malformed art — tests gate this). */
export function parseGrid(rows: string[]): number[][] {
  return rows.map((row, y) => {
    if (row.length !== W) throw new Error(`sprite row ${y} has length ${row.length}, want ${W}`);
    return [...row].map((ch) => {
      if (ch === '.') return 0;
      const v = ch.charCodeAt(0) - 48;
      if (v < 1 || v > 7) throw new Error(`sprite row ${y}: bad char '${ch}'`);
      return v;
    });
  });
}

export function bodyGrid(state: SpriteState): number[][] {
  return parseGrid(GRIDS[state]);
}

// ---- CROWN FLAME (the datum: runway made visible, Pikmin-leaf style) -------------------------
// Drawn ABOVE the body. Height scales with vitality; two frames alternate (the flame licks).
// Returns rows of {x0,x1,color} spans in sprite pixel coords, y counted UP from the body's top row.
export interface FlameSpan {
  y: number; // rows above the body top (1 = directly above)
  x0: number;
  x1: number;
  color: 6 | 7;
}

export function flameSpans(state: SpriteState, vitality: number, frame: 0 | 1): FlameSpan[] {
  if (state === 'dead') return []; // the fire is out — that IS the message
  const cx = 8;
  if (state === 'agonizing') {
    // a guttering spark, barely holding on (the renderer flickers its visibility)
    return frame === 0
      ? [{ y: 1, x0: cx - 1, x1: cx, color: 7 }]
      : [{ y: 1, x0: cx, x1: cx + 1, color: 6 }];
  }
  const h = Math.max(1, Math.round(1 + 4 * Math.min(1, Math.max(0, vitality)))); // 1..5 rows tall — the datum deserves presence
  const spans: FlameSpan[] = [];
  for (let i = 1; i <= h; i++) {
    const width = i <= Math.ceil(h / 2) ? 1 : 0; // taper toward the tip
    const sway = frame === 0 ? 0 : i > 1 ? 1 : 0; // the lick: upper flame leans a pixel
    spans.push({ y: i, x0: cx - width + sway, x1: cx + width + sway, color: i === h ? 6 : 7 });
  }
  return spans;
}

// ---- PALETTE (vitality-swapped on the world's blackbody ramp) ---------------------------------
const OUTLINE: RGB = { r: 20, g: 16, b: 14 };
const EYE: RGB = { r: 16, g: 12, b: 10 };
const ASH_SHADOW: RGB = { r: 38, g: 33, b: 30 };
const ASH_MID: RGB = { r: 58, g: 50, b: 45 };

const mix = (a: RGB, b: RGB, t: number): RGB => ({
  r: Math.round(a.r + (b.r - a.r) * t),
  g: Math.round(a.g + (b.g - a.g) * t),
  b: Math.round(a.b + (b.b - a.b) * t),
});

/**
 * The 8-color palette for a given state+vitality. `ember` is the world's blackbody color at this
 * creature's vitality (passed in so sprite.ts stays decoupled from stateToLight): the body is
 * charcoal that HEATS toward the ember tone as vitality rises; the flame burns the pure ramp.
 */
export function spritePalette(state: SpriteState, vitality: number, ember: RGB, emberHot: RGB): RGB[] {
  if (state === 'dead') {
    // cold ash: no heat anywhere, eyes closed in near-dark
    return [
      { r: 0, g: 0, b: 0 },
      OUTLINE,
      ASH_SHADOW,
      ASH_MID,
      ASH_MID,
      { r: 30, g: 26, b: 24 },
      { r: 0, g: 0, b: 0 },
      { r: 0, g: 0, b: 0 },
    ];
  }
  const heat = state === 'agonizing' ? 0.35 : 0.45 + 0.4 * Math.min(1, Math.max(0, vitality));
  const shadow = mix(ASH_SHADOW, ember, heat * 0.35); // base keeps its charcoal weight
  const midBody = mix(ASH_MID, ember, heat * 0.75);
  const light = mix(ASH_MID, ember, Math.min(1, heat * 1.15)); // heart-lit chest
  return [
    { r: 0, g: 0, b: 0 }, // 0 transparent (unused)
    OUTLINE, // 1
    shadow, // 2
    midBody, // 3
    light, // 4
    EYE, // 5
    ember, // 6 flame outer
    emberHot, // 7 flame core
  ];
}

/** Horizontal RLE spans of one grid (perf: one fillRect per run, not per pixel). */
export interface RunSpan {
  y: number;
  x0: number;
  x1: number;
  color: number;
}

export function toRuns(grid: number[][]): RunSpan[] {
  const runs: RunSpan[] = [];
  grid.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const c = row[x]!;
      if (c === 0) {
        x++;
        continue;
      }
      let x1 = x;
      while (x1 + 1 < row.length && row[x1 + 1] === c) x1++;
      runs.push({ y, x0: x, x1, color: c });
      x = x1 + 1;
    }
  });
  return runs;
}

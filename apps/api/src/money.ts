/**
 * Money in LATEO = USDC in **atomic units (6 decimals)**, ALWAYS `bigint`.
 * NEVER `number`/float (ADR-0002; hard project rule). Helpers take/emit decimal
 * strings; balance arithmetic is done in bigint.
 */
export type Atomic = bigint;

export const USDC_DECIMALS = 6;
const BASE = 10n ** BigInt(USDC_DECIMALS);

/**
 * USDC decimal string -> atomic (bigint), EXACT and float-free.
 * Rejects: non-string (prevents sneaking in a `number`), invalid format, or > 6 decimals.
 */
export function usdcToAtomic(s: string): Atomic {
  if (typeof s !== 'string') {
    throw new TypeError('money must be passed as a string, never as a number (avoids float)');
  }
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s.trim());
  if (!m) throw new RangeError(`invalid USDC amount: ${JSON.stringify(s)}`);
  const whole = m[1] ?? '0';
  const frac = m[2] ?? '';
  if (frac.length > USDC_DECIMALS) {
    throw new RangeError(`at most ${USDC_DECIMALS} decimals, got "${s}"`);
  }
  const padded = frac.padEnd(USDC_DECIMALS, '0');
  return BigInt(whole) * BASE + BigInt(padded === '' ? '0' : padded);
}

/** Atomic (bigint) -> USDC decimal string, exact. */
export function atomicToUsdc(a: Atomic): string {
  if (typeof a !== 'bigint') throw new TypeError('atomic must be a bigint');
  const neg = a < 0n;
  const abs = neg ? -a : a;
  const whole = abs / BASE;
  const frac = (abs % BASE).toString().padStart(USDC_DECIMALS, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

import { describe, it, expect } from 'vitest';
import { usdcToAtomic, atomicToUsdc, type Atomic } from './money.js';

describe('1.1 money — money is bigint, float FORBIDDEN', () => {
  it('converts USDC→atomic exactly', () => {
    expect(usdcToAtomic('0')).toBe(0n);
    expect(usdcToAtomic('1')).toBe(1_000_000n);
    expect(usdcToAtomic('0.0001')).toBe(100n);
    expect(usdcToAtomic('0.000001')).toBe(1n);
    expect(usdcToAtomic('12.5')).toBe(12_500_000n);
  });

  it('the result is ALWAYS a bigint', () => {
    expect(typeof usdcToAtomic('1')).toBe('bigint');
  });

  it('roundtrips atomic↔USDC', () => {
    for (const s of ['0', '1', '0.0001', '0.000001', '12.5', '9999999999.999999']) {
      expect(atomicToUsdc(usdcToAtomic(s))).toBe(s);
    }
  });

  it('rejects passing a number (prevents sneaking in a float)', () => {
    expect(() => usdcToAtomic(0.1 as unknown as string)).toThrow(TypeError);
  });

  it('rejects more than 6 decimals and invalid format', () => {
    expect(() => usdcToAtomic('0.0000001')).toThrow(RangeError); // 7 decimals
    expect(() => usdcToAtomic('abc')).toThrow(RangeError);
    expect(() => usdcToAtomic('1.2.3')).toThrow(RangeError);
  });

  // THE test that BITES a float/Number reimplementation:
  it('exact where float FAILS (0.1 ten times)', () => {
    // float: 0.1 summed 10 times does NOT equal 1.0 (demonstrates the problem)
    let f = 0;
    for (let i = 0; i < 10; i++) f += 0.1;
    expect(f).not.toBe(1); // 0.9999999999999999

    // bigint (ours): exact
    let a: Atomic = 0n;
    for (let i = 0; i < 10; i++) a += usdcToAtomic('0.1');
    expect(a).toBe(usdcToAtomic('1')); // 1_000_000n exactly
  });
});

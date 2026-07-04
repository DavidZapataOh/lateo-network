import { describe, it, expect } from 'vitest';
import { fundedByTreasury, type FundingEvent } from './provenance.js';

const T = '0xTREASURY';
const A = '0xAAAA';
const B = '0xBBBB';
const THIRD = '0xThirdParty';

describe('2.5 T3 — on-chain provenance deriver (funded-by-treasury, the base of truth)', () => {
  it('returns exactly the wallets funded (1 hop) by the treasury', () => {
    const events: FundingEvent[] = [
      { from: T, to: A }, // T seeded A
      { from: T, to: B }, // T seeded B
      { from: THIRD, to: '0xExternal' }, // a third party funded someone else
    ];
    const funded = fundedByTreasury([T], events);
    expect(funded).toEqual(new Set(['0xaaaa', '0xbbbb'])); // lowercased, 1-hop from T
  });

  it('a wallet funded by a THIRD PARTY (not T) is NOT in the set', () => {
    const funded = fundedByTreasury([T], [{ from: THIRD, to: '0xExternal' }]);
    expect(funded.has('0xexternal')).toBe(false);
  });

  it('is reproducible (same events -> same set) and case-insensitive', () => {
    const events: FundingEvent[] = [{ from: '0xTreasury', to: '0xAaAa' }];
    const a = fundedByTreasury(['0xTREASURY'], events);
    const b = fundedByTreasury(['0xtreasury'], events);
    expect([...a].sort()).toEqual([...b].sort());
    expect(a.has('0xaaaa')).toBe(true);
  });

  it('multiple treasuries: union of what each funded', () => {
    const T2 = '0xTREASURY2';
    const funded = fundedByTreasury([T, T2], [
      { from: T, to: A },
      { from: T2, to: B },
    ]);
    expect(funded).toEqual(new Set(['0xaaaa', '0xbbbb']));
  });
});

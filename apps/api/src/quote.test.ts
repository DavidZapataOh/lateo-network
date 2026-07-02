import { describe, it, expect } from 'vitest';
import { QuoteStore, checkPayment, isMenuService, MENU } from './quote.js';

const TTL = 30; // seconds

describe('2.3 T1 — quote issuance (price + nonce + TTL)', () => {
  it('issue returns {price, nonce(bytes32), ttlS} and is immediately valid', () => {
    const store = new QuoteStore();
    const q = store.issue('creat-1', 1500n, TTL, 100);
    expect(q.price).toBe(1500n);
    expect(q.ttlS).toBe(TTL);
    expect(q.nonce).toMatch(/^0x[0-9a-f]{64}$/); // bytes32
    expect(store.validate(q.nonce, 100)).toEqual({ creatureId: 'creat-1', price: 1500n });
  });

  it('two issues yield distinct nonces', () => {
    const store = new QuoteStore();
    const a = store.issue('c', 1n, TTL, 0);
    const b = store.issue('c', 1n, TTL, 0);
    expect(a.nonce).not.toBe(b.nonce);
  });
});

describe('2.3 T3 — nonce store: expired/unknown rejected (BITES, ADR-0007)', () => {
  it('fresh nonce validates; after TTL it is expired; unknown is null', () => {
    const store = new QuoteStore();
    const q = store.issue('c', 1000n, TTL, 100);
    expect(store.validate(q.nonce, 100 + TTL - 1)).not.toBeNull(); // within window
    expect(store.validate(q.nonce, 100 + TTL)).toBeNull(); // expired at now >= issuedAt+ttl
    expect(store.validate('0xdeadbeef', 100)).toBeNull(); // never issued
  });

  it('checkPayment rejects expired / unknown nonce (no value path)', () => {
    const store = new QuoteStore();
    const q = store.issue('c', 1000n, TTL, 100);
    expect(checkPayment(store, { nonce: q.nonce, value: 1000n, service: 'url-to-json' }, 100 + TTL)).toEqual({
      ok: false,
      reason: 'nonce_unknown_or_expired',
    });
    expect(checkPayment(store, { nonce: '0xnope', value: 1000n, service: 'url-to-json' }, 100)).toEqual({
      ok: false,
      reason: 'nonce_unknown_or_expired',
    });
  });

  it('consume makes a nonce single-use (INV-4 store side)', () => {
    const store = new QuoteStore();
    const q = store.issue('c', 1000n, TTL, 100);
    store.consume(q.nonce);
    expect(store.validate(q.nonce, 100)).toBeNull();
  });
});

describe('2.3 T4 — price out of quote rejected (BITES)', () => {
  it('value < price and value > price both rejected; only value == price proceeds', () => {
    const store = new QuoteStore();
    const q = store.issue('c', 1000n, TTL, 100);
    const under = checkPayment(store, { nonce: q.nonce, value: 999n, service: 'url-to-json' }, 100);
    const over = checkPayment(store, { nonce: q.nonce, value: 1001n, service: 'url-to-json' }, 100);
    const exact = checkPayment(store, { nonce: q.nonce, value: 1000n, service: 'url-to-json' }, 100);
    expect(under).toEqual({ ok: false, reason: 'price_mismatch' });
    expect(over).toEqual({ ok: false, reason: 'price_mismatch' });
    expect(exact).toEqual({ ok: true, creatureId: 'c', price: 1000n });
  });
});

describe('2.3 T5 — frozen menu guard §9 (BITES on scope creep)', () => {
  it('MENU is EXACTLY the two frozen services (fails if a third is added)', () => {
    expect([...MENU].sort()).toEqual(['summary-with-citations', 'url-to-json']);
  });

  it('isMenuService accepts the two, rejects anything else', () => {
    expect(isMenuService('summary-with-citations')).toBe(true);
    expect(isMenuService('url-to-json')).toBe(true);
    expect(isMenuService('translate')).toBe(false);
    expect(isMenuService('image-gen')).toBe(false);
  });

  it('checkPayment rejects a service outside the menu (before touching value)', () => {
    const store = new QuoteStore();
    const q = store.issue('c', 1000n, TTL, 100);
    expect(checkPayment(store, { nonce: q.nonce, value: 1000n, service: 'translate' }, 100)).toEqual({
      ok: false,
      reason: 'service_not_in_menu',
    });
  });
});

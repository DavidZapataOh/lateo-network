import { randomBytes } from 'node:crypto';
import type { Atomic } from './money.js';

// The FROZEN service menu (CONTEXT §9). Adding a third service breaks the T5 guard test — by design.
export const MENU = ['summary-with-citations', 'url-to-json'] as const;
export type MenuService = (typeof MENU)[number];
export function isMenuService(s: string): s is MenuService {
  return (MENU as readonly string[]).includes(s);
}

export interface Quote {
  price: Atomic;
  nonce: string; // 0x + 64 hex (bytes32), reused as the EIP-3009 nonce (INV-4)
  ttlS: number;
  issuedAt: number;
}

interface StoredQuote {
  creatureId: string;
  price: Atomic;
  expiresAt: number;
}

/**
 * Per-quote nonce store with a SHORT TTL (ADR-0007). This is the anti-re-pricing security: a nonce
 * that is unknown or expired in OUR store is rejected — even if the EIP-3009 authorization is still
 * valid on-chain (the two clocks: our short quote TTL vs the rail's >=30d validity window). The clock
 * is injected (`now`) so tests are deterministic.
 */
export class QuoteStore {
  private readonly quotes = new Map<string, StoredQuote>();

  issue(creatureId: string, price: Atomic, ttlS: number, now: number): Quote {
    const nonce = '0x' + randomBytes(32).toString('hex');
    this.quotes.set(nonce, { creatureId, price, expiresAt: now + ttlS });
    return { price, nonce, ttlS, issuedAt: now };
  }

  /** The live quote for a nonce, or null if unknown/expired (expired entries are evicted). */
  validate(nonce: string, now: number): { creatureId: string; price: Atomic } | null {
    const q = this.quotes.get(nonce);
    if (!q) return null;
    if (now >= q.expiresAt) {
      this.quotes.delete(nonce);
      return null;
    }
    return { creatureId: q.creatureId, price: q.price };
  }

  /** Single-use: consume a nonce after a served request (INV-4, store side). */
  consume(nonce: string): void {
    this.quotes.delete(nonce);
  }
}

export type PaymentCheck =
  | { ok: true; creatureId: string; price: Atomic }
  | { ok: false; reason: 'service_not_in_menu' | 'nonce_unknown_or_expired' | 'price_mismatch' };

/**
 * Validate a payment BEFORE touching value (ADR-0007): the service must be in the frozen menu, the
 * nonce must be live in our store, and the paid value must equal the quoted price. Any failure is a
 * rejection with no verify/settle — the value rail is never touched.
 */
export function checkPayment(
  store: QuoteStore,
  args: { nonce: string; value: Atomic; service: string },
  now: number,
): PaymentCheck {
  if (!isMenuService(args.service)) return { ok: false, reason: 'service_not_in_menu' };
  const q = store.validate(args.nonce, now);
  if (!q) return { ok: false, reason: 'nonce_unknown_or_expired' };
  if (args.value !== q.price) return { ok: false, reason: 'price_mismatch' };
  return { ok: true, creatureId: q.creatureId, price: q.price };
}

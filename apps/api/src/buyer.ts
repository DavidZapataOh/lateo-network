import { BatchEvmScheme } from '@circle-fin/x402-batching/client';
import type { Account } from 'viem';

export interface BuyResult {
  outcome?: string;
  settleId?: string;
  result?: unknown;
  error?: string;
}

/**
 * The buyer-side x402 client (2.5 T1): an external agent brings its OWN funded wallet, gets a quote
 * (402), signs the EIP-3009 authorization (payer = the agent), pays via the x-payment header, and
 * receives the service. The seller captures on delivery (ADR-0006); the buyer only authorizes.
 */
export async function buyService(
  base: string,
  creatureId: string,
  input: { url: string },
  wallet: Account,
): Promise<BuyResult> {
  const quoteRes = await fetch(`${base}/c/${creatureId}`, { method: 'POST' });
  if (quoteRes.status !== 402) {
    return { error: `no_quote_${quoteRes.status}` }; // dead->410, agonizing->409 propagate here
  }
  const quote = (await quoteRes.json()) as { nonce: string; requirements: unknown };
  const scheme = new BatchEvmScheme(wallet as never);
  const pp = (await scheme.createPaymentPayload(1, quote.requirements as never)) as {
    x402Version: number;
    payload: unknown;
  };
  const payload = {
    x402Version: pp.x402Version,
    payload: pp.payload,
    resource: { url: '/service', description: 'service', mimeType: 'application/json' },
    accepted: quote.requirements,
  };
  const header = Buffer.from(
    JSON.stringify(payload, (_, v) => (typeof v === 'bigint' ? v.toString() : v)),
  ).toString('base64');
  const res = await fetch(`${base}/c/${creatureId}`, {
    method: 'POST',
    headers: { 'x-payment': header, 'content-type': 'application/json' },
    body: JSON.stringify({ nonce: quote.nonce, url: input.url }),
  });
  return (await res.json()) as BuyResult;
}

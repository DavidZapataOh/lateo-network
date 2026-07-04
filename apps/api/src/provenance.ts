import { createPublicClient, http, parseAbiItem, getAddress, defineChain, toHex, type Hex } from 'viem';
import { USDC, GATEWAY_WALLET } from './rail.js';

/** A funding edge: `from` sent USDC value to `to` (a direct transfer or a Gateway depositFor). */
export interface FundingEvent {
  from: string;
  to: string;
}

/**
 * The anti-wash base of truth (ADR-0009 v2): the set of wallets FUNDED BY THE TREASURY (1 hop),
 * derived purely from on-chain funding edges. A participant is EXTERNAL only if it is NOT in this set
 * (and not a self-deal). The DB `class` label is never the source of truth — the chain is. Case-
 * insensitive; reproducible (same edges -> same set). Anyone can rebuild this from Arcscan.
 */
export function fundedByTreasury(treasuries: string[], events: FundingEvent[]): Set<string> {
  const T = new Set(treasuries.map((a) => a.toLowerCase()));
  const funded = new Set<string>();
  for (const e of events) {
    if (T.has(e.from.toLowerCase())) funded.add(e.to.toLowerCase());
  }
  return funded;
}

// GatewayWallet deposit event topic (token, recipient, depositor indexed) — used by seedFromTreasury's
// depositFor. Filtered by raw topic to avoid guessing the event name; recipient is topics[2].
const DEPOSIT_TOPIC = '0x4174a9435a04d04d274c76779cad136a41fde6937c56241c09ab9d3c7064a1a9';
const topicAddr = (a: string): Hex => `0x${a.slice(2).toLowerCase().padStart(64, '0')}`;
const fromTopicAddr = (t: Hex): string => `0x${t.slice(26)}`;

/**
 * Read the treasury's on-chain funding edges from Arc: direct USDC transfers (from ∈ T) and Gateway
 * deposits (depositor ∈ T). Bound the scan with `fromBlock`. Real RPC, no mocks — the E2E validates it.
 */
export async function onchainFunding(
  treasuries: string[],
  opts: { rpcUrl: string; fromBlock?: bigint },
): Promise<FundingEvent[]> {
  const arc = defineChain({
    id: 5042002,
    name: 'arc-testnet',
    nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
    rpcUrls: { default: { http: [opts.rpcUrl] } },
  });
  const pub = createPublicClient({ chain: arc, transport: http(opts.rpcUrl) });
  const fromBlock = opts.fromBlock ?? 0n;
  const head = await pub.getBlockNumber();
  const transferEvent = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
  const events: FundingEvent[] = [];
  // Arc's RPC caps eth_getLogs at a 100000-block range, so scan in windows (contiguous, no overlap).
  const STEP = 90_000n;
  for (const raw of treasuries) {
    const T = getAddress(raw);
    for (let start = fromBlock; start <= head; start += STEP + 1n) {
      const end = start + STEP < head ? start + STEP : head;
      const transfers = await pub.getLogs({ address: USDC as Hex, event: transferEvent, args: { from: T }, fromBlock: start, toBlock: end });
      for (const l of transfers) if (l.args.to) events.push({ from: T, to: l.args.to });
      // Raw eth_getLogs for the Gateway deposit (event name unknown -> filter by raw topic).
      const deposits = (await pub.request({
        method: 'eth_getLogs',
        params: [{ address: GATEWAY_WALLET, topics: [DEPOSIT_TOPIC, null, null, topicAddr(T)], fromBlock: toHex(start), toBlock: toHex(end) }],
      })) as Array<{ topics: Hex[] }>;
      for (const l of deposits) if (l.topics[2]) events.push({ from: T, to: fromTopicAddr(l.topics[2]) });
    }
  }
  return events;
}

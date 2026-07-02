import { GatewayClient, BatchEvmScheme } from '@circle-fin/x402-batching/client';
import { createWalletClient, createPublicClient, http, parseUnits, defineChain } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { BatchFacilitatorClient } from '@circle-fin/x402-batching/server';
import {
  initiateDeveloperControlledWalletsClient,
  type Blockchain,
} from '@circle-fin/developer-controlled-wallets';
import { usdcToAtomic, type Atomic } from './money.js';

/**
 * The value RAIL (slice 1.3): a creature (a Circle dev-controlled wallet, no local key) signs an
 * EIP-3009 authorization via Circle's API; the Circle Gateway facilitator verifies (= authorize)
 * and settles (= capture on delivery) or it is omitted (= void). All spike-proven (SPIKE-1b/3/4/5):
 * verify moves no value, settle captures, second settle -> nonce_already_used, validity window >= 30d.
 */

export const USDC = '0x3600000000000000000000000000000000000000';
export const GATEWAY_WALLET = '0x0077777d7EBA4688BDeF3E311b846F25870A19B9';
export const NETWORK = 'eip155:5042002';
/** Circle's facilitator rejects short windows ("authorization_validity_too_short"); 30d is accepted. */
export const MIN_VALIDITY_SECONDS = 2_592_000;

function reqEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env var: ${name}`);
  return v;
}

export function circleClient(): ReturnType<typeof initiateDeveloperControlledWalletsClient> {
  return initiateDeveloperControlledWalletsClient({
    apiKey: reqEnv('CIRCLE_API_KEY'),
    entitySecret: reqEnv('CIRCLE_ENTITY_SECRET'),
  });
}

export const facilitator = new BatchFacilitatorClient();

export interface PaymentRequirements {
  scheme: 'exact';
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: { name: string; version: string; verifyingContract: string };
}

export function requirementsFor(payTo: string, amount: Atomic): PaymentRequirements {
  return {
    scheme: 'exact',
    network: NETWORK,
    asset: USDC,
    amount: amount.toString(),
    payTo,
    maxTimeoutSeconds: MIN_VALIDITY_SECONDS,
    extra: { name: 'GatewayWalletBatched', version: '1', verifyingContract: GATEWAY_WALLET },
  };
}

type Circle = ReturnType<typeof initiateDeveloperControlledWalletsClient>;

interface TypedDataParams {
  domain: { name?: string; version?: string; chainId?: number; verifyingContract?: string };
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
}

const EIP712_DOMAIN_FIELDS: Array<[keyof TypedDataParams['domain'], string]> = [
  ['name', 'string'],
  ['version', 'string'],
  ['chainId', 'uint256'],
  ['verifyingContract', 'address'],
];

/**
 * A viem-account-shaped signer backed by a Circle wallet: signs any EIP-712 payload via Circle's API.
 * General enough for BOTH the EIP-3009 authorization (BatchEvmScheme, domain has chainId+verifyingContract,
 * no EIP712Domain in types) AND the Gateway BurnIntent (withdraw, domain is name+version, EIP712Domain
 * already in types). Only `address` + `signTypedData` are used by BatchEvmScheme and GatewayClient.withdraw.
 */
function circleAccount(circle: Circle, walletId: string, address: `0x${string}`) {
  return {
    address,
    async signTypedData(params: TypedDataParams): Promise<`0x${string}`> {
      const types = { ...params.types };
      if (!types.EIP712Domain) {
        types.EIP712Domain = EIP712_DOMAIN_FIELDS.filter(([k]) => params.domain[k] !== undefined).map(
          ([name, type]) => ({ name, type }),
        );
      }
      const data = JSON.stringify(
        { domain: params.domain, types, primaryType: params.primaryType, message: params.message },
        (_, v) => (typeof v === 'bigint' ? v.toString() : v),
      );
      const res = await circle.signTypedData({ walletId, data });
      return res.data!.signature as `0x${string}`;
    },
  };
}

export interface SignedAuthorization {
  payload: unknown;
  requirements: PaymentRequirements;
}

/** The creature signs an EIP-3009 authorization (payer = creature) via its Circle wallet. */
export async function signAuthorization(
  circle: Circle,
  args: { walletId: string; address: `0x${string}`; payTo: string; amount: Atomic },
): Promise<SignedAuthorization> {
  const requirements = requirementsFor(args.payTo, args.amount);
  const scheme = new BatchEvmScheme(circleAccount(circle, args.walletId, args.address));
  const pp = (await scheme.createPaymentPayload(1, requirements as never)) as {
    x402Version: number;
    payload: unknown;
  };
  const payload = {
    x402Version: pp.x402Version,
    payload: pp.payload,
    resource: { url: '/rail', description: 'burn', mimeType: 'application/json' },
    accepted: requirements,
  };
  return { payload, requirements };
}

export interface VerifyResult {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
}
export interface SettleResult {
  success: boolean;
  errorReason?: string;
  payer?: string;
  transaction: string;
  network: string;
}

/** verify = authorize (moves NO value). settle = capture. Omitting settle = void (SPIKE-3). */
export function verify(a: SignedAuthorization): Promise<VerifyResult> {
  return facilitator.verify(a.payload as never, a.requirements as never);
}
export function settle(a: SignedAuthorization): Promise<SettleResult> {
  return facilitator.settle(a.payload as never, a.requirements as never);
}

const GATEWAY_API = 'https://gateway-api-testnet.circle.com/v1';
const ARC_GATEWAY_DOMAIN = 26;

/** Read any address's Gateway "available" balance (atomic) via Circle's public balances API. */
export async function gatewayAvailable(address: string): Promise<Atomic> {
  const r = await fetch(`${GATEWAY_API}/balances`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'USDC', sources: [{ depositor: address, domain: ARC_GATEWAY_DOMAIN }] }),
  });
  const d = (await r.json()) as { balances?: { balance: string }[] };
  return usdcToAtomic(d.balances?.[0]?.balance ?? '0');
}

/** Seed a creature's Gateway balance from the TREASURY (ADR-0016). The creature sends no tx. */
export async function seedFromTreasury(amountUsdc: string, creatureAddress: `0x${string}`) {
  const treasury = new GatewayClient({
    chain: 'arcTestnet',
    privateKey: reqEnv('TREASURY_PRIVATE_KEY') as `0x${string}`,
    rpcUrl: reqEnv('ARC_RPC'),
  });
  return treasury.depositFor(amountUsdc, creatureAddress);
}

/** Create a creature's Circle wallet on Arc testnet (EOA — SCA would sign EIP-1271, not EIP-3009). */
export async function createCreatureWallet(
  circle: Circle,
  walletSetId: string,
): Promise<{ walletId: string; address: `0x${string}` }> {
  const res = await circle.createWallets({
    walletSetId,
    blockchains: ['ARC-TESTNET' as Blockchain],
    count: 1,
    accountType: 'EOA',
  });
  const w = res.data!.wallets![0]!;
  return { walletId: w.id, address: w.address as `0x${string}` };
}

const GATEWAY_TRANSFER_API = 'https://gateway-api-testnet.circle.com/v1/transfer';
const GATEWAY_MINTER_ABI = [
  {
    name: 'gatewayMint',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'attestationPayload', type: 'bytes' },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [],
  },
] as const;

// EIP-712 for the Gateway BurnIntent (domain is name+version only; circleAccount derives EIP712Domain).
const BURN_INTENT_TYPES = {
  TransferSpec: [
    { name: 'version', type: 'uint32' },
    { name: 'sourceDomain', type: 'uint32' },
    { name: 'destinationDomain', type: 'uint32' },
    { name: 'sourceContract', type: 'bytes32' },
    { name: 'destinationContract', type: 'bytes32' },
    { name: 'sourceToken', type: 'bytes32' },
    { name: 'destinationToken', type: 'bytes32' },
    { name: 'sourceDepositor', type: 'bytes32' },
    { name: 'destinationRecipient', type: 'bytes32' },
    { name: 'sourceSigner', type: 'bytes32' },
    { name: 'destinationCaller', type: 'bytes32' },
    { name: 'value', type: 'uint256' },
    { name: 'salt', type: 'bytes32' },
    { name: 'hookData', type: 'bytes' },
  ],
  BurnIntent: [
    { name: 'maxBlockHeight', type: 'uint256' },
    { name: 'maxFee', type: 'uint256' },
    { name: 'spec', type: 'TransferSpec' },
  ],
};

interface SdkInternals {
  chainConfig: { gatewayMinter: `0x${string}` };
  createBurnIntent: (
    source: unknown,
    dest: unknown,
    value: bigint,
    recipient: string,
    maxFee: bigint,
  ) => Record<string, unknown>;
}

export interface CashOutResult {
  mintTxHash: `0x${string}`;
  formattedAmount: string;
  recipient: `0x${string}`;
}

/**
 * A creature (Circle wallet) cashes out its EARNED, SETTLED Gateway balance to its own wallet on-chain,
 * via the RELAYER pattern (ADR-0016 — the creature signs, the platform sends the tx):
 *   1. reuse the SDK's createBurnIntent to build the burn intent (recipient = the creature),
 *   2. the CREATURE signs it via Circle (signTypedData),
 *   3. POST /transfer -> attestation,
 *   4. PLATFORM relays gatewayMint (gas only) -> USDC is MINTED to the creature by GatewayMinter.
 * On-chain this reads as "GatewayMinter minted the creature's own Gateway balance to it" — NOT a
 * platform->creature transfer. The creature (recipient) != treasury. Amount must be settled/available.
 */
export async function creatureCashOut(
  circle: Circle,
  args: { walletId: string; address: `0x${string}`; amountUsdc: string },
): Promise<CashOutResult> {
  const rpcUrl = reqEnv('ARC_RPC');
  const signer = circleAccount(circle, args.walletId, args.address);
  const ref = new GatewayClient({ chain: 'arcTestnet', privateKey: generatePrivateKey(), rpcUrl });
  // inject the creature's account so createBurnIntent uses the creature as sourceDepositor/sourceSigner
  // (it reads this.account.address); otherwise the dummy key's address is used and the signature mismatches.
  (ref as unknown as { account: unknown }).account = signer;
  const sdk = ref as unknown as SdkInternals;
  const amount = parseUnits(args.amountUsdc, 6);
  const maxFee = parseUnits('2.01', 6);
  // reuse the SDK builder (same-chain: source config == dest config); recipient = the creature
  const burnIntent = sdk.createBurnIntent(sdk.chainConfig, sdk.chainConfig, amount, args.address, maxFee);

  // the CREATURE signs the burn intent via Circle
  const signature = await signer.signTypedData({
    domain: { name: 'GatewayWallet', version: '1' },
    types: BURN_INTENT_TYPES,
    primaryType: 'BurnIntent',
    message: burnIntent,
  });

  const resp = await fetch(GATEWAY_TRANSFER_API, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify([{ burnIntent, signature }], (_, v) => (typeof v === 'bigint' ? v.toString() : v)),
  });
  const result = (await resp.json()) as { attestation?: `0x${string}`; signature?: `0x${string}`; error?: string; message?: string };
  if (!result.attestation || !result.signature) {
    throw new Error(`Gateway /transfer failed: ${result.message ?? result.error ?? JSON.stringify(result)}`);
  }

  // PLATFORM relays the mint (pays gas; the minted USDC belongs to the creature)
  const arc = defineChain({
    id: 5042002,
    name: 'arc-testnet',
    nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const relayer = privateKeyToAccount(reqEnv('PLATFORM_PRIVATE_KEY') as `0x${string}`);
  const wallet = createWalletClient({ account: relayer, chain: arc, transport: http(rpcUrl) });
  const pub = createPublicClient({ chain: arc, transport: http(rpcUrl) });
  const mintTxHash = await wallet.writeContract({
    address: sdk.chainConfig.gatewayMinter,
    abi: GATEWAY_MINTER_ABI,
    functionName: 'gatewayMint',
    args: [result.attestation, result.signature],
  });
  await pub.waitForTransactionReceipt({ hash: mintTxHash });
  return { mintTxHash, formattedAmount: args.amountUsdc, recipient: args.address };
}

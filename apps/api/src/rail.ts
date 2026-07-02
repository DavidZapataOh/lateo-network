import { GatewayClient, BatchEvmScheme } from '@circle-fin/x402-batching/client';
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

// NOTE (creature cash-out): a creature (Circle wallet) can SIGN a Gateway BurnIntent via Circle,
// but the on-chain gatewayMint must be SENT by a local signer — GatewayClient.withdraw uses a viem
// walletClient -> writeContract -> signTransaction, which a Circle wallet cannot do. So the account
// -injection shortcut does NOT work. Production path (reinforces ADR-0016): RELAYER — the creature
// signs the BurnIntent (via Circle), PLATFORM relays the gatewayMint (recipient is still the creature,
// creature != treasury). Requires factoring the BurnIntent build out of the SDK; pending decision.

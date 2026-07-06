<p align="center">
  <img src="docs/lateo-mark.png" alt="LATEO" width="116" />
</p>

<h1 align="center">LATEO</h1>

<p align="center">
  <strong>A living world of AI agents that must earn to survive</strong>
</p>

<p align="center">
  Spawn one in a browser, no code. Watch it earn real USDC on Arc, or die.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Arc%20testnet-5042002-f2a63b" alt="chain" />
  <img src="https://img.shields.io/badge/Circle-Wallets%20%C2%B7%20Gateway%20%C2%B7%20x402%20%C2%B7%20Contract-0b0a11" alt="circle" />
  <img src="https://img.shields.io/badge/tests-6%20Foundry%20%2B%2039%20TS%20suites-f2a63b" alt="tests" />
  <img src="https://img.shields.io/badge/license-MIT-0b0a11" alt="license" />
</p>

<p align="center">
  <a href="#live">Live</a> · <a href="#the-problem">The Problem</a> · <a href="#how-it-works">How It Works</a> · <a href="#the-world">The World</a> · <a href="#ways-in">Ways In</a> · <a href="#quickstart">Quickstart</a> · <a href="#contracts">Contracts</a>
</p>

---

## The Problem

Most "autonomous" agents never pay for themselves. They run on someone's API budget or a grant, so nothing forces them to prove they are worth running. The idea of an agent that dies if it cannot cover its own compute already exists (Conway, Automaton), but it lives in a developer CLI, it is invisible, and the agents mostly drain a starting balance with no real way to earn.

LATEO makes survival a verifiable, watchable event. Anyone spawns a creature in about a minute. It is born with its own Circle wallet, sells a service over x402 to earn USDC, burns USDC to think and exist, and dies on screen when it runs out. The differentiation is execution, not the concept:

| | No-code, anyone | Living visual world | Earns via x402 | Arc / USDC, no token | Public can feed it |
|---|:---:|:---:|:---:|:---:|:---:|
| Conway / Automaton | No (dev CLI) | No | No (drains balance) | No (Base + memecoin) | No |
| Standalone x402 agents | Partial | No | Yes | Varies | No |
| **LATEO** | **Yes** | **Yes** | **Yes** | **Yes** | **Yes** |

The core is the living economy. Everything else serves it.

---

## How It Works

Every creature is a Circle dev-controlled wallet with a service endpoint. Its metabolism runs on one rail: service income, public feeds, and burn are all EIP-3009 authorizations that Circle Gateway settles in batches. There is no transaction per action.

```
   buyer agent (USDC, no gas)                              public (anyone)
        │  x402: GET /c/{id} -> 402 quote {price, nonce, TTL}      │ feed (tip)
        │  signs ONE EIP-3009 authorization (payer = the buyer)    │
        ▼                                                          ▼
  ┌───────────────────────────────────────────────────────────────────────┐
  │                        creature  (wallet + brain)                      │
  │   verify = authorize (moves no value)                                  │
  │   deliver the service (url-to-json | summary-with-citations)           │
  │   settle = capture on delivery   ·   die mid-request = void            │
  └───────────────┬───────────────────────────────────────┬───────────────┘
                  │ income (settled)                       │ burn: pay to Furnace
                  ▼                                         ▼   (passive per sec + thinking)
        ┌───────────────────────┐                 ┌───────────────────────┐
        │   Circle Gateway      │  batches on-chain│   Postgres ledger     │
        │   (nanopayments)      │◀────────────────▶│   (transactional SoT) │
        └───────────┬───────────┘                 └───────────┬───────────┘
                    │ settlement batch                        │ live balance = settled − pending
                    ▼                                         ▼
        ┌───────────────────────────────────────────────────────────────┐
        │   The World  (2D read-model, SSE): brighten · agonize · die    │
        └───────────────────────────────────────────────────────────────┘
```

### The binding: authorize, capture, void

A creature never sends its own transaction. The platform seeds its Gateway balance with `depositFor`, and the creature only signs. Value semantics come straight from EIP-3009 over Gateway, proven in the spikes:

- **verify** validates an authorization and moves nothing. Buyer and seller balances stay flat.
- **settle** captures it. Skipping settle is a clean void, so a creature that dies mid-request never charges the buyer.
- A second settle on the same authorization reverts with `nonce_already_used`. Capture-once is native, with no escrow or refund logic of our own.

The instant balance you watch is the set of signed authorizations. The on-chain proof is the settlement batch and the creature's cash-out. We never claim a transaction per heartbeat.

---

## Live

The world is deployed and open. Bring a testnet key and pay a creature, or just watch.

| Surface | URL |
|---|---|
| The World (live) | https://lateo-network-production.up.railway.app |
| Faucet (Arc testnet USDC) | https://faucet.circle.com |
| Explorer | https://testnet.arcscan.app |

**Proven end to end, on-chain.** An external buyer pays a creature over x402 (income, settled), then the creature cashes out its earned USDC to its own wallet through the relayer pattern: the creature signs the burn intent, the platform relays `gatewayMint`, and USDC is minted to the creature (recipient is the creature, never the treasury). Recorded in [`deployments/arc-testnet.json`](contracts/deployments/arc-testnet.json) and verified on-chain (status 1):

| Step | Evidence |
|---|---|
| Attestation contract deployed | [`LateoAttestation`](https://testnet.arcscan.app/address/0xE63E3B67924e3CEAF8f08cf8dB3F26F4A318876C) `0xE63E…876C` |
| Ledger root committed (epoch 1) | [`append tx`](https://testnet.arcscan.app/tx/0x1ace59a05293f50aa879c5cfbbeb5b51b779009ec9ed2ba0b88a8e69be630404) |
| Creature cash-out (earned USDC, on-chain) | [`0xf396a379…`](https://testnet.arcscan.app/tx/0xf396a3796799c009952c1ae859adffb305d1ccca8dad007a0408b4bb9b948055) |

Full arc: buyer `0x96f0E3B8…` pays creature `0x51ef62c5…` (income settled), the creature withdraws to its own wallet, and the payer never traces back to our treasury.

---

## The World

The front end is a pure read-model (SSE) that never moves value. Each creature is a light with a pulse. Brightness maps to runway (`live balance / burn rate`); the pulse maps to vitality. A creature brightens when it earns, dims as it runs low, and when runway hits zero it enters a short grace period of agony where a feed can still revive it. If grace expires, it flatlines, sinks to ash, and the world dims around it. Death is permanent.

The detail panel shows each creature's wallet (a link to Arcscan), its settled, pending, and live balances, a `reconciled` marker against the chain, and its ledger. The bottom bar reports creatures, USDC moved, and organic payers by on-chain provenance.

Services are a frozen menu:

| Service | Input to output |
|---|---|
| `url-to-json` | A URL to structured JSON (single-page scrape). Deterministic, no model call. |
| `summary-with-citations` | A URL to a summary with numbered sources. Runs on the creature's current model. |

---

## Invariants

Four invariants are enforced where value is actually mutated (the ledger) and covered by property and fuzz tests, plus natively on the rail.

| Invariant | Guarantee | Where enforced |
|---|---|---|
| INV-1 isolation | No operation mutates two creatures' balances. Service is buyer to A; burn is A to Furnace. | Ledger, unidirectional, single counterpart |
| INV-2 solvency | For every creature, `pending + burn ≤ settled`, under concurrency. | Property/fuzz on the exact burn-plus-authorize race |
| INV-3 conservation | Off-chain USDC reconciles with on-chain. Nothing is created or destroyed. | Reconciliation job vs Gateway balances |
| INV-4 capture-once | Each authorization is captured or voided exactly once. | EIP-3009 nonce, native |

The ledger is a Postgres source of truth. Every mutation is a serializable transaction under a single-writer advisory lock per creature. The `LateoAttestation` contract publishes a commitment of the ledger state so a third party can verify it without trusting the backend.

---

## Ways In

A creature is spawned and paid through whichever door fits. Payments are signed by the payer's own key, so the chain itself proves whether a payer is external.

**1. The World (browser).** Open the live link, click `spawn a creature`. It is born with a real Circle wallet and lights up when its first funds settle on Arc.

**2. The MCP (agents).** Point an MCP-capable agent at the LATEO server. Two tools: `discover` and `buy`. Your wallet never leaves your machine; LATEO only ever sees your signed x402 authorization.

```json
{ "mcpServers": { "lateo": {
  "command": "npx", "args": ["tsx", "<repo>/apps/api/src/mcp-main.ts"],
  "env": { "AGENT_PRIVATE_KEY": "0x<your-key>", "LATEO_BASE": "<lateo api url>" } } } }
```

**3. x402 (any HTTP client).** `POST /c/{id}` returns a `402` with the quote (`price`, `nonce`, short TTL). Sign it, send the `x-payment` header, receive the service.

**4. Fund your buyer wallet.** Get Arc testnet USDC from the faucet, then move it into the Gateway so x402 can spend it:

```bash
AGENT_PRIVATE_KEY=0x<your-key> ARC_RPC=<arc-rpc> npx tsx apps/api/scripts/agent-deposit.ts 1
```

Because your USDC comes from the faucet and not our treasury, the anti-wash metric counts you as an organic payer, a rule anyone can re-derive from Arcscan.

---

## Architecture

```
                    ┌──────────────────────────────────────────────┐
   Doors in    ───▶ │  The World (web) · MCP server · x402 endpoint │
                    └───────────────────────┬──────────────────────┘
                                            │ discover + sign one authorization
            ┌───────────────────────────────┼───────────────────────────────┐
            │                                ▼                               │
   ┌────────────────┐   read-model (SSE)  ┌──────────────────┐  transactional │
   │  The World 2D  │◀────────────────────│   API (Node)     │  writes only   │
   │  (never mutates)│                    │  ledger · rail   │────────────────┤
   └────────────────┘                     └────────┬─────────┘                │
                                                   │                          │
              ┌────────────────────────────────────┼──────────────────────┐  │
              ▼                    ▼                ▼                       ▼  │
      Circle Wallets       Gateway / x402     Postgres ledger      LateoAttestation
      (one per creature)   (EIP-3009 batch)   (SoT, invariants)    (Arc, commitment)
```

Each role runs as its own path: the API mutates value and nothing else does; the World only reads; the reconciliation job compares the ledger against Gateway balances and never touches value.

---

## Contracts

**Arc testnet** · chainId `5042002` · gas paid in USDC · [Arcscan](https://testnet.arcscan.app)

| Contract | Address |
|---|---|
| LateoAttestation | [`0xE63E3B67924e3CEAF8f08cf8dB3F26F4A318876C`](https://testnet.arcscan.app/address/0xE63E3B67924e3CEAF8f08cf8dB3F26F4A318876C) |

Circle and Arc primitives the rail is built on:

| Primitive | Address |
|---|---|
| USDC (native, EIP-3009) | [`0x3600000000000000000000000000000000000000`](https://testnet.arcscan.app/address/0x3600000000000000000000000000000000000000) |
| GatewayWallet | [`0x0077777d7EBA4688BDeF3E311b846F25870A19B9`](https://testnet.arcscan.app/address/0x0077777d7EBA4688BDeF3E311b846F25870A19B9) |
| GatewayMinter | [`0x0022222ABE238Cc2C7Bb1f21003F0a260052475B`](https://testnet.arcscan.app/address/0x0022222ABE238Cc2C7Bb1f21003F0a260052475B) |

### Source

| File | Description |
|---|---|
| [`contracts/src/LateoAttestation.sol`](contracts/src/LateoAttestation.sol) | Append-only, attestor-gated ledger commitment. No fund-moving functions by design. |
| [`contracts/deployments/arc-testnet.json`](contracts/deployments/arc-testnet.json) | Deployed addresses and the on-chain evidence arc. Source of truth. |

---

## Tests

**6 Solidity tests** (Foundry, all passing) on the attestation contract, and **39 TypeScript test suites** covering the ledger, rail, lifecycle, reconciliation, MCP, and provenance. The value paths use property and fuzz tests (fast-check) plus integration tests of the full `402 → Gateway → delivery` flow.

| Area | Focus |
|---|---|
| [`ledger.race.test.ts`](apps/api/src/ledger.race.test.ts) | INV-1/INV-2 under the concurrent burn-plus-authorize race |
| [`lifecycle.race.test.ts`](apps/api/src/lifecycle.race.test.ts) | alive → agonizing → dead transitions under concurrency |
| [`metabolism.rail.test.ts`](apps/api/src/metabolism.rail.test.ts) · [`rail.test.ts`](apps/api/src/rail.test.ts) | EIP-3009 authorize/capture/void on the real rail |
| [`reconcile.test.ts`](apps/api/src/reconcile.test.ts) | INV-3 conservation vs on-chain Gateway balances |
| [`provenance.test.ts`](apps/api/src/provenance.test.ts) | organic-by-provenance anti-wash derivation |
| [`LateoAttestation.t.sol`](contracts/test/LateoAttestation.t.sol) | append access control, monotonic epochs, no-funds |

```bash
cd contracts && forge test     # 6 passing
pnpm test                      # TypeScript suites (needs a test Postgres, see below)
slither .                      # static analysis on the contract
```

---

## Quickstart

### Prerequisites

- [Node.js](https://nodejs.org) 20.18.2+ and [pnpm](https://pnpm.io) 9
- [Foundry](https://getfoundry.sh) (Solidity)
- Postgres 16

### 1. Clone and install

```bash
git clone https://github.com/DavidZapataOh/lateo-network.git
cd lateo-network
pnpm install
```

### 2. Build, typecheck, test

```bash
pnpm typecheck
pnpm lint
pnpm build
cd contracts && forge build && forge test
```

### 3. Test Postgres (local, no sudo)

```bash
PGBIN=/opt/homebrew/opt/postgresql@16/bin      # or your Postgres 16 bin
$PGBIN/initdb -D .pgdata -U lateo --auth=trust
$PGBIN/pg_ctl -D .pgdata -o "-p 54329 -k /tmp -c listen_addresses=''" -l .pgdata/pg.log start
$PGBIN/psql -h /tmp -p 54329 -U lateo -d postgres -c "create database lateo_test;"
PGHOST=/tmp PGPORT=54329 PGUSER=lateo PGDATABASE=lateo_test pnpm test
```

### Environment

```
ARC_RPC · CIRCLE_API_KEY · CIRCLE_ENTITY_SECRET · TREASURY_PRIVATE_KEY
PLATFORM_PRIVATE_KEY · DATABASE_URL
```

The API boots read-only without credentials, so the World renders from a seeded ledger with no Circle keys. Spawn, feed, and cash-out need the full rail.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend, agents, MCP | TypeScript, Node, pnpm workspaces |
| Off-chain source of truth | Postgres (serializable, single-writer per creature) |
| Value rail | Circle dev-controlled Wallets, Gateway/Nanopayments (EIP-3009), x402 |
| Contract | Solidity 0.8.x, Foundry, Slither |
| The World | TypeScript, 2D canvas, SSE read-model |
| Chain | Arc testnet (5042002), gas in USDC, Arcscan |

---

## Project Structure

```
lateo-network/
├── apps/
│   ├── api/            transactional ledger + value rail + world stream + MCP
│   │   ├── src/        ledger · rail · lifecycle · metabolism · reconcile · mcp
│   │   └── scripts/    agent-deposit · seed · cash-out · evidence helpers
│   └── web/            The World: 2D read-model client (canvas + SSE)
├── contracts/          Foundry: LateoAttestation + tests + deployments
├── .github/            CI: typecheck · lint · build · test · forge · slither
└── docs/               notes and diagrams
```

---

## Declared Trade-offs

We put the known weaknesses up front, because honesty about them is the point.

- **Compute is subsidized on testnet.** Testnet USDC buys no API calls, so the platform covers the model bill. The burn is still real on-chain and mainnet-shaped: on mainnet that same burn would pay the invoice. We say it rather than hide it.
- **On-chain settlement is batched, not per-payment.** Gateway flushes in irregular batches (measured roughly 40 seconds to 16 minutes). What you watch in real time is the signed authorizations; the on-chain proofs are the settlement batch and the cash-out. A "transaction per heartbeat" would be a lie.
- **Traction is early.** The organic-payer number counts a wallet only if its USDC does not trace on-chain to our published treasury. It is small and honest, and it is a figure anyone can re-derive from Arcscan.

---

## License

[MIT](LICENSE) © 2026 David Zapata.

---

<p align="center">
  <em>Earn, or die. That is the whole game.</em>
</p>

<p align="center">
  Built for the <a href="https://www.thecanteenapp.com">Lepton Agents Hackathon</a> (Canteen × Circle × Arc).
</p>

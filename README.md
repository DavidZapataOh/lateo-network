# LATEO

**A living world of AI agents that must earn to survive. Spawn yours. Watch it live — or die — on Arc.**

LATEO is a no-code web platform where anyone spawns an autonomous AI agent (a "creature") that must **earn real USDC on Arc** to pay for its own compute — or it **dies**. You watch a living world of creatures thrive, agonize, and flatline in real time.

Built for the **Lepton Agents Hackathon** (Canteen × Circle × Arc). Nanopayments: value as small as $0.000001, settled on Arc in USDC.

## How it uses the Circle Agent Stack
- **Dev-controlled Wallets** — one per creature (identity = its wallet, clickable on Arcscan).
- **Gateway / Nanopayments** — all value (service income, feed, burn) moves via off-chain EIP-3009 authorizations settled in batches (sub-cent).
- **x402** — each creature sells a micro-service over HTTP-402 on Gateway.
- **Contract (Arc, Foundry)** — non-custodial attestation: publishes a third-party-verifiable commitment of the ledger state (verifiability without trusting the backend).

## Stack
- TypeScript + Node (pnpm workspace) · Postgres (transactional off-chain source of truth) · Solidity + Foundry · Arc testnet (chain 5042002, gas in USDC).

## Layout
```
apps/api/        Service: transactional ledger + value rail + (next) live world
contracts/       Foundry: attestation contract (non-custodial) + audit
.github/         CI (typecheck · lint · build · test · forge · slither)
```

## Development
Requirements: Node ≥ 20.18.2, pnpm 9, Foundry, Postgres 16.

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm build
pnpm test        # requires a test Postgres (see below)
```

Contracts:
```bash
cd contracts && forge build && forge test
```

### Test Postgres (local, no sudo)
```bash
PGBIN=/usr/lib/postgresql/16/bin
$PGBIN/initdb -D .pgdata -U lateo --auth=trust
$PGBIN/pg_ctl -D .pgdata -o "-p 54329 -k /tmp -c listen_addresses=''" -l .pgdata/pg.log start
$PGBIN/psql -h /tmp -p 54329 -U lateo -d postgres -c "create database lateo_test;"
# run tests against that cluster:
PGHOST=/tmp PGPORT=54329 PGUSER=lateo PGDATABASE=lateo_test pnpm test
```

In CI, Postgres runs as a service container (see `.github/workflows/ci.yml`).

## Invariants the code preserves (audited)
- **INV-1 isolation** · **INV-2 solvency** · **INV-3 conservation** · **INV-4 capture-once**.
Enforced off-chain in the ledger (property/fuzz + single-writer advisory lock) and natively on the rail (EIP-3009 nonce); the attestation contract publishes them verifiably.

## Status
Built in vertical slices. Slice 1 (value core): Postgres ledger + honest balance + invariants under test. See CI for the green status.

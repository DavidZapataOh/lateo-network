# The Anti-Wash Arc — verifiable machinery, end to end on Arc

LATEO's anti-wash machinery is real, runs on the real rail, and every step of its arc is
verifiable by a third party: an agent pays a creature through the MCP, the x402 payment settles,
the creature cashes out as a Gateway mint on Arcscan, and "external payer" is decided by **on-chain
provenance — never by a database label**. This document walks the evidence, then draws the exact
boundary of what a testnet number can and cannot claim.

Reproduce it with:

```
PGHOST=/tmp PGPORT=54329 PGUSER=lateo PGDATABASE=lateo_test \
  npx tsx apps/api/scripts/external-arc.ts
```

---

## 1. The arc (end to end, on the real rail)

```
external agent ──(MCP: discover → buy)──▶ creature income ──▶ cash-out ──▶ Arcscan
   0x402af8…9b05      x402 verify→settle      0xddd97f…1257    Gateway mint   confirmed
```

| # | Step | Evidence | Anyone can check via |
|---|------|----------|----------------------|
| 1 | Agent pays through the MCP | `buy` tool → x402 `verify`→`settle`; **settleId `5b92682e-fa82-46fa-82a8-5d1948f6b9f6`**; service delivered (`{title,description,h1}`) | in-process MCP + ledger row (`status=settled`) |
| 2 | Creature earns | ledger income credited, counterparty = agent wallet | Postgres ledger |
| 3 | Cash-out | tx **`0x15cb4430…cdc3cc`**, status **1**, `to`=GatewayMinter `0x0022…475B`, **mint of 0.015 USDC to the creature** (`Transfer from 0x0 → 0xddd97f…1257`) | `cast receipt` / [Arcscan](https://testnet.arcscan.app/tx/0x15cb44308bfa7bf7f96f51c403d6e1c043143087a8c15922816937f4a9cdc3cc) |
| 4 | Provenance (derived from chain) | `fundedByTreasury(T)`: **creature ∈ set** (deriver catches the seed → it works), **agent ∉ set** (T never funded it), **payer ≠ creature** (not self-deal) → **external by provenance** | rebuild from Arcscan (USDC `Transfer` + Gateway `deposit` with `from ∈ T`) |
| 5 | Metric | `externalPayers = 1` — computed while the payer is **deliberately mislabeled** `class='agent'` in the DB, proving the number **ignores the label** and follows the chain | metric test suite (label-blind) |

`T` = the published treasury `0xe1e5cB978f518Fa696C9c2f0a52d3865b308DA85`.

## 2. Why "external" is decided on-chain, not by a label

A wallet is **external** iff its USDC does **not** trace to `T` (1 hop: a direct USDC transfer or a
Gateway `depositFor`) **and** it is not the creature itself (self-deal). The DB `class` column is
never read by the metric. `src/metric.test.ts` bites on exactly this: a treasury-funded wallet
mislabeled `class='agent'` is *still* excluded, and re-labeling it changes nothing — only on-chain
provenance moves the number. This is what a skeptic can reconstruct from the explorer without
trusting our database.

## 3. The bug the run caught

`onchainFunding` issued a single wide `eth_getLogs`; Arc's RPC caps the range at 100000 blocks and
rejected it (`query exceeds max block range 100000`). Fixed to window the scan in ≤90000-block
chunks. It surfaced **only by running against the real chain** — a unit test with a mocked RPC would
have hidden it.

---

## 4. The boundary: what a testnet number can and cannot claim

We drew this boundary ourselves, before anyone asked. Knowing exactly where a metric stops being
evidence is part of the design, and it has two layers.

### 4a. This run proves classification, not demand

The paying wallet (`0x402af8…9b05`) is operator-controlled (faucet-funded). It is genuinely
*external to `T` by provenance* — which is precisely what makes it the right test: the pipeline
classified a non-treasury wallet correctly, with the label actively lying. But an operator wallet
is not an arms-length third party, so this `externalPayers = 1` measures the **classifier**, not
**demand**. The demand number starts existing when the public MCP opens to real agents during the
seeding window.

### 4b. The faucet gap — a property of testnets, priced in

The 1-hop-from-`T` rule kills self-wash routed **through the treasury**. It cannot distinguish "real
third party" from "operator with another faucet wallet" — and neither can any provenance scheme: on
a testnet with a public faucet, wallets are free and indistinguishable. This is a property of
testnets, not a gap in this design. **Every** project claiming "real testnet traction" carries it,
whether they name it or not. We name it, and we build for it: provenance is the *necessary* layer
(it makes treasury-routed wash impossible), and social proof is the layer that completes it.

## 5. The layer that completes it: social proof from real seeding

On a testnet, credibility does not come from "impossible to fake" (nothing is) — it comes from
**externals + their verifiable provenance + evidence they are real people**:

- Discord handles of the paying agents' operators,
- timestamps of when the public MCP was opened,
- diversity of wallets / payment patterns that a lone operator does not easily fabricate.

Provenance metric + social proof is the credible claim. Seeding with real people from the Discord
is the source of the second layer, and it runs as a parallel track.

---

## 6. Status

Slice 2.5 delivered the full machinery — MCP interface, x402 settle, Gateway-mint cash-out,
provenance deriver, label-blind metric — verified end to end on the real rail. The traction number
is by design a separate artifact: it accrues during the seeding window, lands on this same
machinery, and gets classified by the same chain-derived rule anyone can rebuild from Arcscan.

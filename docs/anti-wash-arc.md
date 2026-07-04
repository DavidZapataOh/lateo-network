# The Anti-Wash Arc — machinery, evidence, and its two honest limits

**Read this first.** This document proves that LATEO's anti-wash *machinery* is real and
verifiable on-chain. It does **not** prove real traction. The distinction is the whole point of
being honest here: a judge who cannot tell "the pipe works" from "strangers are paying" is being
misled, and a sophisticated judge will notice the omission. So both are stated plainly below.

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

## 4. The two honest limits (do NOT omit these when showing a judge)

### Limit 1 — the payer is operator-controlled: no real traction yet

The paying wallet (`0x402af8…9b05`) is **PLATFORM — a wallet the operator controls**, faucet-funded.
It is genuinely *external to `T` by provenance*, but it is **not an arms-length third party**. So
`externalPayers = 1` right now means *the operator paying from another pocket*. This run proves the
pipeline **classifies** correctly; it does **not** prove demand. The real number (>0 strangers) does
not exist until the public MCP is opened, during a seeding window, to real agents.

### Limit 2 — the faucet gap: a property of testnets, not a fixable bug

The 1-hop-from-`T` rule catches self-wash routed **through the treasury**. It does **not** catch an
operator paying from wallets funded by the **public faucet** (which the operator can also use). The
rule cannot distinguish "real third party" from "operator with another faucet wallet."

This is **not** a bug closeable with code. On a testnet with a public faucet, wallets are free and
indistinguishable, so **no provenance scheme can perfectly separate real-third-party from
operator-with-another-wallet**. It is a property of testnets. Every project claiming "real testnet
traction" has this gap, whether they name it or not.

**What the provenance metric is, precisely:** *necessary* (it kills treasury-routed self-wash) but
**not sufficient alone**. It must be completed by social proof of third parties.

## 5. What closes the gap: social proof from real seeding

Credibility before a judge does not come from "impossible to fake" (on a testnet, nothing is) — it
comes from **"here are the externals + their verifiable provenance + evidence they are real
people"**:

- Discord handles of the paying agents' operators,
- timestamps of when the public MCP was opened,
- diversity of wallets / payment patterns that a lone operator does not easily fabricate.

The provenance metric plus this social proof is the credible claim. Seeding with real people from
the Discord is the **only** source of credibility the testnet does not give by provenance alone.

---

## 6. Status

Slice 2.5 closed the **machinery**, not the number — as always intended. We do not enter Sprint 3
believing we have traction; we have the machinery **waiting for data**. Real seeding (open the MCP,
bring people from the Discord) runs as a parallel track from now — it takes days, and it is the only
way `externalPayers` moves from "1 (me)" to "N real."

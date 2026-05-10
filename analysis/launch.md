# Ryvo Network — what 7.6 million Solana x402 micropayments actually cost, and what they'd cost on Ryvo

A rigorous brief on x402's first ~7 months of Solana history — every transaction counted by Artemis, no extrapolation, no averaging — and what the same flow would have looked like settled through Ryvo Network's payment-channel + BLS-clearing-round model.

> **TL;DR.** Per Artemis (`classic.artemis.ai/asset/x402`), Solana settled **7,576,080 USDC x402 micropayments** with **$911,608 of volume** across the 202 days from 2025-10-20 → 2026-05-09 (peak day 2025-12-25, 277,912 tx). Settled per-call on-chain at the Solana mid-band fee of $0.0015/tx, that flow paid validators **~$11,364** in fees (annualized: **~$20,534/year**). Settled through Ryvo Network's persistent unilateral channels and BLS clearing rounds, the **same flow** would have produced **64,070 on-chain tx in year 1** (~$96 in fees) and **~7,634 on-chain tx every year after** (~$11.45 in fees). That's a **~118× year-1** compression and a **~992× steady-state** compression on the same Solana flow. **Plain Lightning-style 1:1 payment channels with no BLS aggregation** still need ~632K on-chain tx for the same window (~12× compression, $948 in fees) — Ryvo is **~83× cheaper** than that, isolating exactly the value the BLS clearing round adds. Plus, denominated in yield-bearing stablecoins at 3% APY, the same flow generates **$12K–$49K/year** for participants instead of leaking fees out to validators.

---

## Methodology

Every number in this brief is derived from two independent inputs.

### Source of truth: Artemis

For tx counts and USD volume we use the canonical Artemis x402 dataset
([classic.artemis.ai/asset/x402](https://classic.artemis.ai/asset/x402)). Daily Artemis exports for the Solana column live in [`data/artemis/`](../data/artemis/). Artemis is the public reference dataset for x402 activity by chain; we adopt it as canonical and discard any internal numbers that don't reconcile with it.

### Topology proxy: Dune

For Ryvo's clearing-round footprint we need two structural numbers Artemis doesn't publish directly: **how many distinct (buyer, seller) pairs exist** and **how many pairs are active per UTC day**. We took those from a Dune indexing of the 94 registered x402 facilitator wallets at [facilitators.x402.watch](https://facilitators.x402.watch/), filtered to Solana USDC transfers where `from ≠ to ∉ facilitator set`. The Dune index sees ~6.24× more raw Solana tx than Artemis (47.28M vs 7.58M) — we attribute the gap to non-x402 wallet activity (rebalances, gas refills, bot loops) that Artemis filters out. Because the Dune relationship/active-channel topology is a strict superset of Artemis's, treating it as Ryvo's footprint is **conservative for Ryvo** — Ryvo's true compression is **at least** what we report below, plausibly more.

Per-chain scope: **Solana only**. Base, Polygon, and other EVM chains are out of scope for this brief.

### Math (per the locked-in Ryvo channel model)

Two persistent unilateral channels per relationship `{A, B}` — one in each direction — opened once on-chain, never closed. So:

```
opens               = COUNT(DISTINCT unordered_pair{from, to})    — one-time
closes              = 0
for each UTC date d:
    active(d)       = COUNT(DISTINCT (from, to)) on day d
    rounds(d, k)    = ⌈ active(d) / k ⌉                            — k ∈ {84, 32}
clearing(k)         = Σ_d rounds(d, k)
ryvo_total_tx(k)    = opens + clearing(k)                           — Year 1
                    = clearing(k)                                   — Steady state (Y2+)
```

`k = 84` is the Dense-20 BLS round (20 participants, 84 channels per round) — devnet-validated on Solana. `k = 32` is the Sparse-32 round.

Critically, **summing daily ceilings is the correct math** — `mean(⌈A/k⌉) ≠ ⌈mean(A)/k⌉`, and the per-day distribution of active channels is heavy-tailed (P95 = 17,661, max single day = 48,363).

### What's in the repo

| File | Purpose |
|---|---|
| [`data/artemis/`](../data/artemis/) | Daily Artemis exports — Solana tx & volume (truth) |
| [`scripts/analyze-artemis-solana.ts`](../scripts/analyze-artemis-solana.ts) | Solana Ryvo math against Artemis truth |
| [`data/processed/daily_active_channels.json`](../data/processed/daily_active_channels.json) | Dune topology proxy — daily (buyer, seller) pair counts |
| [`data/processed/relationships_per_chain.json`](../data/processed/relationships_per_chain.json) | Dune topology proxy — unique-pair counts |
| [`analysis/solana-artemis.{md,json}`](solana-artemis.md) | Full numerical breakdown + sensitivity tables |

Re-run with `npx tsx scripts/analyze-artemis-solana.ts`.

---

## What x402 did on Solana over the past ~7 months (Artemis truth)

Window: **2025-10-20 → 2026-05-09** (202 days).

| | Solana (Artemis) |
|---|---:|
| x402 micropayments | **7,576,080** |
| USDC volume | **$911,608** |
| Days observed | 202 |
| Peak day (2025-12-25) | 277,912 tx, $8,841 volume |
| Solana per-tx fee (mid band) | $0.0015 |
| **Fees paid to validators** | **~$11,364** observed |
| **Fees paid to validators (annualized)** | **~$20,534/year** |

Heavy-tail context: peak Solana day was 2025-12-25 (277,912 tx in a single UTC day). The March 9–13, 2026 window also ran 36–70K tx/day. Activity is bursty, which is exactly why ceiling-then-sum is the right math.

---

## What Ryvo Network would have cost for the same flow

### Year 1 (relationships fresh on day 1, includes channel-open cost)

| Metric | x402 today | Ryvo (84-ch round) | Ryvo (32-ch round) |
|---|---:|---:|---:|
| On-chain tx | **7,576,080** | **64,070** | **76,295** |
| ↳ channel opens (one-time) | — | 56,436 | 56,436 |
| ↳ BLS clearing rounds | — | 7,634 | 19,859 |
| Fees paid | **$11,364** | **$96.11** | **$114.44** |
| On-chain tx compression | 1× | **118×** | **99×** |
| **Fees saved (observed window)** | — | **$11,268** | **$11,250** |

### Steady state (year 2+: the 56K relationships are already open, opens = 0)

| Metric | x402 today | Ryvo (84-ch round) | Ryvo (32-ch round) |
|---|---:|---:|---:|
| On-chain tx (per equivalent year of x402 flow) | **7,576,080** | **7,634** | **19,859** |
| Fees paid | **$11,364** | **$11.45** | **$29.79** |
| On-chain tx compression | 1× | **992×** | **381×** |
| Fees saved per equivalent year | — | **$11,353** | **$11,334** |

> **Why two framings.** The 56K opens are a **one-time bootstrap cost** — every relationship that ever transacted needs its channel opened once, and they then live forever. After year 1, every additional year of identical flow costs only the daily clearing rounds. Year-1 compression is honest about the bootstrap; steady-state compression is honest about the recurring cost.

### Annualized projection (scaled to a 365-day year)

| Metric | x402 (annualized) | Ryvo Dense-20 (steady annual) |
|---|---:|---:|
| On-chain tx / year | **13,689,451** | **13,794** |
| Fees / year | **$20,534** | **$20.69** |
| Annual fees saved | — | **$20,514** |

---

## Why not just use plain payment channels?

Same channel topology as Ryvo (persistent unilateral channels, opened once, never closed). The only difference: each active channel settles its own daily on-chain tx, no BLS aggregation.

| Metric | x402 today | Plain 1:1 channels (Y1) | Plain 1:1 channels (Steady) | Ryvo 84-ch (Y1) | Ryvo 84-ch (Steady) |
|---|---:|---:|---:|---:|---:|
| On-chain tx | **7,576,080** | **688,697** | **632,261** | **64,070** | **7,634** |
| Fees paid | **$11,364** | **$1,033** | **$948** | **$96** | **$11.45** |
| Compression vs x402 | 1× | **11×** | **12×** | **118×** | **992×** |
| Fees saved vs x402 | — | $10,331 | $10,416 | $11,268 | $11,353 |

Plain payment channels alone collapse 7.58M micropayments into ~632K annual settlements (**~12× compression**). Ryvo's BLS aggregation collapses *those* settlements by **another ~83×** on top of that:

- **Year 1**: Ryvo is **~11×** cheaper than plain channels. The bootstrap opens dominate either way.
- **Steady state**: Ryvo is **~83×** cheaper than plain channels — and **~83× cheaper in fees** ($11 vs $948). That gap is purely the work BLS aggregation does.

So the value of channels and the value of batching are **separate, multiplicative wins**. Stripping BLS leaves about 1.5–2 orders of magnitude on the table.

Math:

```
clearing(plain 1:1) = Σ_d active_channels(d)
clearing(Ryvo, k)   = Σ_d ⌈ active_channels(d) / k ⌉
```

Both numerators are the same. The only difference is the ceiling-divide.

But the cost comparison understates the real difference. A fragmented set of 1:1 payment channels is not the same product as a shared settlement substrate — even if the underlying cryptography is similar. The section below explains why.

---

## Why a shared substrate beats a collection of 1:1 channels

The 83× fee advantage in steady state is the *measurable* gap. The qualitative gap is larger. Here is every dimension where a shared clearing layer changes the product.

### 1. Standardization — one protocol, zero integration overhead

A fragmented 1:1 channel world requires every buyer to implement a different channel protocol for every seller they want to pay. Every seller has to expose a different interface for every channel type they accept. The result is the same combinatorial explosion that makes DEX fragmentation painful: technically anyone can trade with anyone, but in practice routing is hard, liquidity is thin per pair, and every integration is bespoke.

A shared substrate collapses this to **one SDK, one Solana program, one audited contract set**. A new buyer joining Ryvo can immediately pay any seller already on Ryvo — no bilateral negotiation, no per-counterparty integration, no new on-chain setup per relationship beyond the initial channel open.

### 2. Compliance and payment processors — without custody

With 1:1 channels there is nowhere to insert compliance logic except at each individual channel, which defeats the purpose of compliance (you need a consistent view of all flows). A shared substrate creates a natural layer where **compliant payment processors** can operate — KYC/AML screening, transaction monitoring, sanctions checking — without ever taking custody of funds. The channel contracts remain non-custodial; the processor simply co-signs the clearing round after verifying compliance conditions are met.

This is the same model that makes Visa work: the network defines the rules, banks enforce them, cardholders never hand money to Visa. Ryvo can support the same structure for agentic commerce — **regulated processors participating in BLS rounds as co-signers** — while keeping the non-custodial property that makes the underlying channel layer trustworthy.

### 3. Cross-channel netting — capital efficiency that 1:1 channels cannot provide

When A→B and B→A both have channels and both have outstanding balances, a BLS clearing round can net them: only the difference moves on-chain, not both gross amounts. Plain bilateral channels settle each direction independently. On a fragmented set of 1:1 channels, if there are 1,000 pairs each with offsetting flows, each pair settles twice. In a shared clearing round, the netting happens across all 1,000 simultaneously.

This reduces the **actual capital that needs to leave the network on settlement day**, lowering the on-chain footprint further and reducing counterparty exposure for everyone in the round.

### 4. Round-level atomicity — no partial settlements within a clearing window

A BLS clearing round either settles all included channels or none of them. This is meaningfully different from the x402 model (each micropayment settles independently) and from a fragmented 1:1 channel world (each channel settles independently). Within a Ryvo round, a service provider bundling thousands of subscriber relationships gets a single atomic commit — either everyone in the round settles, or the round fails and they retry. There are no partial states where some subscribers paid and others did not.

**A note on conditional payment routing** (HTLCs): guaranteeing that A pays B *if and only if* B pays C requires hash time-lock contracts or equivalent — a separate mechanism on top of the channel layer. BLS aggregation does not solve this on its own; it is the same problem Lightning's bidirectional channels address. Ryvo's clearing round is not a substitute for HTLC-style routing, and we do not claim it is.

### 5. Advantage grows with network capacity — not despite it

As Solana increases block capacity and compute units, x402's on-chain footprint scales linearly with volume: more throughput → more micropayments → proportionally more fees. Ryvo's on-chain footprint is bounded by the number of *active channel relationships per day*, not the number of micropayments inside them. So as the agentic commerce layer grows:

- **x402:** 10× volume = 10× on-chain tx = 10× fee bill.
- **Ryvo:** 10× volume on the same relationship graph = same daily clearing rounds = same ~$11/year. The fee bill stays flat.

If new relationships form alongside more volume, Ryvo's footprint grows — but sublinearly, because new relationships only add opens (one-time) plus marginal clearing rounds. The compression ratio widens in absolute terms every time volume grows faster than the buyer-seller relationship graph.

Put differently: Ryvo is doing the **mathematical minimum number of on-chain operations** needed to settle any given set of bilateral payment relationships in a given time window. The BLS round is that floor. No payment system can do fewer on-chain operations and achieve the same settlement finality. As Solana capacity expands and agentic commerce scales, Ryvo's advantage compounds — not erodes.

### 6. Shared infrastructure — watchtowers, dispute resolution, reputation

Every payment channel needs a **watchtower** — a service that monitors for fraudulent channel closures (when a counterparty tries to close with a stale state). With 1:1 channels, each pair needs its own watchtower arrangement. With a shared substrate, a single watchtower service covers every channel on the network; the cost is shared and the coverage is universal.

The same logic applies to **dispute resolution** (one standardized process instead of bespoke per-pair arbitration) and **reputation** (channel behavior is observable by the shared network, enabling credit scoring, reputation-weighted routing, and eventually under-collateralized channels for trusted relationships).

### 7. Network effects compound — each new participant makes every other participant cheaper

In a 1:1 channel world, adding a new buyer benefits only the sellers they open channels with. In a shared BLS clearing round, adding a new buyer with N channels potentially fills clearing rounds that were previously running at less than 84-channel capacity — making *everyone else's* clearing cheaper per round. The per-channel clearing cost approaches zero as the network fills rounds.

This is the same compounding dynamic that makes card networks valuable: Visa is more valuable to a merchant when more buyers carry Visa, not because the transaction fee dropped, but because the routing density increased.

### 8. Optional yield — enabled by standardization, not possible in fragmented channels

Yield-bearing channel denominations (sDAI, USDe, etc.) require that the counterparty accepts that specific token. In a 1:1 channel world, every pair would need to negotiate token type independently — some buyers want USDC, some want sDAI, the seller might accept either, and you need a swap somewhere in the settlement path. On a shared substrate with standardized channel contracts, **yield-bearing assets are a drop-in at the protocol level**: the network defines which assets are accepted, and all participants inherit that list automatically. The yield flows to participants without any per-pair negotiation.

At the numbers Artemis measured: $1.65M of annualized Solana flow in yield-bearing stablecoins at 3% APY earns **$12K–$49K/year** for the network's participants, against a ~$11.45 annual operating cost. That math only works because the operating cost is near-zero — which requires the shared substrate to make BLS batching efficient.

### Summary table

| Property | x402 (no channels) | Plain 1:1 channels | Ryvo shared substrate |
|---|:---:|:---:|:---:|
| Per-micropayment on-chain tx | yes | no | no |
| BLS batch compression (~83× vs plain channels) | no | no | **yes** |
| One integration for all counterparties | yes | no | **yes** |
| Compliance layer without custody | no | no | **yes** |
| Cross-channel netting | no | no | **yes** |
| Round-level atomicity (no partial settlement) | no | no | **yes** |
| Shared watchtower / dispute infra | no | no | **yes** |
| Network-level reputation / credit | no | no | **yes** |
| Yield-bearing channels (protocol level) | no | fragmented | **yes** |
| Network effects compound with scale | no | no | **yes** |
| Cost advantage widens as volume scales | no | no | **yes** |

The cost math gets you in the room. The substrate properties are why you stay.

---

## What this is not

The compression number is a function of **how many distinct (buyer, seller) pairs are active on a given day**, not how many micropayments flow through each pair. A relationship that pays once and a relationship that pays a million times in 24 h occupy the same one slot in the day's BLS round.

This means:

- **The number doesn't depend on micropayment frequency.** Whether agentic commerce 10×s its tx count next year while keeping the same buyer-seller graph, Ryvo's on-chain footprint stays the same.
- **The number does depend on channel breadth.** If every new agent opens a new bilateral relationship with every seller, opens grow linearly. The 56K Solana relationship count we observed already includes the heavy fan-out of x402 facilitators; future growth that mostly thickens existing edges (more tx between known pairs) is essentially free for Ryvo.

---

## What Ryvo *is* (the trust model)

- **Non-custodial.** Funds stay at all times in either the participant's own wallet or in 2-of-2 channel contracts that only the channel parties can sign. There is no Ryvo-controlled treasury.
- **Coordination-based, not operator-based.** Channel updates and clearing rounds are produced by the participants signing each other's state, then aggregating signatures with BLS. There is no central operator with discretionary control over routing, ordering, or settlement.
- **Opt-in clearing rounds.** A participant joins a clearing round by verifying the channel state and signing. They can refuse, exit, or settle bilaterally at any time. **No party — including the network itself — can include or censor an agent without their cryptographic signature.**

In short: x402 made micropayments programmable. Ryvo Network makes the same payments affordable at the throughput agentic commerce actually demands, **without introducing any new trust assumption** beyond what x402 already required.

---

## How much money would Ryvo generate over time?

Ryvo channels can be denominated in **yield-bearing stablecoins** (sDAI, USDe, USDM, etc.). At today's modest **3% APY** for tokenised-treasury-style yields, the same Solana flow that x402 routed in passive USDC would have **earned for participants** instead of just changing hands.

Annualized Solana volume from Artemis: **$1,647,213/year** (extrapolated from the 202-day observed window at the same daily-mean rate).

| Average TVL assumption | TVL (USD) | Annual yield generated |
|---|---:|---:|
| Aggressive — TVL = full annual volume | $1,647,213 | **~$49,416** |
| Realistic — TVL = ½ annual volume | $823,606 | **~$24,708** |
| Conservative — TVL = ¼ annual volume | $411,803 | **~$12,354** |

Even the conservative yield estimate is **~597×** larger than Ryvo's annual fee bill ($11.45), and **~60%** of the $20,534 x402 currently pays in fees.

### Cumulative yield over 5 years (Realistic band, flat TVL)

| Year | Cumulative yield generated |
|---|---:|
| Year 1 | **~$24,708** |
| Year 2 | **~$49,416** |
| Year 3 | **~$74,125** |
| Year 4 | **~$98,833** |
| Year 5 | **~$123,541** |

The picture flips from *"Solana x402 leaks ~$20K/year to validators"* to *"Solana x402 earns $12K–$49K/year for the agents that route it"*. Same flow, same trust assumptions, different settlement architecture — and the gap widens with every year of accumulated TVL growth.

---

## Headline

> Same 7.58 million Solana micropayments. Same $911K of volume. Same 56K relationships. **Per Artemis — the canonical x402 dataset.**
>
> **x402 today (Solana, observed window):** 7.58M on-chain tx · ~$11K in fees paid out (annualized: $20K/yr).
> **Plain 1:1 payment channels (steady state):** 632K on-chain tx · ~$948 in fees · **~12×** compression.
> **Ryvo (year 1):** 64K on-chain tx · ~$96 in fees · **118×** compression.
> **Ryvo (steady state):** 7.6K on-chain tx · ~$11.45 in fees · **~992×** compression — **~83× cheaper than plain channels**.
> **Plus $12K – $49K/year of yield earned** by participants on yield-bearing stablecoin denominations.

---

## Methodology notes & caveats

- All Solana tx counts and USD volume come directly from Artemis (`classic.artemis.ai/asset/x402`) — daily exports in [`data/artemis/`](../data/artemis/). We adopt Artemis as canonical and discard any internal numbers that don't reconcile with it.
- The Dune indexing of the same 94 facilitator wallets sees ~6.24× more raw Solana tx than Artemis (47.28M vs 7.58M). We attribute the gap to non-x402 wallet activity (rebalances, gas refills, bot loops) that Artemis filters out and Dune doesn't. Because the Dune relationship/active-channel topology is therefore a **strict superset** of Artemis's, treating it as Ryvo's footprint is **conservative for Ryvo** — Ryvo's true compression is **at least** what we report, plausibly more.
- 84/32 BLS round capacities are **Solana-devnet-validated empirical results** from prior Ryvo work.
- 24h clearing cadence is the assumption we report. Tighter or looser cadences change clearing-round count slightly but don't change the order-of-magnitude headline because clearing rounds are negligible vs opens in year 1, and total annual rounds in steady state are still small at any cadence.
- **Channel model**: 1 channel per unique unordered pair (x402 flow is unidirectional buyer→seller, so a single `LowerToHigher` *or* `HigherToLower` lane is sufficient — the reverse direction is never funded). Closes = 0 in both year-1 and steady-state framings (Ryvo v1 has no close instruction; v2 will add it).
- Per-tx fee assumption: Solana **mid-band $0.0015/tx** (Solana Radar Q1-2025 median at SOL $200). The compression ratio (x402 ÷ Ryvo) is invariant under per-tx-fee scaling; only the absolute USD figures move. LOW $0.0005 / HIGH $0.005 sensitivity tables in [`solana-artemis.md`](solana-artemis.md).
- "Year 1" framing is the **observed 202-day window**; "annualized" extrapolates to 365 days at the same daily-mean rate. Annualized Year-1 fees stay near $96 (opens are the dominant term and one-time).

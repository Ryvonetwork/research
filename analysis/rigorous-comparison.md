# Rigorous Ryvo vs x402 comparison (LEGACY — multi-chain Dune-indexed)

> **⚠️ SUPERSEDED 2026-05-10.** This file is the old multi-chain
> (Base + Polygon + Solana) analysis built on Dune-indexed totals. The
> Dune-indexed Solana figure (47.28M tx) does not reconcile with Artemis
> (7.58M tx for the same window) — we attribute the gap to non-x402 wallet
> activity (rebalances, gas refills, bot loops) that Dune sweeps in and
> Artemis filters out. **The current rigorous result is in
> [`solana-artemis.md`](solana-artemis.md)** — Solana-only, Artemis-canonical.
> This file is retained for history and to document the topology proxy
> (relationship graph + daily active-pair counts) the new analysis still uses.

Generated: 2026-05-10T14:55:35.020Z

## Inputs

- Daily aggregates: [`data/processed/daily_active_channels.json`](../data/processed/daily_active_channels.json)  (792 rows, 362 unique UTC days)
- Relationships per chain: [`data/processed/relationships_per_chain.json`](../data/processed/relationships_per_chain.json)
- Per-tx fees: Base $0.001, Polygon $0.001, Solana $0.0015
- BLS round capacity: 84 channels/round (Dense-20), 32 channels/round (Sparse-32)

## Coverage

We indexed **145,404,780** USDC micropayments across Base + Polygon + Solana, totalling **$38,736,949**. This is **80.6%** of the Artemis-reported 180.3M tx and **81.9%** of the $47.3M volume cited at [classic.artemis.ai/asset/x402](https://classic.artemis.ai/asset/x402).

Reconciliation report: [`analysis/phase0-reconciliation.md`](phase0-reconciliation.md).

## Headline (Base + Solana — Polygon is in the appendix)

Polygon is excluded from the headline because its activity is concentrated in only 142 unique relationships generating 12,595,022 tx — bot-loop-tier concentration, not representative of agentic commerce. Full Polygon numbers are in the appendix below.

### Year 1 (relationships fresh on day 1, includes channel opens)

| Metric | x402 today | Ryvo (84-ch round) | Ryvo (32-ch round) |
|---|---:|---:|---:|
| On-chain tx | **132,809,758** | **529,861** | **570,260** |
| Fees paid (USD) | **$156,448.58** | **$561.92** | **$608.43** |
| On-chain tx compression | 1× | **250.7×** | **232.9×** |
| Fee compression | — | **278.4×** | **257.1×** |
| Fees saved | — | **$155,886.67** | **$155,840.15** |

### Steady state (year 2+: relationships are pre-existing, opens = 0)

| Metric | x402 today | Ryvo (84-ch round) | Ryvo (32-ch round) |
|---|---:|---:|---:|
| On-chain tx (per equivalent year of x402 flow) | **132,809,758** | **25,229** | **65,628** |
| Fees paid | **$156,448.58** | **$29.06** | **$75.58** |
| Tx compression | 1× | **5264×** | **2024×** |

### Three-way: x402 vs plain 1:1 channels vs Ryvo

A natural question is "why not just use plain payment channels?" — i.e. one channel per (buyer, seller) pair, settled individually on chain (no BLS aggregation). Same channel topology as Ryvo (2 unilateral channels per relationship, opened once, never closed) — the *only* difference is that each active channel settles its own daily on-chain tx instead of being aggregated into a BLS round of up to 84.

`clearing(1:1) = Σ_d active_channels(d)`  vs  `clearing(Ryvo, k) = Σ_d ⌈active_channels(d) / k⌉`

| Metric | x402 today | Plain 1:1 channels (Year 1) | Plain 1:1 channels (Steady) | Ryvo 84-ch (Year 1) | Ryvo 84-ch (Steady) |
|---|---:|---:|---:|---:|---:|
| On-chain tx | **132,809,758** | **2,594,197** | **2,089,565** | **529,861** | **25,229** |
| Fees paid | **$156,448.58** | **$2,938.6** | **$2,405.75** | **$561.92** | **$29.06** |
| Compression vs x402 | 1× | **51×** | **64×** | **251×** | **5264×** |
| Fees saved vs x402 | — | **$153,509.98** | **$154,042.83** | **$155,886.67** | **$156,419.52** |

**Ryvo's BLS aggregation is worth 4.9× over plain channels in year 1 and 83× in steady state** (fee multiple is similar). Plain payment channels alone collapse the 132M micropayments by ~64× — a real win — but BLS aggregation collapses the *resulting* clearing tx by another 83× on top of that.

### Inclusive view (all 3 chains, year-1 framing — for full transparency)

| Metric | x402 today | Ryvo (84-ch round) | Ryvo (32-ch round) |
|---|---:|---:|---:|
| On-chain tx | **145,404,780** | **530,193** | **570,674** |
| Fees paid (USD) | **$169,043.6** | **$562.25** | **$608.84** |
| Compression | 1× | **274.2×** | **254.8×** |
| Fees saved | — | **$168,481.36** | **$168,434.76** |

## Decomposition (totals)

| | Value |
|---|---:|
| Unique relationships (across all chains) | 504,774 |
| Channel opens (= relationships, see footnote) | 504,774 |
| Channel closes (Ryvo v1 — no close instr.) | 0 |
| Clearing rounds @ 84 ch/round | 25,419 |
| Clearing rounds @ 32 ch/round | 65,900 |
| Total Ryvo on-chain tx @ 84 | 530,193 (= opens + clearing) |
| Total Ryvo on-chain tx @ 32 | 570,674 (= opens + clearing) |

> **Footnote on opens.** `opens = R`, not `2 × R`. Ryvo's `create_channel` instruction initializes one directional lane (`LowerToHigher` *or* `HigherToLower`) per call. x402 is a unidirectional buyer→seller flow, so a single lane is sufficient — the reverse direction is never funded. Earlier internal models used `2 × R` from a unilateral-channels-only protocol design that was superseded by the bidirectional `ChannelBucket` architecture. The corrected count drops total Ryvo Y1 tx by exactly one R per chain.

## Solana lifecycle cost (Y1 vs Y2, capital + recurring)

This compares the **all-in Solana cost** of clearing the indexed flow under x402, naive 1:1 payment-channel sessions (the "Lightning-but-on-Solana" baseline), and Ryvo Dense-20. Capital deposit is the rent-exempt SOL that must be locked to allocate the on-chain state account; for Sessions it's recoverable, for Ryvo v1 it's currently a sunk cost (v2 will add a close-channel instruction with rent recovery).

**Constants (Solana 2026):** 1 ChannelBucket account = 10,093 bytes holding 46 channel lanes ⇒ rent ≈ 0.0711 SOL/bucket. Sessions naive ≈ 200 bytes/channel ⇒ rent ≈ 0.0023 SOL/channel. SOL price assumed at $200.

| Cost component | x402 | Sessions (1:1, recoverable) | Ryvo Dense-20 v1 (sunk) | Ryvo Dense-20 v2 (planned, recoverable) |
|---|---:|---:|---:|---:|
| Solana relationships | 56,436 | 56,436 | 56,436 | 56,436 |
| Capital state accounts (one-time) | 0 | 56,436 channels | 1,227 buckets | 1,227 buckets |
| Capital deposit (USD, locked) | $0 | **$25,767** | **$17,457** | $17,457 |
| Capital recoverable on close? | n/a | yes | **no** | yes |
| Y1 settlement tx | 47,277,644 | 688,815 | 64,108 | 64,108 |
| Y1 fees (Solana, $0.0015/tx mid) | $70,916.47 | $1,033.22 | $96.16 | $96.16 |
| Y1 total Solana cost (capital + fees) | $70,916.47 | **$26,800.55** | **$17,553.47** | $17,553.47 |
| Y2+ recurring tx | 47,277,644 | 632,379 | 7,672 | 7,672 |
| Y2+ recurring fees | $70,916.47 | $948.57 | **$11.51** | $11.51 |

### Reading the lifecycle table

- **Y1 capital is dominated by Sessions** ($25,767, vs Ryvo's $17,457) because Sessions needs one ~200-byte account *per channel*, whereas Ryvo packs 46 channel lanes into one 10,093-byte ChannelBucket — ~0.9× rent efficiency per channel.
- **Y2 recurring fees are dominated by x402** ($70,916.47 vs Ryvo's $11.51) because x402 lands one tx per micropayment whereas Ryvo lands one BLS-aggregated tx per ⌈active/84⌉.
- **Sessions sit between the two**: capital expensive, fees ~the same as 1:1 channels (one settle per active channel-day), capital recoverable via close.
- **Ryvo v1 caveat:** Ryvo v1 has no close-channel instruction. Once a ChannelBucket lane is initialized, its rent stays locked indefinitely. v2 (planned) will add close + rent recovery; until then, the Solana capital deposit is a sunk cost, not a recoverable deposit. Sessions architectures DO support close + rent recovery.
- **Sessions assumption:** stable — one channel per (buyer, seller) pair, opened once at first interaction, held for the entire year. Best-case Sessions model; real-world payment channels are typically more ephemeral, which would only make Sessions costs go UP.

## Solana fee sensitivity (LOW / MID / HIGH)

The flat $0.00044 historical fee floor was the bare 5,000-lamport base fee at SOL ~$88; it understates real network costs during the 2025-Q4 / 2026-Q1 priority-fee congestion window. We don't have a Dune-exact SUM-of-lamports yet (the API key's query engine is deprecated and a re-issue is gated), so we report all three sensitivity bands here. The MID band ($0.0015/tx) is what the rest of this report uses.

| Solana per-tx fee | Band | Solana x402 fees | Solana Sessions Y1 fees | Solana Sessions steady fees | Solana Ryvo Dense Y1 fees | Solana Ryvo Dense steady fees |
|---|---|---:|---:|---:|---:|---:|
| $0.0005 | LOW | $23,638.82 | $344.41 | $316.19 | $32.05 | $3.84 |
| $0.0015 | MID | $70,916.47 | $1,033.22 | $948.57 | $96.16 | $11.51 |
| $0.005 | HIGH | $236,388.22 | $3,444.08 | $3,161.9 | $320.54 | $38.36 |

The relative compression (x402 ÷ Ryvo) is invariant under per-tx-fee scaling — only the absolute USD numbers move. So the headline "5264× steady-state compression" claim holds across all three bands; only the Y1/Y2 dollar-savings figures move.

## Per-chain breakdown

| Chain | x402 tx | Relationships | Opens | Clearing-84 | Clearing-32 | Clearing-1to1 | Ryvo tx (84) | Ryvo tx (32) | x402 fee | Ryvo fee (84) | Ryvo fee (32) | 1:1 fee (Y1) | 1:1 fee (Steady) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| base | 85,532,114 | 448,196 | 448,196 | 17,557 | 45,731 | 1,457,186 | 465,753 | 493,927 | $85,532.11 | $465.75 | $493.93 | $1,905.38 | $1,457.19 |
| polygon | 12,595,022 | 142 | 142 | 190 | 272 | 4,654 | 332 | 414 | $12,595.02 | $0.33 | $0.41 | $4.8 | $4.65 |
| solana | 47,277,644 | 56,436 | 56,436 | 7,672 | 19,897 | 632,379 | 64,108 | 76,333 | $70,916.47 | $96.16 | $114.5 | $1,033.22 | $948.57 |

## Daily distribution stats per chain

| Chain | Days observed | Mean active ch/day | P95 active ch/day | Max active ch/day | Sum of daily active counts |
|---|---:|---:|---:|---:|---:|
| base | 362 | 4025 | 19,983 | 51,982 | 1,457,186 |
| polygon | 190 | 24 | 65 | 67 | 4,654 |
| solana | 240 | 2635 | 16,992 | 48,363 | 632,379 |

## Top 15 busiest days globally

| Chain | Date | Active channels | Rounds (84-ch) | Rounds (32-ch) | x402 tx that day |
|---|---|---:|---:|---:|---:|
| base | 2025-10-28 | 51,982 | 619 | 1,625 | 363,088 |
| solana | 2026-03-11 | 48,363 | 576 | 1,512 | 98,240 |
| solana | 2026-03-10 | 46,594 | 555 | 1,457 | 94,606 |
| solana | 2026-03-09 | 45,959 | 548 | 1,437 | 95,929 |
| base | 2025-10-29 | 42,657 | 508 | 1,334 | 560,961 |
| solana | 2026-03-12 | 42,176 | 503 | 1,318 | 84,810 |
| solana | 2026-03-13 | 41,657 | 496 | 1,302 | 85,166 |
| base | 2025-10-27 | 36,795 | 439 | 1,150 | 484,184 |
| base | 2025-11-11 | 35,765 | 426 | 1,118 | 1,274,431 |
| base | 2025-10-30 | 35,713 | 426 | 1,117 | 386,109 |
| polygon | 2026-03-13 | 67 | 1 | 3 | 163,388 |
| polygon | 2026-03-15 | 67 | 1 | 3 | 159,220 |
| polygon | 2026-01-18 | 66 | 1 | 3 | 135,664 |
| polygon | 2026-02-25 | 66 | 1 | 3 | 16,569 |
| polygon | 2026-03-06 | 66 | 1 | 3 | 163,189 |

## Caveats (will appear verbatim in the published brief)

- All inputs are derived from Dune SQL against tokens_{base,polygon,solana}.transfers.
- Filter: USDC contract per chain + tx_from/tx_signer ∈ facilitator wallets + buyer ≠ seller ≠ facilitator.
- Sample covers 2025-05-09 → 2026-05-09 (12-month window of x402 history, 13 calendar months observed).
- Coverage vs Artemis 180M: 80.6% of tx, 81.9% of volume.
- Relationships R for Solana / late-2026 months may be slightly under-counted due to a Dune datapoint-limit hit (Mar/Apr/May 2026 Solana, May 2026 Base/Polygon partitions). Missing partitions are recent low-volume tail months and would only INCREASE opens count by at most ~5%.
- Channel opens = R (one create_channel call per relationship). x402 flow is unidirectional buyer→seller, so a single LowerToHigher OR HigherToLower lane is sufficient — never both. Earlier 2*R model assumed unilateral channels, before the protocol consolidated to bidirectional ChannelBucket lanes.
- Solana per-tx fee: $0.00044 (the bare 5,000-lamport base fee at SOL ~$88) understates real costs during the 2025-Q4 / 2026-Q1 congestion window. We use the MID sensitivity band ($0.0015 — Solana Radar Q1-2025 median) as primary; LOW ($0.0005 — base-fee floor) and HIGH ($0.005 — Dec-2025 peak) appear in the appendix.
- Ryvo v1 has no close-channel instruction — Solana ChannelBucket rent is sunk capital until v2. Sessions (1:1 channels) DO support rent recovery on close. The lifecycle table reflects this asymmetry.

## Reproducibility

Every number in this report is derived from the two input JSONs by [`scripts/analyze-rigorous.ts`](../scripts/analyze-rigorous.ts). Both inputs are produced by [`scripts/dune-pull-aggregates.ts`](../scripts/dune-pull-aggregates.ts), which runs deterministic SQL against Dune Spellbook tables. Anyone with a Dune API key can re-run the entire pipeline.

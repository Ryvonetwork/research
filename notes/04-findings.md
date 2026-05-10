# 04 — Findings (live, updated as data lands)

This file is the running log of what we've actually measured. Append-only — once a
row is here it should never disappear; we just refine it.

## Status (last updated: 2026-05-10)

| Phase                                   | Status        | Notes                                                                |
|-----------------------------------------|---------------|----------------------------------------------------------------------|
| Facilitator registry captured           | done          | `data/raw/facilitators.json`                                         |
| x402 Bazaar discovery snapshot          | done          | 45,545 resources, 721 unique sellers (legacy)                        |
| Solana RPC sample (10 facilitators)     | done          | ~150K tx — used for spot-checks (legacy)                             |
| Base RPC sample                         | retired       | Out of scope after the 2026-05-10 Solana-only refocus                |
| Dune global pull (multi-chain)          | done (legacy) | 145.4M tx indexed — superseded; topology only                        |
| **Artemis adoption (Phase 4)**          | **done**      | Solana tx & volume from Artemis = canonical                          |
| **Solana × Artemis analysis**           | **done**      | [`../analysis/solana-artemis.md`](../analysis/solana-artemis.md)     |
| **Public-facing brief (`launch.md`)**   | **done**      | [`../analysis/launch.md`](../analysis/launch.md)                     |

## Scope change (2026-05-10)

We retired Base / Polygon / EVM coverage and adopted **Artemis** as the single
source of truth for tx counts and USD volume. The internal Dune indexing of the
94 facilitator wallets sees ~6.24× more raw Solana tx than Artemis (47.28M vs
7.58M for the 202-day window 2025-10-20 → 2026-05-09); we attribute the gap to
non-x402 wallet activity that Artemis filters out (rebalances, gas refills, bot
loops). Per direction, anything that doesn't reconcile with Artemis is demoted
from headline to footnote.

The Dune relationship graph and per-day active-pair counts are retained as a
**topology proxy** for Ryvo's BLS-clearing footprint — treated as an upper
bound, since they are a strict superset of the strictly-Artemis cohort.

## Headline (Solana, Artemis truth)

Window: **2025-10-20 → 2026-05-09** (202 days). Source: Artemis daily Solana
column (`data/artemis/Transactions by Chain.csv`, `Volume by Chain.csv`).

```
Solana x402 micropayments (Artemis)            7,576,080
Solana USDC volume (Artemis)                   $911,608
Annualized tx                                  13,689,451 / yr
Annualized volume                              $1,647,213 / yr
Peak day                                       2025-12-25 — 277,912 tx, $8,841

Unique unordered relationships {A,B} (Dune)        56,436    (channels Ryvo maintains)
Channel opens (= relationships, one-time)          56,436
Channel closes                                          0    (Ryvo v1 has no close instruction)

Σ_d ⌈ active_channels(d) / 84 ⌉                    7,634    (Dense-20 BLS rounds, observed)
Σ_d ⌈ active_channels(d) / 32 ⌉                   19,859    (Sparse-32 BLS rounds, observed)

YEAR 1 RYVO ON-CHAIN TX  (= opens + clearing)
  k = 84                                          64,070    →  118 ×  compression
  k = 32                                          76,295    →   99 ×  compression

STEADY STATE (year 2+: opens = 0)
  k = 84                                           7,634    →  992 ×  compression
  k = 32                                          19,859    →  381 ×  compression

x402 fee bill (observed window, $0.0015/tx mid)   $11,364
Ryvo fee bill (year 1, k = 84)                       $96    →  $11,268 saved (~99.2 %)
Ryvo fee bill (steady state, k = 84)              $11.45    →  $11,353 saved (~99.9 %)

x402 fee bill (annualized)                        $20,534
Ryvo fee bill (steady, annualized)                 $20.69
```

> Solana per-tx fee uses the MID sensitivity band ($0.0015 — Solana Radar
> Q1-2025 median at SOL $200). LOW $0.0005 / HIGH $0.005 sensitivity tables
> appear in `analysis/solana-artemis.md`. Compression ratios are invariant
> under per-tx-fee scaling — only the absolute USD numbers move.
>
> Channel opens = R (one `create_channel` per relationship). x402 flow is
> unidirectional buyer→seller, so a single `LowerToHigher` *or* `HigherToLower`
> lane is sufficient.

### Daily distribution stats (Solana)

```
Days observed                                       202
Mean active channels / day                        3,130
P95  active channels / day                       17,661
Max  active channels / day                       48,363    (2026-03-11)
```

Heavy-tailed — `mean × days / 84` underestimates clearing tx, which is why we
sum daily ceilings instead.

### Top 5 busiest Solana days (by Dune active-channel count)

```
2026-03-11  48,363 channels   →  576 BLS rounds (k=84)
2026-03-10  46,594 channels   →  555 BLS rounds (k=84)
2026-03-09  45,959 channels   →  548 BLS rounds (k=84)
2026-03-12  42,176 channels   →  503 BLS rounds (k=84)
2026-03-13  41,657 channels   →  496 BLS rounds (k=84)
```

### Top 5 busiest Solana days (by Artemis tx count)

```
2025-12-25  277,912 tx   $8,841 volume
2025-11-30  195,365 tx   $311,169 volume
2025-12-25 (peak day)
2025-12-04  141,277 tx   $13,588 volume
2025-12-05  149,620 tx   $5,343 volume
2025-12-06  148,520 tx   $7,804 volume
```

(Note: tx-volume peaks and channel-count peaks don't align — December 2025 was
heavy-volume bot activity through a small set of pairs; March 2026 was wider
fan-out across more relationships.)

## Solana lifecycle cost (Y1 vs Y2, capital + recurring)

Ryvo's `ChannelBucket` packs **46 channel lanes per 10,093-byte account**, vs
Sessions (1:1 channels) which need ~200 bytes per channel. Solana
rent-exempt SOL ≈ ((bytes + 128 metadata) × 3,480 lamports/byte/year × 2 years).

| Architecture | Capital today | Capital after SIMD-0296 (×0.5 rent) | Recoverable on close? |
|---|---:|---:|:---:|
| x402 | $0 | $0 | n/a |
| Sessions (1:1, naive) | $25,767 | $12,884 | yes |
| **Ryvo Dense-20 v1** | **$17,457** | **$8,729** | **no — sunk in v1** |
| Ryvo Dense-20 v2 (planned) | $17,457 | $8,729 | yes |

Ryvo v1 has no `close_channel` instruction, so the rent is currently sunk
working capital, not a recoverable deposit. v2 will add close + rent
recovery. Sessions architectures DO support recovery on close.

## Yield generated by Ryvo over time

3% APY on yield-bearing stablecoin denominations of the same Solana flow:

| Average TVL band                | TVL          | Annual yield generated |
|---------------------------------|-------------:|-----------------------:|
| Aggressive — TVL = annual vol   |  $1,647,213  |               $49,416  |
| Realistic — TVL = ½ annual vol  |    $823,606  |               $24,708  |
| Conservative — TVL = ¼ annual vol |   $411,803 |               $12,354  |

Cumulative yield over 5 years (Realistic, flat TVL): $24,708 → $123,541.

Even the conservative band (~$12K/yr) is **~1,078×** Ryvo's $11.45 annual fee
bill, and **~60%** of the $20,534 x402 currently pays in Solana fees.

## Why the headline is not the older "5,264 ×" number

The previous launch.md (now superseded) was a Base + Solana brief with three
properties that didn't reconcile with Artemis:

1. **Multi-chain (Base + Polygon + Solana)** vs Artemis tracking by chain.
   We've narrowed scope to **Solana only** for direct Artemis comparability.
2. **Used Dune-indexed Solana tx (47.28M)** as the headline x402 number,
   producing a $70K Solana fee bill. Artemis says 7.58M tx → ~$11K fee bill.
   We've adopted Artemis.
3. **Combined Base+Solana 132.8M tx → 25,229 BLS rounds = 5,264× compression**.
   Solana-only, Artemis-truth: 7.58M tx → 7,634 BLS rounds = 992× compression.

The compression structure (channels × batching, both wins multiplicative) is
unchanged. The absolute numbers are smaller because the input flow is smaller
under Artemis truth.

## Bazaar cross-check (legacy — kept for context)

Independent confirmation that channel concentration is real, from a totally
different data source (Bazaar service discovery). Not used in the headline
analysis after the Solana-only refocus.

| Chain   | Resources | Unique Sellers | 30d Calls | Edges (LB) | Avg tx/channel |
|---------|----------:|---------------:|----------:|-----------:|---------------:|
| solana  |       591 |             53 |   62,400  |     2,830  |       22.0     |
| base    |    33,790 |            223 |  279,700  |     3,520  |       79.4     |
| polygon |       185 |             10 |    1,250  |        62  |       20.2     |
| other   |    29,730 |            435 |  115,200  |       402  |      286.7     |
| **all** |    45,550 |            721 |  458,500  |     6,820  |       67.2     |

## What we still don't have

- **Artemis-canonical relationship counts.** Artemis publishes daily tx and
  volume by chain but not the (buyer, seller) pair graph. Our Dune-derived
  56,436 relationships is a topology *upper bound* — an Artemis-strict count
  would be ≤ that and therefore would only widen Ryvo's compression advantage.
- **Solana fee accuracy.** We hold $0.0015/tx as the mid-band assumption; a
  Dune-exact `SUM(lamports)` per facilitator wallet would replace it (gated
  on a Dune API re-issue).

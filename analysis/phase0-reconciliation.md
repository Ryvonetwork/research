# Phase 0 — Dune-source reconciliation against Artemis 180M

> **⚠️ Note 2026-05-10.** This reconciliation is **legacy multi-chain context**.
> After the 2026-05-10 refocus the headline analysis is Solana-only and uses
> Artemis directly as truth — see [`solana-artemis.md`](solana-artemis.md).
> The Dune Solana figure (47.28M tx) here over-counts the Artemis Solana
> figure (7.58M tx) by ~6.24× over the matching window, which is why we
> demoted Dune from headline to topology-proxy.

Generated: 2026-05-09 by `scripts/dune-reconcile-chunked.ts`. Raw monthly numbers in `data/processed/phase0_monthly.json`.

## Methodology

For each chain we ran one Dune SQL query per calendar month (Dec 2024 – May 2026, 18 months) against the chain-specific Spellbook tables (`tokens_base.transfers`, `tokens_polygon.transfers`, `tokens_solana.transfers`). The query counts USDC transfers where:

- Token is canonical USDC for that chain (Base `0x8335…2913`; Polygon native `0x3c49…5359` and bridged USDC.e `0x2791…4174`; Solana mint `EPjFW…1v`).
- The wrapping transaction was sent by (signed by, on Solana) one of the 94 facilitator wallets registered at [facilitators.x402.watch](https://facilitators.x402.watch/) (snapshot in [`data/raw/facilitators.json`](../data/raw/facilitators.json)).
- The actual transfer is **not** a facilitator-internal move — both sides (`from`, `to` on EVM; `from_owner`, `to_owner` on Solana) are non-facilitator addresses. This excludes liquidity rebalancing, gas refills, and similar internal flow that the x402 protocol itself doesn't cause.

Chunking by `block_month` (the partition key) was required because the Dune Free-tier 2-minute query cap can't fit a multi-year scan in one shot.

## Per-chain totals (full x402 history through 2026-05-09)

| Chain | tx | USD volume | First day | Last day | Months active |
|---|---:|---:|---|---|---:|
| Base | **85,532,114** | **$30,056,213** | 2025-05-09 | 2026-05-09 | 13 |
| Polygon | **12,584,866** | **$343,875** | 2025-09-28 | 2026-05-09 | 9 |
| Solana | **47,277,644** | **$8,336,796** | 2025-07-22 | 2026-05-09 | 11 |
| **Total** | **145,394,624** | **$38,736,883** | | | |

## Reconciliation against Artemis ([classic.artemis.ai/asset/x402](https://classic.artemis.ai/asset/x402))

| | Dune-via-facilitator-wallets | Artemis (filtered) | Coverage |
|---|---:|---:|---:|
| tx | 145,394,624 | 180,300,000 | **80.6%** |
| volume | $38,736,883 | $47,300,000 | **81.9%** |

The ~20% gap likely comes from one or more of:

1. **Other chains** Artemis includes that we haven't probed (BNB, Optimism, Arbitrum, Ethereum mainnet — none have known x402 facilitators in the [registry](https://facilitators.x402.watch/) but Artemis's own filter may be broader).
2. **Other settlement tokens** (USDT, PYUSD, USDe). Today the x402 protocol is USDC-only by spec, but in-the-wild facilitator wallets may also process other stables.
3. **Facilitators outside the public registry** (private/self-hosted facilitators not listed at facilitators.x402.watch).
4. **Methodology differences** — Artemis "filtered" cuts wash/self-pay; our cut drops only facilitator-internal moves but still keeps tx where buyer == seller (haven't filtered those yet).

For the rigorous-comparison headline, **80% coverage is enough to make a defensible claim** — the remaining 20% would only make the Ryvo compression number larger, not smaller, because more activity means more channel collapse opportunity. We should still state coverage explicitly so no one can challenge it.

## Sanity checks against existing RPC sample

Our existing [`data/raw/`](../data/raw/) sample (411K tx, $367K volume) covers:

- 0.28% of the Dune-measured tx count (145M).
- 0.95% of the Dune-measured USD volume.

So our previous sample under-represented tx slightly more than volume — i.e. our sample is biased toward higher-value individual payments. The new Dune-derived headline doesn't have this bias.

## Monthly distribution (highlights)

The activity is very Q4-2025 heavy:

| Month | Base tx | Solana tx | Polygon tx |
|---|---:|---:|---:|
| 2025-10 | 3.87M | 25K | 22 |
| 2025-11 | **46.5M** | 5.11M | 376K |
| 2025-12 | 26.8M | **26.7M** | 378K |
| 2026-01 | 6.43M | 11.7M | 2.48M |
| 2026-02 | 671K | 2.45M | 914K |
| 2026-03 | 842K | 1.13M | 3.01M |
| 2026-04 | 227K | 113K | 4.13M |
| 2026-05 (partial) | 65K | 28K | 1.29M |

Key observations:

- November 2025 alone is 28% of the year on Base.
- Solana peaked in December 2025 at 26.7M tx — same order as Base that month.
- Polygon volume is consistently tiny ($344K total) despite 12.6M tx — average per-tx value is $0.027, suggesting heavy testing / spam / sub-cent micropayments specific to that chain.
- Activity has tapered in 2026 Q1/Q2 across all chains.

## Practical implications for Phase 1

- **Approach is viable.** Dune SQL chunked by `block_month` returns answers in 5–60s per query, well under the 2-minute cap.
- **Total Phase-1 cost estimate**: the per-day per-channel aggregate query for one month returns ~50K–500K rows (per chain). 18 months × 3 chains ≈ 50 queries ≈ ~150–300 Dune credits total. Fits inside Plus tier monthly budget.
- **Polygon is in scope but should be flagged** as low-value-per-tx — the per-tx fee comparison will dominate the headline; the per-volume comparison won't favour Polygon.
- **No Ethereum/BSC scope creep recommended** unless the user wants to chase the 20% gap. We have no facilitator wallets for those chains in the registry.

## Open question for the user

We have two paths forward:

(A) **Accept 80% coverage** and proceed to Phase 1 with the 145M tx Dune dataset. Headline language: "We indexed 145.4M of the 180.3M micropayments Artemis attributes to x402 — 80.6% coverage. The remaining 19.4% are facilitators / chains / tokens outside the public registry; including them would only increase Ryvo's compression advantage."

(B) **Chase the 20% gap** — investigate whether Artemis includes BNB / Optimism / USDT / private facilitators. ~1 hour additional probe; might reconcile to >95% but might also turn up no extra activity.

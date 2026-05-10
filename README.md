# Ryvo Network × x402 Research (Solana-only, Artemis-truth)

Goal: take the Artemis-canonical x402 numbers
([classic.artemis.ai/asset/x402](https://classic.artemis.ai/asset/x402)) for **Solana**
and quantify exactly how many on-chain settlements Ryvo Network would need to clear
the same flow — and therefore the real fee/throughput advantage of the channel + BLS
clearing-round model.

The current rigorous result lives in [`analysis/launch.md`](analysis/launch.md), with
the full numerical breakdown in [`analysis/solana-artemis.md`](analysis/solana-artemis.md).

> **Scope (2026-05-10 onward):** This research is **Solana-only**. Base /
> Polygon / EVM analysis was retired so the brief can use Artemis as a single
> source of truth. Internal Dune-derived totals that don't reconcile with
> Artemis (e.g. our 47.28M Dune Solana tx vs Artemis's 7.58M for the matching
> window) have been demoted from headline numbers to topology proxies (the
> relationship graph and daily active-pair counts) — see "Methodology" in
> [`analysis/launch.md`](analysis/launch.md).

## Why this matters

x402 today is "one on-chain tx per micropayment". Ryvo Network does:

```
N micropayments between (buyer, seller)  →  1 channel state update (off-chain, free)
M channels with activity in a clearing window  →  1 BLS-aggregated on-chain settlement tx
```

So the win factor isn't just batching — it's two compressions stacked:

1. **Channel compression** = micropayments per (buyer, seller) pair.
2. **Clearing compression** = channels per BLS round (devnet-validated configurations:
   20 participants → 84 channels in 1 tx; 32 participants → 32 channels in 1 tx).

The full multiplicative win on the 7.58M Solana micropayments Artemis recorded
over 2025-10-20 → 2026-05-09 (202 days):

| | x402 today | Ryvo (Year 1, 84-ch round) | Ryvo (Steady state, 84-ch round) |
|---|---:|---:|---:|
| On-chain tx | 7,576,080 | 64,070 | 7,634 |
| Fees paid | $11,364 | $96 | $11.45 |
| Compression | 1× | **118×** | **992×** |

(Two framings because Ryvo channels are persistent and never closed — Year 1 includes
the bootstrap cost of opening 56,436 channels; steady state is the recurring annual cost.)

Plus, denominated in yield-bearing stablecoins at 3% APY, the same flow generates
**$12K – $49K/year** for participants — see `analysis/launch.md` for the full yield
projection.

## Folder layout

```
research/
  README.md                                  ← this file
  package.json
  .env.example                               ← required env vars (DUNE_API_KEY)
  notes/
    00-context.md                            ← x402 baseline numbers + sources
    01-data-sources.md                       ← APIs/dashboards
    02-collection-strategy.md                ← How we extract granular per-tx buyer→seller
    03-ryvo-math.md                          ← Channel + BLS clearing compression formulas
    04-findings.md                           ← Live results
  data/
    artemis/                                 ← Daily Artemis exports — the source of truth
    raw/
      facilitators.json                      ← Canonical x402 facilitator wallet registry
    processed/                               ← Dune topology proxy outputs
      daily_active_channels.json
      relationships_per_chain.json
      phase0_monthly.json
      solana_x402_fees_{daily,monthly}.json
  scripts/
    analyze-artemis-solana.ts                ← PRIMARY: Solana Ryvo math vs Artemis truth
    lib/
      dune.ts, facilitators.ts               ← Shared helpers for Dune scripts
    dune-probe.ts                            ← Validate Dune key + tier
    dune-probe-solana.ts                     ← Solana-specific probe
    dune-pull-aggregates.ts                  ← Pulls topology proxy (daily active, relationships)
    dune-pull-solana-fees.ts                 ← Solana fee aggregation
    dune-reconcile-chunked.ts                ← Legacy multi-chain Artemis reconciliation
    analyze-rigorous.ts                      ← Legacy multi-chain analyzer (retained for history)
    analyze-future-capacity.ts               ← Solana upgrade scenarios
  analysis/
    launch.md                                ← PRIMARY: public-facing brief
    launch-x-thread.md                       ← X / social-media thread draft
    solana-artemis.{md,json}                 ← PRIMARY: full numerical breakdown
    rigorous-comparison.{md,json}            ← Legacy multi-chain analyzer output (banner)
    future-capacity.{md,json}                ← Solana upgrade projection (banner)
    phase0-reconciliation.md                 ← Legacy Dune-vs-Artemis multi-chain reconciliation (banner)
```

## Quick start

```powershell
cd C:\ryvo\ryvo\research
npm install

# Primary: re-run the Solana × Artemis analysis
npm run analyze:solana
# → analysis/solana-artemis.{md,json}

# Optional — rebuild the Dune topology proxy (requires DUNE_API_KEY)
copy .env.example .env
npm run dune:pull           # → data/processed/daily_active_channels.json + relationships_per_chain.json
npm run analyze:rigorous    # → legacy multi-chain analyzer output (banner-marked)
```

See `notes/` for the full plan and `notes/04-findings.md` for live results.

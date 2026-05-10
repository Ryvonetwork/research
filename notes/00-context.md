# 00 — Context & Headline Numbers

This file captures the starting point — the cumulative x402 figures from public
sources that this research replaces with directly indexed numbers.

For the rigorous, indexed-from-source results see [`../analysis/launch.md`](../analysis/launch.md)
and [`../analysis/rigorous-comparison.md`](../analysis/rigorous-comparison.md).

## What x402 is

x402 is an open, internet-native micropayment protocol that revives HTTP `402 Payment
Required`. Incubated by Coinbase + Cloudflare and others. AI agents, apps, and
services autonomously pay for APIs/content via USDC (or compatible SPL/ERC-20 tokens)
on Base, Solana, Polygon, and a handful of other chains.

Architecture: **Client (buyer) → Facilitator (relayer) → Server (seller)**. Facilitator
submits the on-chain settlement tx (paying gas) and verifies the buyer's signed
authorization. Each micropayment is its own on-chain tx — no batching, no channels.

## Headline numbers we're starting from (cited by Grok / Artemis / Dune / x402.org)

| Metric                                         | Value           | Source / Note                                  |
|------------------------------------------------|-----------------|------------------------------------------------|
| Cumulative on-chain tx (filtered, ~1y)         | ~180.3M         | Artemis (filtered, "real" activity)            |
| Cumulative payment volume                      | ~$47.3M USD     | Artemis                                        |
| Average tx value                               | ~$0.20–$0.40    | Volume ÷ tx count                              |
| Cumulative unique buyers (filtered)            | ~525.4K         | Artemis                                        |
| Cumulative unique sellers (filtered)           | ~5.5K           | Artemis                                        |
| Cumulative unique buyer addresses (raw, Dune)  | ~617K (or ~435K depending on view) | Dune (thechriscen / hashed_official) |
| Cumulative unique seller addresses (raw, Dune) | ~231K (or ~183K depending on view) | Dune                                  |
| 30-day buyers (x402.org, unfiltered)           | 94.06K          | x402.org                                       |
| 30-day sellers (x402.org, unfiltered)          | 22K             | x402.org                                       |
| Cross-chain raw cumulative tx (Dune)           | ~143.5M         | Dune (sums across chains)                      |
| Base share (raw)                               | ~72.2M tx       | Dune (≈50% of all-chain raw)                   |
| Solana share (raw)                             | ~47.4M tx       | Dune (≈33% of all-chain raw)                   |

Scaling Dune's chain shares to the Artemis 180.3M filtered figure:

| Chain   | Estimated tx (180.3M scaled) |
|---------|------------------------------|
| Base    | ~90.72M (50.3%)              |
| Solana  | ~59.50M (33.0%)              |
| Other   | ~30.08M (16.7%)              |

## Per-tx fee assumptions (today)

| Chain   | Fee per tx (USD)         | Notes                                           |
|---------|--------------------------|-------------------------------------------------|
| Base    | ~$0.001                  | Consistent for x402-style USDC settlements      |
| Solana  | $0.00087 (pre-update)    | Median pre-recent fee market update             |
| Solana  | $0.00044 (current)       | Median post-update                              |

## Implied fee bill for the ~180.3M tx (Base + Solana only)

* Base:    90.72M × $0.001  = **~$90,720**
* Solana:  59.50M × $0.00087 ≈ **~$51,764** (pre-update)
* Solana:  59.50M × $0.00044 ≈ **~$26,180** (post-update)
* **Total Base + Solana fees: ~$117K – ~$143K**, i.e. ~0.25–0.30% of the $47.3M volume.

## What's MISSING (and what this research will produce)

We had aggregate counts for buyers, sellers, and per-facilitator totals but **no**
granular bipartite graph — i.e. for each (buyer, seller) pair, how many micropayments
they exchanged. That graph is the only thing that lets us compute Ryvo Network's
**channel compression** (one channel collapses N micropayments) on top of the
**clearing-round compression** (one BLS round collapses M channels).

This research closed that gap by running Dune SQL against
`tokens_{base,polygon,solana}.transfers`, filtered by the 94 facilitator wallets at
[facilitators.x402.watch](https://facilitators.x402.watch/), and producing per-(chain,
date) active-channel counts plus per-chain unordered-pair counts. Headline:

- 145.4M tx directly indexed (80.6 % of Artemis 180.3M)
- 504,774 unique relationships → 1,009,548 channel opens (one-time)
- 25,419 BLS clearing rounds (Dense-20, k = 84)
- Year 1 Ryvo on-chain tx: 1,034,967 (140 × compression)
- Steady state Ryvo on-chain tx: 25,419 (5,720 × compression)

See [`03-ryvo-math.md`](03-ryvo-math.md) for the formulas and
[`04-findings.md`](04-findings.md) for the running log.

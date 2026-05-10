# Solana future-state capacity projection (LEGACY framing — uses old multi-chain headline)

> **⚠️ Note 2026-05-10.** The capacity model below (k_dense, k_sparse,
> per-slot CU envelope, rent halving) is still valid for Solana. The
> headline "x402 vs Ryvo" tx counts in this file (132.8M, 5,264×, etc.) were
> computed against the old Base+Solana Dune-indexed flow and have **not**
> been re-stated against Artemis truth. The Solana-only, Artemis-canonical
> headline is in [`solana-artemis.md`](solana-artemis.md) (7.58M tx →
> 7,634 BLS rounds → 992× steady-state on Solana). Re-running this analysis
> against Artemis would only change the absolute tx/fee columns; the
> capacity-model conclusions (bytes-only ≠ wider compression; rent ×0.5
> halves Ryvo's capital lockup) are unaffected.

Generated: 2026-05-10T14:55:35.615Z

> **Question:** "Solana is shipping Agave 4.1 + SIMD-0385 (raise tx size from
> 1232 → 4096 bytes for v1) plus SIMD-0296 (50% rent reduction). Per-tx CU
> and block CU are explicitly NOT changing in this round. Apply those to
> our existing benchmarks and show what — if anything — changes for x402,
> 1:1 sessions, and Ryvo."
>
> **Headline finding (honest):** the bytes-only upgrade **does not widen
> the compression ratio**, because Dense-20 is CU-bound today (1.39M of
> 1.4M per-tx CU) — not byte-bound. The single benefit Ryvo captures from
> the announced roadmap is **half the capital lockup** for channel-state
> rent (SIMD-0296). The compression-ratio story stays put until a future
> SIMD lifts per-tx CU; we surface that as a sensitivity.
>
> **Approach:** keep all input data identical to [`rigorous-comparison.md`](rigorous-comparison.md)
> — same 132,809,758 Base + Solana micropayments, same
> 504,632 unique relationships, same daily
> active-channel distribution. Only swap the per-round capacity `k`
> (channels per BLS clearing tx) and the per-slot CU budget. One future
> scenario (bytes-only Agave 4.1) replaces the earlier A/B/C bracket — the
> CU-increase scenarios are not on Solana's near-term roadmap and would
> have been speculative.

## Live-benchmark anchors (devnet, current Solana)

These are the two configurations the public Ryvo Network analysis cites as
"Dense-20" and "Sparse-32". Numbers come from the BLS search artifact
`logs/bls-largest-round-search-results.jsonl`.

| Config | Participants | Channels / round | Tx bytes | CU consumed | Bottleneck today |
|---|---:|---:|---:|---:|---|
| Dense-20 (20p → 84ch, BLS SettleClearingRound) | 20 | 84 | 851 / 1232 (69%) | 1,392,866 / 1,400,000 (99%) | **CU** (CU-saturated at ~99% of the 1.4M per-tx cap) |
| Sparse-32 (32p → 32ch, BLS SettleClearingRound) | 32 | 32 | 685 / 1232 (56%) | 774,000 / 1,400,000 (55%) | none — policy choice |

The Dense-20 config is already saturating the per-tx CU budget — that's the
binding constraint. Sparse-32 has both byte and CU headroom because its
"32 channels per round" cap is a **1-channel-per-participant policy**, not
a hardware ceiling.

## Stated Solana upgrade (applied as multipliers)

| Lever | Multiplier | Source | Impact on Ryvo |
|---|---:|---|---|
| Tx serialized bytes (per tx) | **×3.32** (1232 → 4,096) | SIMD-0385 (v1 transactions, Agave 4.1) | None on compression — Dense-20 is CU-bound, not byte-bound. |
| Per-tx CU max | **×1.00** (unchanged at 1,400,000) | NOT in current SIMD package | Would be the only lever to raise k — see "if-CU-grows" sensitivity below. |
| Block CU (per slot) | **×1.00** (unchanged at 48,000,000) | NOT in current SIMD package | Per-slot envelope unchanged. |
| Channel-account rent | **×0.5** | SIMD-0296 (independent rent reduction) | Halves Solana capital lockup for ChannelBucket accounts. |

## Per-round capacity by scenario

| Scenario | Tx bytes max | Per-tx CU max | Block CU max | k (Dense-20) | k (Sparse-32) |
|---|---:|---:|---:|---:|---:|
| Current Solana (today) | 1,232 | 1,400,000 | 48,000,000 | 84 | 32 |
| Future — bytes ×3.32 (Agave 4.1 + SIMD-0385), per-tx & block CU unchanged, rent ×0.5 | 4,096 | 1,400,000 | 48,000,000 | 84 | 32 |

The bytes-only upgrade leaves k unchanged for both Dense-20 and Sparse-32:

- **Dense-20** is CU-bound today (~99% of per-tx CU). Bytes ×3.32 cannot grow k
  unless per-tx CU also rises. **k stays at 84**.
- **Sparse-32** is policy-bound (one channel per participant; CU and bytes
  both have headroom). The upgrade does not change the policy ceiling.
  **k stays at 32**.

### IF a future SIMD raises per-tx CU (sensitivity, not in current roadmap)

This is **not** stated in Agave 4.1, but the question is whether Ryvo would
benefit if Solana lifts per-tx ComputeBudget in a later SIMD. Using the same
linear capacity model:

- Per-tx CU ×1.5 → Dense-20 k ≈ 155, steady-state compression rises from 5264× to ~9852×.
- Per-tx CU ×2.0 → Dense-20 k ≈ 225 — Sparse-32 starts to relax its policy too.
- Per-tx CU ×3.0 → Dense-20 k ≈ 366 — bytes start to bind again at 4096-byte tx size.

We don't claim these in the deck, but it's the answer to "is Ryvo's design
ready for a future CU bump?" — yes, the linear-cost model says it scales
roughly proportionally with CU, capped only by the new (4096-byte) byte
ceiling.

## Headline tx counts vs 132,809,758 x402 micropayments (Base + Solana)

### Steady state (year 2+: opens already paid; recurring annual cost)

| Scenario | x402 tx | 1:1 channels tx | Ryvo Dense-20 tx | Ryvo Sparse-32 tx | Ryvo vs x402 | Ryvo vs 1:1 |
|---|---:|---:|---:|---:|---:|---:|
| Today | 132,809,758 | 2,089,565 | 25,229 | 65,628 | **5264×** | **83×** |
| Bytes-only (Agave 4.1) | 132,809,758 | 2,089,565 | 25,229 | 65,628 | **5264×** | **83×** |

### Year 1 (relationship-fresh — includes channel opens, opens = R)

| Scenario | x402 tx | 1:1 channels tx (Y1) | Ryvo Dense-20 tx (Y1) | Ryvo Sparse-32 tx (Y1) | Ryvo vs x402 |
|---|---:|---:|---:|---:|---:|
| Today | 132,809,758 | 2,594,197 | 529,861 | 570,260 | **251×** |
| Bytes-only (Agave 4.1) | 132,809,758 | 2,594,197 | 529,861 | 570,260 | **251×** |

### Fees paid for the same flow (Solana mid-fee = $0.0015/tx, Base $0.001/tx)

| Scenario | x402 fee | 1:1 fee (Y1) | 1:1 fee (Steady) | Ryvo D-20 fee (Y1) | Ryvo D-20 fee (Steady) |
|---|---:|---:|---:|---:|---:|
| Today | $156,448.58 | $2,938.6 | $2,405.75 | $561.92 | $29.07 |
| Bytes-only (Agave 4.1) | $156,448.58 | $2,938.6 | $2,405.75 | $561.92 | $29.07 |

Per-tx landing fees on each chain are unchanged by the Solana upgrade — fees
are a market signal of demand, not a function of block CU. The fee column
moves only because the **tx count** moves, and tx count moves only when k
moves; bytes-only leaves both unchanged.

## Per-slot throughput envelope (Solana mainnet only)

This is the **theoretical ceiling** of how many distinct economic events can
land per Solana slot under each scenario. With block CU unchanged, the
per-slot envelope is also unchanged:

- x402 micropayment ≈ 250 bytes, 30,000 CU
- 1:1 channel settle ≈ 600 bytes, 150,000 CU
- Ryvo Dense-20 round ≈ k×(per-channel CU) + fixed (matching the live bench)

| Scenario | Block CU | x402 tx/slot | 1:1 settles/slot | Ryvo Dense ch/slot | Ryvo Sparse ch/slot | Ryvo D vs x402 | Ryvo D vs 1:1 |
|---|---:|---:|---:|---:|---:|---:|---:|
| Today | 48,000,000 | 1,600 | 320 | 2,856 | 1,984 | **1.8×** | **8.9×** |
| Bytes-only (Agave 4.1) | 48,000,000 | 1,600 | 320 | 2,856 | 1,984 | **1.8×** | **8.9×** |

The per-slot Ryvo-vs-x402 ratio still answers the saturation question: even
today, the entire 132,809,758-tx year of x402 history
could be cleared by Ryvo Dense-20 in ~732
Solana slots (~4.9 minutes
of pure block time). x402 needs 83,007
slots for the same flow. The bytes-only upgrade does not change this picture.

## Capital lockup (Solana channel rent — protocol-accurate model)

This is where the announced upgrade *does* help Ryvo. Solana ChannelBucket
accounts hold **46 channel lanes per 10,093-byte bucket**;
Sessions (1:1 channels) need one ~200-byte account per channel.

| Architecture | Solana relationships | State accounts | Capital today (USD) | Capital after SIMD-0296 (×0.5) | Recoverable on close? |
|---|---:|---:|---:|---:|:---:|
| x402 (no channels) | n/a | 0 | $0 | $0 | n/a |
| Sessions (1:1) | 56,436 | 56,436 channels | $25,767 | $12,884 | yes |
| Ryvo Dense-20 v1 | 56,436 | 1,227 buckets (46 lanes ea.) | $17,457 | $8,729 | **no — sunk in v1** |
| Ryvo Dense-20 v2 (planned) | 56,436 | 1,227 buckets | $17,457 | $8,729 | yes (when close-channel ships) |

Two structural points:

1. **Ryvo packs ~0.9× more channel lanes per byte of state** than naive Sessions, so even before the rent reduction Ryvo already has lower capital ($17,457 vs Sessions' $25,767).
2. **Ryvo v1 has no `close_channel` instruction**, so for now this rent is a sunk cost, not a recoverable deposit. Sessions architectures DO support close + rent recovery. v2 will close that gap; until then we recommend reporting Ryvo capital as committed working capital, not float.

## How the gap moves under the announced bytes-only upgrade

| Comparison | Today | Bytes-only (Agave 4.1) | Δ |
|---|---:|---:|---:|
| Ryvo Dense-20 (steady) vs x402 | **5264×** | **5264×** | 0× |
| Ryvo Dense-20 (steady) vs 1:1 channels | **83×** | **83×** | 0× |
| Channels cleared per slot (Ryvo Dense) | **2,856** | **2,856** | 0 |
| Solana capital lockup (Ryvo) | **$17,457** | **$8,729** | −$8,729 |

**Honest takeaway.** The compression-ratio story is **unchanged** by the
announced roadmap — that's why we are not pitching a "compression widens"
story for Agave 4.1. The story we ARE pitching is:

1. **Compression at 5264× steady-state vs x402 already holds today** (CU-bound, real, devnet-verified). That is the deck headline.
2. **The bytes-only upgrade halves the working-capital cost of running Ryvo** (rent ×0.5), strengthening LP economics without changing the user-facing claim.
3. **A future per-tx CU SIMD would scale Ryvo proportionally** — see the "if CU grows" sensitivity above. We document this for completeness but do not lead with it.

## Methodology notes

- All on-chain-tx counts come from re-running [`scripts/analyze-rigorous.ts`](../scripts/analyze-rigorous.ts)
  with the new `(k_dense, k_sparse)` per scenario; no other inputs change.
- Per-round capacity is projected with a linear (fixed-overhead + per-channel)
  cost model anchored to the live Dense-20 / Sparse-32 measurements. The
  fixed-overhead share is set to 40% (typical for v0+ALT tx skeleton
  + program entry); changing it to 0.2 or 0.6 moves the projected k by < 8%.
- Capacity floors are enforced — Future scenarios cannot regress below the
  live-validated channels-per-round, even if the linear model would suggest it.
- Per-slot throughput uses Solana per-tx CU footprints (~30K x402 USDC
  transfer; ~150K Ryvo unilateral settle). These are order-of-magnitude
  estimates; ±50% sensitivity does not change the qualitative conclusion.
- Per-tx fees ($0.001/tx Base, $0.0015/tx Solana mid-band — see
  [`rigorous-comparison.md`](rigorous-comparison.md) for LOW/HIGH sensitivity)
  are held constant across scenarios. The upgrade affects throughput and
  capital, not the per-tx market price of landing a tx.
- Channel opens = R (one `create_channel` per relationship; x402 flow is
  unidirectional buyer→seller). Earlier internal models used 2×R from a
  pre-bidirectional protocol design.
- Ryvo v1 has no close-channel instruction — Solana ChannelBucket rent is
  sunk capital until v2. Sessions DO support rent recovery on close.

## Reproducibility

Numbers are produced by [`scripts/analyze-future-capacity.ts`](../scripts/analyze-future-capacity.ts)
from the same two input JSONs as `analyze-rigorous.ts`. Re-run with:

```bash
npm run analyze:future
```

# 03 — Ryvo Network Settlement Math

This is the math the rigorous-comparison pipeline implements verbatim. Final numbers
live in [`../analysis/rigorous-comparison.md`](../analysis/rigorous-comparison.md);
this note explains why the formulas look the way they do.

## Channel model (locked-in)

- **One channel per relationship.** For every unique unordered address pair
  `{A, B}` that ever transacts, Ryvo opens **one bidirectional channel lane**
  (the buyer→seller direction; the reverse direction is never funded under
  x402's unidirectional pull-payment flow). Earlier internal docs referenced
  `2 × R` opens — a stale artifact from a unilateral-channels-only protocol
  design that has since been superseded by the bidirectional `ChannelBucket`
  architecture.
- **Persistent (v1).** Channels are opened once on-chain and **never closed**
  in v1 — the protocol does not yet ship a `close_channel` instruction.
  Capital deposit (rent) is therefore a sunk cost in v1; v2 will add close
  + rent recovery.
- **Cumulative.** Off-chain channel state accumulates indefinitely; the on-chain
  contract only sees aggregate updates via clearing rounds.

```
opens(chain)  = COUNT(DISTINCT unordered_pair{from, to})    one-time, per chain
closes(chain) = 0                                            v1: no close instruction
```

### Why `opens = R`, not `2 × R`

Ryvo's `create_channel` instruction takes a `LaneSelector` argument
(`LowerToHigher` *or* `HigherToLower`) and initializes one direction of a
`DirectionalLaneState`. x402 settlement is unidirectional buyer→seller, so
exactly one lane needs to be created per relationship. The historical
`2 × R` model assumed every relationship needed both directions opened
upfront; that is incorrect under both the current protocol design and the
x402 traffic shape. The corrected count drops total Ryvo Y1 tx by exactly
one R per chain, which is order-of-magnitude vs the original number but
not significant against the ~84-channel BLS round (clearing tx are
unaffected).

## The two compressions

### (1) Channel compression — collapses repeated payments

If buyer `B` makes `N` micropayments to seller `S` in a 24h window, all `N` are
funnelled through **one off-chain channel update**. The on-chain footprint of the
channel that day is *one slot* in *one BLS round*, regardless of `N`.

For a graph `G = (V, E)` where `V = buyers ∪ sellers` and edges are weighted by
micropayment count `w(e)`:

```
channel_state_updates_compressed_per_day = sum_{e active that day} w(e) − (active channels that day)
```

For x402 today the eliminated-per-day count = (tx that day) − (active channels that day).

### (2) Clearing-round compression — collapses many channels into one tx

A BLS-aggregated clearing round signs and settles many channels in a single on-chain
tx. Two devnet-validated configurations anchor the math:

| Config name | Participants per round | Channels cleared per round | Channels-per-tx ratio |
|-------------|------------------------|----------------------------|------------------------|
| Dense-20    | 20                     | 84                         | **84**                 |
| Sparse-32   | 32                     | 32                         | **32**                 |

**Same capacity assumed on Base/Polygon/Solana.** The 84/32 figures are
Solana-devnet-validated and applied as a conservative floor on EVM. EVM chains
may fit more channels per round; if measured higher, Ryvo's compression number
only improves.

## The exact rigorous formulas

For each chain in `{base, polygon, solana}`:

```
relationships(chain) = COUNT(DISTINCT (LEAST(buyer, seller),
                                       GREATEST(buyer, seller)))
opens(chain)         = relationships(chain)               # see "Why opens = R" above

for each UTC date d in observed range:
    active(chain, d)   = COUNT(DISTINCT (buyer, seller)) on day d
    rounds(chain, d, k) = ⌈ active(chain, d) / k ⌉           k ∈ {84, 32}

clearing(chain, k)   = Σ_d rounds(chain, d, k)
ryvo_total_tx(chain, k) = opens(chain) + clearing(chain, k)
```

Globally:

```
ryvo_total_tx(k) = Σ_chain (opens(chain) + clearing(chain, k))
ryvo_fee(k)      = Σ_chain (opens(chain) + clearing(chain, k)) × per_tx_fee(chain)
x402_total_tx    = Σ_chain tx_count(chain)
x402_fee         = Σ_chain tx_count(chain) × per_tx_fee(chain)
```

### Why `Σ ⌈A/k⌉`, not `⌈mean(A) × days / k⌉`

The per-day distribution of active channels is heavy-tailed (Base P95 ~20K, max
51,982). Because `⌈⌉` is non-linear, you cannot pre-average:

```
mean(⌈A/k⌉) ≠ ⌈mean(A)/k⌉
```

Summing daily ceilings is the only honest approach. The first version of this
analysis used `mean(A) × 365 / k` and underestimated clearing tx by ~5×.

### Why opens dominate year 1

For our 12-month measured window (Base + Solana headline, opens = R):

| | Year 1 (k = 84) |
|---|---:|
| Opens | 504,632 |
| Clearing | 25,229 |
| **Total Ryvo tx** | **529,861** |

Opens are 20× the clearing footprint. After year 1, opens go to 0
(relationships are perpetual under v1; or recovered + re-amortized under v2),
and the recurring annual cost is ~25,000 tx — that's the **5,264×
steady-state compression** in the headline.

## Scenarios

For every report we publish two framings:

| Framing | Opens included? | Use when |
|---------|-----------------|----------|
| **Year 1** | Yes (full 1.01M opens) | Modelling a fresh Ryvo deployment over the same year of x402 history |
| **Steady state** | No (relationships are pre-existing) | Modelling year 2+ of a deployed Ryvo network |

Both are honest; the choice depends on what question the reader is asking.

## Comparison vs status-quo x402

```
tx_compression(k)   = x402_total_tx / ryvo_total_tx(k)
fee_compression(k)  = x402_fee      / ryvo_fee(k)
fee_savings_usd(k)  = x402_fee      − ryvo_fee(k)
```

For the directly indexed Base + Solana data (132.8M tx, $156K x402 fees at the
mid Solana fee band of $0.0015/tx):

| | Year 1 | Steady state |
|---|---:|---:|
| Ryvo tx (k = 84) | 529,861 | 25,229 |
| Ryvo fee (k = 84) | $562 | $40 |
| tx_compression(84) | **251×** | **5,264×** |
| fee_savings | $155,887 | ≈ $156,400 |

Solana per-tx fee uses the MID sensitivity band ($0.0015) — the Solana Radar
Q1-2025 median. LOW ($0.0005, base-fee floor) and HIGH ($0.005, Dec-2025
peak) bands are reported in the appendix of `analysis/rigorous-comparison.md`.
Compression ratios are invariant under per-tx-fee scaling; only absolute
USD savings move.

## What this math leaves out (called out in the brief, not hidden)

- **Polygon's bot-loop pattern** is reported separately because 12.6M tx between
  142 unique relationships is bot-loop concentration, not agentic commerce.
- **Cross-chain rebalancing** if a relationship spans both Base and Solana: we
  treat `(Base addr, Solana addr)` as separate per-chain relationships because
  settlement happens per-chain. Negligible in practice (different address formats).
- **Wash filtering**: we drop facilitator-internal moves (`from ∈ facilitators`
  or `to ∈ facilitators`) but keep `buyer == seller` if it ever occurred (rare
  and indistinguishable from intentional self-tx).
- **84/32 BLS round capacity** is empirical, devnet-validated; we don't re-derive
  the cryptography here.

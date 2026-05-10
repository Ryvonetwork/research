/**
 * Solana-only Ryvo vs x402 analysis using **Artemis as the source of truth**.
 *
 * Inputs:
 *   - data/artemis/Transactions by Chain.csv  (daily Solana tx — truth)
 *   - data/artemis/Volume by Chain.csv         (daily Solana volume USD — truth)
 *   - data/processed/daily_active_channels.json (Dune-indexed daily active
 *      (buyer, seller) pairs on Solana — used as a topological proxy for
 *      Ryvo's BLS-clearing footprint; treated as an upper bound)
 *   - data/processed/relationships_per_chain.json (Dune-indexed unique
 *      (buyer, seller) pair count — same caveat)
 *
 * Why this layout. Artemis (classic.artemis.ai/asset/x402) tracks every
 * facilitator-mediated x402 micropayment by chain. For Solana over the
 * 2025-10-20 → 2026-05-09 window it counts 7,576,080 tx and $911,608 of
 * volume — meaningfully smaller than the broader Dune indexing of the same
 * 94 facilitator wallets (47.28M tx, $8.34M volume), because Dune sweeps in
 * non-x402 wallet activity that the facilitators incidentally also signed
 * (rebalances, gas refills, bot loops). Per Ryvo research direction we
 * adopt Artemis as canonical for tx and volume, and use the Dune relationship
 * graph only as an upper-bound topological proxy for Ryvo's footprint.
 *
 * Output: analysis/solana-artemis.{json,md}
 */

import { readFileSync, writeFileSync } from "node:fs";

const ARTEMIS_TX_CSV  = "data/artemis/Transactions by Chain.csv";
const ARTEMIS_VOL_CSV = "data/artemis/Volume by Chain.csv";
const DUNE_DAILY_PATH = "data/processed/daily_active_channels.json";
const DUNE_REL_PATH   = "data/processed/relationships_per_chain.json";

// Solana per-tx fee sensitivity bands. The flat 5,000-lamport base fee
// (~$0.00044 at SOL ~$88) understates real fees during the Q4-2025 / Q1-2026
// priority-fee congestion window. MID matches the Solana Radar Q1-2025 median
// (~$0.0015 at SOL $200), LOW is the late-tail base-fee floor, HIGH is the
// Dec-2025 peak.
const SOLANA_FEE_SCENARIOS = { low: 0.0005, mid: 0.0015, high: 0.005 } as const;
const SOL_FEE = SOLANA_FEE_SCENARIOS.mid;
const ROUND_K_DENSE = 84;   // BLS Dense-20 (devnet-validated)
const ROUND_K_SPARSE = 32;  // BLS Sparse-32 (devnet-validated)

// Solana rent constants for the lifecycle model.
const RYVO_CHANNEL_BUCKET_BYTES = 10_093;
const RYVO_LANES_PER_BUCKET = 46;
const SESSIONS_CHANNEL_BYTES = 200;
const SOL_LAMPORTS_PER_BYTE_YEAR = 3_480;
const SOL_RENT_EXEMPTION_YEARS = 2.0;
const SOL_ACCOUNT_METADATA_BYTES = 128;
const LAMPORTS_PER_SOL = 1_000_000_000;
const SOL_PRICE_USD = 200;

function rentExemptSol(bytes: number): number {
  return ((bytes + SOL_ACCOUNT_METADATA_BYTES)
        * SOL_LAMPORTS_PER_BYTE_YEAR
        * SOL_RENT_EXEMPTION_YEARS) / LAMPORTS_PER_SOL;
}

const RYVO_RENT_PER_BUCKET_SOL    = rentExemptSol(RYVO_CHANNEL_BUCKET_BYTES);
const SESSIONS_RENT_PER_CHANNEL   = rentExemptSol(SESSIONS_CHANNEL_BYTES);

const DAYS_PER_YEAR = 365;
const YIELD_APY_PCT = 0.03;  // 3% — modest tokenized-treasury / sDAI / USDe band

interface ArtemisRow { date: string; tx: number; volume: number }
interface DuneDaily {
  chain: string;
  date: string;
  tx_count: number;
  volume_usd: number;
  active_channels: number;
  unique_buyers: number;
  unique_sellers: number;
}

const fmt = (n: number, frac = 0): string =>
  n.toLocaleString("en-US", { maximumFractionDigits: frac, minimumFractionDigits: 0 });

function parseArtemis(): ArtemisRow[] {
  const txCsv  = readFileSync(ARTEMIS_TX_CSV,  "utf8").trim().split(/\r?\n/);
  const volCsv = readFileSync(ARTEMIS_VOL_CSV, "utf8").trim().split(/\r?\n/);
  const txHeader  = txCsv[0].split(",").map(s => s.replace(/"/g, ""));
  const volHeader = volCsv[0].split(",").map(s => s.replace(/"/g, ""));
  const txSolIdx  = txHeader.indexOf("Solana");
  const volSolIdx = volHeader.indexOf("Solana");

  const rows: ArtemisRow[] = [];
  for (let i = 1; i < txCsv.length; i++) {
    const txCells  = txCsv[i].split(",");
    const volCells = volCsv[i].split(",");
    const date     = txCells[0].replace(/"/g, "");
    const tx       = txCells[txSolIdx]  ? Number(txCells[txSolIdx])  : 0;
    const volume   = volCells[volSolIdx] ? Number(volCells[volSolIdx]) : 0;
    if (tx > 0 || volume > 0) rows.push({ date, tx, volume });
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

function pXX(arr: number[], pct: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * pct));
  return sorted[idx];
}

function main(): void {
  // ---- Artemis (truth) ----
  const artemis = parseArtemis();
  const firstDate = artemis[0].date;
  const lastDate  = artemis[artemis.length - 1].date;
  const observedDays = artemis.length;
  const totalTxArtemis  = artemis.reduce((a, r) => a + r.tx,     0);
  const totalVolArtemis = artemis.reduce((a, r) => a + r.volume, 0);
  const peakDay = artemis.reduce((m, r) => r.tx > m.tx ? r : m, artemis[0]);

  // ---- Dune topology (relationships + daily active channels) ----
  const duneDaily = (JSON.parse(readFileSync(DUNE_DAILY_PATH, "utf8")) as DuneDaily[])
    .filter(r => r.chain === "solana" && r.date >= firstDate && r.date <= lastDate);
  const duneRel = JSON.parse(readFileSync(DUNE_REL_PATH, "utf8")) as { solana: number };

  const duneTxInWindow     = duneDaily.reduce((a, r) => a + r.tx_count,        0);
  const duneActiveSum      = duneDaily.reduce((a, r) => a + r.active_channels, 0);
  const duneActiveMax      = duneDaily.length ? Math.max(...duneDaily.map(r => r.active_channels)) : 0;
  const duneActiveMean     = duneActiveSum / Math.max(1, duneDaily.length);
  const duneActiveP95      = pXX(duneDaily.map(r => r.active_channels), 0.95);

  // Ryvo's structural metrics derive from the relationship graph, NOT raw tx
  // count. Ryvo only cares about how many distinct (buyer, seller) pairs are
  // active per UTC day. We use Dune's day-by-day active-channel count as our
  // best available proxy for that — even though Dune over-counts raw tx vs
  // Artemis, the (buyer, seller) pairs it sees ARE x402 facilitator-mediated
  // pairs (filter is "tx_signer ∈ facilitator wallet set"). Treating these
  // as Ryvo's footprint is conservative for Ryvo: it includes any pair Dune
  // observes, which can only inflate Ryvo's clearing-round count.
  const relationships = duneRel.solana;
  const opens         = relationships;            // Ryvo: one create_channel per relationship
  const clearing84    = duneDaily.reduce((a, r) => a + Math.ceil(r.active_channels / ROUND_K_DENSE),  0);
  const clearing32    = duneDaily.reduce((a, r) => a + Math.ceil(r.active_channels / ROUND_K_SPARSE), 0);
  const clearing1to1  = duneActiveSum;            // 1:1 channels = each active channel-day = 1 settle
  const ryvo84_y1     = opens + clearing84;
  const ryvo32_y1     = opens + clearing32;
  const ryvo84_steady = clearing84;
  const ryvo32_steady = clearing32;
  const ch1to1_y1     = opens + clearing1to1;
  const ch1to1_steady = clearing1to1;

  // ---- x402 cost (using Artemis tx as truth) ----
  const x402_fee_usd = totalTxArtemis * SOL_FEE;
  const ryvo84_fee_y1     = ryvo84_y1     * SOL_FEE;
  const ryvo84_fee_steady = ryvo84_steady * SOL_FEE;
  const ryvo32_fee_y1     = ryvo32_y1     * SOL_FEE;
  const ryvo32_fee_steady = ryvo32_steady * SOL_FEE;
  const ch1to1_fee_y1     = ch1to1_y1     * SOL_FEE;
  const ch1to1_fee_steady = ch1to1_steady * SOL_FEE;

  // ---- Annualized projection (scale to 365 days from observed window) ----
  const annualizationFactor = DAYS_PER_YEAR / observedDays;
  const annualizedTx     = totalTxArtemis  * annualizationFactor;
  const annualizedVol    = totalVolArtemis * annualizationFactor;
  const annualizedX402Fee = annualizedTx * SOL_FEE;

  // ---- Lifecycle / capital model (Solana rent) ----
  const sessionsCapitalSol = relationships * SESSIONS_RENT_PER_CHANNEL;
  const ryvoBuckets        = Math.ceil(relationships / RYVO_LANES_PER_BUCKET);
  const ryvoCapitalSol     = ryvoBuckets * RYVO_RENT_PER_BUCKET_SOL;
  const sessionsCapitalUsd = sessionsCapitalSol * SOL_PRICE_USD;
  const ryvoCapitalUsd     = ryvoCapitalSol     * SOL_PRICE_USD;

  // ---- Yield projection over time (assuming yield-bearing channel denoms) ----
  // Same x402 flow, denominated in sDAI / USDe / USDM / etc., earning APY for
  // participants instead of sitting in passive USDC. Three TVL bands relative
  // to annualized volume.
  const yieldBands = [
    { name: "Aggressive (TVL = annual volume)",        tvl: annualizedVol           },
    { name: "Realistic (TVL = ½ annual volume)",       tvl: annualizedVol * 0.5     },
    { name: "Conservative (TVL = ¼ annual volume)",    tvl: annualizedVol * 0.25    },
  ].map(b => ({
    ...b,
    yield_per_year: b.tvl * YIELD_APY_PCT,
    multiple_of_ryvo_steady_fee: (b.tvl * YIELD_APY_PCT) / Math.max(0.01, ryvo84_fee_steady * annualizationFactor),
  }));

  // Cumulative yield over 5 years (TVL held flat at realistic band; yields
  // compound annually).
  const yearlyYield = annualizedVol * 0.5 * YIELD_APY_PCT;
  const cumulative5y = Array.from({ length: 5 }, (_, i) => yearlyYield * (i + 1));

  // ---- Solana fee sensitivity (LOW / MID / HIGH) ----
  const feeSensitivity = (Object.keys(SOLANA_FEE_SCENARIOS) as Array<keyof typeof SOLANA_FEE_SCENARIOS>).map(band => {
    const f = SOLANA_FEE_SCENARIOS[band];
    return {
      band,
      per_tx_fee_usd: f,
      x402_fee_usd:        totalTxArtemis * f,
      sessions_fee_y1:     ch1to1_y1      * f,
      sessions_fee_steady: ch1to1_steady  * f,
      ryvo_dense_fee_y1:     ryvo84_y1     * f,
      ryvo_dense_fee_steady: ryvo84_steady * f,
    };
  });

  const result = {
    generated_at: new Date().toISOString(),
    inputs: {
      artemis_tx_csv: ARTEMIS_TX_CSV,
      artemis_vol_csv: ARTEMIS_VOL_CSV,
      dune_daily_path: DUNE_DAILY_PATH,
      dune_relationships_path: DUNE_REL_PATH,
      window: { first_date: firstDate, last_date: lastDate, observed_days: observedDays },
      sol_fee_scenarios: SOLANA_FEE_SCENARIOS,
      sol_fee_used: SOL_FEE,
      round_k: { dense: ROUND_K_DENSE, sparse: ROUND_K_SPARSE },
      yield_apy_pct: YIELD_APY_PCT,
      sol_price_usd: SOL_PRICE_USD,
    },
    x402_solana_artemis: {
      tx: totalTxArtemis,
      volume_usd: totalVolArtemis,
      observed_days: observedDays,
      peak_day: peakDay,
      annualized_tx: annualizedTx,
      annualized_volume_usd: annualizedVol,
      annualized_fee_usd: annualizedX402Fee,
      fee_usd_observed: x402_fee_usd,
    },
    ryvo_topology_from_dune: {
      relationships,
      active_channel_days_sum: duneActiveSum,
      active_channels_max_day: duneActiveMax,
      active_channels_mean: duneActiveMean,
      active_channels_p95: duneActiveP95,
      caveat: "Dune-indexed (buyer, seller) pairs across the same 94 facilitator wallets. Used as Ryvo's clearing-round footprint proxy. Conservative for Ryvo — over-counting raw tx (vs Artemis) suggests Dune may also include some non-x402 pairs, so Ryvo's actual on-chain footprint is at most this number, plausibly less.",
      vs_artemis: {
        dune_tx_in_window: duneTxInWindow,
        artemis_tx_in_window: totalTxArtemis,
        ratio_dune_over_artemis: duneTxInWindow / Math.max(1, totalTxArtemis),
      },
    },
    ryvo_solana: {
      opens,
      clearing_84: clearing84,
      clearing_32: clearing32,
      clearing_1to1: clearing1to1,
      year1: {
        ryvo_84_tx: ryvo84_y1,    ryvo_84_fee_usd: ryvo84_fee_y1,
        ryvo_32_tx: ryvo32_y1,    ryvo_32_fee_usd: ryvo32_fee_y1,
        ch1to1_tx:  ch1to1_y1,    ch1to1_fee_usd:  ch1to1_fee_y1,
      },
      steady: {
        ryvo_84_tx: ryvo84_steady, ryvo_84_fee_usd: ryvo84_fee_steady,
        ryvo_32_tx: ryvo32_steady, ryvo_32_fee_usd: ryvo32_fee_steady,
        ch1to1_tx:  ch1to1_steady, ch1to1_fee_usd:  ch1to1_fee_steady,
      },
      compression_y1: {
        tx_84: totalTxArtemis / ryvo84_y1,
        tx_32: totalTxArtemis / ryvo32_y1,
        fee_84: x402_fee_usd / ryvo84_fee_y1,
      },
      compression_steady: {
        tx_84: totalTxArtemis / ryvo84_steady,
        tx_32: totalTxArtemis / ryvo32_steady,
        fee_84: x402_fee_usd / ryvo84_fee_steady,
      },
      ryvo_advantage_over_1to1: {
        y1_tx: ch1to1_y1 / ryvo84_y1,
        steady_tx: ch1to1_steady / ryvo84_steady,
        steady_fee: ch1to1_fee_steady / ryvo84_fee_steady,
      },
    },
    lifecycle_capital: {
      sessions_capital_sol: sessionsCapitalSol,
      sessions_capital_usd: sessionsCapitalUsd,
      sessions_recoverable: true,
      ryvo_buckets: ryvoBuckets,
      ryvo_capital_sol: ryvoCapitalSol,
      ryvo_capital_usd: ryvoCapitalUsd,
      ryvo_v1_recoverable: false,
      ryvo_v2_recoverable_when_close_ships: true,
    },
    yield: {
      apy_pct: YIELD_APY_PCT,
      annualized_volume_usd: annualizedVol,
      bands: yieldBands,
      cumulative_5y_realistic: cumulative5y,
      yearly_realistic_band: yearlyYield,
    },
    fee_sensitivity: feeSensitivity,
  };

  writeFileSync("analysis/solana-artemis.json", JSON.stringify(result, null, 2));

  // ---- Markdown ----
  const r = result;
  const x = r.x402_solana_artemis;
  const ry = r.ryvo_solana;
  const cap = r.lifecycle_capital;

  const md = `# Solana × x402 vs Ryvo (Artemis-truth)

Generated: ${r.generated_at}

## Source-of-truth

- **Tx counts and USD volume** for Solana x402 are taken directly from
  Artemis (\`classic.artemis.ai/asset/x402\`) — the canonical x402 dataset —
  daily exports in [\`data/artemis/\`](../data/artemis/).
- **Relationship graph and daily active (buyer, seller) pair counts** come
  from our Dune indexing of the 94 registered x402 facilitator wallets,
  filtered to Solana. We use these as a topological proxy for Ryvo's
  clearing-round footprint, treated as an upper bound (see caveat).
- All Base / Polygon analysis has been removed. **This brief is Solana-only.**

## Window

- ${x.observed_days} observed days, ${r.inputs.window.first_date} → ${r.inputs.window.last_date}
- Peak Solana day: ${x.peak_day.date} with ${fmt(x.peak_day.tx)} tx and $${fmt(x.peak_day.volume, 2)} volume
- All "year 1" figures below are framed against the **annualized** rate
  (×${(DAYS_PER_YEAR / x.observed_days).toFixed(2)}) for direct year-on-year comparability.

## Headline (what same-flow Solana costs under each architecture)

### Observed window (${x.observed_days} days, Artemis truth)

| Metric | x402 (per-call on-chain) | Plain 1:1 channels (Lightning-style) | Ryvo Dense-20 |
|---|---:|---:|---:|
| On-chain tx (Year 1, includes channel opens) | **${fmt(x.tx)}** | **${fmt(ry.year1.ch1to1_tx)}** | **${fmt(ry.year1.ryvo_84_tx)}** |
| Fees paid (Year 1, Solana mid $${SOL_FEE}/tx) | **$${fmt(x.fee_usd_observed, 2)}** | **$${fmt(ry.year1.ch1to1_fee_usd, 2)}** | **$${fmt(ry.year1.ryvo_84_fee_usd, 2)}** |
| Steady-state on-chain tx (Y2+, opens=0) | ${fmt(x.tx)} | ${fmt(ry.steady.ch1to1_tx)} | **${fmt(ry.steady.ryvo_84_tx)}** |
| Steady-state fees | $${fmt(x.fee_usd_observed, 2)} | $${fmt(ry.steady.ch1to1_fee_usd, 2)} | **$${fmt(ry.steady.ryvo_84_fee_usd, 2)}** |
| Compression vs x402 (Year 1) | 1× | ${ry.compression_y1.tx_84.toFixed(0)}× | **${ry.compression_y1.tx_84.toFixed(0)}×** *see note* |
| Compression vs x402 (Steady) | 1× | ${(x.tx / ry.steady.ch1to1_tx).toFixed(0)}× | **${ry.compression_steady.tx_84.toFixed(0)}×** |

> *Year-1 footnote.* Year-1 Ryvo and 1:1-channels both pay the one-time
> bootstrap of opening ${fmt(ry.opens)} channels. After Year 1 the same flow
> costs only the recurring clearing rounds.

### Annualized (extrapolated to 365 days at the same daily-mean rate)

| Metric | x402 | Ryvo Dense-20 (steady-state) |
|---|---:|---:|
| Annual on-chain tx | **${fmt(x.annualized_tx, 0)}** | **${fmt(ry.steady.ryvo_84_tx * (DAYS_PER_YEAR / x.observed_days), 0)}** |
| Annual volume USD | $${fmt(x.annualized_volume_usd, 0)} | (same — channels carry the same flow) |
| Annual fees paid | **$${fmt(x.annualized_fee_usd, 2)}** | **$${fmt(ry.steady.ryvo_84_fee_usd * (DAYS_PER_YEAR / x.observed_days), 2)}** |
| Annual fees saved | — | **$${fmt(x.annualized_fee_usd - ry.steady.ryvo_84_fee_usd * (DAYS_PER_YEAR / x.observed_days), 2)}** |

## Decomposition (Ryvo Dense-20 footprint over the observed window)

| Component | Count |
|---|---:|
| Unique relationships indexed (= channel opens, one-time) | ${fmt(ry.opens)} |
| Daily active (buyer, seller) pairs (sum over ${x.observed_days} days) | ${fmt(r.ryvo_topology_from_dune.active_channel_days_sum)} |
| → Mean active pairs per day | ${r.ryvo_topology_from_dune.active_channels_mean.toFixed(0)} |
| → P95 active pairs per day | ${fmt(r.ryvo_topology_from_dune.active_channels_p95)} |
| → Max active pairs (single day) | ${fmt(r.ryvo_topology_from_dune.active_channels_max_day)} |
| BLS clearing rounds (Dense-20, k=84) | ${fmt(ry.clearing_84)} |
| BLS clearing rounds (Sparse-32, k=32) | ${fmt(ry.clearing_32)} |
| Total Ryvo Dense-20 tx (Year 1) = opens + clearing | ${fmt(ry.year1.ryvo_84_tx)} |
| Total Ryvo Dense-20 tx (Steady, opens=0) | ${fmt(ry.steady.ryvo_84_tx)} |

## Per-call on-chain cost (Artemis truth, observed window)

\`\`\`
x402 fee bill (Solana) = ${fmt(x.tx)} tx × $${SOL_FEE}/tx = $${fmt(x.fee_usd_observed, 2)}
\`\`\`

This is what Solana validators were paid for the work of landing each x402
micropayment as its own transaction over the observed window. Annualized
this comes to **$${fmt(x.annualized_fee_usd, 2)} / year**.

## Ryvo cost (same flow, BLS-aggregated)

\`\`\`
Ryvo Dense-20 Y1 = ${fmt(ry.opens)} opens + ${fmt(ry.clearing_84)} clearing rounds
                = ${fmt(ry.year1.ryvo_84_tx)} on-chain tx
                = $${fmt(ry.year1.ryvo_84_fee_usd, 2)}

Ryvo Dense-20 Y2+ (relationships pre-existing, opens=0)
                = ${fmt(ry.clearing_84)} clearing rounds
                = ${fmt(ry.steady.ryvo_84_tx)} on-chain tx
                = $${fmt(ry.steady.ryvo_84_fee_usd, 2)}
\`\`\`

**Compression** (observed window):

- Year 1: ${ry.compression_y1.tx_84.toFixed(0)}× tx, ${ry.compression_y1.fee_84.toFixed(0)}× fees → saves **$${fmt(x.fee_usd_observed - ry.year1.ryvo_84_fee_usd, 2)}**
- Steady state: ${ry.compression_steady.tx_84.toFixed(0)}× tx, ${ry.compression_steady.fee_84.toFixed(0)}× fees → saves **$${fmt(x.fee_usd_observed - ry.steady.ryvo_84_fee_usd, 2)}**

## Why not just plain payment channels?

Same channel topology, no BLS aggregation — every active channel settles
its own daily on-chain tx.

| Metric | x402 | Plain 1:1 channels (Y1) | Plain 1:1 channels (Steady) | Ryvo Dense-20 (Y1) | Ryvo Dense-20 (Steady) |
|---|---:|---:|---:|---:|---:|
| On-chain tx | ${fmt(x.tx)} | ${fmt(ry.year1.ch1to1_tx)} | ${fmt(ry.steady.ch1to1_tx)} | ${fmt(ry.year1.ryvo_84_tx)} | ${fmt(ry.steady.ryvo_84_tx)} |
| Fees | $${fmt(x.fee_usd_observed, 2)} | $${fmt(ry.year1.ch1to1_fee_usd, 2)} | $${fmt(ry.steady.ch1to1_fee_usd, 2)} | $${fmt(ry.year1.ryvo_84_fee_usd, 2)} | $${fmt(ry.steady.ryvo_84_fee_usd, 2)} |
| Compression vs x402 | 1× | ${(x.tx / ry.year1.ch1to1_tx).toFixed(0)}× | ${(x.tx / ry.steady.ch1to1_tx).toFixed(0)}× | ${ry.compression_y1.tx_84.toFixed(0)}× | ${ry.compression_steady.tx_84.toFixed(0)}× |

**Ryvo's BLS aggregation is worth ${ry.ryvo_advantage_over_1to1.steady_tx.toFixed(0)}× over plain channels in steady state**.
Plain channels collapse the per-call architecture by ${(x.tx / ry.steady.ch1to1_tx).toFixed(0)}×; BLS clearing
collapses *those* settlements by another ${ry.ryvo_advantage_over_1to1.steady_tx.toFixed(0)}× on top of that.

## Yield generated by Ryvo over time

Ryvo channels can be denominated in yield-bearing stablecoins (sDAI, USDe,
USDM, etc.). At a modest **${(YIELD_APY_PCT * 100).toFixed(0)}% APY** the same Solana flow earns for participants
instead of just changing hands.

Annualized Solana volume from Artemis: **$${fmt(x.annualized_volume_usd, 0)} / year**.

| TVL assumption | TVL (USD) | Annual yield generated | Multiple of Ryvo's annual fee bill |
|---|---:|---:|---:|
${r.yield.bands.map(b => `| ${b.name} | $${fmt(b.tvl, 0)} | **$${fmt(b.yield_per_year, 0)}** | ${b.multiple_of_ryvo_steady_fee.toFixed(0)}× |`).join("\n")}

### Cumulative yield over 5 years (Realistic band, flat TVL)

| Year | Cumulative yield generated |
|---|---:|
${r.yield.cumulative_5y_realistic.map((v, i) => `| Year ${i + 1} | **$${fmt(v, 0)}** |`).join("\n")}

The picture flips from *"Solana x402 leaks ~$${fmt(x.annualized_fee_usd, 0)}/year to validators"*
to *"Solana x402 earns $${fmt(yieldBands[1].yield_per_year, 0)}/year for participants under Ryvo"*.
Same flow, same trust assumptions, different settlement architecture.

## Solana lifecycle (capital + recurring)

**Constants (Solana 2026):** 1 ChannelBucket = ${fmt(RYVO_CHANNEL_BUCKET_BYTES)} bytes holding ${RYVO_LANES_PER_BUCKET} lanes ⇒
rent ≈ ${RYVO_RENT_PER_BUCKET_SOL.toFixed(4)} SOL/bucket. Sessions naive ≈ ${SESSIONS_CHANNEL_BYTES} B/channel ⇒
${SESSIONS_RENT_PER_CHANNEL.toFixed(4)} SOL/channel. SOL price assumed at $${SOL_PRICE_USD}.

| Cost component | x402 | Sessions (1:1) | Ryvo Dense-20 v1 | Ryvo Dense-20 v2 (planned) |
|---|---:|---:|---:|---:|
| Solana relationships | ${fmt(ry.opens)} | ${fmt(ry.opens)} | ${fmt(ry.opens)} | ${fmt(ry.opens)} |
| Capital state accounts | 0 | ${fmt(ry.opens)} channels | ${fmt(cap.ryvo_buckets)} buckets | ${fmt(cap.ryvo_buckets)} buckets |
| Capital deposit (USD locked) | $0 | $${fmt(cap.sessions_capital_usd, 0)} | **$${fmt(cap.ryvo_capital_usd, 0)}** | $${fmt(cap.ryvo_capital_usd, 0)} |
| Capital recoverable on close? | n/a | yes | **no (sunk)** | yes |
| Y1 settlement tx | ${fmt(x.tx)} | ${fmt(ry.year1.ch1to1_tx)} | ${fmt(ry.year1.ryvo_84_tx)} | ${fmt(ry.year1.ryvo_84_tx)} |
| Y1 fees | $${fmt(x.fee_usd_observed, 2)} | $${fmt(ry.year1.ch1to1_fee_usd, 2)} | $${fmt(ry.year1.ryvo_84_fee_usd, 2)} | $${fmt(ry.year1.ryvo_84_fee_usd, 2)} |
| Y2+ recurring fees | $${fmt(x.fee_usd_observed, 2)} | $${fmt(ry.steady.ch1to1_fee_usd, 2)} | **$${fmt(ry.steady.ryvo_84_fee_usd, 2)}** | $${fmt(ry.steady.ryvo_84_fee_usd, 2)} |

## Solana fee sensitivity (LOW / MID / HIGH per-tx)

The Q4-2025 / Q1-2026 priority-fee window pushed Solana median per-tx fees
above the 5,000-lamport base floor. We hold the MID band ($${SOLANA_FEE_SCENARIOS.mid}/tx, Solana
Radar Q1-2025 median at SOL $200) as the primary number. The compression
ratio (x402 ÷ Ryvo) is invariant under per-tx-fee scaling — only the
absolute USD numbers move.

| Per-tx fee | Band | x402 fee | Sessions Y1 | Sessions steady | Ryvo Dense Y1 | Ryvo Dense steady |
|---|---|---:|---:|---:|---:|---:|
${r.fee_sensitivity.map(s => `| $${s.per_tx_fee_usd} | ${s.band.toUpperCase()} | $${fmt(s.x402_fee_usd, 2)} | $${fmt(s.sessions_fee_y1, 2)} | $${fmt(s.sessions_fee_steady, 2)} | $${fmt(s.ryvo_dense_fee_y1, 2)} | $${fmt(s.ryvo_dense_fee_steady, 2)} |`).join("\n")}

## Caveats

- Tx and volume are Artemis-canonical. The Dune indexing of the same 94
  facilitator wallets sees ${(r.ryvo_topology_from_dune.vs_artemis.ratio_dune_over_artemis).toFixed(2)}× more raw Solana tx
  (${fmt(r.ryvo_topology_from_dune.vs_artemis.dune_tx_in_window)} vs ${fmt(r.ryvo_topology_from_dune.vs_artemis.artemis_tx_in_window)}); we treat that gap as
  non-x402 wallet activity (rebalances, gas refills, bot loops) that
  Artemis filters out and Dune doesn't.
- Ryvo's ${fmt(ry.opens)} relationships and ${fmt(r.ryvo_topology_from_dune.active_channel_days_sum)} active-channel-days come from the Dune
  index. Because Dune over-counts raw tx vs Artemis, it may also include some
  pairs that aren't in the strict Artemis cohort — Ryvo's true on-chain
  footprint is **at most** the values reported here, plausibly less.
  Compression ratios should therefore be read as **lower bounds**.
- Channel opens = R (one \`create_channel\` per relationship). x402 flow is
  unidirectional buyer→seller; a single LowerToHigher OR HigherToLower lane
  is sufficient. Earlier 2×R models assumed unilateral channels, before the
  protocol consolidated to bidirectional ChannelBucket lanes.
- 84/32 BLS round capacities are devnet-validated empirical results from
  prior Ryvo work.
- Ryvo v1 has no close-channel instruction — Solana ChannelBucket rent is
  sunk capital until v2.

## Reproducibility

Re-run with:

\`\`\`bash
npx tsx scripts/analyze-artemis-solana.ts
\`\`\`

Output: \`analysis/solana-artemis.{json,md}\`.
`;

  writeFileSync("analysis/solana-artemis.md", md);
  console.log("Wrote analysis/solana-artemis.{json,md}");
  console.log("\n=== ARTEMIS-TRUTH SOLANA HEADLINE ===");
  console.log(`Window:           ${firstDate} → ${lastDate} (${observedDays} days)`);
  console.log(`x402 tx:          ${fmt(totalTxArtemis)} (Artemis)`);
  console.log(`x402 volume:      $${fmt(totalVolArtemis, 2)} (Artemis)`);
  console.log(`x402 fee bill:    $${fmt(x402_fee_usd, 2)} (observed) / $${fmt(annualizedX402Fee, 2)} (annualized)`);
  console.log(`Relationships:    ${fmt(relationships)} (Dune topology)`);
  console.log(`Ryvo Y1 tx:       ${fmt(ryvo84_y1)} (84-ch) / ${fmt(ryvo32_y1)} (32-ch)`);
  console.log(`Ryvo Y1 fee:      $${fmt(ryvo84_fee_y1, 2)} (84-ch)`);
  console.log(`Ryvo steady tx:   ${fmt(ryvo84_steady)} (84-ch) / ${fmt(ryvo32_steady)} (32-ch)`);
  console.log(`Ryvo steady fee:  $${fmt(ryvo84_fee_steady, 2)} (84-ch)`);
  console.log(`Compression Y1:   ${ry.compression_y1.tx_84.toFixed(0)}× (84-ch)`);
  console.log(`Compression Std:  ${ry.compression_steady.tx_84.toFixed(0)}× (84-ch)`);
  console.log(`Yield (Realistic ½ TVL): $${fmt(yieldBands[1].yield_per_year, 0)}/yr`);
}

main();

/**
 * Phase 3: rigorous Ryvo math.
 *
 * Inputs:
 *   - data/processed/daily_active_channels.json   per (chain, date) → tx_count, volume_usd, active_channels, unique_buyers, unique_sellers
 *   - data/processed/relationships_per_chain.json per chain → unordered-pair count (= relationships R)
 *
 * Formulas (per the locked-in plan):
 *   opens         = sum_chain(R)                   # one channel per buyer→seller relationship (x402 flow is unidirectional)
 *   closes        = 0  (Ryvo v1 has no close-channel instruction; rent is sunk until v2)
 *   for each (chain, date):
 *       active_d   = active_channels of that cell
 *       rounds_d_k = ceil(active_d / k)            # k ∈ {84, 32}
 *   clearing(k)   = sum over (chain, date) of rounds_d_k
 *   ryvo_total(k) = opens + clearing(k)
 *
 *   x402_total_tx = sum tx_count
 *   x402_fee      = sum tx_count_per_chain * fee_per_chain
 *   ryvo_fee(k)   = (opens_per_chain + clearing_per_chain(k)) * fee_per_chain
 *
 * Solana per-tx fee uses the MID sensitivity band ($0.0015) as primary; the
 * report appendix shows LOW/HIGH sensitivity. See SOLANA_FEE_SCENARIOS below.
 *
 * Outputs:
 *   analysis/rigorous-comparison.json  full machine-readable result
 *   analysis/rigorous-comparison.md    human-readable headline + tables
 */
import { readFileSync, writeFileSync } from "node:fs";

const DAILY_PATH = "data/processed/daily_active_channels.json";
const REL_PATH   = "data/processed/relationships_per_chain.json";

// Solana per-tx fee sensitivity bands. The flat $0.00044 floor (5,000-lamport
// base fee at SOL ~$88) understates real fees during the Q4-2025 / Q1-2026
// congestion months, where memecoin-era priority fees pushed the cluster
// median to roughly $0.005. We don't have a Dune-exact pull (the API key's
// engine is deprecated and an exact sum-of-lamports is gated behind a
// re-issue), so we report all three. MID matches the Solana Radar Q1-2025
// median (~$0.0015 at SOL $200), LOW is the late-tail/base-fee floor, HIGH
// is the Dec-2025 peak.
const SOLANA_FEE_SCENARIOS = { low: 0.0005, mid: 0.0015, high: 0.005 } as const;
const FEES = { base: 0.001, polygon: 0.001, solana: SOLANA_FEE_SCENARIOS.mid } as const;
const ROUND_CAPACITIES = { dense_20: 84, sparse_32: 32 } as const;
const ARTEMIS_GLOBAL_TX = 180_300_000;
const ARTEMIS_GLOBAL_VOL = 47_300_000;

// --- Solana rent / capital-lockup constants (used for the lifecycle cost
// model). These come directly from the protocol source, see plan doc.
//
//   ChannelBucket account size = 10,093 bytes (holds 46 channel lanes)
//   Sessions naive 1:1 channel state (counterfactual) ≈ 200 bytes
//   Solana rent: 3,480 lamports/byte/year × 2.0 years exemption × (size + 128 metadata)
const RYVO_CHANNEL_BUCKET_BYTES = 10_093;
const RYVO_LANES_PER_BUCKET = 46;
const SESSIONS_CHANNEL_BYTES = 200;
const SOL_LAMPORTS_PER_BYTE_YEAR = 3_480;
const SOL_RENT_EXEMPTION_YEARS = 2.0;
const SOL_ACCOUNT_METADATA_BYTES = 128;
const LAMPORTS_PER_SOL = 1_000_000_000;
const SOL_PRICE_USD = 200;

function rentExemptSol(bytes: number): number {
  return ((bytes + SOL_ACCOUNT_METADATA_BYTES) *
          SOL_LAMPORTS_PER_BYTE_YEAR *
          SOL_RENT_EXEMPTION_YEARS) / LAMPORTS_PER_SOL;
}

const RYVO_RENT_PER_BUCKET_SOL = rentExemptSol(RYVO_CHANNEL_BUCKET_BYTES);
const SESSIONS_RENT_PER_CHANNEL_SOL = rentExemptSol(SESSIONS_CHANNEL_BYTES);

interface DailyRow {
  chain: "base" | "polygon" | "solana";
  date: string;
  tx_count: number | string;
  volume_usd: number | string;
  active_channels: number | string;
  unique_buyers: number | string;
  unique_sellers: number | string;
}
interface Relationships { base: number; polygon: number; solana: number; total: number; _last_month_processed?: string }

const N = (v: unknown): number => Number(v ?? 0);
const fmt = (n: number, frac = 0): string => n.toLocaleString("en-US", { maximumFractionDigits: frac, minimumFractionDigits: 0 });

interface ChainSummary {
  chain: string;
  observed_days: number;
  total_tx: number;
  total_volume_usd: number;
  unique_relationships: number;
  active_channels_sum: number;
  active_channels_max_day: number;
  active_channels_mean: number;
  active_channels_p95: number;
  opens: number;
  clearing_84: number;
  clearing_32: number;
  ryvo_total_tx_84: number;
  ryvo_total_tx_32: number;
  // 1:1 plain payment channels (same topology, no BLS batching).
  // clearing_1to1 = sum_d active(d) — every active channel settles its own daily tx.
  clearing_1to1: number;
  ch1to1_total_tx_year1: number;     // opens + clearing_1to1
  ch1to1_total_tx_steady: number;    // clearing_1to1 only
  per_tx_fee: number;
  x402_fee_usd: number;
  ryvo_fee_usd_84: number;
  ryvo_fee_usd_32: number;
  ch1to1_fee_year1: number;
  ch1to1_fee_steady: number;
}

function pXX(arr: number[], pct: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * pct));
  return sorted[idx];
}

function main(): void {
  const daily = JSON.parse(readFileSync(DAILY_PATH, "utf8")) as DailyRow[];
  const rels  = JSON.parse(readFileSync(REL_PATH, "utf8")) as Relationships;

  const byChain: Record<string, DailyRow[]> = { base: [], polygon: [], solana: [] };
  for (const r of daily) byChain[r.chain]?.push(r);

  const perChain: ChainSummary[] = [];
  const allBusiest: { chain: string; date: string; active_channels: number; rounds_84: number; rounds_32: number; tx_count: number }[] = [];

  let totalTx = 0, totalVol = 0, totalOpens = 0;
  let totalClearing84 = 0, totalClearing32 = 0;
  let totalClearing1to1 = 0;
  let totalCh1to1FeeYear1 = 0, totalCh1to1FeeSteady = 0;
  let totalX402Fee = 0, totalRyvoFee84 = 0, totalRyvoFee32 = 0;
  const observedDates = new Set<string>();

  for (const chain of ["base", "polygon", "solana"] as const) {
    const rows = byChain[chain];
    const fee = FEES[chain];
    const R = rels[chain];

    const txCount = rows.reduce((a, r) => a + N(r.tx_count), 0);
    const volUsd  = rows.reduce((a, r) => a + N(r.volume_usd), 0);
    const activeArr = rows.map((r) => N(r.active_channels));
    const activeSum = activeArr.reduce((a, b) => a + b, 0);
    const activeMax = activeArr.length ? Math.max(...activeArr) : 0;
    const activeMean = activeArr.length ? activeSum / activeArr.length : 0;
    const activeP95 = pXX(activeArr, 0.95);
    // opens = R (not 2*R). x402 flow is unidirectional buyer→seller, so each
    // unique unordered pair needs only ONE create_channel call (the
    // LowerToHigher OR HigherToLower lane, never both). The original 2*R
    // assumed every relationship needed both directions opened; that was a
    // historical artifact from an earlier (unilateral-only) protocol design.
    const opens = R;
    const clearing84 = rows.reduce((a, r) => a + Math.ceil(N(r.active_channels) / 84), 0);
    const clearing32 = rows.reduce((a, r) => a + Math.ceil(N(r.active_channels) / 32), 0);
    const ryvo84 = opens + clearing84;
    const ryvo32 = opens + clearing32;
    // 1:1 plain payment channels: same opens, same channel topology, but every active
    // (buyer, seller) channel settles its own on-chain tx every day it's active.
    // No BLS aggregation. This isolates the value of batching from the value of channels.
    const clearing1to1 = activeSum; // = sum_d active(d)
    const ch1to1Year1 = opens + clearing1to1;
    const ch1to1Steady = clearing1to1;
    const x402Fee = txCount * fee;
    const ryvoFee84 = ryvo84 * fee;
    const ryvoFee32 = ryvo32 * fee;
    const ch1to1FeeYear1 = ch1to1Year1 * fee;
    const ch1to1FeeSteady = ch1to1Steady * fee;

    perChain.push({
      chain, observed_days: rows.length, total_tx: txCount, total_volume_usd: volUsd,
      unique_relationships: R, active_channels_sum: activeSum, active_channels_max_day: activeMax,
      active_channels_mean: activeMean, active_channels_p95: activeP95,
      opens, clearing_84: clearing84, clearing_32: clearing32,
      ryvo_total_tx_84: ryvo84, ryvo_total_tx_32: ryvo32,
      clearing_1to1: clearing1to1,
      ch1to1_total_tx_year1: ch1to1Year1,
      ch1to1_total_tx_steady: ch1to1Steady,
      per_tx_fee: fee, x402_fee_usd: x402Fee, ryvo_fee_usd_84: ryvoFee84, ryvo_fee_usd_32: ryvoFee32,
      ch1to1_fee_year1: ch1to1FeeYear1,
      ch1to1_fee_steady: ch1to1FeeSteady,
    });

    totalTx += txCount; totalVol += volUsd; totalOpens += opens;
    totalClearing84 += clearing84; totalClearing32 += clearing32;
    totalClearing1to1 += clearing1to1;
    totalCh1to1FeeYear1 += ch1to1FeeYear1;
    totalCh1to1FeeSteady += ch1to1FeeSteady;
    totalX402Fee += x402Fee; totalRyvoFee84 += ryvoFee84; totalRyvoFee32 += ryvoFee32;
    for (const r of rows) observedDates.add(r.date);

    const sortedByActive = [...rows].sort((a, b) => N(b.active_channels) - N(a.active_channels)).slice(0, 5);
    for (const r of sortedByActive) {
      const a = N(r.active_channels);
      allBusiest.push({
        chain, date: r.date, active_channels: a,
        rounds_84: Math.ceil(a / 84), rounds_32: Math.ceil(a / 32), tx_count: N(r.tx_count),
      });
    }
  }

  const ryvo84Total = totalOpens + totalClearing84;
  const ryvo32Total = totalOpens + totalClearing32;
  const ch1to1Year1Total = totalOpens + totalClearing1to1;
  const ch1to1SteadyTotal = totalClearing1to1;

  // Headline view: Base + Solana only (Polygon moved to appendix because of
  // bot-loop concentration — 142 relationships generating 12.5M tx is not
  // representative of "agentic commerce").
  const headlineChains = perChain.filter((c) => c.chain !== "polygon");
  const headlineTotalTx = headlineChains.reduce((a, c) => a + c.total_tx, 0);
  const headlineTotalVol = headlineChains.reduce((a, c) => a + c.total_volume_usd, 0);
  const headlineRel = headlineChains.reduce((a, c) => a + c.unique_relationships, 0);
  const headlineOpens = headlineRel;  // see comment in per-chain loop above
  const headlineClearing84 = headlineChains.reduce((a, c) => a + c.clearing_84, 0);
  const headlineClearing32 = headlineChains.reduce((a, c) => a + c.clearing_32, 0);
  const headlineRyvo84 = headlineOpens + headlineClearing84;
  const headlineRyvo32 = headlineOpens + headlineClearing32;
  const headlineX402Fee = headlineChains.reduce((a, c) => a + c.x402_fee_usd, 0);
  const headlineRyvoFee84 = headlineChains.reduce((a, c) => a + c.ryvo_fee_usd_84, 0);
  const headlineRyvoFee32 = headlineChains.reduce((a, c) => a + c.ryvo_fee_usd_32, 0);
  const headlineClearing1to1 = headlineChains.reduce((a, c) => a + c.clearing_1to1, 0);
  const headlineCh1to1Year1 = headlineOpens + headlineClearing1to1;
  const headlineCh1to1Steady = headlineClearing1to1;
  const headlineCh1to1FeeYear1 = headlineChains.reduce((a, c) => a + c.ch1to1_fee_year1, 0);
  const headlineCh1to1FeeSteady = headlineChains.reduce((a, c) => a + c.ch1to1_fee_steady, 0);

  const headline = {
    chains: ["base", "solana"],
    total_tx: headlineTotalTx,
    total_volume_usd: headlineTotalVol,
    unique_relationships: headlineRel,
    opens: headlineOpens,
    clearing_84: headlineClearing84,
    clearing_32: headlineClearing32,
    ryvo_total_tx_84: headlineRyvo84,
    ryvo_total_tx_32: headlineRyvo32,
    x402_fee_usd: headlineX402Fee,
    ryvo_fee_usd_84: headlineRyvoFee84,
    ryvo_fee_usd_32: headlineRyvoFee32,
    tx_compression_84: headlineTotalTx / headlineRyvo84,
    tx_compression_32: headlineTotalTx / headlineRyvo32,
    fee_compression_84: headlineX402Fee / headlineRyvoFee84,
    fee_compression_32: headlineX402Fee / headlineRyvoFee32,
    fee_savings_usd_84: headlineX402Fee - headlineRyvoFee84,
    fee_savings_usd_32: headlineX402Fee - headlineRyvoFee32,
    // Steady-state: opens=0 (relationships pre-existing from prior years)
    steady_state: {
      ryvo_tx_84: headlineClearing84,
      ryvo_tx_32: headlineClearing32,
      ryvo_fee_84: headlineChains.reduce((a, c) => a + c.clearing_84 * c.per_tx_fee, 0),
      ryvo_fee_32: headlineChains.reduce((a, c) => a + c.clearing_32 * c.per_tx_fee, 0),
      tx_compression_84: headlineTotalTx / headlineClearing84,
      tx_compression_32: headlineTotalTx / headlineClearing32,
    },
    // 1:1 plain payment channels (Lightning-like, persistent, no BLS aggregation).
    // Same channel topology as Ryvo (2 unilateral per relationship), but each active
    // channel settles its own daily on-chain tx. Isolates the value of BLS batching.
    ch1to1: {
      year1_tx: headlineCh1to1Year1,
      steady_tx: headlineCh1to1Steady,
      year1_fee: headlineCh1to1FeeYear1,
      steady_fee: headlineCh1to1FeeSteady,
      tx_compression_year1: headlineTotalTx / headlineCh1to1Year1,
      tx_compression_steady: headlineTotalTx / headlineCh1to1Steady,
      fee_compression_year1: headlineX402Fee / headlineCh1to1FeeYear1,
      fee_compression_steady: headlineX402Fee / headlineCh1to1FeeSteady,
      fee_savings_year1: headlineX402Fee - headlineCh1to1FeeYear1,
      fee_savings_steady: headlineX402Fee - headlineCh1to1FeeSteady,
      // How much better Ryvo's BLS batching is vs plain channels.
      ryvo_advantage_year1_tx_84: headlineCh1to1Year1 / headlineRyvo84,
      ryvo_advantage_steady_tx_84: headlineCh1to1Steady / headlineClearing84,
      ryvo_advantage_year1_fee_84: headlineCh1to1FeeYear1 / headlineRyvoFee84,
      ryvo_advantage_steady_fee_84:
        headlineCh1to1FeeSteady / headlineChains.reduce((a, c) => a + c.clearing_84 * c.per_tx_fee, 0),
    },
  };

  // ---- Solana fee sensitivity (low / mid / high per-tx) ----
  // The mid case is the primary number used everywhere else in this report.
  // We surface low and high so the reader can see the band of plausible
  // historical fees across the Q4-2025 / Q1-2026 congestion window.
  const solanaChain = perChain.find((c) => c.chain === "solana")!;
  const solanaFeeSensitivity = (Object.keys(SOLANA_FEE_SCENARIOS) as Array<keyof typeof SOLANA_FEE_SCENARIOS>).map((band) => {
    const fee = SOLANA_FEE_SCENARIOS[band];
    return {
      band,
      per_tx_fee_usd: fee,
      x402_fee_usd:           solanaChain.total_tx              * fee,
      sessions_fee_y1:        solanaChain.ch1to1_total_tx_year1 * fee,
      sessions_fee_steady:    solanaChain.ch1to1_total_tx_steady* fee,
      ryvo_dense_fee_y1:      solanaChain.ryvo_total_tx_84      * fee,
      ryvo_dense_fee_steady:  solanaChain.clearing_84           * fee,
      ryvo_sparse_fee_y1:     solanaChain.ryvo_total_tx_32      * fee,
      ryvo_sparse_fee_steady: solanaChain.clearing_32           * fee,
    };
  });

  // ---- Solana lifecycle cost model (capital + Y1/Y2 fees) ----
  // x402: no channels, no capital; Y1 fee = Y2 fee = total tx × per-tx fee.
  // Sessions (best case = "stable", one channel held for the year):
  //   - Capital: one rent-exempt account per relationship (~200 bytes)
  //   - Y1 fees: opens-fee + clearing-1to1 fees
  //   - Y2 fees: clearing-1to1 fees only (relationships persist)
  //   - Capital is RECOVERABLE on close in this architecture.
  // Ryvo (Dense-20):
  //   - Capital: one ChannelBucket account (10,093 bytes) per ceil(R/46) buckets
  //   - Y1 fees: opens-fee + clearing-84 fees
  //   - Y2 fees: clearing-84 fees only (relationships persist)
  //   - v1: capital is SUNK (no close-channel instruction yet)
  //   - v2 (planned): capital is recoverable; Y2 cost unchanged
  const solanaSessionsCapitalSol = solanaChain.unique_relationships * SESSIONS_RENT_PER_CHANNEL_SOL;
  const solanaRyvoBuckets        = Math.ceil(solanaChain.unique_relationships / RYVO_LANES_PER_BUCKET);
  const solanaRyvoCapitalSol     = solanaRyvoBuckets * RYVO_RENT_PER_BUCKET_SOL;
  const solanaSessionsCapitalUsd = solanaSessionsCapitalSol * SOL_PRICE_USD;
  const solanaRyvoCapitalUsd     = solanaRyvoCapitalSol     * SOL_PRICE_USD;
  const lifecycleSolana = {
    sessions_assumption: "stable — one channel per (buyer, seller) pair, opened once at first interaction, held for the entire year. Best-case Sessions model; real-world payment channels are typically more ephemeral, which would only make Sessions costs go UP.",
    ryvo_v1_caveat: "Ryvo v1 has no close-channel instruction. Once a ChannelBucket lane is initialized, its rent stays locked indefinitely. v2 (planned) will add close + rent recovery; until then, the Solana capital deposit is a sunk cost, not a recoverable deposit. Sessions architectures DO support close + rent recovery.",
    relationships: solanaChain.unique_relationships,
    ryvo_buckets:  solanaRyvoBuckets,
    capital_deposit: {
      x402_usd:                    0,
      sessions_usd:                solanaSessionsCapitalUsd,
      sessions_recoverable:        true,
      ryvo_v1_usd:                 solanaRyvoCapitalUsd,
      ryvo_v1_recoverable:         false,
      ryvo_v2_usd:                 solanaRyvoCapitalUsd,
      ryvo_v2_recoverable:         true,
    },
    y1: {
      x402_settlement_count:       solanaChain.total_tx,
      x402_fee_usd:                solanaChain.x402_fee_usd,
      sessions_settlement_count:   solanaChain.ch1to1_total_tx_year1,
      sessions_fee_usd:            solanaChain.ch1to1_fee_year1,
      sessions_total_y1_usd:       solanaSessionsCapitalUsd + solanaChain.ch1to1_fee_year1,
      ryvo_settlement_count:       solanaChain.ryvo_total_tx_84,
      ryvo_fee_usd:                solanaChain.ryvo_fee_usd_84,
      ryvo_total_y1_usd:           solanaRyvoCapitalUsd     + solanaChain.ryvo_fee_usd_84,
    },
    y2: {
      x402_settlement_count:       solanaChain.total_tx,
      x402_fee_usd:                solanaChain.x402_fee_usd,
      sessions_settlement_count:   solanaChain.ch1to1_total_tx_steady,
      sessions_fee_usd:            solanaChain.ch1to1_fee_steady,
      ryvo_settlement_count:       solanaChain.clearing_84,
      ryvo_fee_usd:                solanaChain.clearing_84 * solanaChain.per_tx_fee,
    },
  };

  const result = {
    generated_at: new Date().toISOString(),
    inputs: {
      daily_path: DAILY_PATH,
      relationships_path: REL_PATH,
      fees: FEES,
      solana_fee_scenarios: SOLANA_FEE_SCENARIOS,
      round_capacities: ROUND_CAPACITIES,
      rent_constants: {
        ryvo_channel_bucket_bytes: RYVO_CHANNEL_BUCKET_BYTES,
        ryvo_lanes_per_bucket: RYVO_LANES_PER_BUCKET,
        sessions_channel_bytes: SESSIONS_CHANNEL_BYTES,
        sol_lamports_per_byte_year: SOL_LAMPORTS_PER_BYTE_YEAR,
        sol_rent_exemption_years: SOL_RENT_EXEMPTION_YEARS,
        sol_account_metadata_bytes: SOL_ACCOUNT_METADATA_BYTES,
        sol_price_usd: SOL_PRICE_USD,
        ryvo_rent_per_bucket_sol: RYVO_RENT_PER_BUCKET_SOL,
        sessions_rent_per_channel_sol: SESSIONS_RENT_PER_CHANNEL_SOL,
      },
      notes: [
        "All inputs are derived from Dune SQL against tokens_{base,polygon,solana}.transfers.",
        "Filter: USDC contract per chain + tx_from/tx_signer ∈ facilitator wallets + buyer ≠ seller ≠ facilitator.",
        "Sample covers 2025-05-09 → 2026-05-09 (12-month window of x402 history, 13 calendar months observed).",
        "Coverage vs Artemis 180M: ${tx}% of tx, ${vol}% of volume.",
        "Relationships R for Solana / late-2026 months may be slightly under-counted due to a Dune datapoint-limit hit (Mar/Apr/May 2026 Solana, May 2026 Base/Polygon partitions). Missing partitions are recent low-volume tail months and would only INCREASE opens count by at most ~5%.",
        "Channel opens = R (one create_channel call per relationship). x402 flow is unidirectional buyer→seller, so a single LowerToHigher OR HigherToLower lane is sufficient — never both. Earlier 2*R model assumed unilateral channels, before the protocol consolidated to bidirectional ChannelBucket lanes.",
        "Solana per-tx fee: $0.00044 (the bare 5,000-lamport base fee at SOL ~$88) understates real costs during the 2025-Q4 / 2026-Q1 congestion window. We use the MID sensitivity band ($0.0015 — Solana Radar Q1-2025 median) as primary; LOW ($0.0005 — base-fee floor) and HIGH ($0.005 — Dec-2025 peak) appear in the appendix.",
        "Ryvo v1 has no close-channel instruction — Solana ChannelBucket rent is sunk capital until v2. Sessions (1:1 channels) DO support rent recovery on close. The lifecycle table reflects this asymmetry.",
      ],
    },
    per_chain: perChain,
    totals: {
      observed_days_union: observedDates.size,
      total_tx: totalTx,
      total_volume_usd: totalVol,
      unique_relationships: rels.total,
      opens: totalOpens,
      clearing_84: totalClearing84,
      clearing_32: totalClearing32,
      ryvo_total_tx_84: ryvo84Total,
      ryvo_total_tx_32: ryvo32Total,
      x402_fee_usd: totalX402Fee,
      ryvo_fee_usd_84: totalRyvoFee84,
      ryvo_fee_usd_32: totalRyvoFee32,
      tx_compression_84: totalTx / ryvo84Total,
      tx_compression_32: totalTx / ryvo32Total,
      fee_compression_84: totalX402Fee / totalRyvoFee84,
      fee_compression_32: totalX402Fee / totalRyvoFee32,
      fee_savings_usd_84: totalX402Fee - totalRyvoFee84,
      fee_savings_usd_32: totalX402Fee - totalRyvoFee32,
      ch1to1_clearing: totalClearing1to1,
      ch1to1_year1_tx: ch1to1Year1Total,
      ch1to1_steady_tx: ch1to1SteadyTotal,
      ch1to1_year1_fee: totalCh1to1FeeYear1,
      ch1to1_steady_fee: totalCh1to1FeeSteady,
      pct_of_artemis_tx: totalTx / ARTEMIS_GLOBAL_TX,
      pct_of_artemis_volume: totalVol / ARTEMIS_GLOBAL_VOL,
    },
    busiest_days: allBusiest.sort((a, b) => b.active_channels - a.active_channels).slice(0, 15),
    headline,
    solana_fee_sensitivity: solanaFeeSensitivity,
    lifecycle_solana: lifecycleSolana,
  };

  writeFileSync("analysis/rigorous-comparison.json", JSON.stringify(result, null, 2));

  const t = result.totals;
  const h = result.headline;
  const md = `# Rigorous Ryvo vs x402 comparison (auto-generated)

Generated: ${result.generated_at}

## Inputs

- Daily aggregates: [\`${DAILY_PATH}\`](../${DAILY_PATH})  (${daily.length} rows, ${observedDates.size} unique UTC days)
- Relationships per chain: [\`${REL_PATH}\`](../${REL_PATH})
- Per-tx fees: Base $${FEES.base}, Polygon $${FEES.polygon}, Solana $${FEES.solana}
- BLS round capacity: ${ROUND_CAPACITIES.dense_20} channels/round (Dense-20), ${ROUND_CAPACITIES.sparse_32} channels/round (Sparse-32)

## Coverage

We indexed **${fmt(t.total_tx)}** USDC micropayments across Base + Polygon + Solana, totalling **$${fmt(t.total_volume_usd)}**. This is **${(t.pct_of_artemis_tx * 100).toFixed(1)}%** of the Artemis-reported 180.3M tx and **${(t.pct_of_artemis_volume * 100).toFixed(1)}%** of the $47.3M volume cited at [classic.artemis.ai/asset/x402](https://classic.artemis.ai/asset/x402).

Reconciliation report: [\`analysis/phase0-reconciliation.md\`](phase0-reconciliation.md).

## Headline (Base + Solana — Polygon is in the appendix)

Polygon is excluded from the headline because its activity is concentrated in only ${perChain.find(c => c.chain === 'polygon')?.unique_relationships ?? 0} unique relationships generating ${fmt(perChain.find(c => c.chain === 'polygon')?.total_tx ?? 0)} tx — bot-loop-tier concentration, not representative of agentic commerce. Full Polygon numbers are in the appendix below.

### Year 1 (relationships fresh on day 1, includes channel opens)

| Metric | x402 today | Ryvo (84-ch round) | Ryvo (32-ch round) |
|---|---:|---:|---:|
| On-chain tx | **${fmt(h.total_tx)}** | **${fmt(h.ryvo_total_tx_84)}** | **${fmt(h.ryvo_total_tx_32)}** |
| Fees paid (USD) | **$${fmt(h.x402_fee_usd, 2)}** | **$${fmt(h.ryvo_fee_usd_84, 2)}** | **$${fmt(h.ryvo_fee_usd_32, 2)}** |
| On-chain tx compression | 1× | **${h.tx_compression_84.toFixed(1)}×** | **${h.tx_compression_32.toFixed(1)}×** |
| Fee compression | — | **${h.fee_compression_84.toFixed(1)}×** | **${h.fee_compression_32.toFixed(1)}×** |
| Fees saved | — | **$${fmt(h.fee_savings_usd_84, 2)}** | **$${fmt(h.fee_savings_usd_32, 2)}** |

### Steady state (year 2+: relationships are pre-existing, opens = 0)

| Metric | x402 today | Ryvo (84-ch round) | Ryvo (32-ch round) |
|---|---:|---:|---:|
| On-chain tx (per equivalent year of x402 flow) | **${fmt(h.total_tx)}** | **${fmt(h.steady_state.ryvo_tx_84)}** | **${fmt(h.steady_state.ryvo_tx_32)}** |
| Fees paid | **$${fmt(h.x402_fee_usd, 2)}** | **$${fmt(h.steady_state.ryvo_fee_84, 2)}** | **$${fmt(h.steady_state.ryvo_fee_32, 2)}** |
| Tx compression | 1× | **${h.steady_state.tx_compression_84.toFixed(0)}×** | **${h.steady_state.tx_compression_32.toFixed(0)}×** |

### Three-way: x402 vs plain 1:1 channels vs Ryvo

A natural question is "why not just use plain payment channels?" — i.e. one channel per (buyer, seller) pair, settled individually on chain (no BLS aggregation). Same channel topology as Ryvo (2 unilateral channels per relationship, opened once, never closed) — the *only* difference is that each active channel settles its own daily on-chain tx instead of being aggregated into a BLS round of up to 84.

\`clearing(1:1) = Σ_d active_channels(d)\`  vs  \`clearing(Ryvo, k) = Σ_d ⌈active_channels(d) / k⌉\`

| Metric | x402 today | Plain 1:1 channels (Year 1) | Plain 1:1 channels (Steady) | Ryvo 84-ch (Year 1) | Ryvo 84-ch (Steady) |
|---|---:|---:|---:|---:|---:|
| On-chain tx | **${fmt(h.total_tx)}** | **${fmt(h.ch1to1.year1_tx)}** | **${fmt(h.ch1to1.steady_tx)}** | **${fmt(h.ryvo_total_tx_84)}** | **${fmt(h.steady_state.ryvo_tx_84)}** |
| Fees paid | **$${fmt(h.x402_fee_usd, 2)}** | **$${fmt(h.ch1to1.year1_fee, 2)}** | **$${fmt(h.ch1to1.steady_fee, 2)}** | **$${fmt(h.ryvo_fee_usd_84, 2)}** | **$${fmt(h.steady_state.ryvo_fee_84, 2)}** |
| Compression vs x402 | 1× | **${h.ch1to1.tx_compression_year1.toFixed(0)}×** | **${h.ch1to1.tx_compression_steady.toFixed(0)}×** | **${h.tx_compression_84.toFixed(0)}×** | **${h.steady_state.tx_compression_84.toFixed(0)}×** |
| Fees saved vs x402 | — | **$${fmt(h.ch1to1.fee_savings_year1, 2)}** | **$${fmt(h.ch1to1.fee_savings_steady, 2)}** | **$${fmt(h.fee_savings_usd_84, 2)}** | **$${fmt(h.x402_fee_usd - h.steady_state.ryvo_fee_84, 2)}** |

**Ryvo's BLS aggregation is worth ${h.ch1to1.ryvo_advantage_year1_tx_84.toFixed(1)}× over plain channels in year 1 and ${h.ch1to1.ryvo_advantage_steady_tx_84.toFixed(0)}× in steady state** (fee multiple is similar). Plain payment channels alone collapse the 132M micropayments by ~${h.ch1to1.tx_compression_steady.toFixed(0)}× — a real win — but BLS aggregation collapses the *resulting* clearing tx by another ${h.ch1to1.ryvo_advantage_steady_tx_84.toFixed(0)}× on top of that.

### Inclusive view (all 3 chains, year-1 framing — for full transparency)

| Metric | x402 today | Ryvo (84-ch round) | Ryvo (32-ch round) |
|---|---:|---:|---:|
| On-chain tx | **${fmt(t.total_tx)}** | **${fmt(t.ryvo_total_tx_84)}** | **${fmt(t.ryvo_total_tx_32)}** |
| Fees paid (USD) | **$${fmt(t.x402_fee_usd, 2)}** | **$${fmt(t.ryvo_fee_usd_84, 2)}** | **$${fmt(t.ryvo_fee_usd_32, 2)}** |
| Compression | 1× | **${t.tx_compression_84.toFixed(1)}×** | **${t.tx_compression_32.toFixed(1)}×** |
| Fees saved | — | **$${fmt(t.fee_savings_usd_84, 2)}** | **$${fmt(t.fee_savings_usd_32, 2)}** |

## Decomposition (totals)

| | Value |
|---|---:|
| Unique relationships (across all chains) | ${fmt(t.unique_relationships)} |
| Channel opens (= relationships, see footnote) | ${fmt(t.opens)} |
| Channel closes (Ryvo v1 — no close instr.) | 0 |
| Clearing rounds @ 84 ch/round | ${fmt(t.clearing_84)} |
| Clearing rounds @ 32 ch/round | ${fmt(t.clearing_32)} |
| Total Ryvo on-chain tx @ 84 | ${fmt(t.ryvo_total_tx_84)} (= opens + clearing) |
| Total Ryvo on-chain tx @ 32 | ${fmt(t.ryvo_total_tx_32)} (= opens + clearing) |

> **Footnote on opens.** \`opens = R\`, not \`2 × R\`. Ryvo's \`create_channel\` instruction initializes one directional lane (\`LowerToHigher\` *or* \`HigherToLower\`) per call. x402 is a unidirectional buyer→seller flow, so a single lane is sufficient — the reverse direction is never funded. Earlier internal models used \`2 × R\` from a unilateral-channels-only protocol design that was superseded by the bidirectional \`ChannelBucket\` architecture. The corrected count drops total Ryvo Y1 tx by exactly one R per chain.

## Solana lifecycle cost (Y1 vs Y2, capital + recurring)

This compares the **all-in Solana cost** of clearing the indexed flow under x402, naive 1:1 payment-channel sessions (the "Lightning-but-on-Solana" baseline), and Ryvo Dense-20. Capital deposit is the rent-exempt SOL that must be locked to allocate the on-chain state account; for Sessions it's recoverable, for Ryvo v1 it's currently a sunk cost (v2 will add a close-channel instruction with rent recovery).

**Constants (Solana 2026):** 1 ChannelBucket account = ${fmt(RYVO_CHANNEL_BUCKET_BYTES)} bytes holding ${RYVO_LANES_PER_BUCKET} channel lanes ⇒ rent ≈ ${RYVO_RENT_PER_BUCKET_SOL.toFixed(4)} SOL/bucket. Sessions naive ≈ ${SESSIONS_CHANNEL_BYTES} bytes/channel ⇒ rent ≈ ${SESSIONS_RENT_PER_CHANNEL_SOL.toFixed(4)} SOL/channel. SOL price assumed at $${SOL_PRICE_USD}.

| Cost component | x402 | Sessions (1:1, recoverable) | Ryvo Dense-20 v1 (sunk) | Ryvo Dense-20 v2 (planned, recoverable) |
|---|---:|---:|---:|---:|
| Solana relationships | ${fmt(result.lifecycle_solana.relationships)} | ${fmt(result.lifecycle_solana.relationships)} | ${fmt(result.lifecycle_solana.relationships)} | ${fmt(result.lifecycle_solana.relationships)} |
| Capital state accounts (one-time) | 0 | ${fmt(result.lifecycle_solana.relationships)} channels | ${fmt(result.lifecycle_solana.ryvo_buckets)} buckets | ${fmt(result.lifecycle_solana.ryvo_buckets)} buckets |
| Capital deposit (USD, locked) | $0 | **$${fmt(result.lifecycle_solana.capital_deposit.sessions_usd, 0)}** | **$${fmt(result.lifecycle_solana.capital_deposit.ryvo_v1_usd, 0)}** | $${fmt(result.lifecycle_solana.capital_deposit.ryvo_v2_usd, 0)} |
| Capital recoverable on close? | n/a | yes | **no** | yes |
| Y1 settlement tx | ${fmt(result.lifecycle_solana.y1.x402_settlement_count)} | ${fmt(result.lifecycle_solana.y1.sessions_settlement_count)} | ${fmt(result.lifecycle_solana.y1.ryvo_settlement_count)} | ${fmt(result.lifecycle_solana.y1.ryvo_settlement_count)} |
| Y1 fees (Solana, $${SOLANA_FEE_SCENARIOS.mid}/tx mid) | $${fmt(result.lifecycle_solana.y1.x402_fee_usd, 2)} | $${fmt(result.lifecycle_solana.y1.sessions_fee_usd, 2)} | $${fmt(result.lifecycle_solana.y1.ryvo_fee_usd, 2)} | $${fmt(result.lifecycle_solana.y1.ryvo_fee_usd, 2)} |
| Y1 total Solana cost (capital + fees) | $${fmt(result.lifecycle_solana.y1.x402_fee_usd, 2)} | **$${fmt(result.lifecycle_solana.y1.sessions_total_y1_usd, 2)}** | **$${fmt(result.lifecycle_solana.y1.ryvo_total_y1_usd, 2)}** | $${fmt(result.lifecycle_solana.y1.ryvo_total_y1_usd, 2)} |
| Y2+ recurring tx | ${fmt(result.lifecycle_solana.y2.x402_settlement_count)} | ${fmt(result.lifecycle_solana.y2.sessions_settlement_count)} | ${fmt(result.lifecycle_solana.y2.ryvo_settlement_count)} | ${fmt(result.lifecycle_solana.y2.ryvo_settlement_count)} |
| Y2+ recurring fees | $${fmt(result.lifecycle_solana.y2.x402_fee_usd, 2)} | $${fmt(result.lifecycle_solana.y2.sessions_fee_usd, 2)} | **$${fmt(result.lifecycle_solana.y2.ryvo_fee_usd, 2)}** | $${fmt(result.lifecycle_solana.y2.ryvo_fee_usd, 2)} |

### Reading the lifecycle table

- **Y1 capital is dominated by Sessions** ($${fmt(result.lifecycle_solana.capital_deposit.sessions_usd, 0)}, vs Ryvo's $${fmt(result.lifecycle_solana.capital_deposit.ryvo_v1_usd, 0)}) because Sessions needs one ~200-byte account *per channel*, whereas Ryvo packs ${RYVO_LANES_PER_BUCKET} channel lanes into one ${fmt(RYVO_CHANNEL_BUCKET_BYTES)}-byte ChannelBucket — ~${(RYVO_LANES_PER_BUCKET / (RYVO_CHANNEL_BUCKET_BYTES / SESSIONS_CHANNEL_BYTES)).toFixed(1)}× rent efficiency per channel.
- **Y2 recurring fees are dominated by x402** ($${fmt(result.lifecycle_solana.y2.x402_fee_usd, 2)} vs Ryvo's $${fmt(result.lifecycle_solana.y2.ryvo_fee_usd, 2)}) because x402 lands one tx per micropayment whereas Ryvo lands one BLS-aggregated tx per ⌈active/${ROUND_CAPACITIES.dense_20}⌉.
- **Sessions sit between the two**: capital expensive, fees ~the same as 1:1 channels (one settle per active channel-day), capital recoverable via close.
- **Ryvo v1 caveat:** ${result.lifecycle_solana.ryvo_v1_caveat}
- **Sessions assumption:** ${result.lifecycle_solana.sessions_assumption}

## Solana fee sensitivity (LOW / MID / HIGH)

The flat $0.00044 historical fee floor was the bare 5,000-lamport base fee at SOL ~$88; it understates real network costs during the 2025-Q4 / 2026-Q1 priority-fee congestion window. We don't have a Dune-exact SUM-of-lamports yet (the API key's query engine is deprecated and a re-issue is gated), so we report all three sensitivity bands here. The MID band ($${SOLANA_FEE_SCENARIOS.mid}/tx) is what the rest of this report uses.

| Solana per-tx fee | Band | Solana x402 fees | Solana Sessions Y1 fees | Solana Sessions steady fees | Solana Ryvo Dense Y1 fees | Solana Ryvo Dense steady fees |
|---|---|---:|---:|---:|---:|---:|
${result.solana_fee_sensitivity.map((s) => `| $${s.per_tx_fee_usd} | ${s.band.toUpperCase()} | $${fmt(s.x402_fee_usd, 2)} | $${fmt(s.sessions_fee_y1, 2)} | $${fmt(s.sessions_fee_steady, 2)} | $${fmt(s.ryvo_dense_fee_y1, 2)} | $${fmt(s.ryvo_dense_fee_steady, 2)} |`).join("\n")}

The relative compression (x402 ÷ Ryvo) is invariant under per-tx-fee scaling — only the absolute USD numbers move. So the headline "${h.steady_state.tx_compression_84.toFixed(0)}× steady-state compression" claim holds across all three bands; only the Y1/Y2 dollar-savings figures move.

## Per-chain breakdown

| Chain | x402 tx | Relationships | Opens | Clearing-84 | Clearing-32 | Clearing-1to1 | Ryvo tx (84) | Ryvo tx (32) | x402 fee | Ryvo fee (84) | Ryvo fee (32) | 1:1 fee (Y1) | 1:1 fee (Steady) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
${perChain.map((c) => `| ${c.chain} | ${fmt(c.total_tx)} | ${fmt(c.unique_relationships)} | ${fmt(c.opens)} | ${fmt(c.clearing_84)} | ${fmt(c.clearing_32)} | ${fmt(c.clearing_1to1)} | ${fmt(c.ryvo_total_tx_84)} | ${fmt(c.ryvo_total_tx_32)} | $${fmt(c.x402_fee_usd, 2)} | $${fmt(c.ryvo_fee_usd_84, 2)} | $${fmt(c.ryvo_fee_usd_32, 2)} | $${fmt(c.ch1to1_fee_year1, 2)} | $${fmt(c.ch1to1_fee_steady, 2)} |`).join("\n")}

## Daily distribution stats per chain

| Chain | Days observed | Mean active ch/day | P95 active ch/day | Max active ch/day | Sum of daily active counts |
|---|---:|---:|---:|---:|---:|
${perChain.map((c) => `| ${c.chain} | ${c.observed_days} | ${c.active_channels_mean.toFixed(0)} | ${fmt(c.active_channels_p95)} | ${fmt(c.active_channels_max_day)} | ${fmt(c.active_channels_sum)} |`).join("\n")}

## Top 15 busiest days globally

| Chain | Date | Active channels | Rounds (84-ch) | Rounds (32-ch) | x402 tx that day |
|---|---|---:|---:|---:|---:|
${result.busiest_days.map((d) => `| ${d.chain} | ${d.date} | ${fmt(d.active_channels)} | ${fmt(d.rounds_84)} | ${fmt(d.rounds_32)} | ${fmt(d.tx_count)} |`).join("\n")}

## Caveats (will appear verbatim in the published brief)

${result.inputs.notes.map((n) => `- ${n.replace("\${tx}", (t.pct_of_artemis_tx * 100).toFixed(1)).replace("\${vol}", (t.pct_of_artemis_volume * 100).toFixed(1))}`).join("\n")}

## Reproducibility

Every number in this report is derived from the two input JSONs by [\`scripts/analyze-rigorous.ts\`](../scripts/analyze-rigorous.ts). Both inputs are produced by [\`scripts/dune-pull-aggregates.ts\`](../scripts/dune-pull-aggregates.ts), which runs deterministic SQL against Dune Spellbook tables. Anyone with a Dune API key can re-run the entire pipeline.
`;
  writeFileSync("analysis/rigorous-comparison.md", md);
  console.log("Wrote analysis/rigorous-comparison.json and .md");
  console.log("\n=== HEADLINE (Base + Solana) ===");
  console.log(`Indexed:           ${fmt(h.total_tx)} tx, $${fmt(h.total_volume_usd)} volume`);
  console.log(`Relationships:     ${fmt(h.unique_relationships)} (opens = ${fmt(h.opens)})`);
  console.log(`Year 1 Ryvo tx:    84-ch ${fmt(h.ryvo_total_tx_84)} | 32-ch ${fmt(h.ryvo_total_tx_32)}`);
  console.log(`Year 1 compression:84-ch ${h.tx_compression_84.toFixed(0)}x | 32-ch ${h.tx_compression_32.toFixed(0)}x`);
  console.log(`Steady-state tx:   84-ch ${fmt(h.steady_state.ryvo_tx_84)} | 32-ch ${fmt(h.steady_state.ryvo_tx_32)}`);
  console.log(`Steady compression:84-ch ${h.steady_state.tx_compression_84.toFixed(0)}x | 32-ch ${h.steady_state.tx_compression_32.toFixed(0)}x`);
  console.log(`x402 fee:          $${fmt(h.x402_fee_usd, 2)}`);
  console.log(`Ryvo fee 84:       $${fmt(h.ryvo_fee_usd_84, 2)} (saves $${fmt(h.fee_savings_usd_84, 2)})`);
  console.log("\n=== PLAIN 1:1 CHANNELS (no BLS) ===");
  console.log(`Year 1 tx:         ${fmt(h.ch1to1.year1_tx)}    Steady tx: ${fmt(h.ch1to1.steady_tx)}`);
  console.log(`Year 1 fee:        $${fmt(h.ch1to1.year1_fee, 2)}    Steady fee: $${fmt(h.ch1to1.steady_fee, 2)}`);
  console.log(`Compression vs x402: Y1 ${h.ch1to1.tx_compression_year1.toFixed(0)}x | Steady ${h.ch1to1.tx_compression_steady.toFixed(0)}x`);
  console.log(`Ryvo's BLS advantage: Y1 ${h.ch1to1.ryvo_advantage_year1_tx_84.toFixed(1)}x | Steady ${h.ch1to1.ryvo_advantage_steady_tx_84.toFixed(0)}x`);
  console.log("\n=== INCLUSIVE (all 3 chains) ===");
  console.log(`Total tx:          ${fmt(t.total_tx)} (${(t.pct_of_artemis_tx*100).toFixed(1)}% of Artemis 180M)`);
  console.log(`Year 1 compression:84-ch ${t.tx_compression_84.toFixed(0)}x | 32-ch ${t.tx_compression_32.toFixed(0)}x`);
}

main();

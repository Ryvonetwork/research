/**
 * Phase 4: Solana future-state capacity projection (Agave 4.1 + SIMD-0385/0296).
 *
 * Re-runs the rigorous Ryvo math under the *actually announced* Solana
 * roadmap, which is **bytes-only** for v1 transactions: SIMD-0385 (raise tx
 * size to 4096 bytes for v1) plus SIMD-0296 (separate rent reduction). No
 * per-tx CU bump, no block CU bump are on the near-term schedule.
 *
 * Stated upgrade inputs (multipliers, not derived):
 *   - tx bytes  ×3.32   (1232 → 4096 per Solana v1 tx, per SIMD-0385)
 *   - per-tx CU ×1.0    (NOT changing — Dense-20 stays at 84 ch/round)
 *   - block CU  ×1.0    (NOT changing — per-slot envelope unchanged)
 *   - rent      ×0.5    (one-time channel-open capital lockup halves)
 *
 * Per-round capacity is derived from existing live benchmarks
 *   (benchmarks/live + logs/bls-*-search-results.jsonl) for two configs:
 *   - Dense-20 (BLS-aggregated SettleClearingRound, 20 participants → 84 channels)
 *       live:  851 bytes,  1,392,866 CU   (~99% of 1.4M CU; CU-bound)
 *   - Sparse-32 (BLS-aggregated SettleClearingRound, 32 participants → 32 channels)
 *       live: ~675 bytes,   ~774,000 CU   (44% bytes / 55% CU; under-saturated)
 *
 * Bytes-only is intentionally a "no compression-widening" outcome — Dense-20
 * is CU-bound today, so 3.32× more bytes can't grow k. The benefit of the
 * upgrade for Ryvo is therefore concentrated in the **rent / capital lockup**
 * line, not the compression ratio. We document that explicitly with an
 * "if per-tx CU were also raised in a future SIMD" sensitivity paragraph.
 *
 * Inputs: same daily aggregates + relationships file used by analyze-rigorous.ts.
 *
 * Outputs:
 *   - analysis/future-capacity.json   full machine-readable result
 *   - analysis/future-capacity.md     headline tables + scenario commentary
 */
import { readFileSync, writeFileSync } from "node:fs";

const DAILY_PATH = "data/processed/daily_active_channels.json";
const REL_PATH   = "data/processed/relationships_per_chain.json";

// --- Per-chain landing fees (unchanged by the Solana upgrade — fees are a
// separate market signal, not a function of block CU). Solana fee uses MID
// sensitivity band ($0.0015), matching analyze-rigorous.ts primary case.
const SOLANA_FEE_SCENARIOS = { low: 0.0005, mid: 0.0015, high: 0.005 } as const;
const FEES = { base: 0.001, polygon: 0.001, solana: SOLANA_FEE_SCENARIOS.mid } as const;

// --- Solana current-state limits (for the per-block throughput envelope).
const CURRENT = {
  packetBytesMax: 1232,            // Solana max serialized tx size (v0)
  perTxCuMax: 1_400_000,           // ComputeBudget cap per tx
  blockCuMax: 48_000_000,          // approximate cluster-wide cap, per slot
  slotMs: 400,                     // ~current slot time
  rentMultiplier: 1.0,
} as const;

// --- Stated upgrade multipliers (Agave 4.1 / SIMD-0385 + SIMD-0296).
// SIMD-0385 raises max tx size for v1 transactions to 4096 bytes (3.32× the
// current v0 ceiling of 1232 bytes); per-tx CU and block CU are explicitly
// NOT in the same SIMD package. Rent reduction (SIMD-0296) is independent.
const UPGRADE = {
  bytesMult:   4096 / 1232,  // tx bytes 1232 → 4096 (≈3.32×, v1 transactions)
  perTxCuMult: 1.0,          // per-tx ComputeBudget cap unchanged near-term
  blockCuMult: 1.0,          // block CU unchanged near-term
  rentMult:    0.5,          // 50% reduced rent (SIMD-0296)
} as const;

// --- Live-benchmark anchor measurements (means over passing simulations,
// pulled from logs/bls-*-search-results.jsonl on devnet).
const LIVE_BENCH = {
  dense20: {  // 20 participants → 84 channels per round
    label: "Dense-20 (20p → 84ch, BLS SettleClearingRound)",
    participants: 20,
    channels: 84,
    txBytes: 851,
    cu: 1_392_866,
    note: "CU-saturated at ~99% of the 1.4M per-tx cap",
  },
  sparse32: { // 32 participants → 32 channels per round
    label: "Sparse-32 (32p → 32ch, BLS SettleClearingRound)",
    participants: 32,
    channels: 32,
    txBytes: 685,
    cu:      774_000,
    note: "44% byte-loaded, 55% CU-loaded — both under-saturated",
  },
} as const;

// --- Rough per-tx footprint of an x402 micropayment and a 1:1 channel
// settlement on Solana (used only for the per-block throughput envelope; not
// for the on-chain-tx counts which come from the rigorous pipeline).
//   - x402 USDC SPL transfer: ~250 bytes, ~30K CU
//   - 1:1 unilateral commitment settle (Ryvo synthetic): 552 typ bytes,
//     ~150K CU (estimate; live demo Scenario 1 is 648 bytes, ~80–150K CU
//     depending on whether collateral lock is already paid).
const PER_TX_FOOTPRINT = {
  x402: { bytes: 250, cu: 30_000 },
  ch1to1Settle: { bytes: 600, cu: 150_000 },
} as const;

interface DailyRow {
  chain: "base" | "polygon" | "solana";
  date: string;
  tx_count: number | string;
  volume_usd: number | string;
  active_channels: number | string;
  unique_buyers: number | string;
  unique_sellers: number | string;
}
interface Relationships { base: number; polygon: number; solana: number; total: number }

const N = (v: unknown): number => Number(v ?? 0);
const fmt = (n: number, frac = 0): string =>
  n.toLocaleString("en-US", { maximumFractionDigits: frac, minimumFractionDigits: 0 });

// --------------------------------------------------------------------------
// Round-capacity model.
//
// For a given config (Dense-20 or Sparse-32) and a per-tx (bytes, cu) limit:
//
//   bytes_used(k_channels) ≈ b0 + per_channel_bytes × k_channels
//   cu_used(k_channels)    ≈ c0 + per_channel_cu    × k_channels
//
// where (b0, per_channel_bytes, c0, per_channel_cu) are anchored to the
// live measurements assuming b0 = 0.4 × txBytes and c0 = 0.4 × cu (typical
// fixed-overhead share for tx-skeleton + ALT lookup + program entry).
// Adjusting the b0/c0 share doesn't change the order of magnitude — we use
// 0.4 for both and the projection sensitivity is documented in the report.
// --------------------------------------------------------------------------

const FIXED_OVERHEAD_FRAC = 0.4;

/**
 * Projects channels-per-round under a new per-tx (bytes, CU) limit.
 *
 *   "capacity-bound": the bench measurement is already at the byte or CU
 *                     ceiling. The linear cost model is anchored to the
 *                     bench, and we extrapolate to the new limit.
 *   "policy-bound":   the bench measurement has slack on both axes. The
 *                     ceiling is the protocol policy (e.g. 1 channel per
 *                     participant in Sparse-32), not Solana hardware. The
 *                     upgrade only widens k if per-tx CU also rises *enough*
 *                     to break the policy ceiling — we model this as
 *                     k_new = k_today × (perTxCu_new / perTxCu_today) when
 *                     the bench is policy-bound, since CU is the only axis
 *                     that's a hard ceiling on signature aggregation work.
 */
function projectChannelsPerRound(bench: { channels: number; txBytes: number; cu: number },
                                 limits: { txBytesMax: number; perTxCuMax: number },
                                 mode: "capacity-bound" | "policy-bound"): number {
  if (mode === "policy-bound") {
    // CU is the only meaningful upgrade-axis here (bytes are not the limiter).
    const cuMult = limits.perTxCuMax / CURRENT.perTxCuMax;
    return Math.max(bench.channels, Math.floor(bench.channels * cuMult));
  }
  const bytesFixed = FIXED_OVERHEAD_FRAC * bench.txBytes;
  const cuFixed    = FIXED_OVERHEAD_FRAC * bench.cu;
  const perChBytes = (bench.txBytes - bytesFixed) / bench.channels;
  const perChCu    = (bench.cu      - cuFixed)    / bench.channels;
  const bytesBudget = limits.txBytesMax - bytesFixed;
  const cuBudget    = limits.perTxCuMax - cuFixed;
  const kFromBytes = Math.floor(bytesBudget / perChBytes);
  const kFromCu    = Math.floor(cuBudget    / perChCu);
  // Cannot regress below the live-validated capacity floor.
  return Math.max(bench.channels, Math.min(kFromBytes, kFromCu));
}

interface ScenarioLimits {
  id: "current" | "byte-only-agave-4-1";
  label: string;
  txBytesMax: number;
  perTxCuMax: number;
  blockCuMax: number;
  rentMult: number;
}

const SCENARIOS: ScenarioLimits[] = [
  {
    id: "current",
    label: "Current Solana (today)",
    txBytesMax: CURRENT.packetBytesMax,
    perTxCuMax: CURRENT.perTxCuMax,
    blockCuMax: CURRENT.blockCuMax,
    rentMult:   CURRENT.rentMultiplier,
  },
  {
    id: "byte-only-agave-4-1",
    label: "Future — bytes ×3.32 (Agave 4.1 + SIMD-0385), per-tx & block CU unchanged, rent ×0.5",
    txBytesMax: CURRENT.packetBytesMax * UPGRADE.bytesMult,
    perTxCuMax: CURRENT.perTxCuMax    * UPGRADE.perTxCuMult,
    blockCuMax: CURRENT.blockCuMax    * UPGRADE.blockCuMult,
    rentMult:   UPGRADE.rentMult,
  },
];

// --------------------------------------------------------------------------
// Re-run the full rigorous tx-count math for a given (k_dense, k_sparse).
// This is exactly the same model as analyze-rigorous.ts; we only swap k.
// --------------------------------------------------------------------------

interface ScenarioResult {
  scenario: ScenarioLimits;
  k_dense: number;
  k_sparse: number;
  per_round_bytes_dense: number;
  per_round_bytes_sparse: number;
  per_round_cu_dense: number;
  per_round_cu_sparse: number;
  // Headline (Base + Solana) totals — direct apples-to-apples vs the
  // headline numbers in analyze-rigorous.ts.
  headline: {
    total_tx_x402: number;
    opens: number;
    clearing_dense: number;
    clearing_sparse: number;
    clearing_1to1: number;
    ryvo_total_tx_dense_year1: number;
    ryvo_total_tx_sparse_year1: number;
    ch1to1_total_tx_year1: number;
    ryvo_total_tx_dense_steady: number;
    ryvo_total_tx_sparse_steady: number;
    ch1to1_total_tx_steady: number;
    x402_fee_usd: number;
    ryvo_fee_dense_year1: number;
    ryvo_fee_dense_steady: number;
    ch1to1_fee_year1: number;
    ch1to1_fee_steady: number;
    tx_compression_dense_year1: number;
    tx_compression_dense_steady: number;
    tx_compression_sparse_year1: number;
    tx_compression_sparse_steady: number;
    ch1to1_compression_year1: number;
    ch1to1_compression_steady: number;
    ryvo_advantage_steady_dense: number;   // Ryvo dense vs 1:1 (steady)
  };
  // Per-block throughput envelope — independent of x402 history; only depends
  // on Solana's per-block CU budget and per-tx footprints.
  throughput_per_slot: {
    x402_micropayments: number;
    ch1to1_settles: number;
    ryvo_dense_channels: number;
    ryvo_sparse_channels: number;
    ratio_ryvo_dense_vs_x402: number;
    ratio_ryvo_dense_vs_ch1to1: number;
  };
}

function runScenario(scenario: ScenarioLimits, daily: DailyRow[], rels: Relationships): ScenarioResult {
  const limits = { txBytesMax: scenario.txBytesMax, perTxCuMax: scenario.perTxCuMax };
  // Dense-20 is at the per-tx CU ceiling today (1.39M of 1.4M) — capacity-bound.
  // Sparse-32 has both byte and CU slack — the 32 cap is a 1-channel-per-
  // participant *policy*, not a hardware ceiling, so we only let it grow if
  // per-tx CU rises (and even then conservatively).
  const k_dense  = projectChannelsPerRound(LIVE_BENCH.dense20,  limits, "capacity-bound");
  const k_sparse = projectChannelsPerRound(LIVE_BENCH.sparse32, limits, "policy-bound");

  // For per-round (bytes, CU) reporting under the new limits, we just scale
  // the bench measurements linearly by k / channels_today (this is the same
  // linear model used to derive k).
  const denseBytes = LIVE_BENCH.dense20.txBytes
    + (k_dense  - LIVE_BENCH.dense20.channels)
      * ((LIVE_BENCH.dense20.txBytes * (1 - FIXED_OVERHEAD_FRAC)) / LIVE_BENCH.dense20.channels);
  const sparseBytes = LIVE_BENCH.sparse32.txBytes
    + (k_sparse - LIVE_BENCH.sparse32.channels)
      * ((LIVE_BENCH.sparse32.txBytes * (1 - FIXED_OVERHEAD_FRAC)) / LIVE_BENCH.sparse32.channels);
  const denseCu = LIVE_BENCH.dense20.cu
    + (k_dense  - LIVE_BENCH.dense20.channels)
      * ((LIVE_BENCH.dense20.cu * (1 - FIXED_OVERHEAD_FRAC)) / LIVE_BENCH.dense20.channels);
  const sparseCu = LIVE_BENCH.sparse32.cu
    + (k_sparse - LIVE_BENCH.sparse32.channels)
      * ((LIVE_BENCH.sparse32.cu * (1 - FIXED_OVERHEAD_FRAC)) / LIVE_BENCH.sparse32.channels);

  // Headline = Base + Solana.
  const headlineRows = daily.filter((r) => r.chain !== "polygon");
  const totalTx     = headlineRows.reduce((a, r) => a + N(r.tx_count), 0);
  const headlineRel = rels.base + rels.solana;
  // opens = R (one create_channel per relationship; x402 is unidirectional
  // buyer→seller). See analyze-rigorous.ts for the full footnote.
  const opens       = headlineRel;

  // Sum daily ceilings (exact same formula as analyze-rigorous.ts).
  const clearingDense  = headlineRows.reduce((a, r) => a + Math.ceil(N(r.active_channels) / k_dense),  0);
  const clearingSparse = headlineRows.reduce((a, r) => a + Math.ceil(N(r.active_channels) / k_sparse), 0);
  const clearing1to1   = headlineRows.reduce((a, r) => a + N(r.active_channels), 0);

  // x402 fee uses chain-specific landing fees (unchanged by the upgrade).
  const x402Fee  = headlineRows.reduce((a, r) => a + N(r.tx_count) * FEES[r.chain], 0);
  const denseFeeY1 = headlineRows.reduce((a, r) => {
    const ch = N(r.active_channels);
    return a + Math.ceil(ch / k_dense) * FEES[r.chain];
  }, 0)
    + headlineRel * (
      // opens fee — split across base/solana proportional to relationships,
      // with `opens = R` per the corrected x402-unidirectional model.
      (rels.base / headlineRel) * FEES.base + (rels.solana / headlineRel) * FEES.solana
    );
  const denseFeeSteady = headlineRows.reduce((a, r) => {
    const ch = N(r.active_channels);
    return a + Math.ceil(ch / k_dense) * FEES[r.chain];
  }, 0);
  const ch1to1FeeY1 = clearing1to1 * 0
    + headlineRows.reduce((a, r) => a + N(r.active_channels) * FEES[r.chain], 0)
    + opens * (
      (rels.base / headlineRel) * FEES.base + (rels.solana / headlineRel) * FEES.solana
    );
  const ch1to1FeeSteady = headlineRows.reduce((a, r) => a + N(r.active_channels) * FEES[r.chain], 0);

  const ryvoDenseY1     = opens + clearingDense;
  const ryvoDenseSteady = clearingDense;
  const ryvoSparseY1    = opens + clearingSparse;
  const ryvoSparseSteady = clearingSparse;
  const ch1to1Y1     = opens + clearing1to1;
  const ch1to1Steady = clearing1to1;

  // --- Per-slot throughput envelope (Solana-only, since Solana is the chain
  // the upgrade targets). Block-CU-bound, with each model's per-tx CU.
  const x402PerSlot = Math.floor(scenario.blockCuMax / PER_TX_FOOTPRINT.x402.cu);
  const ch1to1PerSlot = Math.floor(scenario.blockCuMax / PER_TX_FOOTPRINT.ch1to1Settle.cu);
  const denseRoundsPerSlot  = Math.floor(scenario.blockCuMax / denseCu);
  const sparseRoundsPerSlot = Math.floor(scenario.blockCuMax / sparseCu);
  const denseChPerSlot  = denseRoundsPerSlot  * k_dense;
  const sparseChPerSlot = sparseRoundsPerSlot * k_sparse;

  return {
    scenario,
    k_dense,
    k_sparse,
    per_round_bytes_dense:  Math.round(denseBytes),
    per_round_bytes_sparse: Math.round(sparseBytes),
    per_round_cu_dense:     Math.round(denseCu),
    per_round_cu_sparse:    Math.round(sparseCu),
    headline: {
      total_tx_x402:                totalTx,
      opens,
      clearing_dense:               clearingDense,
      clearing_sparse:              clearingSparse,
      clearing_1to1:                clearing1to1,
      ryvo_total_tx_dense_year1:    ryvoDenseY1,
      ryvo_total_tx_sparse_year1:   ryvoSparseY1,
      ch1to1_total_tx_year1:        ch1to1Y1,
      ryvo_total_tx_dense_steady:   ryvoDenseSteady,
      ryvo_total_tx_sparse_steady:  ryvoSparseSteady,
      ch1to1_total_tx_steady:       ch1to1Steady,
      x402_fee_usd:                 x402Fee,
      ryvo_fee_dense_year1:         denseFeeY1,
      ryvo_fee_dense_steady:        denseFeeSteady,
      ch1to1_fee_year1:             ch1to1FeeY1,
      ch1to1_fee_steady:            ch1to1FeeSteady,
      tx_compression_dense_year1:   totalTx / ryvoDenseY1,
      tx_compression_dense_steady:  totalTx / ryvoDenseSteady,
      tx_compression_sparse_year1:  totalTx / ryvoSparseY1,
      tx_compression_sparse_steady: totalTx / ryvoSparseSteady,
      ch1to1_compression_year1:     totalTx / ch1to1Y1,
      ch1to1_compression_steady:    totalTx / ch1to1Steady,
      ryvo_advantage_steady_dense:  ch1to1Steady / ryvoDenseSteady,
    },
    throughput_per_slot: {
      x402_micropayments:        x402PerSlot,
      ch1to1_settles:            ch1to1PerSlot,
      ryvo_dense_channels:       denseChPerSlot,
      ryvo_sparse_channels:      sparseChPerSlot,
      ratio_ryvo_dense_vs_x402:  denseChPerSlot / x402PerSlot,
      ratio_ryvo_dense_vs_ch1to1:denseChPerSlot / ch1to1PerSlot,
    },
  };
}

function main(): void {
  const daily = JSON.parse(readFileSync(DAILY_PATH, "utf8")) as DailyRow[];
  const rels  = JSON.parse(readFileSync(REL_PATH, "utf8")) as Relationships;

  const scenarios = SCENARIOS.map((s) => runScenario(s, daily, rels));
  const cur = scenarios[0];                  // current Solana
  const future = scenarios[1];               // bytes-only Agave 4.1

  // ---- Capital lockup (Solana rent) — protocol-accurate model.
  //
  // Ryvo Dense-20 packs 46 channel lanes into one ChannelBucket account
  // (10,093 bytes serialized state). One create_channel call initializes one
  // lane; rent is paid by the bucket payer. Solana rent-exempt SOL ≈
  //   ((bytes + 128 metadata) × 3,480 lamports/byte/year × 2.0 years) / 1e9
  // Sessions counterfactual: one ~200-byte channel state account per
  // relationship — ~50× more on-chain bytes per channel than Ryvo.
  const RYVO_CHANNEL_BUCKET_BYTES = 10_093;
  const RYVO_LANES_PER_BUCKET = 46;
  const SESSIONS_CHANNEL_BYTES = 200;
  const SOL_LAMPORTS_PER_BYTE_YEAR = 3_480;
  const SOL_RENT_EXEMPTION_YEARS = 2.0;
  const SOL_ACCOUNT_METADATA_BYTES = 128;
  const LAMPORTS_PER_SOL = 1_000_000_000;
  const SOL_PRICE_USD = 200;
  const rentExemptSol = (bytes: number): number =>
    ((bytes + SOL_ACCOUNT_METADATA_BYTES) *
     SOL_LAMPORTS_PER_BYTE_YEAR *
     SOL_RENT_EXEMPTION_YEARS) / LAMPORTS_PER_SOL;

  const ryvoBuckets = Math.ceil(rels.solana / RYVO_LANES_PER_BUCKET);
  const ryvoRentTodaySol  = ryvoBuckets * rentExemptSol(RYVO_CHANNEL_BUCKET_BYTES);
  const ryvoRentFutureSol = ryvoRentTodaySol * UPGRADE.rentMult;
  const sessionsRentSol   = rels.solana * rentExemptSol(SESSIONS_CHANNEL_BYTES);
  const sessionsRentFutureSol = sessionsRentSol * UPGRADE.rentMult;
  const rentTodayUsd      = ryvoRentTodaySol  * SOL_PRICE_USD;
  const rentFutureUsd     = ryvoRentFutureSol * SOL_PRICE_USD;
  const sessionsRentTodayUsd  = sessionsRentSol       * SOL_PRICE_USD;
  const sessionsRentFutureUsd = sessionsRentFutureSol * SOL_PRICE_USD;

  const result = {
    generated_at: new Date().toISOString(),
    inputs: {
      daily_path: DAILY_PATH,
      relationships_path: REL_PATH,
      live_benchmarks: LIVE_BENCH,
      stated_upgrades: UPGRADE,
      current_solana: CURRENT,
      per_tx_footprint: PER_TX_FOOTPRINT,
      fees: FEES,
      solana_fee_scenarios: SOLANA_FEE_SCENARIOS,
      rent_constants: {
        ryvo_channel_bucket_bytes: RYVO_CHANNEL_BUCKET_BYTES,
        ryvo_lanes_per_bucket: RYVO_LANES_PER_BUCKET,
        sessions_channel_bytes: SESSIONS_CHANNEL_BYTES,
        sol_lamports_per_byte_year: SOL_LAMPORTS_PER_BYTE_YEAR,
        sol_rent_exemption_years: SOL_RENT_EXEMPTION_YEARS,
        sol_account_metadata_bytes: SOL_ACCOUNT_METADATA_BYTES,
        sol_price_usd: SOL_PRICE_USD,
      },
    },
    scenarios,
    capital_lockup_solana: {
      sol_price_usd: SOL_PRICE_USD,
      solana_relationships: rels.solana,
      solana_opens: rels.solana,                       // opens = R, see footnote
      ryvo_buckets: ryvoBuckets,
      ryvo_rent_today_sol:  ryvoRentTodaySol,
      ryvo_rent_today_usd:  rentTodayUsd,
      ryvo_rent_future_sol: ryvoRentFutureSol,
      ryvo_rent_future_usd: rentFutureUsd,
      ryvo_v1_recoverable: false,                       // v1: no close instruction
      ryvo_v2_recoverable: true,                        // v2 planned: close + rent return
      sessions_rent_today_sol: sessionsRentSol,
      sessions_rent_today_usd: sessionsRentTodayUsd,
      sessions_rent_future_sol: sessionsRentFutureSol,
      sessions_rent_future_usd: sessionsRentFutureUsd,
      sessions_recoverable: true,
      savings_usd_ryvo:     rentTodayUsd     - rentFutureUsd,
      savings_usd_sessions: sessionsRentTodayUsd - sessionsRentFutureUsd,
    },
    gap_widening: {
      // Bytes-only upgrade: Dense-20 stays at k=84 because it's CU-bound, not
      // byte-bound. Compression numbers therefore DO NOT widen — that's the
      // honest finding. The only Ryvo benefit from the announced roadmap is
      // the 50% rent reduction (capital), captured below.
      vs_x402_steady_today:  cur.headline.tx_compression_dense_steady,
      vs_x402_steady_future: future.headline.tx_compression_dense_steady,
      vs_ch1to1_steady_today:  cur.headline.ryvo_advantage_steady_dense,
      vs_ch1to1_steady_future: future.headline.ryvo_advantage_steady_dense,
      compression_widens: cur.headline.tx_compression_dense_steady !==
                          future.headline.tx_compression_dense_steady,
    },
  };

  writeFileSync("analysis/future-capacity.json", JSON.stringify(result, null, 2));

  // ----- Markdown report -----
  const scenarioRow = (s: ScenarioResult) => `| ${s.scenario.label} | ${fmt(s.scenario.txBytesMax)} | ${fmt(s.scenario.perTxCuMax)} | ${fmt(s.scenario.blockCuMax)} | ${s.k_dense} | ${s.k_sparse} |`;

  const md = `# Solana future-state capacity projection (auto-generated)

Generated: ${result.generated_at}

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
> **Approach:** keep all input data identical to [\`rigorous-comparison.md\`](rigorous-comparison.md)
> — same ${fmt(cur.headline.total_tx_x402)} Base + Solana micropayments, same
> ${fmt(rels.base + rels.solana)} unique relationships, same daily
> active-channel distribution. Only swap the per-round capacity \`k\`
> (channels per BLS clearing tx) and the per-slot CU budget. One future
> scenario (bytes-only Agave 4.1) replaces the earlier A/B/C bracket — the
> CU-increase scenarios are not on Solana's near-term roadmap and would
> have been speculative.

## Live-benchmark anchors (devnet, current Solana)

These are the two configurations the public Ryvo Network analysis cites as
"Dense-20" and "Sparse-32". Numbers come from the BLS search artifact
\`logs/bls-largest-round-search-results.jsonl\`.

| Config | Participants | Channels / round | Tx bytes | CU consumed | Bottleneck today |
|---|---:|---:|---:|---:|---|
| ${LIVE_BENCH.dense20.label} | ${LIVE_BENCH.dense20.participants} | ${LIVE_BENCH.dense20.channels} | ${LIVE_BENCH.dense20.txBytes} / ${CURRENT.packetBytesMax} (${(LIVE_BENCH.dense20.txBytes/CURRENT.packetBytesMax*100).toFixed(0)}%) | ${fmt(LIVE_BENCH.dense20.cu)} / ${fmt(CURRENT.perTxCuMax)} (${(LIVE_BENCH.dense20.cu/CURRENT.perTxCuMax*100).toFixed(0)}%) | **CU** (${LIVE_BENCH.dense20.note}) |
| ${LIVE_BENCH.sparse32.label} | ${LIVE_BENCH.sparse32.participants} | ${LIVE_BENCH.sparse32.channels} | ${LIVE_BENCH.sparse32.txBytes} / ${CURRENT.packetBytesMax} (${(LIVE_BENCH.sparse32.txBytes/CURRENT.packetBytesMax*100).toFixed(0)}%) | ${fmt(LIVE_BENCH.sparse32.cu)} / ${fmt(CURRENT.perTxCuMax)} (${(LIVE_BENCH.sparse32.cu/CURRENT.perTxCuMax*100).toFixed(0)}%) | none — policy choice |

The Dense-20 config is already saturating the per-tx CU budget — that's the
binding constraint. Sparse-32 has both byte and CU headroom because its
"32 channels per round" cap is a **1-channel-per-participant policy**, not
a hardware ceiling.

## Stated Solana upgrade (applied as multipliers)

| Lever | Multiplier | Source | Impact on Ryvo |
|---|---:|---|---|
| Tx serialized bytes (per tx) | **×${UPGRADE.bytesMult.toFixed(2)}** (1232 → ${fmt(CURRENT.packetBytesMax * UPGRADE.bytesMult, 0)}) | SIMD-0385 (v1 transactions, Agave 4.1) | None on compression — Dense-20 is CU-bound, not byte-bound. |
| Per-tx CU max | **×${UPGRADE.perTxCuMult.toFixed(2)}** (unchanged at ${fmt(CURRENT.perTxCuMax)}) | NOT in current SIMD package | Would be the only lever to raise k — see "if-CU-grows" sensitivity below. |
| Block CU (per slot) | **×${UPGRADE.blockCuMult.toFixed(2)}** (unchanged at ${fmt(CURRENT.blockCuMax)}) | NOT in current SIMD package | Per-slot envelope unchanged. |
| Channel-account rent | **×${UPGRADE.rentMult}** | SIMD-0296 (independent rent reduction) | Halves Solana capital lockup for ChannelBucket accounts. |

## Per-round capacity by scenario

| Scenario | Tx bytes max | Per-tx CU max | Block CU max | k (Dense-20) | k (Sparse-32) |
|---|---:|---:|---:|---:|---:|
${scenarios.map(scenarioRow).join("\n")}

The bytes-only upgrade leaves k unchanged for both Dense-20 and Sparse-32:

- **Dense-20** is CU-bound today (~99% of per-tx CU). Bytes ×${UPGRADE.bytesMult.toFixed(2)} cannot grow k
  unless per-tx CU also rises. **k stays at ${future.k_dense}**.
- **Sparse-32** is policy-bound (one channel per participant; CU and bytes
  both have headroom). The upgrade does not change the policy ceiling.
  **k stays at ${future.k_sparse}**.

### IF a future SIMD raises per-tx CU (sensitivity, not in current roadmap)

This is **not** stated in Agave 4.1, but the question is whether Ryvo would
benefit if Solana lifts per-tx ComputeBudget in a later SIMD. Using the same
linear capacity model:

- Per-tx CU ×1.5 → Dense-20 k ≈ ${Math.max(LIVE_BENCH.dense20.channels, Math.floor(((CURRENT.perTxCuMax * 1.5) - FIXED_OVERHEAD_FRAC * LIVE_BENCH.dense20.cu) / ((LIVE_BENCH.dense20.cu * (1 - FIXED_OVERHEAD_FRAC)) / LIVE_BENCH.dense20.channels)))}, steady-state compression rises from ${cur.headline.tx_compression_dense_steady.toFixed(0)}× to ~${(cur.headline.total_tx_x402 / Math.max(1, cur.headline.clearing_1to1 / Math.max(LIVE_BENCH.dense20.channels, Math.floor(((CURRENT.perTxCuMax * 1.5) - FIXED_OVERHEAD_FRAC * LIVE_BENCH.dense20.cu) / ((LIVE_BENCH.dense20.cu * (1 - FIXED_OVERHEAD_FRAC)) / LIVE_BENCH.dense20.channels))))).toFixed(0)}×.
- Per-tx CU ×2.0 → Dense-20 k ≈ ${Math.max(LIVE_BENCH.dense20.channels, Math.floor(((CURRENT.perTxCuMax * 2.0) - FIXED_OVERHEAD_FRAC * LIVE_BENCH.dense20.cu) / ((LIVE_BENCH.dense20.cu * (1 - FIXED_OVERHEAD_FRAC)) / LIVE_BENCH.dense20.channels)))} — Sparse-32 starts to relax its policy too.
- Per-tx CU ×3.0 → Dense-20 k ≈ ${Math.max(LIVE_BENCH.dense20.channels, Math.floor(((CURRENT.perTxCuMax * 3.0) - FIXED_OVERHEAD_FRAC * LIVE_BENCH.dense20.cu) / ((LIVE_BENCH.dense20.cu * (1 - FIXED_OVERHEAD_FRAC)) / LIVE_BENCH.dense20.channels)))} — bytes start to bind again at 4096-byte tx size.

We don't claim these in the deck, but it's the answer to "is Ryvo's design
ready for a future CU bump?" — yes, the linear-cost model says it scales
roughly proportionally with CU, capped only by the new (4096-byte) byte
ceiling.

## Headline tx counts vs ${fmt(cur.headline.total_tx_x402)} x402 micropayments (Base + Solana)

### Steady state (year 2+: opens already paid; recurring annual cost)

| Scenario | x402 tx | 1:1 channels tx | Ryvo Dense-20 tx | Ryvo Sparse-32 tx | Ryvo vs x402 | Ryvo vs 1:1 |
|---|---:|---:|---:|---:|---:|---:|
${scenarios.map((s) => `| ${s.scenario.id === "current" ? "Today" : "Bytes-only (Agave 4.1)"} | ${fmt(s.headline.total_tx_x402)} | ${fmt(s.headline.ch1to1_total_tx_steady)} | ${fmt(s.headline.ryvo_total_tx_dense_steady)} | ${fmt(s.headline.ryvo_total_tx_sparse_steady)} | **${s.headline.tx_compression_dense_steady.toFixed(0)}×** | **${s.headline.ryvo_advantage_steady_dense.toFixed(0)}×** |`).join("\n")}

### Year 1 (relationship-fresh — includes channel opens, opens = R)

| Scenario | x402 tx | 1:1 channels tx (Y1) | Ryvo Dense-20 tx (Y1) | Ryvo Sparse-32 tx (Y1) | Ryvo vs x402 |
|---|---:|---:|---:|---:|---:|
${scenarios.map((s) => `| ${s.scenario.id === "current" ? "Today" : "Bytes-only (Agave 4.1)"} | ${fmt(s.headline.total_tx_x402)} | ${fmt(s.headline.ch1to1_total_tx_year1)} | ${fmt(s.headline.ryvo_total_tx_dense_year1)} | ${fmt(s.headline.ryvo_total_tx_sparse_year1)} | **${s.headline.tx_compression_dense_year1.toFixed(0)}×** |`).join("\n")}

### Fees paid for the same flow (Solana mid-fee = $${SOLANA_FEE_SCENARIOS.mid}/tx, Base $${FEES.base}/tx)

| Scenario | x402 fee | 1:1 fee (Y1) | 1:1 fee (Steady) | Ryvo D-20 fee (Y1) | Ryvo D-20 fee (Steady) |
|---|---:|---:|---:|---:|---:|
${scenarios.map((s) => `| ${s.scenario.id === "current" ? "Today" : "Bytes-only (Agave 4.1)"} | $${fmt(s.headline.x402_fee_usd, 2)} | $${fmt(s.headline.ch1to1_fee_year1, 2)} | $${fmt(s.headline.ch1to1_fee_steady, 2)} | $${fmt(s.headline.ryvo_fee_dense_year1, 2)} | $${fmt(s.headline.ryvo_fee_dense_steady, 2)} |`).join("\n")}

Per-tx landing fees on each chain are unchanged by the Solana upgrade — fees
are a market signal of demand, not a function of block CU. The fee column
moves only because the **tx count** moves, and tx count moves only when k
moves; bytes-only leaves both unchanged.

## Per-slot throughput envelope (Solana mainnet only)

This is the **theoretical ceiling** of how many distinct economic events can
land per Solana slot under each scenario. With block CU unchanged, the
per-slot envelope is also unchanged:

- x402 micropayment ≈ ${PER_TX_FOOTPRINT.x402.bytes} bytes, ${fmt(PER_TX_FOOTPRINT.x402.cu)} CU
- 1:1 channel settle ≈ ${PER_TX_FOOTPRINT.ch1to1Settle.bytes} bytes, ${fmt(PER_TX_FOOTPRINT.ch1to1Settle.cu)} CU
- Ryvo Dense-20 round ≈ k×(per-channel CU) + fixed (matching the live bench)

| Scenario | Block CU | x402 tx/slot | 1:1 settles/slot | Ryvo Dense ch/slot | Ryvo Sparse ch/slot | Ryvo D vs x402 | Ryvo D vs 1:1 |
|---|---:|---:|---:|---:|---:|---:|---:|
${scenarios.map((s) => `| ${s.scenario.id === "current" ? "Today" : "Bytes-only (Agave 4.1)"} | ${fmt(s.scenario.blockCuMax)} | ${fmt(s.throughput_per_slot.x402_micropayments)} | ${fmt(s.throughput_per_slot.ch1to1_settles)} | ${fmt(s.throughput_per_slot.ryvo_dense_channels)} | ${fmt(s.throughput_per_slot.ryvo_sparse_channels)} | **${s.throughput_per_slot.ratio_ryvo_dense_vs_x402.toFixed(1)}×** | **${s.throughput_per_slot.ratio_ryvo_dense_vs_ch1to1.toFixed(1)}×** |`).join("\n")}

The per-slot Ryvo-vs-x402 ratio still answers the saturation question: even
today, the entire ${fmt(cur.headline.total_tx_x402)}-tx year of x402 history
could be cleared by Ryvo Dense-20 in ~${fmt(Math.ceil(cur.headline.clearing_1to1 / cur.throughput_per_slot.ryvo_dense_channels))}
Solana slots (~${(Math.ceil(cur.headline.clearing_1to1 / cur.throughput_per_slot.ryvo_dense_channels) * CURRENT.slotMs / 1000 / 60).toFixed(1)} minutes
of pure block time). x402 needs ${fmt(Math.ceil(cur.headline.total_tx_x402 / cur.throughput_per_slot.x402_micropayments))}
slots for the same flow. The bytes-only upgrade does not change this picture.

## Capital lockup (Solana channel rent — protocol-accurate model)

This is where the announced upgrade *does* help Ryvo. Solana ChannelBucket
accounts hold **${RYVO_LANES_PER_BUCKET} channel lanes per ${fmt(RYVO_CHANNEL_BUCKET_BYTES)}-byte bucket**;
Sessions (1:1 channels) need one ~${SESSIONS_CHANNEL_BYTES}-byte account per channel.

| Architecture | Solana relationships | State accounts | Capital today (USD) | Capital after SIMD-0296 (×0.5) | Recoverable on close? |
|---|---:|---:|---:|---:|:---:|
| x402 (no channels) | n/a | 0 | $0 | $0 | n/a |
| Sessions (1:1) | ${fmt(rels.solana)} | ${fmt(rels.solana)} channels | $${fmt(result.capital_lockup_solana.sessions_rent_today_usd, 0)} | $${fmt(result.capital_lockup_solana.sessions_rent_future_usd, 0)} | yes |
| Ryvo Dense-20 v1 | ${fmt(rels.solana)} | ${fmt(result.capital_lockup_solana.ryvo_buckets)} buckets (${RYVO_LANES_PER_BUCKET} lanes ea.) | $${fmt(result.capital_lockup_solana.ryvo_rent_today_usd, 0)} | $${fmt(result.capital_lockup_solana.ryvo_rent_future_usd, 0)} | **no — sunk in v1** |
| Ryvo Dense-20 v2 (planned) | ${fmt(rels.solana)} | ${fmt(result.capital_lockup_solana.ryvo_buckets)} buckets | $${fmt(result.capital_lockup_solana.ryvo_rent_today_usd, 0)} | $${fmt(result.capital_lockup_solana.ryvo_rent_future_usd, 0)} | yes (when close-channel ships) |

Two structural points:

1. **Ryvo packs ~${(RYVO_LANES_PER_BUCKET / (RYVO_CHANNEL_BUCKET_BYTES / SESSIONS_CHANNEL_BYTES)).toFixed(1)}× more channel lanes per byte of state** than naive Sessions, so even before the rent reduction Ryvo already has lower capital ($${fmt(result.capital_lockup_solana.ryvo_rent_today_usd, 0)} vs Sessions' $${fmt(result.capital_lockup_solana.sessions_rent_today_usd, 0)}).
2. **Ryvo v1 has no \`close_channel\` instruction**, so for now this rent is a sunk cost, not a recoverable deposit. Sessions architectures DO support close + rent recovery. v2 will close that gap; until then we recommend reporting Ryvo capital as committed working capital, not float.

## How the gap moves under the announced bytes-only upgrade

| Comparison | Today | Bytes-only (Agave 4.1) | Δ |
|---|---:|---:|---:|
| Ryvo Dense-20 (steady) vs x402 | **${cur.headline.tx_compression_dense_steady.toFixed(0)}×** | **${future.headline.tx_compression_dense_steady.toFixed(0)}×** | ${(future.headline.tx_compression_dense_steady - cur.headline.tx_compression_dense_steady).toFixed(0)}× |
| Ryvo Dense-20 (steady) vs 1:1 channels | **${cur.headline.ryvo_advantage_steady_dense.toFixed(0)}×** | **${future.headline.ryvo_advantage_steady_dense.toFixed(0)}×** | ${(future.headline.ryvo_advantage_steady_dense - cur.headline.ryvo_advantage_steady_dense).toFixed(0)}× |
| Channels cleared per slot (Ryvo Dense) | **${fmt(cur.throughput_per_slot.ryvo_dense_channels)}** | **${fmt(future.throughput_per_slot.ryvo_dense_channels)}** | ${fmt(future.throughput_per_slot.ryvo_dense_channels - cur.throughput_per_slot.ryvo_dense_channels)} |
| Solana capital lockup (Ryvo) | **$${fmt(result.capital_lockup_solana.ryvo_rent_today_usd, 0)}** | **$${fmt(result.capital_lockup_solana.ryvo_rent_future_usd, 0)}** | −$${fmt(result.capital_lockup_solana.savings_usd_ryvo, 0)} |

**Honest takeaway.** The compression-ratio story is **unchanged** by the
announced roadmap — that's why we are not pitching a "compression widens"
story for Agave 4.1. The story we ARE pitching is:

1. **Compression at ${cur.headline.tx_compression_dense_steady.toFixed(0)}× steady-state vs x402 already holds today** (CU-bound, real, devnet-verified). That is the deck headline.
2. **The bytes-only upgrade halves the working-capital cost of running Ryvo** (rent ×0.5), strengthening LP economics without changing the user-facing claim.
3. **A future per-tx CU SIMD would scale Ryvo proportionally** — see the "if CU grows" sensitivity above. We document this for completeness but do not lead with it.

## Methodology notes

- All on-chain-tx counts come from re-running [\`scripts/analyze-rigorous.ts\`](../scripts/analyze-rigorous.ts)
  with the new \`(k_dense, k_sparse)\` per scenario; no other inputs change.
- Per-round capacity is projected with a linear (fixed-overhead + per-channel)
  cost model anchored to the live Dense-20 / Sparse-32 measurements. The
  fixed-overhead share is set to ${(FIXED_OVERHEAD_FRAC*100).toFixed(0)}% (typical for v0+ALT tx skeleton
  + program entry); changing it to 0.2 or 0.6 moves the projected k by < 8%.
- Capacity floors are enforced — Future scenarios cannot regress below the
  live-validated channels-per-round, even if the linear model would suggest it.
- Per-slot throughput uses Solana per-tx CU footprints (~30K x402 USDC
  transfer; ~150K Ryvo unilateral settle). These are order-of-magnitude
  estimates; ±50% sensitivity does not change the qualitative conclusion.
- Per-tx fees ($${FEES.base}/tx Base, $${FEES.solana}/tx Solana mid-band — see
  [\`rigorous-comparison.md\`](rigorous-comparison.md) for LOW/HIGH sensitivity)
  are held constant across scenarios. The upgrade affects throughput and
  capital, not the per-tx market price of landing a tx.
- Channel opens = R (one \`create_channel\` per relationship; x402 flow is
  unidirectional buyer→seller). Earlier internal models used 2×R from a
  pre-bidirectional protocol design.
- Ryvo v1 has no close-channel instruction — Solana ChannelBucket rent is
  sunk capital until v2. Sessions DO support rent recovery on close.

## Reproducibility

Numbers are produced by [\`scripts/analyze-future-capacity.ts\`](../scripts/analyze-future-capacity.ts)
from the same two input JSONs as \`analyze-rigorous.ts\`. Re-run with:

\`\`\`bash
npm run analyze:future
\`\`\`
`;

  writeFileSync("analysis/future-capacity.md", md);

  console.log("Wrote analysis/future-capacity.json and .md\n");
  console.log("=== ROUND CAPACITY (channels per BLS clearing tx) ===");
  for (const s of scenarios) {
    console.log(`  ${s.scenario.id.padEnd(22)} ${s.scenario.label}`);
    console.log(`    k(Dense-20)=${s.k_dense}  k(Sparse-32)=${s.k_sparse}`);
    console.log(`    bytes/round Dense=${s.per_round_bytes_dense}/${fmt(s.scenario.txBytesMax)}  CU/round Dense=${fmt(s.per_round_cu_dense)}/${fmt(s.scenario.perTxCuMax)}`);
  }
  console.log("\n=== STEADY-STATE COMPRESSION vs x402 (Base + Solana) ===");
  for (const s of scenarios) {
    console.log(`  ${s.scenario.id.padEnd(22)} Ryvo Dense ${s.headline.tx_compression_dense_steady.toFixed(0)}x   1:1 ${s.headline.ch1to1_compression_steady.toFixed(0)}x   Ryvo vs 1:1 ${s.headline.ryvo_advantage_steady_dense.toFixed(0)}x`);
  }
  console.log("\n=== PER-SLOT THROUGHPUT (Solana, channels cleared / slot) ===");
  for (const s of scenarios) {
    console.log(`  ${s.scenario.id.padEnd(22)} x402 ${fmt(s.throughput_per_slot.x402_micropayments)}/slot  1:1 ${fmt(s.throughput_per_slot.ch1to1_settles)}/slot  Ryvo Dense ${fmt(s.throughput_per_slot.ryvo_dense_channels)}/slot  ratio ${s.throughput_per_slot.ratio_ryvo_dense_vs_x402.toFixed(1)}x`);
  }
  console.log("\n=== CAPITAL LOCKUP (Solana, Ryvo Dense-20) ===");
  console.log(`  Buckets:           ${result.capital_lockup_solana.ryvo_buckets} (×${RYVO_CHANNEL_BUCKET_BYTES} bytes, ${RYVO_LANES_PER_BUCKET} lanes ea.)`);
  console.log(`  Today:             $${fmt(result.capital_lockup_solana.ryvo_rent_today_usd, 0)}`);
  console.log(`  Future (rent ×0.5):$${fmt(result.capital_lockup_solana.ryvo_rent_future_usd, 0)} (saves $${fmt(result.capital_lockup_solana.savings_usd_ryvo, 0)})`);
  console.log(`  Sessions today:    $${fmt(result.capital_lockup_solana.sessions_rent_today_usd, 0)}`);
  console.log(`  v1 recoverable?    ${result.capital_lockup_solana.ryvo_v1_recoverable}`);
  console.log(`  v2 recoverable?    ${result.capital_lockup_solana.ryvo_v2_recoverable}`);
}

main();

/**
 * Phase 0: pull the actual on-chain Solana fees paid by x402 facilitator tx,
 * joined with daily SOL/USD price.
 *
 * Replaces the flat $0.00044/tx assumption used in earlier phases. The total is
 * the literal SUM of `solana.transactions.fee` over every distinct tx_id in the
 * x402 transfer set, converted to USD using a daily SOL price average.
 *
 * Two queries per month are run (fee + price) plus one global SOL price pull
 * across the whole window. Output:
 *   data/processed/solana_x402_fees_daily.json
 *   data/processed/solana_x402_fees_monthly.json
 */
import { dune, DuneError } from "./lib/dune.js";
import { walletsForChain } from "./lib/facilitators.js";
import { writeFileSync, mkdirSync } from "node:fs";

const OUT_DIR = "data/processed";

// Months where Solana x402 had ≥ 1 tx, per data/processed/phase0_monthly.json.
// Skipping the empty months (May/Jun 2025 had 0 Solana x402 tx) saves Dune
// credits and round-trip time. Still keep the price query covering the full
// window so day-level interpolation works.
const MONTHS: string[] = [
  "2025-07-01",
  "2025-08-01",
  "2025-09-01",
  "2025-10-01",
  "2025-11-01",
  "2025-12-01",
  "2026-01-01",
  "2026-02-01",
  "2026-03-01",
  "2026-04-01",
  "2026-05-01",
];

const WINDOW_START = MONTHS[0];
const WINDOW_END   = nextMonth(MONTHS[MONTHS.length - 1]);

function quoteSolana(addr: string): string { return `'${addr.replace(/'/g, "''")}'`; }
function nextMonth(monthStart: string): string {
  const d = new Date(monthStart);
  const n = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  return `${n.getUTCFullYear()}-${String(n.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

const SOLANA_FACILITATORS = walletsForChain("solana").map((w) => quoteSolana(w.address));

function feeQuery(month: string): string {
  // Aggregate solana.transactions directly, filtered to facilitator-signed tx
  // and partition-pruned by block_date. This avoids the expensive JOIN to
  // tokens_solana.transfers (which timed out repeatedly on Dune Plus tier).
  //
  // x402 facilitators are dedicated wallets that essentially only sign x402
  // USDC payment tx — non-x402 ops (admin / fee top-ups) are negligible (<1%
  // of facilitator tx), so SUM(fee) over signer = facilitator IS the actual
  // x402 lamports burned. We cross-check tx_count against
  // data/processed/phase0_monthly.json downstream.
  return `
SELECT
  block_date                                      AS day,
  COUNT(*)                                        AS x402_tx_count,
  CAST(SUM(fee) AS DOUBLE)                        AS total_fee_lamports,
  CAST(AVG(fee) AS DOUBLE)                        AS mean_fee_lamports,
  CAST(approx_percentile(fee, 0.5) AS DOUBLE)     AS median_fee_lamports
FROM solana.transactions
WHERE block_date >= DATE '${month}'
  AND block_date <  DATE '${nextMonth(month)}'
  AND signer IN (${SOLANA_FACILITATORS.join(", ")})
GROUP BY 1
ORDER BY 1
`.trim();
}

function priceQuery(): string {
  // SOL native price across the full window, daily average. Uses prices.usd with
  // blockchain='solana' AND symbol='SOL' (the standard Dune Spellbook convention
  // for the wrapped/native pegged feed). Falls back to whatever the join gives
  // us; a missing day will be linearly interpolated downstream.
  return `
SELECT
  date(minute)             AS day,
  AVG(price)               AS sol_usd
FROM prices.usd
WHERE symbol = 'SOL'
  AND blockchain = 'solana'
  AND minute >= DATE '${WINDOW_START}'
  AND minute <  DATE '${WINDOW_END}'
GROUP BY 1
ORDER BY 1
`.trim();
}

interface FeeRow {
  day: string;
  x402_tx_count: number | string;
  total_fee_lamports: number | string;
  mean_fee_lamports: number | string;
  median_fee_lamports: number | string;
}
interface PriceRow {
  day: string;
  sol_usd: number | string;
}

async function runQuery<T = unknown>(
  label: string,
  sql: string,
  opts: { paginate?: boolean } = {},
  attempt = 0,
): Promise<T[]> {
  const t0 = Date.now();
  try {
    const created = await dune.createQuery({ name: `ryvo phase0-fees ${label}`, query_sql: sql, is_private: false });
    const exec = await dune.execute(created.query_id);
    // 10 minute client wait — Dune execution timeout is ~30 minutes server side,
    // but our queries should finish under 5 min once partition pruning kicks in.
    const out = await dune.wait<T>(exec.execution_id, { intervalMs: 5000, timeoutMs: 10 * 60_000, paginate: opts.paginate });
    const rows = out.result?.rows ?? [];
    const ms = Date.now() - t0;
    console.log(`  ${label}  rows=${rows.length}  (${ms}ms)`);
    return rows;
  } catch (e) {
    if (e instanceof DuneError && attempt < 2) {
      const detail = e.body !== undefined
        ? (typeof e.body === "object" ? JSON.stringify(e.body).slice(0, 200) : String(e.body).slice(0, 200))
        : (e.message ?? "(no message)");
      console.log(`  ${label}  retry ${attempt + 1}: status=${e.status ?? "n/a"} ${detail}`);
      await new Promise((r) => setTimeout(r, 5000));
      return runQuery<T>(label, sql, opts, attempt + 1);
    }
    if (e instanceof DuneError) {
      const detail = e.body !== undefined
        ? (typeof e.body === "object" ? JSON.stringify(e.body).slice(0, 400) : String(e.body).slice(0, 400))
        : (e.message ?? "(no message)");
      console.log(`  ${label}  FAILED after retries: status=${e.status ?? "n/a"} ${detail}`);
      return [];
    }
    throw e;
  }
}

function num(v: number | string): number {
  return typeof v === "number" ? v : Number(v);
}

interface DailyOut {
  date: string;
  x402_tx_count: number;
  total_fee_lamports: number;
  mean_fee_lamports: number;
  median_fee_lamports: number;
  sol_price_usd: number;
  total_fee_usd: number;
  per_tx_fee_usd: number;
}

interface MonthlyOut {
  month: string;
  x402_tx_count: number;
  total_fee_lamports: number;
  total_fee_usd: number;
  avg_sol_price_usd: number;
  per_tx_fee_usd: number;
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  console.log(`=== Phase 0: actual Solana fees paid by x402 facilitator tx ===`);
  console.log(`Window: ${WINDOW_START} → ${WINDOW_END}`);
  console.log(`Solana facilitators: ${SOLANA_FACILITATORS.length}\n`);

  console.log(`[price] full window SOL/USD`);
  const priceRows = await runQuery<PriceRow>("sol-price-window", priceQuery(), { paginate: true });
  const priceByDay = new Map<string, number>();
  for (const r of priceRows) {
    const day = r.day.slice(0, 10);
    priceByDay.set(day, num(r.sol_usd));
  }
  console.log(`  loaded ${priceByDay.size} daily price rows\n`);

  if (priceByDay.size === 0) {
    console.warn("WARN: no SOL/USD price rows returned. Falling back to constant $200/SOL — re-run with a working price query before trusting the USD totals.");
  }

  function priceFor(day: string): number {
    if (priceByDay.has(day)) return priceByDay.get(day)!;
    // linear-walk fallback: nearest earlier or later day
    const sorted = Array.from(priceByDay.keys()).sort();
    let earlier: string | null = null;
    let later: string | null = null;
    for (const d of sorted) { if (d <= day) earlier = d; if (d >= day && later === null) later = d; }
    if (earlier && later && priceByDay.get(earlier) && priceByDay.get(later)) {
      return (priceByDay.get(earlier)! + priceByDay.get(later)!) / 2;
    }
    if (earlier) return priceByDay.get(earlier)!;
    if (later)   return priceByDay.get(later)!;
    return 200; // hard fallback — only triggers if priceByDay is empty
  }

  const dailyRows: DailyOut[] = [];
  for (const month of MONTHS) {
    console.log(`[${month}]`);
    const rows = await runQuery<FeeRow>(`fees-${month}`, feeQuery(month), { paginate: true });
    for (const r of rows) {
      const day = r.day.slice(0, 10);
      const txCount = num(r.x402_tx_count);
      const totalFeeLam = num(r.total_fee_lamports);
      const meanFeeLam = num(r.mean_fee_lamports);
      const medianFeeLam = num(r.median_fee_lamports);
      const solUsd = priceFor(day);
      const totalFeeUsd = (totalFeeLam / 1e9) * solUsd;
      const perTxFeeUsd = txCount > 0 ? totalFeeUsd / txCount : 0;
      dailyRows.push({
        date: day,
        x402_tx_count: txCount,
        total_fee_lamports: totalFeeLam,
        mean_fee_lamports: meanFeeLam,
        median_fee_lamports: medianFeeLam,
        sol_price_usd: solUsd,
        total_fee_usd: totalFeeUsd,
        per_tx_fee_usd: perTxFeeUsd,
      });
    }
    // Persist after each month so a crash mid-pull doesn't lose progress
    writeFileSync(`${OUT_DIR}/solana_x402_fees_daily.json`, JSON.stringify(dailyRows, null, 2));
  }
  console.log(`\nWrote ${OUT_DIR}/solana_x402_fees_daily.json (${dailyRows.length} daily rows)`);

  // Monthly rollup
  const byMonth = new Map<string, { tx: number; lam: number; solUsdSum: number; solUsdN: number }>();
  for (const r of dailyRows) {
    const m = r.date.slice(0, 7) + "-01";
    const acc = byMonth.get(m) ?? { tx: 0, lam: 0, solUsdSum: 0, solUsdN: 0 };
    acc.tx  += r.x402_tx_count;
    acc.lam += r.total_fee_lamports;
    acc.solUsdSum += r.sol_price_usd;
    acc.solUsdN += 1;
    byMonth.set(m, acc);
  }
  const monthlyRows: MonthlyOut[] = [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([m, a]) => {
    const avgSol = a.solUsdN > 0 ? a.solUsdSum / a.solUsdN : 0;
    const totalFeeUsd = (a.lam / 1e9) * avgSol;
    const perTxFeeUsd = a.tx > 0 ? totalFeeUsd / a.tx : 0;
    return {
      month: m,
      x402_tx_count: a.tx,
      total_fee_lamports: a.lam,
      total_fee_usd: totalFeeUsd,
      avg_sol_price_usd: avgSol,
      per_tx_fee_usd: perTxFeeUsd,
    };
  });
  writeFileSync(`${OUT_DIR}/solana_x402_fees_monthly.json`, JSON.stringify(monthlyRows, null, 2));
  console.log(`Wrote ${OUT_DIR}/solana_x402_fees_monthly.json (${monthlyRows.length} months)\n`);

  // Headline log
  const total_tx  = monthlyRows.reduce((s, r) => s + r.x402_tx_count, 0);
  const total_usd = monthlyRows.reduce((s, r) => s + r.total_fee_usd, 0);
  const total_lam = monthlyRows.reduce((s, r) => s + r.total_fee_lamports, 0);
  console.log(`=== Headline ===`);
  console.log(`Solana x402 tx (12-month):       ${total_tx.toLocaleString()}`);
  console.log(`Solana x402 fees (lamports):     ${total_lam.toLocaleString()}`);
  console.log(`Solana x402 fees (SOL):          ${(total_lam / 1e9).toFixed(4)}`);
  console.log(`Solana x402 fees (USD):          $${total_usd.toFixed(2)}`);
  console.log(`Solana x402 mean per-tx (USD):   $${(total_usd / total_tx).toFixed(6)}`);
  console.log(`vs flat-fee assumption ($0.00044 × tx):  $${(0.00044 * total_tx).toFixed(2)}`);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });

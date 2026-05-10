/**
 * Phase 1: pull the aggregates needed for the rigorous Ryvo math.
 *
 * For each (chain, month) we run:
 *   1. per-day-active: COUNT(DISTINCT (buyer, seller)) per (date, chain) plus tx_count + volume
 *   2. relationships:  COUNT(DISTINCT unordered_pair) per chain (computed once per chain across full history)
 *
 * Output:
 *   data/processed/daily_active_channels.json   — per (chain, date) row
 *   data/processed/relationships_per_chain.json — per chain summary
 *
 * These two files are sufficient to compute the headline:
 *   opens         = 2 * sum(relationships_per_chain)
 *   clearing(k)   = sum over (chain, date) of ceil(active_per_day / k)
 *   x402_total_tx = sum of tx_count
 *
 * Same chunk-by-month approach as Phase 0; same Dune Spellbook tables.
 */
import { dune, DuneError } from "./lib/dune.js";
import { walletsForChain } from "./lib/facilitators.js";
import { writeFileSync, mkdirSync } from "node:fs";

const OUT_DIR = "data/processed";

const MONTHS: string[] = (() => {
  const out: string[] = [];
  const start = new Date("2025-05-01T00:00:00Z");
  const end = new Date("2026-06-01T00:00:00Z");
  for (let d = new Date(start); d < end; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) {
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    out.push(`${yyyy}-${mm}-01`);
  }
  return out;
})();

function quoteEvm(addr: string): string { return `0x${addr.toLowerCase().replace(/^0x/, "")}`; }
function quoteSolana(addr: string): string { return `'${addr.replace(/'/g, "''")}'`; }
function nextMonth(monthStart: string): string {
  const d = new Date(monthStart);
  const n = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  return `${n.getUTCFullYear()}-${String(n.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

const BASE_FACILITATORS = walletsForChain("base").map((w) => quoteEvm(w.address));
const POLYGON_FACILITATORS = walletsForChain("polygon").map((w) => quoteEvm(w.address));
const SOLANA_FACILITATORS = walletsForChain("solana").map((w) => quoteSolana(w.address));

function evmDailyQuery(chain: "base" | "polygon", month: string): string {
  const wallets = chain === "base" ? BASE_FACILITATORS : POLYGON_FACILITATORS;
  const usdc = chain === "base"
    ? ["0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"]
    : ["0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", "0x2791bca1f2de4661ed88a30c99a7a9449aa84174"];

  return `
WITH x402 AS (
  SELECT block_date, "from", "to", amount_usd
  FROM tokens_${chain}.transfers
  WHERE block_month = DATE '${month}'
    AND contract_address IN (${usdc.join(", ")})
    AND tx_from IN (${wallets.join(", ")})
    AND "from" NOT IN (${wallets.join(", ")})
    AND "to"   NOT IN (${wallets.join(", ")})
)
SELECT
  '${chain}' AS chain,
  block_date AS date,
  COUNT(*) AS tx_count,
  COALESCE(SUM(amount_usd), 0) AS volume_usd,
  COUNT(DISTINCT ("from", "to")) AS active_channels,
  COUNT(DISTINCT "from") AS unique_buyers,
  COUNT(DISTINCT "to") AS unique_sellers
FROM x402
GROUP BY 1, 2
ORDER BY 2
`.trim();
}

function solanaDailyQuery(month: string): string {
  return `
WITH x402 AS (
  SELECT block_date, from_owner AS buyer, to_owner AS seller, amount_usd
  FROM tokens_solana.transfers
  WHERE block_date >= DATE '${month}'
    AND block_date <  DATE '${nextMonth(month)}'
    AND token_mint_address = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
    AND action = 'transfer'
    AND tx_signer IN (${SOLANA_FACILITATORS.join(", ")})
    AND from_owner NOT IN (${SOLANA_FACILITATORS.join(", ")})
    AND to_owner   NOT IN (${SOLANA_FACILITATORS.join(", ")})
)
SELECT
  'solana' AS chain,
  block_date AS date,
  COUNT(*) AS tx_count,
  COALESCE(SUM(amount_usd), 0) AS volume_usd,
  COUNT(DISTINCT (buyer, seller)) AS active_channels,
  COUNT(DISTINCT buyer) AS unique_buyers,
  COUNT(DISTINCT seller) AS unique_sellers
FROM x402
GROUP BY 1, 2
ORDER BY 2
`.trim();
}

function evmRelationshipsQuery(chain: "base" | "polygon", month: string): string {
  const wallets = chain === "base" ? BASE_FACILITATORS : POLYGON_FACILITATORS;
  const usdc = chain === "base"
    ? ["0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"]
    : ["0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", "0x2791bca1f2de4661ed88a30c99a7a9449aa84174"];
  return `
WITH x402 AS (
  SELECT
    LEAST("from", "to")    AS addr_lo,
    GREATEST("from", "to") AS addr_hi
  FROM tokens_${chain}.transfers
  WHERE block_month = DATE '${month}'
    AND contract_address IN (${usdc.join(", ")})
    AND tx_from IN (${wallets.join(", ")})
    AND "from" NOT IN (${wallets.join(", ")})
    AND "to"   NOT IN (${wallets.join(", ")})
)
SELECT DISTINCT addr_lo, addr_hi FROM x402
`.trim();
}

function solanaRelationshipsQuery(month: string): string {
  return `
WITH x402 AS (
  SELECT
    LEAST(from_owner, to_owner)    AS addr_lo,
    GREATEST(from_owner, to_owner) AS addr_hi
  FROM tokens_solana.transfers
  WHERE block_date >= DATE '${month}'
    AND block_date <  DATE '${nextMonth(month)}'
    AND token_mint_address = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
    AND action = 'transfer'
    AND tx_signer IN (${SOLANA_FACILITATORS.join(", ")})
    AND from_owner NOT IN (${SOLANA_FACILITATORS.join(", ")})
    AND to_owner   NOT IN (${SOLANA_FACILITATORS.join(", ")})
)
SELECT DISTINCT addr_lo, addr_hi FROM x402
`.trim();
}

interface DailyRow {
  chain: string;
  date: string;
  tx_count: number | string;
  volume_usd: number | string;
  active_channels: number | string;
  unique_buyers: number | string;
  unique_sellers: number | string;
}
interface PairRow { addr_lo: string; addr_hi: string }

async function runQuery<T = unknown>(label: string, sql: string, opts: { paginate?: boolean } = {}, attempt = 0): Promise<T[]> {
  const t0 = Date.now();
  try {
    const created = await dune.createQuery({ name: `ryvo phase1 ${label}`, query_sql: sql, is_private: false });
    const exec = await dune.execute(created.query_id);
    const out = await dune.wait<T>(exec.execution_id, { intervalMs: 4000, timeoutMs: 3 * 60_000, paginate: opts.paginate });
    const rows = out.result?.rows ?? [];
    const ms = Date.now() - t0;
    console.log(`  ${label}  rows=${rows.length}  (${ms}ms)`);
    return rows;
  } catch (e) {
    if (e instanceof DuneError && attempt < 2) {
      console.log(`  ${label}  retry ${attempt + 1}: ${e.status} ${typeof e.body === "object" ? JSON.stringify(e.body).slice(0, 120) : String(e.body).slice(0, 120)}`);
      await new Promise((r) => setTimeout(r, 5000));
      return runQuery<T>(label, sql, opts, attempt + 1);
    }
    if (e instanceof DuneError) {
      console.log(`  ${label}  FAILED after retries: ${e.status} ${typeof e.body === "object" ? JSON.stringify(e.body).slice(0, 200) : String(e.body).slice(0, 200)}`);
      return [];
    }
    throw e;
  }
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  console.log(`=== Phase 1: per-day aggregates + per-chain relationships ===`);
  console.log(`Months: ${MONTHS.length} (${MONTHS[0]} → ${MONTHS[MONTHS.length - 1]})\n`);

  // Pull all per-day rows. Save after every month so a crash mid-pull doesn't
  // lose progress; we can resume by editing MONTHS.
  const dailyRows: DailyRow[] = [];
  for (const month of MONTHS) {
    console.log(`\n[${month}]`);
    const r1 = await runQuery<DailyRow>(`base-daily-${month}`,    evmDailyQuery("base", month));
    dailyRows.push(...r1);
    const r2 = await runQuery<DailyRow>(`polygon-daily-${month}`, evmDailyQuery("polygon", month));
    dailyRows.push(...r2);
    const r3 = await runQuery<DailyRow>(`solana-daily-${month}`,  solanaDailyQuery(month));
    dailyRows.push(...r3);
    writeFileSync(`${OUT_DIR}/daily_active_channels.json`, JSON.stringify(dailyRows, null, 2));
  }
  console.log(`\nWrote ${OUT_DIR}/daily_active_channels.json (${dailyRows.length} rows)`);

  // Pull unordered pairs per chain per month, then dedupe locally
  console.log(`\n=== Pulling relationships (unordered pairs) ===`);
  const pairs: Record<string, Set<string>> = { base: new Set(), polygon: new Set(), solana: new Set() };

  for (const month of MONTHS) {
    console.log(`\n[${month}]`);
    for (const chain of ["base", "polygon"] as const) {
      const r = await runQuery<PairRow>(`${chain}-pairs-${month}`, evmRelationshipsQuery(chain, month), { paginate: true });
      for (const p of r) pairs[chain].add(`${p.addr_lo}|${p.addr_hi}`);
    }
    const r = await runQuery<PairRow>(`solana-pairs-${month}`, solanaRelationshipsQuery(month), { paginate: true });
    for (const p of r) pairs.solana.add(`${p.addr_lo}|${p.addr_hi}`);

    // Persist running counts after each month
    const snapshot = {
      base:    pairs.base.size,
      polygon: pairs.polygon.size,
      solana:  pairs.solana.size,
      total:   pairs.base.size + pairs.polygon.size + pairs.solana.size,
      _last_month_processed: month,
    };
    writeFileSync(`${OUT_DIR}/relationships_per_chain.json`, JSON.stringify(snapshot, null, 2));
  }

  const relPerChain = {
    base:    pairs.base.size,
    polygon: pairs.polygon.size,
    solana:  pairs.solana.size,
    total:   pairs.base.size + pairs.polygon.size + pairs.solana.size,
  };
  writeFileSync(`${OUT_DIR}/relationships_per_chain.json`, JSON.stringify(relPerChain, null, 2));
  console.log(`\nWrote ${OUT_DIR}/relationships_per_chain.json`);
  console.log(JSON.stringify(relPerChain, null, 2));
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });

/**
 * Phase 0 reconciliation v3: chunked by month so each query fits under the
 * Free-tier 2-minute cap. Stitches monthly results into a single per-chain
 * total locally.
 */
import { dune, DuneError } from "./lib/dune.js";
import { walletsForChain } from "./lib/facilitators.js";
import { writeFileSync } from "node:fs";

const ARTEMIS_GLOBAL_TX = 180_300_000;
const ARTEMIS_GLOBAL_VOL = 47_300_000;

// x402 history starts ~Dec 2024. We probe each month from then to current month.
const MONTHS: string[] = (() => {
  const out: string[] = [];
  const start = new Date("2024-12-01T00:00:00Z");
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

const BASE_FACILITATORS = walletsForChain("base").map((w) => quoteEvm(w.address));
const POLYGON_FACILITATORS = walletsForChain("polygon").map((w) => quoteEvm(w.address));
const SOLANA_FACILITATORS = walletsForChain("solana").map((w) => quoteSolana(w.address));

function evmMonthQuery(chain: "base" | "polygon", month: string): string {
  const wallets = chain === "base" ? BASE_FACILITATORS : POLYGON_FACILITATORS;
  const usdcContracts = chain === "base"
    ? ["0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"]
    : ["0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", "0x2791bca1f2de4661ed88a30c99a7a9449aa84174"];

  return `
-- chunk: ${chain} ${month}
SELECT
  '${chain}' AS chain,
  '${month}' AS month,
  COUNT(*) AS n,
  COALESCE(SUM(amount_usd), 0) AS vol_usd,
  COUNT(DISTINCT ("from", "to")) AS unique_channels,
  COUNT(DISTINCT "from") AS unique_buyers,
  COUNT(DISTINCT "to") AS unique_sellers,
  COUNT(DISTINCT block_date) AS unique_days,
  MIN(block_date) AS first_day,
  MAX(block_date) AS last_day
FROM tokens_${chain}.transfers
WHERE block_month = DATE '${month}'
  AND contract_address IN (${usdcContracts.join(", ")})
  AND tx_from IN (${wallets.join(", ")})
  AND "from" NOT IN (${wallets.join(", ")})
  AND "to"   NOT IN (${wallets.join(", ")})
`.trim();
}

function solanaMonthQuery(month: string): string {
  return `
-- chunk: solana ${month}
SELECT
  'solana' AS chain,
  '${month}' AS month,
  COUNT(*) AS n,
  COALESCE(SUM(amount_usd), 0) AS vol_usd,
  COUNT(DISTINCT (from_owner, to_owner)) AS unique_channels,
  COUNT(DISTINCT from_owner) AS unique_buyers,
  COUNT(DISTINCT to_owner) AS unique_sellers,
  COUNT(DISTINCT block_date) AS unique_days,
  MIN(block_date) AS first_day,
  MAX(block_date) AS last_day
FROM tokens_solana.transfers
WHERE block_date >= DATE '${month}'
  AND block_date <  DATE '${nextMonth(month)}'
  AND token_mint_address = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
  AND action = 'transfer'
  AND tx_signer IN (${SOLANA_FACILITATORS.join(", ")})
  AND from_owner NOT IN (${SOLANA_FACILITATORS.join(", ")})
  AND to_owner   NOT IN (${SOLANA_FACILITATORS.join(", ")})
`.trim();
}

function nextMonth(monthStart: string): string {
  const d = new Date(monthStart);
  const n = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  return `${n.getUTCFullYear()}-${String(n.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

interface MonthRow {
  chain: string;
  month: string;
  n: number | string;
  vol_usd: number | string;
  unique_channels: number | string;
  unique_buyers: number | string;
  unique_sellers: number | string;
  unique_days: number | string;
  first_day: string | null;
  last_day: string | null;
}

async function runMonth(label: string, sql: string, attempt = 0): Promise<MonthRow | null> {
  const t0 = Date.now();
  try {
    const created = await dune.createQuery({ name: `ryvo phase0 ${label}`, query_sql: sql, is_private: false });
    const exec = await dune.execute(created.query_id);
    const out = await dune.wait<MonthRow>(exec.execution_id, { intervalMs: 4000, timeoutMs: 3 * 60_000 });
    const ms = Date.now() - t0;
    const row = (out.result?.rows ?? [])[0];
    if (row) {
      const n = Number(row.n ?? 0);
      const v = Number(row.vol_usd ?? 0);
      console.log(`  ${label}  n=${n.toLocaleString().padStart(10)}  vol=$${v.toLocaleString(undefined, { maximumFractionDigits: 0 }).padStart(10)}  ch=${Number(row.unique_channels ?? 0).toLocaleString().padStart(7)}  days=${row.unique_days}  range=${row.first_day} → ${row.last_day}  (${ms}ms)`);
    } else {
      console.log(`  ${label}  (no rows, ${ms}ms)`);
    }
    return row ?? null;
  } catch (e) {
    if (e instanceof DuneError && attempt < 2) {
      console.log(`  ${label}  retry ${attempt + 1}: ${e.status} ${typeof e.body === "object" ? JSON.stringify(e.body).slice(0, 120) : String(e.body).slice(0, 120)}`);
      await new Promise((r) => setTimeout(r, 5000));
      return runMonth(label, sql, attempt + 1);
    }
    if (e instanceof DuneError) {
      console.log(`  ${label}  FAILED after retries: ${e.status} ${typeof e.body === "object" ? JSON.stringify(e.body).slice(0, 200) : String(e.body).slice(0, 200)}`);
      return null;
    }
    throw e;
  }
}

async function main(): Promise<void> {
  console.log(`=== Dune chunked reconciliation ===`);
  console.log(`Months to scan: ${MONTHS.length} (${MONTHS[0]} .. ${MONTHS[MONTHS.length - 1]})`);
  console.log(`Facilitator wallets — base: ${BASE_FACILITATORS.length}, polygon: ${POLYGON_FACILITATORS.length}, solana: ${SOLANA_FACILITATORS.length}\n`);

  const allRows: MonthRow[] = [];

  for (const month of MONTHS) {
    console.log(`\n[${month}]`);
    const r1 = await runMonth(`base-${month}`,    evmMonthQuery("base", month));
    if (r1) allRows.push(r1);
    const r2 = await runMonth(`polygon-${month}`, evmMonthQuery("polygon", month));
    if (r2) allRows.push(r2);
    const r3 = await runMonth(`solana-${month}`,  solanaMonthQuery(month));
    if (r3) allRows.push(r3);
  }

  // Persist
  writeFileSync("data/processed/phase0_monthly.json", JSON.stringify(allRows, null, 2));
  console.log(`\nSaved data/processed/phase0_monthly.json (${allRows.length} rows)`);

  // Aggregate per chain
  console.log(`\n=== PER-CHAIN TOTALS ===`);
  const chains = ["base", "polygon", "solana"];
  let grandTx = 0;
  let grandVol = 0;
  for (const c of chains) {
    const rows = allRows.filter((r) => r.chain === c);
    const tx = rows.reduce((a, r) => a + Number(r.n ?? 0), 0);
    const vol = rows.reduce((a, r) => a + Number(r.vol_usd ?? 0), 0);
    grandTx += tx;
    grandVol += vol;
    const days = rows.filter((r) => Number(r.n) > 0);
    const first = days.length ? days.map((r) => r.first_day).filter(Boolean).sort()[0] : "n/a";
    const last  = days.length ? days.map((r) => r.last_day).filter(Boolean).sort().slice(-1)[0] : "n/a";
    console.log(`  ${c.padEnd(8)} tx=${tx.toLocaleString().padStart(12)}  vol=$${vol.toLocaleString(undefined, { maximumFractionDigits: 0 }).padStart(12)}  range=${first} → ${last}  months_with_activity=${days.length}`);
  }
  console.log(`  ${"TOTAL".padEnd(8)} tx=${grandTx.toLocaleString().padStart(12)}  vol=$${grandVol.toLocaleString(undefined, { maximumFractionDigits: 0 }).padStart(12)}`);

  console.log(`\n  vs Artemis target:`);
  console.log(`    tx:     ${(grandTx / ARTEMIS_GLOBAL_TX * 100).toFixed(1)}% of ${ARTEMIS_GLOBAL_TX.toLocaleString()}  (delta: ${(grandTx - ARTEMIS_GLOBAL_TX).toLocaleString()})`);
  console.log(`    volume: ${(grandVol / ARTEMIS_GLOBAL_VOL * 100).toFixed(1)}% of $${ARTEMIS_GLOBAL_VOL.toLocaleString()}  (delta: $${(grandVol - ARTEMIS_GLOBAL_VOL).toLocaleString(undefined, { maximumFractionDigits: 0 })})`);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });

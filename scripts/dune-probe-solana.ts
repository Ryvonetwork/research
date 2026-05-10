/**
 * Probe Solana token transfer schema on Dune to find the right column for
 * "the wallet that signed/paid for the wrapping tx" (i.e. the facilitator).
 *
 * Strategy: query INFORMATION_SCHEMA for tokens_solana.transfers columns,
 * then sample 10 rows for one known facilitator wallet (PayAI) to see what
 * the row shape looks like.
 */
import { dune, DuneError } from "./lib/dune.js";

const PAYAI_SOL = "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

async function run(label: string, sql: string): Promise<unknown[]> {
  console.log(`\n--- ${label} ---`);
  console.log(sql.length > 500 ? sql.slice(0, 500) + " ..." : sql);
  try {
    const created = await dune.createQuery({ name: `ryvo solana probe ${label}`, query_sql: sql, is_private: false });
    const exec = await dune.execute(created.query_id);
    const out = await dune.wait(exec.execution_id, { timeoutMs: 5 * 60_000, intervalMs: 3000 });
    const rows = out.result?.rows ?? [];
    console.log(`  rows=${rows.length}`);
    for (const r of rows.slice(0, 30)) console.log(`  ${JSON.stringify(r)}`);
    return rows;
  } catch (e) {
    if (e instanceof DuneError) {
      console.log(`  FAILED: ${e.status} ${JSON.stringify(e.body).slice(0, 600)}`);
      return [];
    }
    throw e;
  }
}

async function main(): Promise<void> {
  console.log("=== Solana schema probe ===");

  // 1. Inspect column list of tokens_solana.transfers
  await run(
    "schema-tokens_solana.transfers",
    `SELECT column_name, data_type
     FROM information_schema.columns
     WHERE table_schema = 'tokens_solana' AND table_name = 'transfers'
     ORDER BY ordinal_position`,
  );

  // 2. Try to find any USDC transfers involving PayAI's facilitator wallet by
  //    matching it in either from / to / signer-style columns.
  //    Sampling 5 rows so we can see the shape.
  await run(
    "sample-payai-related-usdc-transfers",
    `SELECT *
     FROM tokens_solana.transfers
     WHERE token_mint_address = '${USDC_MINT}'
       AND (from_owner = '${PAYAI_SOL}' OR to_owner = '${PAYAI_SOL}')
     LIMIT 5`,
  );

  // 3. Alternate: maybe the spellbook table is solana.transfers (not tokens_solana)
  await run(
    "schema-solana.transfers",
    `SELECT column_name, data_type
     FROM information_schema.columns
     WHERE table_schema = 'solana' AND table_name = 'transfers'
     ORDER BY ordinal_position`,
  );

  // 4. Look at the broader catalog to find any solana spellbook tables that
  //    might include x402 / facilitator activity.
  await run(
    "list-solana-spellbook-tables",
    `SELECT table_schema, table_name
     FROM information_schema.tables
     WHERE table_schema IN ('tokens_solana', 'solana', 'solana_utils', 'spellbook')
       AND (table_name LIKE '%transfer%' OR table_name LIKE '%token%' OR table_name LIKE '%x402%')
     ORDER BY 1, 2
     LIMIT 50`,
  );
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });

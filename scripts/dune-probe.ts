/**
 * Phase 0 probe v2: figure out which Dune tier we're on, and how to write/run a
 * custom x402 SQL query against the v1 API.
 */
import { dune, DuneError } from "./lib/dune.js";

async function tryCreateQuery(): Promise<{ ok: boolean; queryId?: number; status?: number; body?: unknown }> {
  const url = "https://api.dune.com/api/v1/query";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "X-Dune-API-Key": process.env.DUNE_API_KEY!,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: "ryvo phase0 probe",
      query_sql: "SELECT 1 as one",
      query_engine: "dune",
      is_private: false,
    }),
  });
  const text = await res.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* keep text */ }
  if (!res.ok) return { ok: false, status: res.status, body };
  const j = body as { query_id?: number };
  return { ok: true, queryId: j.query_id, body };
}

async function tryExecutePrivateQuery(queryId: number): Promise<void> {
  const exec = await dune.execute(queryId);
  console.log(`  execute: execution_id=${exec.execution_id} state=${exec.state}`);
  const out = await dune.wait(exec.execution_id, { timeoutMs: 60_000, intervalMs: 1500 });
  console.log(`  result: rows=${out.result?.rows.length ?? 0}`);
  if (out.result?.rows?.length) {
    console.log(`  sample: ${JSON.stringify(out.result.rows.slice(0, 3))}`);
  }
}

async function main(): Promise<void> {
  console.log("=== Dune Phase-0 probe v2 ===\n");

  // Test 1: API key validity by trying to create a private query.
  // If we get back a query_id, we have at least Plus tier (CRUD via API).
  // If 403/payment-required, we're on Free.
  console.log("[1/4] Testing tier — attempting to CREATE a private 'SELECT 1' query ...");
  const create = await tryCreateQuery();
  if (create.ok) {
    console.log(`  ok: created query_id=${create.queryId} (tier supports query CRUD via API)`);
  } else {
    console.log(`  failed: status=${create.status} body=${JSON.stringify(create.body).slice(0, 400)}`);
  }

  // Test 2: if creation worked, execute it to confirm full pipeline.
  if (create.ok && create.queryId) {
    console.log(`\n[2/4] Executing query ${create.queryId} end-to-end ...`);
    try {
      await tryExecutePrivateQuery(create.queryId);
    } catch (e) {
      if (e instanceof DuneError) {
        console.log(`  failed: status=${e.status} body=${JSON.stringify(e.body).slice(0, 400)}`);
      } else throw e;
    }
  }

  // Test 3: fetch some popular x402 query IDs that are likely indexed by community.
  // Strategy: try a handful of recent IDs in the 5–6M range (Dune query IDs are
  // monotonic and recent x402 dashboards land around 4.5–6M).
  console.log("\n[3/4] Probing known x402 community dashboard query candidates (fail-soft) ...");
  const candidates = [
    // hashed_official / thechriscen dashboards have queries in the 4.5M+ range; we'll
    // refine these once we find them via the dashboard HTML scrape below.
  ];
  if (candidates.length === 0) console.log("  (none — will identify via dashboard scrape)");

  // Test 4: scrape hashed_official dashboard HTML for embedded query IDs.
  // Dune dashboards inject their query IDs into the <script> blob.
  console.log("\n[4/4] Scraping hashed_official/x402-analytics for embedded query IDs ...");
  try {
    const r = await fetch("https://dune.com/hashed_official/x402-analytics");
    const html = await r.text();
    const ids = new Set<string>();
    const re = /\\?"queryId\\?"\s*:\s*(\d+)|\/queries\/(\d+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      const id = m[1] ?? m[2];
      if (id) ids.add(id);
    }
    if (ids.size === 0) {
      console.log(`  no query IDs found in HTML (likely SSR-rendered). HTML size=${html.length} bytes`);
    } else {
      console.log(`  found ${ids.size} candidate query IDs:`);
      for (const id of [...ids].slice(0, 30)) console.log(`    ${id}`);
    }
  } catch (e) {
    console.log(`  scrape failed: ${(e as Error).message}`);
  }

  console.log("\nProbe v2 complete.");
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});

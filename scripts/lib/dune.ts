import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadDotenvOnce(): void {
  if ((globalThis as any).__dotenvLoaded) return;
  const envPath = resolve(__dirname, "../../.env");
  if (!existsSync(envPath)) return;
  const text = readFileSync(envPath, "utf8");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim();
    if (!(k in process.env)) process.env[k] = v;
  }
  (globalThis as any).__dotenvLoaded = true;
}

loadDotenvOnce();

const API_BASE = "https://api.dune.com/api/v1";

export class DuneError extends Error {
  constructor(message: string, public readonly status?: number, public readonly body?: unknown) {
    super(message);
    this.name = "DuneError";
  }
}

function key(): string {
  const k = process.env.DUNE_API_KEY;
  if (!k) throw new DuneError("DUNE_API_KEY not set in environment / .env");
  return k;
}

async function req<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      "X-Dune-API-Key": key(),
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch { /* keep as text */ }
  if (!res.ok) {
    throw new DuneError(`${init?.method ?? "GET"} ${path} -> ${res.status}`, res.status, body);
  }
  return body as T;
}

export interface ExecuteResponse { execution_id: string; state: string }
export interface StatusResponse {
  execution_id: string;
  query_id: number;
  state: string;
  submitted_at?: string;
  execution_started_at?: string;
  execution_ended_at?: string;
  result_metadata?: {
    column_names: string[];
    column_types: string[];
    row_count: number;
    result_set_bytes: number;
    total_row_count: number;
    total_result_set_bytes: number;
    datapoint_count: number;
    pending_time_millis: number;
    execution_time_millis: number;
  };
}
export interface ResultsResponse<R = Record<string, unknown>> {
  execution_id: string;
  query_id: number;
  state: string;
  result?: { rows: R[]; metadata: StatusResponse["result_metadata"] };
}

export interface CreateQueryRequest {
  name: string;
  query_sql: string;
  query_engine?: "dune" | "v2 Dune SQL";
  is_private?: boolean;
  description?: string;
}
export interface CreateQueryResponse { query_id: number }

export interface UpdateQueryRequest {
  name?: string;
  query_sql?: string;
  description?: string;
}

export const dune = {
  /** Create a new saved query (requires Plus+ tier; public queries don't count toward private cap). */
  async createQuery(req_: CreateQueryRequest): Promise<CreateQueryResponse> {
    // The `query_engine` field was deprecated in May 2026 — passing any value
    // (incl. the historical "dune" / "v2 Dune SQL") now returns 400 with
    // "Deprecated query engine". DuneSQL is the only engine left, so we just
    // omit the field and let the API pick.
    return req<CreateQueryResponse>("/query", {
      method: "POST",
      body: JSON.stringify({
        name: req_.name,
        query_sql: req_.query_sql,
        is_private: req_.is_private ?? false,
        description: req_.description ?? "",
      }),
    });
  },

  /** Update an existing query (in place; cheaper than creating a new one each run). */
  async updateQuery(queryId: number, body: UpdateQueryRequest): Promise<unknown> {
    return req(`/query/${queryId}`, { method: "PATCH", body: JSON.stringify(body) });
  },

  /** Archive (soft-delete) a query. */
  async archiveQuery(queryId: number): Promise<unknown> {
    return req(`/query/${queryId}/archive`, { method: "POST" });
  },

  /** Execute a saved query by ID. */
  async execute(queryId: number, params?: Record<string, unknown>): Promise<ExecuteResponse> {
    return req(`/query/${queryId}/execute`, {
      method: "POST",
      body: JSON.stringify(params ? { query_parameters: params } : {}),
    });
  },

  async status(executionId: string): Promise<StatusResponse> {
    return req(`/execution/${executionId}/status`);
  },

  async results<R = Record<string, unknown>>(executionId: string, opts?: { limit?: number; offset?: number }): Promise<ResultsResponse<R>> {
    const q = new URLSearchParams();
    if (opts?.limit !== undefined) q.set("limit", String(opts.limit));
    if (opts?.offset !== undefined) q.set("offset", String(opts.offset));
    const qs = q.toString();
    return req(`/execution/${executionId}/results${qs ? `?${qs}` : ""}`);
  },

  /** Fetch all rows for an execution, paginating in `pageSize` chunks. */
  async resultsAll<R = Record<string, unknown>>(executionId: string, pageSize = 32_000): Promise<R[]> {
    const out: R[] = [];
    let offset = 0;
    while (true) {
      const page = await this.results<R>(executionId, { limit: pageSize, offset });
      const rows = page.result?.rows ?? [];
      out.push(...rows);
      if (rows.length < pageSize) return out;
      offset += rows.length;
    }
  },

  /** Get latest cached results without re-executing. Useful for cheap probes. */
  async latest<R = Record<string, unknown>>(queryId: number): Promise<ResultsResponse<R>> {
    return req(`/query/${queryId}/results`);
  },

  /** Wait for an execution to terminate. Polls every `intervalMs`. */
  async wait<R = Record<string, unknown>>(
    executionId: string,
    { intervalMs = 2000, timeoutMs = 5 * 60_000, onTick, paginate }: { intervalMs?: number; timeoutMs?: number; onTick?: (s: StatusResponse) => void; paginate?: boolean } = {},
  ): Promise<ResultsResponse<R>> {
    const t0 = Date.now();
    while (true) {
      const s = await this.status(executionId);
      onTick?.(s);
      if (s.state === "QUERY_STATE_COMPLETED") {
        if (!paginate) return this.results<R>(executionId);
        const rows = await this.resultsAll<R>(executionId);
        return { execution_id: executionId, query_id: s.query_id, state: s.state, result: { rows, metadata: s.result_metadata } };
      }
      if (s.state === "QUERY_STATE_FAILED" || s.state === "QUERY_STATE_CANCELLED" || s.state === "QUERY_STATE_EXPIRED") {
        throw new DuneError(`execution ${executionId} ended in ${s.state}`, undefined, s);
      }
      if (Date.now() - t0 > timeoutMs) {
        throw new DuneError(`execution ${executionId} timed out after ${timeoutMs}ms`, undefined, s);
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  },

  /** Convenience: execute a query, wait, return rows. */
  async run<R = Record<string, unknown>>(
    queryId: number,
    params?: Record<string, unknown>,
    waitOpts?: Parameters<typeof dune.wait>[1],
  ): Promise<R[]> {
    const exec = await this.execute(queryId, params);
    const out = await this.wait<R>(exec.execution_id, waitOpts);
    return out.result?.rows ?? [];
  },
};

export type DuneClient = typeof dune;

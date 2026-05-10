import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FACILITATORS_PATH = resolve(__dirname, "../../data/raw/facilitators.json");

export type Chain = "base" | "solana" | "polygon";

export interface Facilitator {
  id: string;
  name: string;
  api_url: string;
  fee_pct: number;
  first_tx: string;
  wallets: Partial<Record<Chain, string[]>>;
}

interface FacilitatorsFile {
  _meta: unknown;
  facilitators: Facilitator[];
}

let cache: Facilitator[] | null = null;

export function loadFacilitators(): Facilitator[] {
  if (cache) return cache;
  const raw = JSON.parse(readFileSync(FACILITATORS_PATH, "utf8")) as FacilitatorsFile;
  cache = raw.facilitators;
  return cache;
}

export function getFacilitator(id: string): Facilitator {
  const f = loadFacilitators().find((x) => x.id === id.toLowerCase());
  if (!f) throw new Error(`Unknown facilitator id: ${id}. Known: ${loadFacilitators().map((x) => x.id).join(", ")}`);
  return f;
}

export function facilitatorsForChain(chain: Chain): Facilitator[] {
  return loadFacilitators().filter((f) => (f.wallets[chain]?.length ?? 0) > 0);
}

export function walletsForChain(chain: Chain): { address: string; facilitatorId: string; facilitatorName: string }[] {
  const out: { address: string; facilitatorId: string; facilitatorName: string }[] = [];
  for (const f of loadFacilitators()) {
    for (const w of f.wallets[chain] ?? []) {
      out.push({ address: w, facilitatorId: f.id, facilitatorName: f.name });
    }
  }
  return out;
}

export function isFacilitatorWallet(chain: Chain, address: string): boolean {
  const needle = chain === "solana" ? address : address.toLowerCase();
  for (const f of loadFacilitators()) {
    for (const w of f.wallets[chain] ?? []) {
      const cmp = chain === "solana" ? w : w.toLowerCase();
      if (cmp === needle) return true;
    }
  }
  return false;
}

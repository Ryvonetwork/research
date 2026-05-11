import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const DEFAULT_RPC_URL =
  "https://mainnet.helius-rpc.com/?api-key=3faa0eb3-3be2-42bd-8a96-cd73694301ae";

const args = parseArgs(process.argv.slice(2));
const rpcUrl = args.rpcUrl ?? process.env.HELIUS_RPC_URL ?? DEFAULT_RPC_URL;
const target = Number(args.target ?? 1_000_000);
const concurrency = Number(args.concurrency ?? 8);
const checkpointEvery = Number(args.checkpointEvery ?? 250);
const checkpointPath = args.checkpoint ?? "usdc-fee-checkpoint.json";
const maxBlocks = args.maxBlocks == null ? Infinity : Number(args.maxBlocks);
const startSlotArg = args.startSlot == null ? undefined : Number(args.startSlot);

let state = loadState(checkpointPath);
if (!state) {
  const latestSlot = startSlotArg ?? (await rpc("getSlot", [{ commitment: "finalized" }]));
  state = {
    startedAt: new Date().toISOString(),
    lastUpdatedAt: null,
    nextSlot: latestSlot,
    blocksScanned: 0,
    slotsSkipped: 0,
    usdcTxCount: 0,
    feeLamports: "0",
    startSlot: latestSlot,
    lastScannedSlot: null,
    target,
  };
}

let feeLamports = BigInt(state.feeLamports);
let nextSlot = Number(state.nextSlot);
let blocksScanned = Number(state.blocksScanned);
let slotsSkipped = Number(state.slotsSkipped);
let usdcTxCount = Number(state.usdcTxCount);
const seenSignatures = new Set();

console.error(
  `Scanning backward from slot ${nextSlot.toLocaleString()} for ${target.toLocaleString()} USDC txs...`
);

while (usdcTxCount < target && blocksScanned < maxBlocks && nextSlot >= 0) {
  const batchSlots = [];
  for (let i = 0; i < concurrency && nextSlot >= 0; i += 1) {
    batchSlots.push(nextSlot);
    nextSlot -= 1;
  }

  const blocks = await Promise.all(batchSlots.map((slot) => getBlockWithRetry(slot)));

  for (const [i, block] of blocks.entries()) {
    if (usdcTxCount >= target) break;

    const slot = batchSlots[i];
    state.lastScannedSlot = slot;

    if (!block) {
      slotsSkipped += 1;
      continue;
    }

    blocksScanned += 1;
    for (const tx of block.transactions ?? []) {
      if (usdcTxCount >= target) break;

      const signature = tx.transaction?.signatures?.[0];
      if (!signature || seenSignatures.has(signature)) continue;
      if (!hasUsdcBalanceChange(tx.meta)) continue;

      seenSignatures.add(signature);
      usdcTxCount += 1;
      feeLamports += BigInt(tx.meta?.fee ?? 0);

      if (usdcTxCount >= target) break;
    }
  }

  if (blocksScanned % checkpointEvery < concurrency || usdcTxCount >= target) {
    saveState();
    printProgress();
  }
}

saveState();
printProgress();

const feeSol = Number(feeLamports) / 1_000_000_000;
console.log(
  JSON.stringify(
    {
      target,
      usdcTxCount,
      feeLamports: feeLamports.toString(),
      feeSol,
      startSlot: state.startSlot,
      lastScannedSlot: state.lastScannedSlot,
      blocksScanned,
      slotsSkipped,
      checkpointPath,
      completed: usdcTxCount >= target,
    },
    null,
    2
  )
);

function hasUsdcBalanceChange(meta) {
  if (!meta || meta.err) return false;

  const pre = balancesByAccountIndex(meta.preTokenBalances);
  const post = balancesByAccountIndex(meta.postTokenBalances);
  const indexes = new Set([...pre.keys(), ...post.keys()]);

  for (const index of indexes) {
    const before = pre.get(index);
    const after = post.get(index);
    const mint = before?.mint ?? after?.mint;
    if (mint !== USDC_MINT) continue;

    const beforeAmount = before?.amount ?? 0n;
    const afterAmount = after?.amount ?? 0n;
    if (beforeAmount !== afterAmount) return true;
  }

  return false;
}

function balancesByAccountIndex(items = []) {
  const map = new Map();
  for (const item of items) {
    if (item.mint !== USDC_MINT) continue;
    map.set(item.accountIndex, {
      mint: item.mint,
      amount: BigInt(item.uiTokenAmount?.amount ?? "0"),
    });
  }
  return map;
}

async function getBlockWithRetry(slot) {
  const params = [
    slot,
    {
      commitment: "finalized",
      encoding: "jsonParsed",
      transactionDetails: "full",
      maxSupportedTransactionVersion: 0,
      rewards: false,
    },
  ];

  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      return await rpc("getBlock", params);
    } catch (error) {
      const message = String(error.message ?? error);
      if (message.includes("was skipped") || message.includes("Block not available")) {
        return null;
      }
      const delay = 500 * 2 ** attempt;
      console.error(`slot ${slot} failed (${message}); retrying in ${delay}ms`);
      await sleep(delay);
    }
  }

  throw new Error(`Failed to fetch slot ${slot} after retries`);
}

async function rpc(method, params) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: `${Date.now()}-${Math.random()}`, method, params }),
  });
  const payload = await response.json();
  if (payload.error) {
    throw new Error(payload.error.message ?? JSON.stringify(payload.error));
  }
  return payload.result;
}

function loadState(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

function saveState() {
  state.lastUpdatedAt = new Date().toISOString();
  state.nextSlot = nextSlot;
  state.blocksScanned = blocksScanned;
  state.slotsSkipped = slotsSkipped;
  state.usdcTxCount = usdcTxCount;
  state.feeLamports = feeLamports.toString();
  state.target = target;
  writeFileSync(checkpointPath, `${JSON.stringify(state, null, 2)}\n`);
}

function printProgress() {
  const feeSolNow = Number(feeLamports) / 1_000_000_000;
  console.error(
    `progress: ${usdcTxCount.toLocaleString()} USDC txs, ${feeSolNow.toFixed(
      6
    )} SOL fees, ${blocksScanned.toLocaleString()} blocks scanned, next slot ${nextSlot.toLocaleString()}`
  );
}

function parseArgs(rawArgs) {
  const parsed = {};
  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i];
    if (!arg.startsWith("--")) continue;
    const [key, inlineValue] = arg.slice(2).split("=", 2);
    parsed[key] = inlineValue ?? rawArgs[++i] ?? true;
  }
  return parsed;
}

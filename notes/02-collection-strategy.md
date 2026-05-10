# 02 — Collection Strategy

How we go from "list of facilitator wallets" to "complete (buyer, seller, tx_count,
volume_usd) edge list" for the past year of x402 activity on Base + Solana.

## Output schema (what every collector must produce)

One JSONL row per micropayment. Fields:

| field         | type     | notes                                                    |
|---------------|----------|----------------------------------------------------------|
| chain         | string   | `base` / `solana`                                        |
| facilitator   | string   | facilitator wallet that submitted the tx                 |
| facilitator_name | string| canonical project name (`coinbase`, `dexter`, …)         |
| tx_hash       | string   | tx hash (Base) or signature (Solana)                     |
| block_time    | int      | unix seconds                                             |
| buyer         | string   | the user/agent wallet that *paid*                        |
| seller        | string   | the server/service wallet that was *paid*                |
| token         | string   | mint/contract of the token used (USDC unless noted)      |
| amount_atomic | string   | atomic units (uint256 string, USDC = 6 decimals)         |
| amount_usd    | number   | best-effort USD value (USDC ≈ $1; adjust if non-USDC)    |
| fee_atomic    | string   | gas/fee paid in chain's native unit (lamports / wei)     |
| fee_usd       | number   | converted using token-day price (cached per day)         |

Everything else is derivable from this. The graph builder groups by `(chain, buyer, seller)`.

## Solana pipeline (Helius)

```
for each facilitator wallet F (10 of them):
  cursor = null
  loop:
    sigs = getSignaturesForAddress(F, { before: cursor, limit: 1000 })
    if sigs is empty: break
    for sig in sigs:
      tx = getTransaction(sig.signature, jsonParsed, maxSupportedTransactionVersion: 0)
      if tx is null or tx.meta.err: continue
      for ix in tx.transaction.message.instructions + inner instructions:
        if ix.program === "spl-token" and ix.parsed.type in ["transfer", "transferChecked"]:
          info = ix.parsed.info
          mint = info.mint || resolve_via_account_info(info.source)
          if mint != "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": continue   # USDC only
          buyer  = owner_of_ata(info.source)        # cache aggressively
          seller = owner_of_ata(info.destination)
          emit row(...)
    cursor = sigs[-1].signature
```

Notes:
* `getSignaturesForAddress` does not see ATA-owned signatures — but x402 tx are
  *signed by* the facilitator wallet (which pays the fee), so the facilitator
  appears as a top-level signer and the call returns it. ✓
* We cache `ata → owner` because each (buyer, seller) pair has stable USDC ATAs.
* Helius free tier: 1k signatures/req, generally 50–100 req/s comfortably. For ~60M
  tx ÷ 1k = 60k page requests + tx fetches. Tx fetches dominate; budget multi-day
  pull for full history. Sampling first ~50k tx per facilitator is enough to estimate
  the graph topology with very tight error bars.

## Base pipeline (RPC `eth_getLogs`)

The fastest path is to scan the USDC contract's `Transfer` event log and filter by
`tx.from ∈ facilitator_set`:

```
USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
TOPIC_TRANSFER = keccak("Transfer(address,address,uint256)")
                = 0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef

facilitators_base = lower(set of 57 addresses)

for window [start_block, end_block] of size 5000 (or whatever RPC tolerates):
  logs = eth_getLogs({
    address: USDC, topics: [TOPIC_TRANSFER],
    fromBlock: start_block, toBlock: end_block
  })
  group logs by tx_hash
  for each tx_hash:
    tx = eth_getTransactionByHash(tx_hash)   # cache
    if lower(tx.from) not in facilitators_base: continue
    for each log in this tx (usually 1, sometimes 2 with fee split):
      buyer  = topic1 (32 bytes → last 20)
      seller = topic2 (32 bytes → last 20)
      amount = data (uint256)
      emit row(...)
```

Notes:
* x402 settlement on Base earliest tx ≈ Oct 2025 (per facilitators.x402.watch dates).
  Block ~24M onwards. Total ~91M tx → ~91M Transfer logs filtered down to Transfer
  logs whose tx-from is a facilitator. Use binary-search for the start block once.
* Many free RPCs cap `eth_getLogs` to 5k or 10k blocks per call. Use Alchemy/QuickNode
  for sustained throughput; public `mainnet.base.org` works for sampling.
* Alternative: skip log scan and use `eth_getBlockByNumber(block, true)` block-by-block,
  filtering tx.from. Slower per block but no per-RPC log limits.
* Alternative 2: drive collection from the Bitquery x402 GraphQL — same data, no infra.

## Sellers from x402 Bazaar (parallel, cheap)

```
GET https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?cursor=...
→ paginate through all resources
→ extract: resource (URL), payTo (seller wallet), accepts[].network, name/description,
           paymentAnalytics.totalTransactions, totalUniqueUsers, etc.
```

Saves to `data/processed/sellers_bazaar.jsonl`. Cross-check our on-chain `seller`
set against this — anything in the Bazaar set is definitely a real x402 seller; anything
outside might be a wallet a facilitator also pays gas to (e.g. itself).

## Sampling vs full pull (pragmatism)

The full ~180M tx pull is O(weeks) on free-tier RPCs. For the analysis we need:

* **Pair count distribution shape** (heavy-tailed?) — works on a stratified sample.
* **Top-N (buyer, seller) edges by tx count** — accurate from the largest facilitators.
* **Total unique edges (= total channels needed under Ryvo Network)** — needs full pull, but
  can be extrapolated from the cumulative-distinct curve.

So **phase 1** (this sprint): fully pull all 10 Solana facilitators (manageable), and
sample-pull the top 3 Base facilitators (Coinbase, Questflow, Heurist). That covers
~70%+ of all tx. **Phase 2** (later): fill in the long tail of Base facilitators if we
want precision under 1%.

## Storage layout

```
data/raw/
  solana/
    coinbase__<startTs>_<endTs>.jsonl
    dexter__...jsonl
    payai__...jsonl
    ...
  base/
    coinbase__<startBlock>_<endBlock>.jsonl
    questflow__...jsonl
    heurist__...jsonl
    ...
  bazaar/
    discovery__<date>.jsonl

data/processed/
  edges.parquet         # (chain, buyer, seller, tx_count, volume_usdc, first_ts, last_ts)
  buyers.parquet        # per-buyer stats
  sellers.parquet       # per-seller stats
  graph_summary.json    # totals + the Ryvo Network settlement-math output
```

# 01 — Data Sources

Everything we know about how to get x402 data, ranked by usefulness for our goal
(reconstructing the buyer→seller payment graph).

## Tier 1 — Direct on-chain extraction (most granular, what we'll actually use)

### Solana — Helius RPC

* RPC URL: `https://mainnet.helius-rpc.com/?api-key=YOUR_HELIUS_KEY`
  Set via `HELIUS_RPC` env var (see `.env.example`).
* Methods:
  * `getSignaturesForAddress(facilitator, { before, limit:1000 })` → page through every
    signature where the facilitator was a signer/account.
  * `getTransaction(sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 })`
    → returns parsed instructions including `spl-token::transfer` /
    `spl-token::transferChecked` with source/destination ATAs and amount.
  * `getAccountInfo(ata)` → resolve ATA owner = the actual buyer/seller wallet.
* USDC mint on Solana: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` (6 decimals).
* Each x402 settlement tx has *one* facilitator-signed `transferChecked` from the
  buyer's USDC ATA → seller's USDC ATA. That's our edge.

### Base — public/Alchemy/QuickNode/Infura RPC + USDC events

* USDC contract on Base: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (6 decimals).
* x402 facilitators on Base call USDC's EIP-3009 `transferWithAuthorization`. The
  resulting log emits both:
  * `Transfer(address indexed from, address indexed to, uint256 value)`
    topic0 = `0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef`
  * `AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)`
    topic0 = `0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5`
* Strategy: `eth_getLogs` for USDC `Transfer` events, then for each log fetch the
  parent tx and check `tx.from ∈ facilitator_set` to confirm it's an x402 payment.
  `from`/`to` in the event = buyer/seller. Tx `from` = facilitator.
* No Base RPC key is bundled here; user can plug any of:
  * Public: `https://mainnet.base.org` (rate-limited; ok for sampling)
  * Alchemy: `https://base-mainnet.g.alchemy.com/v2/<key>`
  * QuickNode / Infura / Ankr — all support `eth_getLogs`

## Tier 2 — Hosted indexers (good for sanity checks, slower for bulk export)

### Bitquery (GraphQL, has dedicated x402 API)

* Endpoint: `https://streaming.bitquery.io/eap` (or `/graphql` for v1 Solana)
* Has prebuilt examples for both Base and Solana x402 in their docs:
  * Base: `EVM(network: base) { Transfers(where: { Transfer: { Receiver: { in: [...] }}}) ... }`
  * Solana v1: `solana { transfers(receiverAddress: {is:"..."}, currency:{is:"EPjFWdd5..."} ) ... }`
* Strength: handles multi-chain, returns `Sender`/`Receiver`/`Amount`/`AmountInUSD`.
* Weakness: free tier rate limits; needs an API key for sustained pulls.
* Use as: independent verification of our own RPC-derived numbers.

### Allium (`solana.agents.x402_facilitators` and friends)

* Maintains a hourly-refreshed registry table of facilitators.
* Paid product, but we can use the metadata they expose for free.

### Dune Analytics

* Public queries we'll cross-reference (no API needed, just read the dashboards):
  * `query_6054244` (hashed_official) — facilitator address → project map (EVM)
  * `dune.com/hashed_official/x402-analytics` — per-chain & per-project tx counts
  * `dune.com/thechriscen/x402-payment-analytics` — buyer/seller breakdowns
* The Presidio-Hardened-x402 repo (`dune/`) has clean Trino SQL we can adapt if we
  ever want to run our own Dune queries.

### x402scan (Merit-Systems/x402scan)

* https://www.x402scan.com — UI explorer; no public REST API found
* Open source on GitHub (333★) — could spin it up locally for indexing
* `@x402scan/mcp` npm package exists but wraps *paying* x402 endpoints, not bulk export

### x402.org / x402engine.app

* x402.org: only landing/marketing — no API
* x402engine.app: serves x402-paid endpoints, not analytics

## Tier 3 — Authoritative registries

### facilitators.x402.watch  ← **canonical facilitator list**

We've already pulled this and saved it to `data/raw/facilitators.json`. As of the fetch
the registry has **19 facilitators / ~84 addresses across 3 chains**:

* Base: ~57 facilitator addresses (Coinbase 10, Questflow 10, Heurist 9, X402rs 6,
  PayAI 5, CodeNut 4, AurraCloud 3, OpenX402 2, Thirdweb 1, KAMIYO 1, Daydreams 1,
  Ultravioleta 1, Mogami 1, 402104 1, xEcho 1, Virtuals 1)
* Solana: 10 facilitator addresses (Coinbase, PayAI, Dexter, Daydreams, Corbits,
  CodeNut, AurraCloud, OpenX402, KAMIYO, Ultravioleta)
* Polygon: 27 facilitator addresses (Polygon's own x3 sets of 8 + Thirdweb +
  KAMIYO + X402rs) — out of scope for this analysis (Base + Solana only)

### Polygon docs `/agentic-payments/x402/analytics/`

* Confirms the same Polygon set of 24 + the Thirdweb / Questflow / PayAI / x402.rs /
  Corbits addresses on Polygon. Sanity cross-check.

## Tier 4 — Discovery / metadata (sellers only, not transactions)

* **x402 Bazaar** — `https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources`
  Returns paginated list of every advertised x402 service: `payTo` address (the seller
  wallet), pricing, network, lifetime tx counts, unique users, success rate. We'll snapshot
  this to (a) get a rich seller registry with names/categories, and (b) cross-check our
  on-chain seller set against the official discovery list.
* **x402scan / x402scout** — same data with prettier UIs and trust scores.

## Conclusion / what we'll actually use

* **Solana**: pull via Helius RPC for each of the 10 Solana facilitators (`getSignaturesForAddress`
  + `getTransaction` + ATA-owner resolution). Save raw jsonl per facilitator.
* **Base**: pull via Bitquery GraphQL OR `eth_getLogs` against any Base RPC, filtered to
  `tx.from ∈ Base facilitator set`. Save raw jsonl per facilitator.
* **x402 Bazaar**: snapshot the discovery resources to get human-readable seller names
  and to confirm our on-chain `to` addresses are real x402 servers.
* **Cross-check** monthly totals against Artemis / Dune dashboards before publishing.

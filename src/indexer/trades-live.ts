/**
 * Live trades indexer + per-trade insider scoring.
 *
 * Subscribes to Polymarket OrderFilled events via WebSocket on BOTH:
 *   - V1 contracts (legacy, pre-Apr-28-2026, all 8 known insiders trade here)
 *   - V2 contracts (current, post-Apr-28-2026)
 *
 * V2 has a 10-field event signature; we collapse it to V1's 8-field shape
 * so downstream `buildTradeRow` works unchanged.
 *
 * For each new trade:
 *   1. Insert into `trades` table (idempotent on (tx_hash, log_index))
 *   2. Recompute the per-(wallet, market) abnormality score for both maker and
 *      taker against the trade's market — same E1/E2/E3/E4 logic as the batch
 *      scorer in src/detection/score.ts
 *   3. If score >= 60, print a [FLAG] alert with signal breakdown
 *
 * Run via: npm run live
 */

import "dotenv/config";
import { parseAbiItem, decodeEventLog, type Log } from "viem";
import { httpClient, wsClient, ADDRESSES } from "../lib/viem.js";
import { db, schema } from "../lib/db.js";
import { sql } from "drizzle-orm";
import { buildTradeRow } from "../lib/decode.js";
import knownInsidersJson from "../../data/known_insiders.json" with { type: "json" };

const FLAG_THRESHOLD = 60;

const KNOWN_INSIDER_ADDRESSES = new Set(
  (knownInsidersJson as Array<{ address: string }>).map((k) => k.address.toLowerCase()),
);

// V1 OrderFilled — 8 fields
const ORDER_FILLED_V1 = parseAbiItem(
  "event OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker, uint256 makerAssetId, uint256 takerAssetId, uint256 makerAmountFilled, uint256 takerAmountFilled, uint256 fee)",
);

// V2 OrderFilled — 10 fields with side enum, tokenId, builder, metadata
const ORDER_FILLED_V2 = parseAbiItem(
  "event OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker, uint8 side, uint256 tokenId, uint256 makerAmountFilled, uint256 takerAmountFilled, uint256 fee, bytes32 builder, bytes32 metadata)",
);

const blockTsCache = new Map<bigint, Date>();

async function getBlockTimestamp(blockNumber: bigint): Promise<Date> {
  const cached = blockTsCache.get(blockNumber);
  if (cached) return cached;
  const block = await httpClient.getBlock({ blockNumber });
  const ts = new Date(Number(block.timestamp) * 1000);
  blockTsCache.set(blockNumber, ts);
  if (blockTsCache.size > 1000) {
    const firstKey = blockTsCache.keys().next().value;
    if (firstKey !== undefined) blockTsCache.delete(firstKey);
  }
  return ts;
}

// =============================================================================
// Per-(wallet, market) score (matches src/detection/score.ts logic)
// =============================================================================

type PairData = {
  wallet: string;
  token_id: string;
  question: string | null;
  end_date: Date | null;
  market_usdc: number;
  biggest_single_trade_usdc: number;
  first_trade_ts: Date | null;
  first_funding_ts: Date | null;
  is_manipulable_strict: boolean;
};

async function fetchPairData(wallet: string, tokenId: string): Promise<PairData | null> {
  const w = wallet.toLowerCase();
  const result = await db.execute(sql`
    WITH market_info AS (
      SELECT
        m.token_id,
        m.question,
        m.end_date,
        (
          (m.neg_risk = true OR m.question ~* '\\m(pardon|strike|launch|fire|name|announce|approve|veto|reject|sign|nominate|appoint|search|streamed|elect|win)\\M')
          AND COALESCE(m.liquidity, 0) < 100000
          AND m.end_date IS NOT NULL
        ) AS is_manipulable_strict
      FROM markets m
      WHERE m.token_id = ${tokenId}
    ),
    wallet_buys AS (
      SELECT t.usdc_amount::float AS usdc, t.block_timestamp
      FROM trades t
      WHERE t.token_id = ${tokenId}
        AND ((LOWER(t.maker) = ${w} AND t.side = 'BUY') OR (LOWER(t.taker) = ${w} AND t.side = 'SELL'))
    )
    SELECT
      mi.token_id,
      mi.question,
      mi.end_date,
      mi.is_manipulable_strict,
      COALESCE(SUM(wb.usdc), 0) AS market_usdc,
      COALESCE(MAX(wb.usdc), 0) AS biggest_single_trade_usdc,
      MIN(wb.block_timestamp) AS first_trade_ts,
      wff.block_timestamp AS first_funding_ts
    FROM market_info mi
    LEFT JOIN wallet_buys wb ON true
    LEFT JOIN wallet_first_funding wff ON LOWER(wff.wallet) = ${w}
    GROUP BY mi.token_id, mi.question, mi.end_date, mi.is_manipulable_strict, wff.block_timestamp
  `);

  const row = result.rows[0] as any;
  if (!row) return null;
  if (!row.is_manipulable_strict) return null;
  if (parseFloat(row.market_usdc) < 100) return null;

  return {
    wallet: w,
    token_id: row.token_id,
    question: row.question,
    end_date: row.end_date ? new Date(row.end_date) : null,
    market_usdc: parseFloat(row.market_usdc),
    biggest_single_trade_usdc: parseFloat(row.biggest_single_trade_usdc),
    first_trade_ts: row.first_trade_ts ? new Date(row.first_trade_ts) : null,
    first_funding_ts: row.first_funding_ts ? new Date(row.first_funding_ts) : null,
    is_manipulable_strict: row.is_manipulable_strict,
  };
}

function scorePair(p: PairData): { score: number; signals: { e1: number; e2: number; e3: number; e4: number } } {
  // E1: wallet age at first trade in this market
  let e1 = 0;
  if (p.first_funding_ts && p.first_trade_ts) {
    const days = (p.first_trade_ts.getTime() - p.first_funding_ts.getTime()) / 86_400_000;
    if (days < 1) e1 = 1.0;
    else if (days < 7) e1 = 0.9;
    else if (days < 30) e1 = 0.6;
    else if (days < 180) e1 = 0.3;
    else e1 = 0.1;
  }

  // E2: trade size — max(biggest single, market_usdc/5)
  let e2 = 0;
  const sizeBasis = Math.max(p.biggest_single_trade_usdc, p.market_usdc / 5);
  if (sizeBasis >= 50_000) e2 = 1.0;
  else if (sizeBasis >= 10_000) e2 = 0.8;
  else if (sizeBasis >= 5_000) e2 = 0.6;
  else if (sizeBasis >= 1_000) e2 = 0.4;
  else if (sizeBasis >= 100) e2 = 0.2;

  // E3: entry timing
  let e3 = 0;
  if (p.first_trade_ts && p.end_date) {
    const hoursBefore = (p.end_date.getTime() - p.first_trade_ts.getTime()) / 3_600_000;
    if (hoursBefore < 0) e3 = 0;
    else if (hoursBefore < 24) e3 = 1.0;
    else if (hoursBefore < 72) e3 = 0.9;
    else if (hoursBefore < 168) e3 = 0.7;
    else if (hoursBefore < 720) e3 = 0.5;
    else if (hoursBefore < 2160) e3 = 0.3;
    else e3 = 0.1;
  }

  // E4: total $ in this market
  let e4 = 0;
  if (p.market_usdc >= 100_000) e4 = 1.0;
  else if (p.market_usdc >= 25_000) e4 = 0.8;
  else if (p.market_usdc >= 5_000) e4 = 0.5;
  else if (p.market_usdc >= 1_000) e4 = 0.3;
  else if (p.market_usdc >= 100) e4 = 0.1;

  // Top-3-of-4 averaging (rewards 3-strong-1-weak insider patterns)
  const all4Avg = (e1 + e2 + e3 + e4) / 4;
  const sorted = [e1, e2, e3, e4].sort((a, b) => b - a);
  const top3Avg = (sorted[0] + sorted[1] + sorted[2]) / 3;
  return { score: Math.max(all4Avg, top3Avg) * 100, signals: { e1, e2, e3, e4 } };
}

// =============================================================================
// V1/V2 event decoding
// =============================================================================

function decodeAndNormalize(log: Log) {
  // Try V1 first
  try {
    const decoded = decodeEventLog({ abi: [ORDER_FILLED_V1], data: log.data, topics: log.topics });
    if (decoded.eventName === "OrderFilled") {
      const a = decoded.args as any;
      return {
        version: "v1" as const,
        orderHash: a.orderHash,
        maker: a.maker,
        taker: a.taker,
        makerAssetId: a.makerAssetId as bigint,
        takerAssetId: a.takerAssetId as bigint,
        makerAmount: a.makerAmountFilled as bigint,
        takerAmount: a.takerAmountFilled as bigint,
        fee: a.fee as bigint,
      };
    }
  } catch {}

  // V2 — collapse (side, tokenId) back to (makerAssetId, takerAssetId) shape
  const decoded = decodeEventLog({ abi: [ORDER_FILLED_V2], data: log.data, topics: log.topics });
  if (decoded.eventName !== "OrderFilled") {
    throw new Error(`Unexpected event: ${decoded.eventName}`);
  }
  const a = decoded.args as any;
  const isBuy = Number(a.side) === 0;
  return {
    version: "v2" as const,
    orderHash: a.orderHash,
    maker: a.maker,
    taker: a.taker,
    makerAssetId: isBuy ? 0n : (a.tokenId as bigint),
    takerAssetId: isBuy ? (a.tokenId as bigint) : 0n,
    makerAmount: a.makerAmountFilled as bigint,
    takerAmount: a.takerAmountFilled as bigint,
    fee: a.fee as bigint,
  };
}

// =============================================================================
// Rescore queue
// =============================================================================

const rescoreQueue: Array<{ wallet: string; tokenId: string }> = [];
let queueWorkerRunning = false;

async function queueWorker() {
  if (queueWorkerRunning) return;
  queueWorkerRunning = true;
  while (rescoreQueue.length > 0) {
    const item = rescoreQueue.shift();
    if (!item) break;
    try {
      const pair = await fetchPairData(item.wallet, item.tokenId);
      if (!pair) continue;
      const { score, signals } = scorePair(pair);
      if (score >= FLAG_THRESHOLD) {
        const isKnown = KNOWN_INSIDER_ADDRESSES.has(item.wallet);
        const reason = [
          `wallet=${item.wallet}`,
          `score=${score.toFixed(1)}`,
          `e1_age=${signals.e1.toFixed(2)}`,
          `e2_size=${signals.e2.toFixed(2)}`,
          `e3_timing=${signals.e3.toFixed(2)}`,
          `e4_total=${signals.e4.toFixed(2)}`,
          `marketUsd=${pair.market_usdc.toFixed(0)}`,
          `q=${pair.question?.slice(0, 60) ?? "(unknown)"}`,
          isKnown ? "KNOWN_INSIDER" : "unknown",
        ].join(" ");
        console.log(`[FLAG] ${reason}`);
      }
    } catch (e) {
      console.error(`[live] scoring error for ${item.wallet}:`, (e as Error).message);
    }
  }
  queueWorkerRunning = false;
}

setInterval(() => {
  if (rescoreQueue.length > 0) queueWorker();
}, 500);

// =============================================================================
// Handle a batch of new logs
// =============================================================================

const exchangeAddrs = new Set([
  ADDRESSES.exchangeV1.toLowerCase(),
  ADDRESSES.negRiskExchangeV1.toLowerCase(),
  ADDRESSES.exchangeV2.toLowerCase(),
  ADDRESSES.negRiskExchangeV2.toLowerCase(),
]);

async function handleLogs(logs: Log[]): Promise<void> {
  if (logs.length === 0) return;

  const rows = await Promise.all(
    logs.map(async (log) => {
      const norm = decodeAndNormalize(log);
      const ts = await getBlockTimestamp(log.blockNumber!);
      return {
        ...buildTradeRow({
          txHash: log.transactionHash!,
          logIndex: log.logIndex!,
          blockNumber: log.blockNumber!,
          blockTimestamp: ts,
          orderHash: norm.orderHash,
          maker: norm.maker,
          taker: norm.taker,
          makerAssetId: norm.makerAssetId,
          takerAssetId: norm.takerAssetId,
          makerAmount: norm.makerAmount,
          takerAmount: norm.takerAmount,
          fee: norm.fee,
        }),
        _version: norm.version,
      };
    }),
  );

  // Persist
  const dbRows = rows.map(({ _version, ...rest }) => rest);
  await db
    .insert(schema.trades)
    .values(dbRows)
    .onConflictDoNothing({ target: [schema.trades.txHash, schema.trades.logIndex] });

  // Print each trade
  for (const r of rows) {
    console.log(
      `[live ${r._version}] ${r.blockTimestamp.toISOString()} ${r.side} $${r.usdcAmount} for ${r.sharesAmount} shares @ ${r.price} (token ${r.tokenId.slice(0, 12)}…)`,
    );
  }

  // Queue (wallet, token_id) pairs for scoring. Dedupe per batch.
  const seen = new Set<string>();
  for (const r of rows) {
    const maker = r.maker.toLowerCase();
    const taker = r.taker.toLowerCase();
    if (!exchangeAddrs.has(maker)) {
      const key = `${maker}|${r.tokenId}`;
      if (!seen.has(key)) {
        seen.add(key);
        rescoreQueue.push({ wallet: maker, tokenId: r.tokenId });
      }
    }
    if (!exchangeAddrs.has(taker)) {
      const key = `${taker}|${r.tokenId}`;
      if (!seen.has(key)) {
        seen.add(key);
        rescoreQueue.push({ wallet: taker, tokenId: r.tokenId });
      }
    }
  }
}

// =============================================================================
// Main: subscribe to V1 + V2
// =============================================================================

async function main() {
  console.log(`[live] subscribing to OrderFilled on V1 + V2 (regular + neg-risk)…`);
  console.log(`[live]   V1 regular:   ${ADDRESSES.exchangeV1}`);
  console.log(`[live]   V1 neg-risk:  ${ADDRESSES.negRiskExchangeV1}`);
  console.log(`[live]   V2 regular:   ${ADDRESSES.exchangeV2}`);
  console.log(`[live]   V2 neg-risk:  ${ADDRESSES.negRiskExchangeV2}`);
  console.log(`[live] FLAG_THRESHOLD = ${FLAG_THRESHOLD}`);

  const unwatchV1 = wsClient.watchEvent({
    address: [ADDRESSES.exchangeV1, ADDRESSES.negRiskExchangeV1],
    event: ORDER_FILLED_V1,
    onLogs: (logs) => handleLogs(logs).catch((e) => console.error("[live v1] handler error:", e)),
    onError: (err) => console.error("[live v1] subscription error:", err),
  });

  const unwatchV2 = wsClient.watchEvent({
    address: [ADDRESSES.exchangeV2, ADDRESSES.negRiskExchangeV2],
    event: ORDER_FILLED_V2,
    onLogs: (logs) => handleLogs(logs).catch((e) => console.error("[live v2] handler error:", e)),
    onError: (err) => console.error("[live v2] subscription error:", err),
  });

  process.on("SIGINT", () => {
    console.log("\n[live] shutting down…");
    unwatchV1();
    unwatchV2();
    process.exit(0);
  });

  console.log(`[live] subscribed. Waiting for events. Ctrl+C to exit.`);
  await new Promise(() => {}); // block forever
}

main().catch((e) => {
  console.error("[live] FATAL:", e);
  process.exit(1);
});

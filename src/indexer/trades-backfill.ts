/**
 * Trades backfill via Polymarket's Goldsky-hosted orderbook subgraph.
 *
 * Why Goldsky and not direct on-chain? Alchemy free tier on Polygon caps
 * eth_getLogs at 10 blocks/request. A 9-month backfill = ~12M blocks =
 * ~1.2M RPC calls = many hours and certain rate-limit grief. The Goldsky
 * subgraph has the same OrderFilled events already indexed — we just
 * paginate through them. Live ingestion still uses direct on-chain
 * WebSocket (see trades-live.ts).
 *
 * Subgraph schema (from research):
 *   type OrderFilledEvent @entity {
 *     id: ID!  # txHash + orderHash
 *     transactionHash: Bytes!
 *     timestamp: BigInt!  # unix seconds
 *     orderHash: Bytes!
 *     maker: String!
 *     taker: String!
 *     makerAssetId: String!
 *     takerAssetId: String!
 *     makerAmountFilled: BigInt!
 *     takerAmountFilled: BigInt!
 *     fee: BigInt!
 *   }
 *
 * Limitation: subgraph entities don't include logIndex or blockNumber.
 * We synthesize a stable logIndex from the event ID's hash suffix and use
 * timestamp-derived block estimate as a placeholder. This is fine for our
 * detection (we never query by blockNumber alone) and idempotency is
 * enforced via UNIQUE(tx_hash, log_index) where log_index is derived from
 * orderHash hash.
 */

import "dotenv/config";
import { db, schema } from "../lib/db.js";
import { buildTradeRow } from "../lib/decode.js";
import { eq } from "drizzle-orm";

const SUBGRAPH_URL =
  "https://api.goldsky.com/api/public/project_cl6mb8i9h0003e201j6li0diw/subgraphs/orderbook-subgraph/0.0.1/gn";

const INDEXER_NAME = "trades-backfill";
const PAGE_SIZE = 1000; // Goldsky/TheGraph default max
const MAX_PAGES_BEFORE_LOG = 10;

// =============================================================================
// GraphQL types
// =============================================================================
type OrderFilledEventGQL = {
  id: string;
  transactionHash: string;
  timestamp: string;
  orderHash: string;
  maker: string;
  taker: string;
  makerAssetId: string;
  takerAssetId: string;
  makerAmountFilled: string;
  takerAmountFilled: string;
  fee: string;
};

type GraphQLResponse<T> = {
  data?: T;
  errors?: Array<{ message: string }>;
};

// =============================================================================
// Subgraph query — paginate by timestamp ascending
// =============================================================================
async function fetchPage(
  fromTimestamp: number,
  excludeId: string | null,
): Promise<OrderFilledEventGQL[]> {
  // Use timestamp_gte + skip pattern. Better yet, paginate by id_gt for stable cursor.
  // We use timestamp ordering, fallback to id-tiebreak via where_id_not.
  const query = `
    query Page($ts: BigInt!, $excludeId: String) {
      orderFilledEvents(
        first: ${PAGE_SIZE}
        orderBy: timestamp
        orderDirection: asc
        where: {
          timestamp_gte: $ts
          ${excludeId ? `id_not: $excludeId` : ""}
        }
      ) {
        id
        transactionHash
        timestamp
        orderHash
        maker
        taker
        makerAssetId
        takerAssetId
        makerAmountFilled
        takerAmountFilled
        fee
      }
    }
  `;

  const variables: Record<string, unknown> = { ts: fromTimestamp.toString() };
  if (excludeId) variables.excludeId = excludeId;

  const res = await fetch(SUBGRAPH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    throw new Error(`Goldsky HTTP ${res.status}: ${await res.text()}`);
  }

  const json = (await res.json()) as GraphQLResponse<{ orderFilledEvents: OrderFilledEventGQL[] }>;
  if (json.errors) {
    throw new Error(`Goldsky GraphQL errors: ${JSON.stringify(json.errors)}`);
  }
  return json.data!.orderFilledEvents;
}

/**
 * Synthesize a deterministic logIndex from the OrderFilledEvent id.
 * Subgraph id format: `${txHash}_${orderHash}`. Multiple OrderFilled events
 * can share a tx (matching multiple orders), so we use the orderHash's
 * trailing 6 hex digits as a stable per-event index within the tx.
 *
 * This ensures UNIQUE(tx_hash, log_index) holds without on-chain log indices.
 */
function syntheticLogIndex(orderHash: string): number {
  // Take last 6 hex chars (24 bits → max 16M, fits in INT)
  const tail = orderHash.replace(/^0x/, "").slice(-6);
  return parseInt(tail, 16);
}

// =============================================================================
// Persist event → trades row
// =============================================================================
async function persistEvents(events: OrderFilledEventGQL[]): Promise<void> {
  if (events.length === 0) return;

  const rows = events.map((e) => {
    const row = buildTradeRow({
      txHash: e.transactionHash,
      logIndex: syntheticLogIndex(e.orderHash),
      blockNumber: 0n, // unknown from subgraph; not used by detection
      blockTimestamp: new Date(parseInt(e.timestamp, 10) * 1000),
      orderHash: e.orderHash,
      maker: e.maker,
      taker: e.taker,
      makerAssetId: BigInt(e.makerAssetId),
      takerAssetId: BigInt(e.takerAssetId),
      makerAmount: BigInt(e.makerAmountFilled),
      takerAmount: BigInt(e.takerAmountFilled),
      fee: BigInt(e.fee),
    });
    return row;
  });

  await db
    .insert(schema.trades)
    .values(rows)
    .onConflictDoNothing({ target: [schema.trades.txHash, schema.trades.logIndex] });
}

// =============================================================================
// Indexer state
// =============================================================================
async function getResumeTimestamp(): Promise<number> {
  const rows = await db
    .select()
    .from(schema.indexerState)
    .where(eq(schema.indexerState.indexerName, INDEXER_NAME));
  if (rows.length === 0) {
    // Default: 9 months back
    const monthsBack = parseInt(process.env.BACKFILL_MONTHS ?? "9", 10);
    const target = Math.floor(Date.now() / 1000) - monthsBack * 30 * 24 * 3600;
    console.log(`[backfill] starting fresh — backfilling ${monthsBack} months from ts ${target}`);
    return target;
  }
  // We stored the last seen timestamp as `lastProcessedBlock` (overload — same column)
  return Number(rows[0].lastProcessedBlock);
}

async function setResumeTimestamp(ts: number): Promise<void> {
  await db
    .insert(schema.indexerState)
    .values({ indexerName: INDEXER_NAME, lastProcessedBlock: BigInt(ts) })
    .onConflictDoUpdate({
      target: schema.indexerState.indexerName,
      set: { lastProcessedBlock: BigInt(ts), updatedAt: new Date() },
    });
}

// =============================================================================
// Main backfill loop
// =============================================================================
async function main() {
  let cursor = await getResumeTimestamp();
  let lastSeenId: string | null = null;
  let totalIngested = 0;
  let pagesSinceLog = 0;
  const startedAt = Date.now();

  console.log(`[backfill] starting from timestamp ${cursor} (${new Date(cursor * 1000).toISOString()})`);

  while (true) {
    const events = await fetchPage(cursor, lastSeenId);

    if (events.length === 0) {
      console.log(`[backfill] reached end of subgraph data at ts ${cursor}`);
      break;
    }

    await persistEvents(events);
    totalIngested += events.length;

    const lastEvent = events[events.length - 1];
    const lastTs = parseInt(lastEvent.timestamp, 10);

    // Advance cursor. If multiple events share the same timestamp at the page boundary,
    // we use lastSeenId to skip them on next page.
    if (lastTs > cursor) {
      cursor = lastTs;
      lastSeenId = lastEvent.id;
    } else {
      // Same timestamp throughout the page → bump cursor by 1s to avoid infinite loop
      cursor = lastTs + 1;
      lastSeenId = null;
    }

    await setResumeTimestamp(cursor);

    pagesSinceLog++;
    if (pagesSinceLog >= MAX_PAGES_BEFORE_LOG || events.length < PAGE_SIZE) {
      const elapsedSec = (Date.now() - startedAt) / 1000;
      const rate = totalIngested / elapsedSec;
      console.log(
        `[backfill] ts=${cursor} (${new Date(cursor * 1000).toISOString()}) — ${totalIngested} events — ${rate.toFixed(0)}/s`,
      );
      pagesSinceLog = 0;
    }

    // If page came back smaller than PAGE_SIZE, we're at the head
    if (events.length < PAGE_SIZE) {
      console.log(`[backfill] partial page (${events.length}/${PAGE_SIZE}) — caught up to head`);
      break;
    }
  }

  const totalSec = (Date.now() - startedAt) / 1000;
  console.log(`[backfill] DONE — ${totalIngested} events in ${totalSec.toFixed(1)}s`);
  process.exit(0);
}

main().catch((e) => {
  console.error("[backfill] FATAL:", e);
  process.exit(1);
});

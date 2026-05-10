/**
 * Parallel time-window trades backfill.
 *
 * Single-cursor backfill is too slow for 9 months of data. The bottleneck
 * is Goldsky's per-page query cost at high cursor depths. Solution: split
 * the time range into N windows and run N workers concurrently. Each
 * worker only scans its own window so depth stays shallow.
 *
 * Worker isolation:
 *   - Each worker has unique indexer_name in indexer_state ("trades-w0", "w1", ...)
 *   - Each worker has its own from_ts and to_ts boundaries
 *   - Idempotent inserts via UNIQUE(tx_hash, log_index) handle any overlap
 *
 * Run via:
 *   npx tsx src/indexer/trades-backfill-parallel.ts \
 *     --workers 12 --from 2025-10-31T06:19:00Z --to 2026-05-09T00:00:00Z
 */

import "dotenv/config";
import { db, schema } from "../lib/db.js";
import { buildTradeRow } from "../lib/decode.js";
import { eq } from "drizzle-orm";

const SUBGRAPH_URL =
  "https://api.goldsky.com/api/public/project_cl6mb8i9h0003e201j6li0diw/subgraphs/orderbook-subgraph/0.0.1/gn";

const PAGE_SIZE = 1000;

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

// =============================================================================
// Subgraph query — bounded by [fromTs, toTs]
// =============================================================================
async function fetchPage(
  fromTs: number,
  toTs: number,
  excludeId: string | null,
): Promise<OrderFilledEventGQL[]> {
  const query = `
    query Page($from: BigInt!, $to: BigInt!, $excludeId: String) {
      orderFilledEvents(
        first: ${PAGE_SIZE}
        orderBy: timestamp
        orderDirection: asc
        where: {
          timestamp_gte: $from
          timestamp_lt: $to
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

  const variables: Record<string, unknown> = {
    from: fromTs.toString(),
    to: toTs.toString(),
  };
  if (excludeId) variables.excludeId = excludeId;

  const res = await fetch(SUBGRAPH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 2000 + Math.random() * 1000));
      return fetchPage(fromTs, toTs, excludeId);
    }
    throw new Error(`Goldsky HTTP ${res.status}: ${await res.text()}`);
  }

  const json = (await res.json()) as { data?: { orderFilledEvents: OrderFilledEventGQL[] }; errors?: any };
  if (json.errors) throw new Error(`GraphQL: ${JSON.stringify(json.errors)}`);
  return json.data!.orderFilledEvents;
}

// Synthetic logIndex: trailing 6 hex chars of orderHash → stable per-event index in tx
function syntheticLogIndex(orderHash: string): number {
  return parseInt(orderHash.replace(/^0x/, "").slice(-6), 16);
}

async function persistEvents(events: OrderFilledEventGQL[]): Promise<void> {
  if (events.length === 0) return;

  const rows = events.map((e) =>
    buildTradeRow({
      txHash: e.transactionHash,
      logIndex: syntheticLogIndex(e.orderHash),
      blockNumber: 0n,
      blockTimestamp: new Date(parseInt(e.timestamp, 10) * 1000),
      orderHash: e.orderHash,
      maker: e.maker,
      taker: e.taker,
      makerAssetId: BigInt(e.makerAssetId),
      takerAssetId: BigInt(e.takerAssetId),
      makerAmount: BigInt(e.makerAmountFilled),
      takerAmount: BigInt(e.takerAmountFilled),
      fee: BigInt(e.fee),
    }),
  );

  // Try bulk insert first (fast path)
  try {
    await db
      .insert(schema.trades)
      .values(rows)
      .onConflictDoNothing({ target: [schema.trades.txHash, schema.trades.logIndex] });
  } catch (e: any) {
    // Fall back to per-row inserts so one bad row doesn't kill the batch
    let skipped = 0;
    let firstErr: string | null = null;
    let firstBadRow: any = null;
    for (const row of rows) {
      try {
        await db
          .insert(schema.trades)
          .values(row)
          .onConflictDoNothing({ target: [schema.trades.txHash, schema.trades.logIndex] });
      } catch (rowErr: any) {
        skipped++;
        if (firstErr === null) {
          firstErr = rowErr?.cause?.message || rowErr?.message || String(rowErr);
          firstBadRow = {
            txHash: row.txHash,
            usdc: row.usdcAmount,
            shares: row.sharesAmount,
            price: row.price,
            makerAmt: row.makerAmount,
            takerAmt: row.takerAmount,
            fee: row.fee,
          };
        }
      }
    }
    if (skipped > 0) {
      console.warn(`[persist] ${skipped}/${rows.length} skipped. First err: ${firstErr}`);
      if (firstBadRow) console.warn(`[persist] sample bad row:`, JSON.stringify(firstBadRow));
    }
  }
}

// =============================================================================
// Per-worker indexer state
// =============================================================================
async function getResumeTs(workerName: string, defaultTs: number): Promise<number> {
  const rows = await db
    .select()
    .from(schema.indexerState)
    .where(eq(schema.indexerState.indexerName, workerName));
  if (rows.length === 0) return defaultTs;
  return Number(rows[0].lastProcessedBlock);
}

async function setResumeTs(workerName: string, ts: number): Promise<void> {
  await db
    .insert(schema.indexerState)
    .values({ indexerName: workerName, lastProcessedBlock: BigInt(ts) })
    .onConflictDoUpdate({
      target: schema.indexerState.indexerName,
      set: { lastProcessedBlock: BigInt(ts), updatedAt: new Date() },
    });
}

// =============================================================================
// Worker
// =============================================================================
async function runWorker(workerName: string, fromTs: number, toTs: number): Promise<number> {
  let cursor = await getResumeTs(workerName, fromTs);
  let lastSeenId: string | null = null;
  let total = 0;
  const startedAt = Date.now();

  console.log(`[${workerName}] starting cursor=${new Date(cursor * 1000).toISOString()} → ${new Date(toTs * 1000).toISOString()}`);

  while (cursor < toTs) {
    const events = await fetchPage(cursor, toTs, lastSeenId);

    if (events.length === 0) {
      console.log(`[${workerName}] window empty at ts=${cursor}, done`);
      break;
    }

    await persistEvents(events);
    total += events.length;

    const lastEvent = events[events.length - 1];
    const lastTs = parseInt(lastEvent.timestamp, 10);

    if (lastTs > cursor) {
      cursor = lastTs;
      lastSeenId = lastEvent.id;
    } else {
      cursor = lastTs + 1;
      lastSeenId = null;
    }

    await setResumeTs(workerName, cursor);

    if (events.length < PAGE_SIZE) {
      console.log(`[${workerName}] partial page (${events.length}/${PAGE_SIZE}), window done`);
      break;
    }

    if (total % 5000 === 0) {
      const elapsed = (Date.now() - startedAt) / 1000;
      console.log(
        `[${workerName}] ${total} events, ts=${new Date(cursor * 1000).toISOString().slice(0, 19)}, ${(total / elapsed).toFixed(0)}/s`,
      );
    }
  }

  const elapsed = (Date.now() - startedAt) / 1000;
  console.log(`[${workerName}] DONE — ${total} events in ${elapsed.toFixed(1)}s`);
  return total;
}

// =============================================================================
// Main — split window into N chunks, run all in parallel
// =============================================================================
function parseArgs(): { workers: number; fromTs: number; toTs: number } {
  const args = process.argv.slice(2);
  const get = (flag: string, def: string) => {
    const i = args.indexOf(flag);
    return i !== -1 && args[i + 1] ? args[i + 1] : def;
  };
  const workers = parseInt(get("--workers", "12"), 10);
  const fromIso = get("--from", "2025-10-31T06:19:00Z");
  const toIso = get("--to", new Date().toISOString());
  const fromTs = Math.floor(new Date(fromIso).getTime() / 1000);
  const toTs = Math.floor(new Date(toIso).getTime() / 1000);
  return { workers, fromTs, toTs };
}

async function main() {
  const { workers, fromTs, toTs } = parseArgs();
  const totalSpan = toTs - fromTs;
  const windowSize = Math.ceil(totalSpan / workers);

  console.log(`[parallel] launching ${workers} workers across ${(totalSpan / 86400).toFixed(1)} days of calendar data`);
  console.log(`[parallel] each worker covers ~${(windowSize / 86400).toFixed(1)} days`);
  console.log("");

  const promises: Promise<number>[] = [];
  for (let i = 0; i < workers; i++) {
    const wFrom = fromTs + i * windowSize;
    const wTo = i === workers - 1 ? toTs : Math.min(toTs, fromTs + (i + 1) * windowSize);
    const name = `trades-w${i}`;
    // Wrap in catch so one worker's failure doesn't abort the batch via Promise.all
    promises.push(
      runWorker(name, wFrom, wTo).catch((e) => {
        console.error(`[${name}] WORKER FAILED:`, e?.message || e);
        return 0;
      }),
    );
  }

  const startedAt = Date.now();
  const totals = await Promise.all(promises);
  const grand = totals.reduce((a, b) => a + b, 0);
  const elapsed = (Date.now() - startedAt) / 1000;

  console.log("");
  console.log(`[parallel] ALL WORKERS DONE`);
  console.log(`[parallel] grand total: ${grand} events in ${elapsed.toFixed(1)}s (${(grand / elapsed).toFixed(0)}/s)`);
  process.exit(0);
}

main().catch((e) => {
  console.error("[parallel] FATAL:", e);
  process.exit(1);
});

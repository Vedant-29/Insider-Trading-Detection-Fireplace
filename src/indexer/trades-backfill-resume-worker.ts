/**
 * Resume a single failed worker by name.
 *
 * Used when a parallel worker dies mid-backfill (transient `fetch failed`
 * from Goldsky etc). Resumes from the worker's saved cursor in
 * `indexer_state` and runs to its assigned window end.
 *
 * Usage:
 *   npx tsx src/indexer/trades-backfill-resume-worker.ts \
 *     --name trades-w4 --to 2025-10-16T05:59:59Z
 *
 * The worker reads its starting cursor from indexer_state.last_processed_block
 * (where `last_processed_block` actually stores the last seen unix timestamp
 * for trade workers). If absent, that's a bug — abort.
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

async function fetchPage(
  fromTs: number,
  toTs: number,
  excludeId: string | null,
  attempt = 1,
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
          ${excludeId ? "id_not: $excludeId" : ""}
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
    }`;
  const variables: Record<string, unknown> = {
    from: String(fromTs),
    to: String(toTs),
  };
  if (excludeId) variables.excludeId = excludeId;

  try {
    const res = await fetch(SUBGRAPH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) {
      throw new Error(`Goldsky HTTP ${res.status}: ${await res.text()}`);
    }
    const json = (await res.json()) as { data?: { orderFilledEvents: OrderFilledEventGQL[] }; errors?: unknown };
    if (json.errors) throw new Error(`Goldsky errors: ${JSON.stringify(json.errors)}`);
    return json.data!.orderFilledEvents;
  } catch (e) {
    // Retry transient network errors up to 5 times with exponential backoff
    if (attempt <= 5) {
      const delayMs = 1000 * 2 ** attempt; // 2s, 4s, 8s, 16s, 32s
      console.log(`[resume] fetch failed (attempt ${attempt}), retrying in ${delayMs}ms — ${e}`);
      await new Promise((r) => setTimeout(r, delayMs));
      return fetchPage(fromTs, toTs, excludeId, attempt + 1);
    }
    throw e;
  }
}

function syntheticLogIndex(orderHash: string): number {
  const tail = orderHash.slice(-8);
  return parseInt(tail, 16) % 1_000_000;
}

async function persistEvents(events: OrderFilledEventGQL[]): Promise<void> {
  const rows = events.map((ev) =>
    buildTradeRow({
      txHash: ev.transactionHash,
      logIndex: syntheticLogIndex(ev.orderHash),
      blockNumber: BigInt(0), // unknown, fine — schema allows
      blockTimestamp: new Date(parseInt(ev.timestamp, 10) * 1000),
      orderHash: ev.orderHash,
      maker: ev.maker,
      taker: ev.taker,
      makerAssetId: BigInt(ev.makerAssetId),
      takerAssetId: BigInt(ev.takerAssetId),
      makerAmount: BigInt(ev.makerAmountFilled),
      takerAmount: BigInt(ev.takerAmountFilled),
      fee: BigInt(ev.fee),
    }),
  );
  if (rows.length === 0) return;
  await db
    .insert(schema.trades)
    .values(rows)
    .onConflictDoNothing({ target: [schema.trades.txHash, schema.trades.logIndex] });
}

async function getResumeTs(workerName: string): Promise<number | null> {
  const rows = await db
    .select()
    .from(schema.indexerState)
    .where(eq(schema.indexerState.indexerName, workerName));
  if (rows.length === 0) return null;
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

function parseArgs(): { name: string; toTs: number } {
  const args = process.argv.slice(2);
  let name: string | undefined;
  let to: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--name") name = args[++i];
    else if (args[i] === "--to") to = args[++i];
  }
  if (!name) throw new Error("--name required");
  if (!to) throw new Error("--to required");
  return { name, toTs: Math.floor(new Date(to).getTime() / 1000) };
}

async function main() {
  const { name, toTs } = parseArgs();
  const cursor = await getResumeTs(name);
  if (cursor === null) {
    console.error(`[resume] no saved state for ${name}, abort`);
    process.exit(1);
  }
  console.log(
    `[resume] worker=${name} resume_from=${new Date(cursor * 1000).toISOString()} to=${new Date(toTs * 1000).toISOString()}`,
  );

  let curr = cursor;
  let lastSeenId: string | null = null;
  let total = 0;
  const startedAt = Date.now();

  while (curr < toTs) {
    const events = await fetchPage(curr, toTs, lastSeenId);
    if (events.length === 0) {
      console.log(`[${name}] window empty at ts=${curr}, done`);
      break;
    }
    await persistEvents(events);
    total += events.length;

    const lastEvent = events[events.length - 1];
    const lastTs = parseInt(lastEvent.timestamp, 10);
    if (lastTs > curr) {
      curr = lastTs;
      lastSeenId = lastEvent.id;
    } else {
      curr = lastTs + 1;
      lastSeenId = null;
    }
    await setResumeTs(name, curr);

    if (events.length < PAGE_SIZE) {
      console.log(`[${name}] partial page (${events.length}/${PAGE_SIZE}), window done`);
      break;
    }
    if (total % 5000 === 0) {
      const elapsed = (Date.now() - startedAt) / 1000;
      console.log(
        `[${name}] ${total} events, ts=${new Date(curr * 1000).toISOString().slice(0, 19)}, ${(total / elapsed).toFixed(0)}/s`,
      );
    }
  }

  const elapsed = (Date.now() - startedAt) / 1000;
  console.log(`[${name}] DONE — ${total} events in ${elapsed.toFixed(1)}s`);
  process.exit(0);
}

main().catch((e) => {
  console.error("[resume] FATAL:", e);
  process.exit(1);
});

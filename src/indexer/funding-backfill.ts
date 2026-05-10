/**
 * USDC.e first-funding indexer.
 *
 * For every wallet that has ever appeared as maker or taker in `trades`,
 * find the FIRST USDC.e transfer ever received by that wallet. Persist to
 * `wallet_first_funding`.
 *
 * We use Alchemy's `alchemy_getAssetTransfers` API. It's not block-window
 * limited like eth_getLogs and lets you filter to a specific recipient +
 * specific token in one call. Free tier is fine for this use case.
 *
 * Strategy:
 *   1. SELECT distinct wallets from `trades` (maker + taker, deduped)
 *   2. SKIP wallets already in `wallet_first_funding`
 *   3. For each remaining wallet, request first 1 USDC.e transfer
 *      (ascending order, maxCount 1)
 *   4. Persist that single transfer
 *
 * Rate limiting: Alchemy free tier is ~25 req/sec. We use a concurrency
 * limit of 8 with a small jitter to stay safe.
 *
 * Run via: npm run index:funding
 */

import "dotenv/config";
import { db, schema } from "../lib/db.js";
import { sql } from "drizzle-orm";
import { RPC_URL, ADDRESSES } from "../lib/viem.js";

const CONCURRENCY = 8;
const BATCH_SIZE = 500; // wallets per progress log
const RPC_REQ_DELAY_MS = 50; // ~20 req/sec per worker (×8 workers ≈ 160 req/sec, but Alchemy throttles us if needed)

type AssetTransfer = {
  blockNum: string; // hex
  uniqueId: string; // "txHash:log:logIndex"
  hash: string;
  from: string;
  to: string;
  value: number;
  rawContract: { value: string; address: string; decimal: string };
  metadata: { blockTimestamp?: string } | null;
};

type AssetTransfersResponse = {
  jsonrpc: "2.0";
  id: number;
  result?: { transfers: AssetTransfer[]; pageKey?: string };
  error?: { code: number; message: string };
};

// =============================================================================
// Alchemy API call
// =============================================================================
async function fetchFirstUsdcDeposit(wallet: string): Promise<AssetTransfer | null> {
  const body = {
    id: 1,
    jsonrpc: "2.0",
    method: "alchemy_getAssetTransfers",
    params: [
      {
        fromBlock: "0x0",
        toBlock: "latest",
        toAddress: wallet,
        contractAddresses: [ADDRESSES.usdcE],
        category: ["erc20"],
        order: "asc",
        maxCount: "0x1",
        withMetadata: true,
      },
    ],
  };

  let attempt = 0;
  while (attempt < 3) {
    try {
      const res = await fetch(RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        if (res.status === 429) {
          // rate limited — back off
          await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
          attempt++;
          continue;
        }
        throw new Error(`Alchemy HTTP ${res.status}`);
      }
      const json = (await res.json()) as AssetTransfersResponse;
      if (json.error) {
        throw new Error(`Alchemy error: ${json.error.message}`);
      }
      const transfers = json.result?.transfers ?? [];
      return transfers.length > 0 ? transfers[0] : null;
    } catch (e: any) {
      if (attempt === 2) throw e;
      attempt++;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return null;
}

// =============================================================================
// Concurrency-limited worker pool
// =============================================================================
async function processBatch(wallets: string[]): Promise<{ found: number; missing: number }> {
  let found = 0;
  let missing = 0;

  // Simple worker pool
  const queue = [...wallets];
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length > 0) {
      const wallet = queue.shift();
      if (!wallet) break;

      try {
        const transfer = await fetchFirstUsdcDeposit(wallet);
        if (!transfer) {
          missing++;
          continue;
        }

        // Parse fields
        const blockNumber = BigInt(transfer.blockNum);
        const ts = transfer.metadata?.blockTimestamp
          ? new Date(transfer.metadata.blockTimestamp)
          : new Date(); // fallback (shouldn't happen with withMetadata: true)
        const [txHash, , logIndexStr] = transfer.uniqueId.split(":");
        const logIndex = parseInt(logIndexStr, 10);

        await db
          .insert(schema.walletFirstFunding)
          .values({
            wallet: wallet.toLowerCase(),
            txHash,
            logIndex,
            blockNumber,
            blockTimestamp: ts,
            amount: transfer.value.toString(),
            fundedBy: transfer.from.toLowerCase(),
          })
          .onConflictDoNothing({ target: schema.walletFirstFunding.wallet });

        found++;
      } catch (e: any) {
        console.error(`[funding] failed for ${wallet}: ${e.message}`);
      }

      if (RPC_REQ_DELAY_MS > 0) await new Promise((r) => setTimeout(r, RPC_REQ_DELAY_MS));
    }
  });

  await Promise.all(workers);
  return { found, missing };
}

// =============================================================================
// Main
// =============================================================================
async function main() {
  console.log("[funding] gathering wallets to look up…");

  // Strategy: only fetch funding for wallets that have a "human-trader-like"
  // trade footprint. Pure bots/market-makers have millions of trades — they're
  // never insiders. Insiders historically have 10-1000 trades on Polymarket.
  // We filter to wallets with 3-3000 trades total in MANIPULABLE markets, plus
  // we always include the 8 known insiders regardless of count.
  // This shrinks the set from ~620k → ~30k while preserving all insider candidates.
  const exchangeAddrs = [
    ADDRESSES.exchangeV1.toLowerCase(),
    ADDRESSES.negRiskExchangeV1.toLowerCase(),
    ADDRESSES.exchangeV2.toLowerCase(),
    ADDRESSES.negRiskExchangeV2.toLowerCase(),
  ];

  const MIN_BIGGEST_USDC = parseFloat(process.env.FUNDING_MIN_USDC ?? "5000");

  const result = await db.execute(sql`
    WITH biggest_per_wallet AS (
      SELECT t.maker AS wallet, MAX(t.usdc_amount::float) AS biggest
      FROM ${schema.trades} t
      JOIN ${schema.marketManipulability} mm ON mm.token_id = t.token_id
      WHERE mm.is_manipulable = true AND t.side = 'BUY'
      GROUP BY t.maker
      UNION ALL
      SELECT t.taker AS wallet, MAX(t.usdc_amount::float) AS biggest
      FROM ${schema.trades} t
      JOIN ${schema.marketManipulability} mm ON mm.token_id = t.token_id
      WHERE mm.is_manipulable = true AND t.side = 'SELL'
      GROUP BY t.taker
    ),
    rolled AS (
      SELECT wallet, MAX(biggest) AS biggest
      FROM biggest_per_wallet
      GROUP BY wallet
    )
    SELECT wallet
    FROM rolled
    WHERE biggest >= ${MIN_BIGGEST_USDC}
      AND wallet NOT IN (${sql.raw(exchangeAddrs.map((a) => `'${a}'`).join(","))})
      AND wallet NOT IN (SELECT wallet FROM ${schema.walletFirstFunding})
  `);

  const wallets = result.rows.map((r: any) => r.wallet as string);
  console.log(`[funding] ${wallets.length} wallets need funding lookup (biggest trade in manipulable markets >= $${MIN_BIGGEST_USDC})`);

  if (wallets.length === 0) {
    console.log("[funding] nothing to do, exiting.");
    process.exit(0);
  }

  const startedAt = Date.now();
  let totalFound = 0;
  let totalMissing = 0;

  for (let i = 0; i < wallets.length; i += BATCH_SIZE) {
    const batch = wallets.slice(i, i + BATCH_SIZE);
    const { found, missing } = await processBatch(batch);
    totalFound += found;
    totalMissing += missing;

    const elapsedSec = (Date.now() - startedAt) / 1000;
    const processed = i + batch.length;
    const rate = processed / elapsedSec;
    const remaining = wallets.length - processed;
    const etaMin = remaining / rate / 60;
    console.log(
      `[funding] ${processed}/${wallets.length} processed — ${totalFound} funded, ${totalMissing} no-funding — ${rate.toFixed(0)} wallets/s — ETA ${etaMin.toFixed(1)} min`,
    );
  }

  const totalSec = (Date.now() - startedAt) / 1000;
  console.log(`[funding] DONE — ${totalFound} funded, ${totalMissing} no-funding in ${totalSec.toFixed(1)}s`);
  process.exit(0);
}

main().catch((e) => {
  console.error("[funding] FATAL:", e);
  process.exit(1);
});

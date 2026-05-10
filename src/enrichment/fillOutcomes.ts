/**
 * Determine the winning token for each closed market.
 *
 * For each closed market with NULL is_winning_token:
 *   1. Fetch the market by condition_id from Gamma (in batches)
 *   2. Match each of our 2 tokens to its index in clobTokenIds
 *   3. Set outcome_index and is_winning_token
 *
 * The 'is_winning_token' field is what we use to compute per-trade win/loss
 * and ultimately per-wallet win rate.
 *
 * Run via: npx tsx src/enrichment/fillOutcomes.ts
 */

import "dotenv/config";
import { db } from "../lib/db.js";
import { sql } from "drizzle-orm";
import { fetchMarketsByConditionIds } from "./gamma.js";

const BATCH = 50;

async function main() {
  console.log("[outcomes] gathering closed markets needing outcome_index…");

  // We need each closed market's clobTokenIds order to determine which of our
  // 2 tokens is "Yes" and which is "No".
  const result = await db.execute(sql`
    SELECT DISTINCT condition_id
    FROM markets
    WHERE closed = true
      AND outcome_prices IS NOT NULL
      AND condition_id IS NOT NULL
      AND outcome_index IS NULL
  `);
  const conditionIds = result.rows
    .map((r: any) => r.condition_id as string)
    .filter((c) => c && c.startsWith("0x"));
  console.log(`[outcomes] ${conditionIds.length} condition_ids need outcome resolution`);

  if (conditionIds.length === 0) {
    console.log("[outcomes] nothing to do.");
    process.exit(0);
  }

  let totalUpdated = 0;
  const startedAt = Date.now();

  for (let i = 0; i < conditionIds.length; i += BATCH) {
    const chunk = conditionIds.slice(i, i + BATCH);
    let markets: Awaited<ReturnType<typeof fetchMarketsByConditionIds>> = [];
    try {
      markets = await fetchMarketsByConditionIds(chunk);
    } catch (e) {
      console.error(`[outcomes] batch error: ${(e as Error).message}`);
      continue;
    }

    // For each market, determine winning token and update both rows
    for (const m of markets) {
      if (!m.clobTokenIds || m.clobTokenIds.length !== 2) continue;
      if (!m.outcomePrices || m.outcomePrices.length !== 2) continue;
      // outcomePrices: [1,0] means index 0 won (price went to 1).
      const idx0Won = m.outcomePrices[0] > m.outcomePrices[1];
      const winningTokenId = idx0Won ? m.clobTokenIds[0] : m.clobTokenIds[1];

      // Update both tokens
      for (let idx = 0; idx < m.clobTokenIds.length; idx++) {
        const tid = m.clobTokenIds[idx];
        const isWinning = tid === winningTokenId;
        await db.execute(sql.raw(
          `UPDATE markets SET outcome_index = ${idx}, is_winning_token = ${isWinning} WHERE token_id = '${tid.replace(/'/g, "''")}'`
        ));
        totalUpdated++;
      }
    }

    if (i % 500 === 0 || i + BATCH >= conditionIds.length) {
      const elapsed = (Date.now() - startedAt) / 1000;
      const processed = Math.min(i + BATCH, conditionIds.length);
      const rate = processed / elapsed;
      const eta = (conditionIds.length - processed) / rate / 60;
      console.log(
        `[outcomes] ${processed}/${conditionIds.length} condition_ids processed — ${totalUpdated} tokens updated — ${rate.toFixed(0)}/s — ETA ${eta.toFixed(1)} min`,
      );
    }
  }

  const totalSec = (Date.now() - startedAt) / 1000;
  console.log(`[outcomes] DONE — ${totalUpdated} tokens updated in ${totalSec.toFixed(1)}s`);
  process.exit(0);
}

main().catch((e) => {
  console.error("[outcomes] FATAL:", e);
  process.exit(1);
});

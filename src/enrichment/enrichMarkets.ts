/**
 * Enrich `markets` table by fetching metadata from Gamma API.
 *
 * For every distinct token_id in `trades` that doesn't yet have a row in
 * `markets`, fetch the market from Gamma and persist.
 *
 * Run via: npm run enrich:markets
 */

import "dotenv/config";
import { db, schema } from "../lib/db.js";
import { sql } from "drizzle-orm";
import { fetchMarketsByTokenIds } from "./gamma.js";

const BATCH = 50;

async function main() {
  console.log("[enrich] gathering distinct token_ids from trades…");

  // We split this into 2 queries because PostgreSQL's planner picks a slow
  // Sort-then-Unique on (DISTINCT trades.token_id WHERE NOT IN markets) when
  // markets is non-empty. Plain DISTINCT (no anti-join) gets a clean
  // parallel HashAggregate, then we filter in JS. ~50 sec on 56M trades.
  console.log("[enrich] step 1: SELECT DISTINCT token_id FROM trades …");
  const startQ1 = Date.now();
  const distinctResult = await db.execute(sql`SELECT DISTINCT token_id FROM ${schema.trades}`);
  const allTokenIds = distinctResult.rows.map((r: any) => r.token_id as string);
  console.log(`[enrich]   got ${allTokenIds.length} distinct token_ids in ${((Date.now() - startQ1) / 1000).toFixed(1)}s`);

  console.log("[enrich] step 2: SELECT token_id FROM markets …");
  const startQ2 = Date.now();
  const enrichedResult = await db.execute(sql`SELECT token_id FROM ${schema.markets}`);
  const enrichedSet = new Set(enrichedResult.rows.map((r: any) => r.token_id as string));
  console.log(`[enrich]   got ${enrichedSet.size} already-enriched in ${((Date.now() - startQ2) / 1000).toFixed(1)}s`);

  const tokenIds = allTokenIds.filter((id) => !enrichedSet.has(id));
  console.log(`[enrich] ${tokenIds.length} markets need enrichment`);

  if (tokenIds.length === 0) {
    console.log("[enrich] nothing to do, exiting.");
    process.exit(0);
  }

  const startedAt = Date.now();
  let totalEnriched = 0;
  let totalNotFound = 0;

  for (let i = 0; i < tokenIds.length; i += BATCH) {
    const chunk = tokenIds.slice(i, i + BATCH);
    const markets = await fetchMarketsByTokenIds(chunk);

    // Map: tokenId → market data
    // Gamma returns markets with `clobTokenIds` array; we need to pivot so each
    // token_id we requested gets its own row.
    const tokenIdToMarket = new Map<string, (typeof markets)[number]>();
    for (const m of markets) {
      for (const tid of m.clobTokenIds) {
        tokenIdToMarket.set(tid, m);
      }
    }

    const rows = chunk.map((tokenId) => {
      const m = tokenIdToMarket.get(tokenId);
      if (!m) {
        totalNotFound++;
        // Insert a stub row so we don't keep retrying this token
        return {
          tokenId,
          conditionId: null,
          question: null,
          slug: null,
          endDate: null,
          liquidity: null,
          volume: null,
          negRisk: null,
          umaBond: null,
          customLiveness: null,
          description: null,
          resolutionSource: null,
          tags: [],
          outcomes: null,
          outcomePrices: null,
          bestAsk: null,
          bestBid: null,
          closed: null,
        };
      }
      totalEnriched++;
      return {
        tokenId,
        conditionId: m.conditionId,
        question: m.question,
        slug: m.slug,
        endDate: m.endDate,
        liquidity: m.liquidity?.toString() ?? null,
        volume: m.volume?.toString() ?? null,
        negRisk: m.negRisk,
        umaBond: m.umaBond?.toString() ?? null,
        customLiveness: m.customLiveness,
        description: m.description,
        resolutionSource: m.resolutionSource,
        tags: m.tags,
        outcomes: m.outcomes ? m.outcomes : null,
        outcomePrices: m.outcomePrices ? m.outcomePrices : null,
        bestAsk: m.bestAsk?.toString() ?? null,
        bestBid: m.bestBid?.toString() ?? null,
        closed: m.closed,
      };
    });

    await db
      .insert(schema.markets)
      .values(rows)
      .onConflictDoNothing({ target: schema.markets.tokenId });

    const elapsedSec = (Date.now() - startedAt) / 1000;
    const processed = i + chunk.length;
    const rate = processed / elapsedSec;
    const remaining = tokenIds.length - processed;
    const etaMin = remaining / rate / 60;
    if (i % (BATCH * 5) === 0 || processed === tokenIds.length) {
      console.log(
        `[enrich] ${processed}/${tokenIds.length} processed — ${totalEnriched} enriched, ${totalNotFound} stub — ${rate.toFixed(0)}/s — ETA ${etaMin.toFixed(1)} min`,
      );
    }
  }

  const totalSec = (Date.now() - startedAt) / 1000;
  console.log(
    `[enrich] DONE — ${totalEnriched} enriched, ${totalNotFound} stub-only in ${totalSec.toFixed(1)}s`,
  );
  process.exit(0);
}

main().catch((e) => {
  console.error("[enrich] FATAL:", e);
  process.exit(1);
});

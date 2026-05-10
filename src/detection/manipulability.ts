/**
 * 5-factor market manipulability filter.
 *
 * Grounded in the ACDC April 2026 study (Anti-Corruption Data Collective)
 * which analyzed 435,672 Polymarket markets. Key empirical finding:
 * insider risk tracks the OUTCOME-MAKER class — markets resolved by a
 * small institutional decision (military, exec admin, corp board) are
 * far more manipulable than markets resolved by aggregated public action
 * (elections, S&P close, sports).
 *
 * Five factors, max 100 points:
 *
 *   F1: Outcome-maker class            (max 40)
 *   F2: Per-outcome liquidity          (max 20)  — Kyle's lambda proxy
 *   F3: Time to resolution             (max 15)
 *   F4: Resolution-source narrowness   (max 15)
 *   F5: Longshot × negRisk × thin combo (max 10) — ACDC's strongest single
 *                                                  signal
 *
 * Gate: score >= 40 → market is manipulable, included in detection.
 *
 * Run via: npm run score:manipulability
 */

import "dotenv/config";
import { db, schema } from "../lib/db.js";
import { eq, sql } from "drizzle-orm";
import type { Market } from "../lib/schema.js";

// =============================================================================
// Regex patterns
// =============================================================================

/** Verbs that indicate a single decision-maker / small group action. */
const DECISION_VERBS =
  /\b(pardon|pardons|strike|strikes|launch|launches|announce|announces|announcement|release|released|fire|fires|appoint|appoints|nominate|nominates|sign|signs|veto|sanction|sanctions|resign|resigns|acquire|acquires|merge|approve|approval|reject|rejects|extradite|arrest|arrests|kill|killed|capture|captures|deploy|deploys)\b/i;

/** Aggregate / public-outcome keywords (oppose insider edge). */
const AGGREGATE_KEYWORDS =
  /\b(election|elections|win|wins|game|games|score|scores|temperature|index|gdp|cpi|jobs|s&p|sp500|nasdaq|dow|super bowl|world series|world cup|championship|rainfall|snowfall|nba finals|nfl|playoffs)\b/i;

/** Specific-date phrases ("by Jan 31", "on Monday"). */
const SPECIFIC_DATE =
  /\b(by|on|before)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|\d{1,2}\/\d{1,2}|\d{1,2}-\d{1,2})\b/i;

/** Description patterns for narrow / single-source resolution. */
const NARROW_SOURCE = [
  /official announcement/i,
  /white house/i,
  /department of/i,
  /press release/i,
  /\bpublished by\b/i,
  /spotify/i,
  /google/i,
  /microsoft/i,
  /apple/i,
  /supreme court/i,
  /pentagon/i,
  /\bidf\b/i,
  /\buma\b/i,
  /pardon/i,
  /the white house/i,
];

/** Description patterns for aggregate data sources (low manipulability). */
const AGGREGATE_SOURCE = [
  /s&p 500/i,
  /\bnoaa\b/i,
  /bureau of labor/i,
  /bloomberg consensus/i,
  /credible media/i,
  /widely reported/i,
  /coinbase price/i,
  /binance price/i,
];

const POLITICS_TAGS = new Set(["politics", "us-politics", "geopolitics", "military"]);
const SPORTS_TAGS = new Set(["sports", "nba", "nfl", "mlb", "soccer", "tennis", "boxing", "ufc"]);
const WEATHER_TAGS = new Set(["weather", "climate"]);

// =============================================================================
// Score factors
// =============================================================================

function factorOutcomeMaker(market: Market): { score: number; reasons: string[] } {
  let s = 0;
  const reasons: string[] = [];
  const tags = (market.tags ?? []).map((t) => t.toLowerCase());
  const question = market.question ?? "";

  if (market.negRisk === true) {
    s += 20;
    reasons.push("neg_risk_market");
  }

  // Tag-based
  if (tags.some((t) => POLITICS_TAGS.has(t))) {
    s += 15;
    reasons.push("politics_tag");
  } else if (tags.some((t) => SPORTS_TAGS.has(t))) {
    s -= 10;
    reasons.push("sports_tag");
  } else if (tags.some((t) => WEATHER_TAGS.has(t))) {
    s -= 10;
    reasons.push("weather_tag");
  }

  // Title-based decision verbs
  if (DECISION_VERBS.test(question)) {
    s += 10;
    reasons.push("decision_verb");
  }
  if (AGGREGATE_KEYWORDS.test(question)) {
    s -= 10;
    reasons.push("aggregate_keyword");
  }

  return { score: Math.max(0, Math.min(40, s)), reasons };
}

function factorLiquidity(market: Market): { score: number; reasons: string[] } {
  let liquidity = market.liquidity ? parseFloat(market.liquidity) : 0;
  // For neg_risk markets, the per-outcome liquidity is what matters.
  // Approximate: divide by outcome count (we use 2 as default for binary).
  if (market.negRisk === true) {
    liquidity = liquidity / 2;
  }

  const reasons: string[] = [];
  let s = 0;
  if (liquidity < 10_000) {
    s = 20;
    reasons.push(`thin_liquidity_$${Math.round(liquidity)}`);
  } else if (liquidity < 50_000) {
    s = 15;
    reasons.push(`low_liquidity_$${Math.round(liquidity)}`);
  } else if (liquidity < 100_000) {
    s = 10;
  } else if (liquidity < 500_000) {
    s = 5;
  }
  return { score: s, reasons };
}

function factorTime(market: Market, refTime: Date = new Date()): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  if (!market.endDate) return { score: 0, reasons };

  const hoursToEnd = (market.endDate.getTime() - refTime.getTime()) / 3_600_000;
  let s = 0;
  if (hoursToEnd < 24 && hoursToEnd > -24 * 365) {
    // Within 24h of end (or up to a year past — for resolved markets, time-pressure was high at trade time)
    s = 15;
    reasons.push("near_resolution");
  } else if (hoursToEnd < 72) {
    s = 10;
  } else if (hoursToEnd < 7 * 24) {
    s = 5;
  } else if (hoursToEnd < 30 * 24) {
    s = 2;
  }

  // Specific-date bonus: market title mentions a specific day/date
  const question = market.question ?? "";
  if (SPECIFIC_DATE.test(question)) {
    s = Math.min(15, s + 5);
    reasons.push("specific_date");
  }

  return { score: s, reasons };
}

function factorResolutionSource(market: Market): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  const desc = (market.description ?? "").toLowerCase();
  const resSrc = (market.resolutionSource ?? "").toLowerCase();

  // Combine description + resolution_source for matching
  const haystack = `${desc} ${resSrc}`;

  let s = 5; // default: unknown/generic
  if (NARROW_SOURCE.some((re) => re.test(haystack))) {
    s = 15;
    reasons.push("narrow_source");
  } else if (AGGREGATE_SOURCE.some((re) => re.test(haystack))) {
    s = 0;
    reasons.push("aggregate_source");
  }

  // Bonus: non-default UMA params signal contested resolution
  const umaBond = market.umaBond ? parseFloat(market.umaBond) : 0;
  const customLiveness = market.customLiveness ?? 0;
  if (umaBond > 500 || customLiveness > 0) {
    s = Math.min(15, s + 5);
    reasons.push("nonstandard_uma");
  }

  return { score: s, reasons };
}

function factorLongshotCombo(market: Market): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  if (market.negRisk !== true) return { score: 0, reasons };

  const bestAsk = market.bestAsk ? parseFloat(market.bestAsk) : null;
  if (bestAsk === null || bestAsk > 0.35) return { score: 0, reasons };

  let liquidity = market.liquidity ? parseFloat(market.liquidity) : 0;
  if (market.negRisk === true) liquidity = liquidity / 2;
  if (liquidity >= 50_000) return { score: 0, reasons };

  reasons.push("longshot_neg_risk_thin");
  return { score: 10, reasons };
}

// =============================================================================
// Combine factors
// =============================================================================
export type ManipulabilityResult = {
  score: number;
  factorOutcomeMaker: number;
  factorLiquidity: number;
  factorTime: number;
  factorResolutionSource: number;
  factorLongshotCombo: number;
  isManipulable: boolean;
  reasons: string[];
};

export function computeManipulability(market: Market): ManipulabilityResult {
  const f1 = factorOutcomeMaker(market);
  const f2 = factorLiquidity(market);
  const f3 = factorTime(market);
  const f4 = factorResolutionSource(market);
  const f5 = factorLongshotCombo(market);

  const total = f1.score + f2.score + f3.score + f4.score + f5.score;
  const reasons = [...f1.reasons, ...f2.reasons, ...f3.reasons, ...f4.reasons, ...f5.reasons];

  return {
    score: total,
    factorOutcomeMaker: f1.score,
    factorLiquidity: f2.score,
    factorTime: f3.score,
    factorResolutionSource: f4.score,
    factorLongshotCombo: f5.score,
    isManipulable: total >= 40,
    reasons,
  };
}

// =============================================================================
// Batch run over all markets
// =============================================================================
async function main() {
  console.log("[manipulability] loading markets…");
  const markets = await db.select().from(schema.markets);
  console.log(`[manipulability] ${markets.length} markets to score`);

  const startedAt = Date.now();
  const BATCH = 1000;
  let totalManipulable = 0;

  for (let i = 0; i < markets.length; i += BATCH) {
    const batch = markets.slice(i, i + BATCH);
    const rows = batch.map((m) => {
      const r = computeManipulability(m);
      if (r.isManipulable) totalManipulable++;
      return {
        tokenId: m.tokenId,
        score: r.score.toFixed(2),
        factorOutcomeMaker: r.factorOutcomeMaker.toFixed(2),
        factorLiquidity: r.factorLiquidity.toFixed(2),
        factorTime: r.factorTime.toFixed(2),
        factorResolutionSource: r.factorResolutionSource.toFixed(2),
        factorLongshotCombo: r.factorLongshotCombo.toFixed(2),
        isManipulable: r.isManipulable,
        reasons: r.reasons,
      };
    });

    await db
      .insert(schema.marketManipulability)
      .values(rows)
      .onConflictDoUpdate({
        target: schema.marketManipulability.tokenId,
        set: {
          score: sql`excluded.score`,
          factorOutcomeMaker: sql`excluded.factor_outcome_maker`,
          factorLiquidity: sql`excluded.factor_liquidity`,
          factorTime: sql`excluded.factor_time`,
          factorResolutionSource: sql`excluded.factor_resolution_source`,
          factorLongshotCombo: sql`excluded.factor_longshot_combo`,
          isManipulable: sql`excluded.is_manipulable`,
          reasons: sql`excluded.reasons`,
          computedAt: new Date(),
        },
      });

    if ((i + BATCH) % (BATCH * 5) === 0 || i + BATCH >= markets.length) {
      const elapsedSec = (Date.now() - startedAt) / 1000;
      console.log(`[manipulability] ${Math.min(i + BATCH, markets.length)}/${markets.length} — ${totalManipulable} manipulable so far — ${elapsedSec.toFixed(1)}s`);
    }
  }

  const totalSec = (Date.now() - startedAt) / 1000;
  console.log(
    `[manipulability] DONE — ${totalManipulable}/${markets.length} markets manipulable (≥40) in ${totalSec.toFixed(1)}s`,
  );
  process.exit(0);
}

// Only run main if executed directly, not when imported
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error("[manipulability] FATAL:", e);
    process.exit(1);
  });
}

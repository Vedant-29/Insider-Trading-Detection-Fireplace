/**
 * Wallet scoring v2 — per-(wallet, market) signals + per-wallet win rate.
 *
 * Why this design (vs v1):
 *   v1 scored at the wallet level — averaging behavior across all markets the
 *   wallet traded. This dilutes insider signals when an insider ALSO does normal
 *   trading on the side. d4vd is the canonical example: $540k insider bet on
 *   "Will Bianca Censori be #1 Google search?", but d4vd ALSO trades 65 sports
 *   markets normally → wallet-level diversity = 0.00, concentration = 0.00, score = 17.
 *
 *   v2 fixes this by scoring each (wallet, market) pair independently. d4vd ×
 *   Bianca = single market, single big bet, late timing → per-pair score ~85.
 *   Take MAX across all markets per wallet, and d4vd correctly flags.
 *
 * Two complementary scoring tracks:
 *   T_event_max:  best per-(wallet, market) score across all wallet's markets
 *   T_winrate:    binomial p-value test on wallet's win rate (resolved markets only)
 *
 * Final wallet score = MAX(T_event_max, T_winrate).
 *
 * Tighter manipulability filter (is_manipulable_strict):
 *   v1 flagged 97% of markets manipulable → meaningless. v2 requires:
 *     - decision_verb in question OR negRisk=true
 *     - liquidity < 100_000
 *     - end_date within 60 days
 *
 * Run via: npx tsx src/detection/score.ts
 */

import "dotenv/config";
import { db } from "../lib/db.js";
import { sql } from "drizzle-orm";
import knownInsidersJson from "../../data/known_insiders.json" with { type: "json" };

const FLAG_THRESHOLD = 60;

const KNOWN_INSIDER_ADDRESSES = new Set(
  (knownInsidersJson as Array<{ address: string }>).map((k) => k.address.toLowerCase()),
);

// =============================================================================
// Per-(wallet, market) abnormality score (T_event_max track)
// =============================================================================
//
// For each (wallet, token_id) pair, we compute 4 signals using ONLY that market's
// trades — this is the key fix vs v1.
//
// Signals (each in [0, 1]):
//   E1: wallet age (days between first USDC funding and FIRST trade in this market)
//   E2: trade size in this market (max single trade USDC)
//   E3: entry timing (hours before market resolution at first trade)
//   E4: total $ in this market
//
// Per-pair score = (E1 + E2 + E3 + E4) / 4 × 100
//
// Note: we don't use a "concentration" signal here because it's always 1.0 at
// per-market level (100% of trades in this market are in this market). It only
// makes sense at wallet level, which the MAX aggregation effectively captures.

type PerPairRow = {
  wallet: string;
  token_id: string;
  question: string | null;
  is_manipulable_strict: boolean;
  is_winning_token: boolean | null;
  market_usdc: number;
  biggest_single_trade_usdc: number;
  first_trade_ts: Date | null;
  end_date: Date | null;
  first_funding_ts: Date | null;
};

async function fetchPerPairAggregates(): Promise<PerPairRow[]> {
  // Compute per-(wallet, token_id) aggregates restricted to manipulable_strict markets.
  // The CTE is heavy; we order by max market_usdc per wallet so the worst MAX comes first.
  const result = await db.execute(sql`
    WITH manipulable_markets AS (
      SELECT
        m.token_id,
        m.question,
        m.end_date,
        m.is_winning_token,
        -- v2 strict manipulability filter:
        --   1. has decision-maker class (neg_risk OR decision verb in question)
        --   2. liquidity < $100k (popular markets are not manipulable by 1 person)
        --   3. has end_date (so we can compute timing signal)
        -- Note: we removed v1's hard sports/weather exclusion because the
        -- decision-verb regex effectively catches it (sports questions like
        -- "Mariners vs Blue Jays" don't contain decision verbs).
        (
          (
            m.neg_risk = true
            OR m.question ~* '\\m(pardon|strike|launch|fire|name|announce|approve|veto|reject|sign|nominate|appoint|search|streamed|elect|win)\\M'
          )
          AND COALESCE(m.liquidity, 0) < 100000
          AND m.end_date IS NOT NULL
        ) AS is_manipulable_strict
      FROM markets m
    ),
    eligible_trades AS (
      SELECT t.*, mm.question, mm.end_date, mm.is_winning_token
      FROM trades t
      JOIN manipulable_markets mm ON mm.token_id = t.token_id
      WHERE mm.is_manipulable_strict = true
    ),
    wallet_market_buys AS (
      -- BUY trades by wallet (maker side BUYs OR taker side SELLs = wallet bought the token)
      SELECT
        maker AS wallet,
        token_id,
        question,
        end_date,
        is_winning_token,
        usdc_amount::float AS usdc,
        block_timestamp
      FROM eligible_trades
      WHERE side = 'BUY'
      UNION ALL
      SELECT
        taker AS wallet,
        token_id,
        question,
        end_date,
        is_winning_token,
        usdc_amount::float AS usdc,
        block_timestamp
      FROM eligible_trades
      WHERE side = 'SELL'
    ),
    per_pair AS (
      SELECT
        wallet,
        token_id,
        MAX(question) AS question,
        BOOL_OR(true) AS is_manipulable_strict,
        BOOL_OR(is_winning_token) AS is_winning_token,
        MAX(end_date) AS end_date,
        SUM(usdc) AS market_usdc,
        MAX(usdc) AS biggest_single_trade_usdc,
        MIN(block_timestamp) AS first_trade_ts
      FROM wallet_market_buys
      GROUP BY wallet, token_id
    )
    SELECT
      pp.wallet,
      pp.token_id,
      pp.question,
      pp.is_manipulable_strict,
      pp.is_winning_token,
      pp.market_usdc,
      pp.biggest_single_trade_usdc,
      pp.first_trade_ts,
      pp.end_date,
      wff.block_timestamp AS first_funding_ts
    FROM per_pair pp
    LEFT JOIN wallet_first_funding wff ON LOWER(wff.wallet) = LOWER(pp.wallet)
    WHERE pp.market_usdc >= 100  -- ignore dust trades
  `);

  return result.rows.map((r: any) => ({
    wallet: r.wallet,
    token_id: r.token_id,
    question: r.question,
    is_manipulable_strict: r.is_manipulable_strict,
    is_winning_token: r.is_winning_token,
    market_usdc: parseFloat(r.market_usdc),
    biggest_single_trade_usdc: parseFloat(r.biggest_single_trade_usdc),
    first_trade_ts: r.first_trade_ts ? new Date(r.first_trade_ts) : null,
    end_date: r.end_date ? new Date(r.end_date) : null,
    first_funding_ts: r.first_funding_ts ? new Date(r.first_funding_ts) : null,
  }));
}

function scorePerPair(p: PerPairRow): number {
  // E1: wallet age at FIRST trade in this market. Days since first USDC funding.
  // Insiders often create a wallet specifically for one bet → very fresh wallet.
  let e1 = 0;
  if (p.first_funding_ts && p.first_trade_ts) {
    const days = (p.first_trade_ts.getTime() - p.first_funding_ts.getTime()) / 86_400_000;
    if (days < 1) e1 = 1.0;
    else if (days < 7) e1 = 0.9;
    else if (days < 30) e1 = 0.6;
    else if (days < 180) e1 = 0.3;
    else e1 = 0.1;
  }

  // E2: trade size — use MAX of (biggest single trade, total in market / 5).
  // Why: a $30k position built in one fill scores the same as one built in 6 × $5k fills.
  // Insiders often split a big bet into multiple smaller fills.
  let e2 = 0;
  const sizeBasis = Math.max(p.biggest_single_trade_usdc, p.market_usdc / 5);
  if (sizeBasis >= 50_000) e2 = 1.0;
  else if (sizeBasis >= 10_000) e2 = 0.8;
  else if (sizeBasis >= 5_000) e2 = 0.6;
  else if (sizeBasis >= 1_000) e2 = 0.4;
  else if (sizeBasis >= 100) e2 = 0.2;

  // E3: entry timing (hours before market resolution at FIRST trade in this market).
  // Insiders bet "close to market end" — but "close" varies by event:
  //   - Election day market: insider bets hours before, resolution within 24h
  //   - Year-in-Search market: insider bets weeks before, resolution at year-end
  // We give substantial credit at all timeframes within 90 days, peaking <72h.
  let e3 = 0;
  if (p.first_trade_ts && p.end_date) {
    const hoursBefore = (p.end_date.getTime() - p.first_trade_ts.getTime()) / 3_600_000;
    if (hoursBefore < 0) e3 = 0; // traded after resolution
    else if (hoursBefore < 24) e3 = 1.0;
    else if (hoursBefore < 72) e3 = 0.9;
    else if (hoursBefore < 168) e3 = 0.7;  // <1 week
    else if (hoursBefore < 720) e3 = 0.5;  // <1 month
    else if (hoursBefore < 2160) e3 = 0.3; // <3 months
    else e3 = 0.1;
  }

  // E4: total $ in this market (concentration of conviction).
  let e4 = 0;
  if (p.market_usdc >= 100_000) e4 = 1.0;
  else if (p.market_usdc >= 25_000) e4 = 0.8;
  else if (p.market_usdc >= 5_000) e4 = 0.5;
  else if (p.market_usdc >= 1_000) e4 = 0.3;
  else if (p.market_usdc >= 100) e4 = 0.1;

  // Per-pair composite: weighted blend.
  //   - avg of all 4: penalizes weakness on any one
  //   - top-3-of-4 avg: rewards 3-strong-1-weak insider patterns (e.g. Trump CZ
  //     who is fresh + concentrated + huge + WON but bet 3 months early)
  // Take MAX of the two so we don't punish 3-strong patterns.
  const all4Avg = (e1 + e2 + e3 + e4) / 4;
  const sorted = [e1, e2, e3, e4].sort((a, b) => b - a);
  const top3Avg = (sorted[0] + sorted[1] + sorted[2]) / 3;
  return Math.max(all4Avg, top3Avg) * 100;
}

// =============================================================================
// Win-rate p-value (T_winrate track)
// =============================================================================
//
// Binomial distribution: P(K wins or more out of N trades by chance, p_null = 0.5)
// Lower p-value = more anomalous. We convert to a 0-100 score via:
//   score_winrate = (1 - p_value) × 100  (capped at 95 — leaves room for big bets to dominate)
//
// We require N >= 5 resolved markets to avoid spurious significance.

function binomialPvalue(wins: number, trials: number, pNull = 0.5): number {
  // P(X >= wins | n=trials, p=pNull). Sum tail of binomial PMF.
  if (trials === 0) return 1.0;
  if (wins > trials) wins = trials;
  let sum = 0;
  for (let k = wins; k <= trials; k++) {
    sum += binomialPmf(k, trials, pNull);
  }
  return sum;
}

function binomialPmf(k: number, n: number, p: number): number {
  // n choose k * p^k * (1-p)^(n-k), via log-space to avoid overflow.
  if (k < 0 || k > n) return 0;
  let logP = 0;
  for (let i = 1; i <= k; i++) logP += Math.log(n - i + 1) - Math.log(i);
  logP += k * Math.log(p) + (n - k) * Math.log(1 - p);
  return Math.exp(logP);
}

// =============================================================================
// Aggregate per-pair scores into per-wallet score
// =============================================================================

type WalletScore = {
  wallet: string;
  score: number;
  /** Best per-pair score (T_event_max). */
  event_max: number;
  /** Token IDs ordered by per-pair score, descending. Top 3 only for output. */
  top_markets: Array<{ token_id: string; question: string; pair_score: number; market_usdc: number }>;
  /** Number of resolved manipulable markets. */
  resolved_n: number;
  /** Wins on those resolved markets. */
  resolved_wins: number;
  /** Win rate. */
  win_rate: number;
  /** Binomial p-value vs random baseline (0.5). */
  win_pvalue: number;
  /** Win-rate score component. */
  winrate_score: number;
  /** Number of distinct markets traded (manipulable strict). */
  n_markets: number;
  flagged: boolean;
  is_known_insider: boolean;
};

function aggregatePairsToWallet(pairs: PerPairRow[]): WalletScore[] {
  // Group by wallet
  const byWallet = new Map<string, PerPairRow[]>();
  for (const p of pairs) {
    const w = p.wallet.toLowerCase();
    if (!byWallet.has(w)) byWallet.set(w, []);
    byWallet.get(w)!.push(p);
  }

  const results: WalletScore[] = [];
  for (const [wallet, walletPairs] of byWallet) {
    // Score each pair, sort desc
    const scoredPairs = walletPairs
      .map((p) => ({ pair: p, score: scorePerPair(p) }))
      .sort((a, b) => b.score - a.score);

    const eventMax = scoredPairs[0]?.score ?? 0;

    // Win-rate computation on resolved pairs
    const resolved = walletPairs.filter((p) => p.is_winning_token !== null);
    const wins = resolved.filter((p) => p.is_winning_token === true).length;
    const n = resolved.length;
    const winRate = n > 0 ? wins / n : 0;
    const pValue = n >= 5 ? binomialPvalue(wins, n) : 1.0;
    let winrateScore = 0;
    if (n >= 5 && winRate >= 0.6) {
      // Penalize low N; reward high win rate + statistical significance.
      // Score = (1 - p_value) × 100, capped at 95.
      winrateScore = Math.min(95, (1 - pValue) * 100);
    }

    const finalScore = Math.max(eventMax, winrateScore);

    results.push({
      wallet,
      score: finalScore,
      event_max: eventMax,
      top_markets: scoredPairs.slice(0, 3).map((sp) => ({
        token_id: sp.pair.token_id,
        question: sp.pair.question ?? "(no question)",
        pair_score: sp.score,
        market_usdc: sp.pair.market_usdc,
      })),
      resolved_n: n,
      resolved_wins: wins,
      win_rate: winRate,
      win_pvalue: pValue,
      winrate_score: winrateScore,
      n_markets: walletPairs.length,
      flagged: finalScore >= FLAG_THRESHOLD,
      is_known_insider: KNOWN_INSIDER_ADDRESSES.has(wallet),
    });
  }

  return results;
}

// =============================================================================
// Persist
// =============================================================================

async function persistScores(scores: WalletScore[]): Promise<void> {
  // We reuse the wallet_scores table but overwrite. Map our new fields back:
  //   score → score
  //   event_max → signal_size (repurposed; documented)
  //   winrate_score → signal_concentration (repurposed)
  //   n_markets → n_manipulable_markets
  //   resolved_wins → n_trades (repurposed for visibility)
  //   resolved_n → n_markets (repurposed)
  //
  // Better: add new columns. We'll add them to schema for clean separation.
  await db.execute(sql`
    ALTER TABLE wallet_scores
      ADD COLUMN IF NOT EXISTS event_max NUMERIC(5,2),
      ADD COLUMN IF NOT EXISTS winrate_score NUMERIC(5,2),
      ADD COLUMN IF NOT EXISTS resolved_n INTEGER,
      ADD COLUMN IF NOT EXISTS resolved_wins INTEGER,
      ADD COLUMN IF NOT EXISTS win_rate NUMERIC(5,4),
      ADD COLUMN IF NOT EXISTS win_pvalue NUMERIC(10,8)
  `);

  // Bulk upsert
  console.log(`[score] persisting ${scores.length} wallet scores…`);
  const BATCH = 1000;
  for (let i = 0; i < scores.length; i += BATCH) {
    const chunk = scores.slice(i, i + BATCH);
    // Use raw SQL for simpler param binding
    const valuesSql = chunk
      .map((s) => {
        return `('${s.wallet}', ${s.score.toFixed(2)}, ${s.event_max.toFixed(2)}, ${s.winrate_score.toFixed(2)}, ${s.resolved_n}, ${s.resolved_wins}, ${s.win_rate.toFixed(4)}, ${s.win_pvalue.toFixed(8)}, ${s.n_markets}, ${s.flagged}, ${s.is_known_insider})`;
      })
      .join(",\n");

    await db.execute(sql.raw(`
      INSERT INTO wallet_scores (wallet, score, event_max, winrate_score, resolved_n, resolved_wins, win_rate, win_pvalue, n_markets, flagged, is_known_insider, computed_at, n_trades, n_manipulable_markets, signal_age, signal_diversity, signal_size, signal_timing, signal_concentration, signal_cashout, total_volume_usd, biggest_market_pct)
      VALUES ${chunk.map((s) => `('${s.wallet}', ${s.score.toFixed(2)}, ${s.event_max.toFixed(2)}, ${s.winrate_score.toFixed(2)}, ${s.resolved_n}, ${s.resolved_wins}, ${s.win_rate.toFixed(4)}, ${s.win_pvalue.toFixed(8)}, ${s.n_markets}, ${s.flagged}, ${s.is_known_insider}, NOW(), 0, ${s.n_markets}, 0, 0, 0, 0, 0, 0, 0, 0)`).join(",\n")}
      ON CONFLICT (wallet) DO UPDATE SET
        score = EXCLUDED.score,
        event_max = EXCLUDED.event_max,
        winrate_score = EXCLUDED.winrate_score,
        resolved_n = EXCLUDED.resolved_n,
        resolved_wins = EXCLUDED.resolved_wins,
        win_rate = EXCLUDED.win_rate,
        win_pvalue = EXCLUDED.win_pvalue,
        n_markets = EXCLUDED.n_markets,
        flagged = EXCLUDED.flagged,
        is_known_insider = EXCLUDED.is_known_insider,
        computed_at = NOW()
    `));
  }
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  console.log("[score] computing per-(wallet, market) aggregates from manipulable_strict markets…");
  const startedAt = Date.now();

  const pairs = await fetchPerPairAggregates();
  console.log(`[score] ${pairs.length} (wallet, market) pairs eligible for scoring`);

  if (pairs.length === 0) {
    console.log("[score] no pairs to score (manipulable_strict filter may be too tight). Check filter.");
    process.exit(0);
  }

  const scores = aggregatePairsToWallet(pairs);
  console.log(`[score] ${scores.length} wallets scored, ${scores.filter((s) => s.flagged).length} flagged at >=${FLAG_THRESHOLD}`);

  // Show known insiders' detail
  const knownScored = scores.filter((s) => s.is_known_insider).sort((a, b) => b.score - a.score);
  console.log("\n=== Known insiders (in window) ===");
  for (const s of knownScored) {
    console.log(`  ${s.wallet.slice(0, 10)}…  score=${s.score.toFixed(1)}  event_max=${s.event_max.toFixed(1)}  winrate_score=${s.winrate_score.toFixed(1)}  win_rate=${s.win_rate.toFixed(2)} (${s.resolved_wins}/${s.resolved_n})  n_markets=${s.n_markets}  flagged=${s.flagged}`);
    if (s.top_markets.length > 0) {
      console.log(`    top: ${s.top_markets[0].question?.slice(0, 70)} → score=${s.top_markets[0].pair_score.toFixed(1)} ($${Math.round(s.top_markets[0].market_usdc).toLocaleString()})`);
    }
  }

  await persistScores(scores);
  const elapsed = (Date.now() - startedAt) / 1000;
  console.log(`\n[score] DONE in ${elapsed.toFixed(1)}s`);
  process.exit(0);
}

main().catch((e) => {
  console.error("[score] FATAL:", e);
  process.exit(1);
});

/**
 * Drizzle ORM schema for Polymarket insider detection.
 * Six tables: trades, wallet_first_funding, markets, market_manipulability,
 * wallet_scores, indexer_state.
 *
 * See plan/03-database-schema.md for full design rationale.
 */

import {
  pgTable,
  bigserial,
  bigint,
  integer,
  text,
  timestamp,
  numeric,
  boolean,
  jsonb,
  index,
  uniqueIndex,
  primaryKey,
} from "drizzle-orm/pg-core";

// =============================================================================
// trades — every Polymarket V1 OrderFilled event
// =============================================================================
export const trades = pgTable(
  "trades",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    txHash: text("tx_hash").notNull(),
    logIndex: integer("log_index").notNull(),
    blockNumber: bigint("block_number", { mode: "bigint" }).notNull(),
    blockTimestamp: timestamp("block_timestamp", { withTimezone: true }).notNull(),
    orderHash: text("order_hash").notNull(),
    maker: text("maker").notNull(),
    taker: text("taker").notNull(),
    makerAssetId: text("maker_asset_id").notNull(),
    takerAssetId: text("taker_asset_id").notNull(),
    makerAmount: numeric("maker_amount", { precision: 78, scale: 0 }).notNull(),
    takerAmount: numeric("taker_amount", { precision: 78, scale: 0 }).notNull(),
    fee: numeric("fee", { precision: 78, scale: 0 }),
    side: text("side").notNull(), // 'BUY' | 'SELL'
    tokenId: text("token_id").notNull(), // non-zero asset id
    usdcAmount: numeric("usdc_amount", { precision: 20, scale: 6 }).notNull(),
    sharesAmount: numeric("shares_amount", { precision: 20, scale: 6 }).notNull(),
    price: numeric("price", { precision: 10, scale: 8 }).notNull(),
  },
  (table) => ({
    uniqueLog: uniqueIndex("trades_tx_log_unique").on(table.txHash, table.logIndex),
    makerIdx: index("trades_maker_idx").on(table.maker),
    takerIdx: index("trades_taker_idx").on(table.taker),
    tokenIdx: index("trades_token_idx").on(table.tokenId),
    tsIdx: index("trades_ts_idx").on(table.blockTimestamp),
  }),
);

// =============================================================================
// wallet_first_funding — first USDC.e ever received by a Polymarket-active wallet
// =============================================================================
export const walletFirstFunding = pgTable(
  "wallet_first_funding",
  {
    wallet: text("wallet").primaryKey(),
    txHash: text("tx_hash").notNull(),
    logIndex: integer("log_index").notNull(),
    blockNumber: bigint("block_number", { mode: "bigint" }).notNull(),
    blockTimestamp: timestamp("block_timestamp", { withTimezone: true }).notNull(),
    amount: numeric("amount", { precision: 20, scale: 6 }).notNull(),
    fundedBy: text("funded_by").notNull(),
  },
  (table) => ({
    tsIdx: index("wallet_funding_ts_idx").on(table.blockTimestamp),
  }),
);

// =============================================================================
// markets — Polymarket market metadata from Gamma API
// =============================================================================
export const markets = pgTable(
  "markets",
  {
    tokenId: text("token_id").primaryKey(),
    conditionId: text("condition_id"),
    question: text("question"),
    slug: text("slug"),
    endDate: timestamp("end_date", { withTimezone: true }),
    liquidity: numeric("liquidity", { precision: 20, scale: 2 }),
    volume: numeric("volume", { precision: 20, scale: 2 }),
    negRisk: boolean("neg_risk"),
    umaBond: numeric("uma_bond", { precision: 20, scale: 6 }),
    customLiveness: integer("custom_liveness"),
    description: text("description"),
    resolutionSource: text("resolution_source"),
    tags: text("tags").array(),
    outcomes: jsonb("outcomes"),
    outcomePrices: jsonb("outcome_prices"),
    bestAsk: numeric("best_ask", { precision: 10, scale: 6 }),
    bestBid: numeric("best_bid", { precision: 10, scale: 6 }),
    closed: boolean("closed"),
    enrichedAt: timestamp("enriched_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    negRiskIdx: index("markets_neg_risk_idx").on(table.negRisk),
    endDateIdx: index("markets_end_date_idx").on(table.endDate),
  }),
);

// =============================================================================
// market_manipulability — computed manipulability score per market (5-factor)
// =============================================================================
export const marketManipulability = pgTable(
  "market_manipulability",
  {
    tokenId: text("token_id").primaryKey().references(() => markets.tokenId),
    score: numeric("score", { precision: 5, scale: 2 }).notNull(),
    factorOutcomeMaker: numeric("factor_outcome_maker", { precision: 5, scale: 2 }),
    factorLiquidity: numeric("factor_liquidity", { precision: 5, scale: 2 }),
    factorTime: numeric("factor_time", { precision: 5, scale: 2 }),
    factorResolutionSource: numeric("factor_resolution_source", { precision: 5, scale: 2 }),
    factorLongshotCombo: numeric("factor_longshot_combo", { precision: 5, scale: 2 }),
    isManipulable: boolean("is_manipulable").notNull(),
    reasons: text("reasons").array(),
    computedAt: timestamp("computed_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    scoreIdx: index("manip_score_idx").on(table.score),
  }),
);

// =============================================================================
// wallet_scores — final output: insider score per wallet
// =============================================================================
export const walletScores = pgTable(
  "wallet_scores",
  {
    wallet: text("wallet").primaryKey(),
    score: numeric("score", { precision: 5, scale: 2 }).notNull(),
    signalAge: numeric("signal_age", { precision: 3, scale: 2 }),
    signalDiversity: numeric("signal_diversity", { precision: 3, scale: 2 }),
    signalSize: numeric("signal_size", { precision: 3, scale: 2 }),
    signalTiming: numeric("signal_timing", { precision: 3, scale: 2 }),
    signalConcentration: numeric("signal_concentration", { precision: 3, scale: 2 }),
    signalCashout: numeric("signal_cashout", { precision: 3, scale: 2 }),
    nTrades: integer("n_trades"),
    nMarkets: integer("n_markets"),
    nManipulableMarkets: integer("n_manipulable_markets"),
    totalVolumeUsd: numeric("total_volume_usd", { precision: 20, scale: 2 }),
    biggestMarketPct: numeric("biggest_market_pct", { precision: 5, scale: 4 }),
    flagged: boolean("flagged"),
    isKnownInsider: boolean("is_known_insider"),
    computedAt: timestamp("computed_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    scoreIdx: index("wallet_score_idx").on(table.score),
  }),
);

// =============================================================================
// indexer_state — backfill resumability
// =============================================================================
export const indexerState = pgTable("indexer_state", {
  indexerName: text("indexer_name").primaryKey(),
  lastProcessedBlock: bigint("last_processed_block", { mode: "bigint" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

// =============================================================================
// Inferred types — use these throughout the app for type safety
// =============================================================================
export type Trade = typeof trades.$inferSelect;
export type NewTrade = typeof trades.$inferInsert;
export type WalletFunding = typeof walletFirstFunding.$inferSelect;
export type NewWalletFunding = typeof walletFirstFunding.$inferInsert;
export type Market = typeof markets.$inferSelect;
export type NewMarket = typeof markets.$inferInsert;
export type MarketManipulability = typeof marketManipulability.$inferSelect;
export type NewMarketManipulability = typeof marketManipulability.$inferInsert;
export type WalletScore = typeof walletScores.$inferSelect;
export type NewWalletScore = typeof walletScores.$inferInsert;
export type IndexerState = typeof indexerState.$inferSelect;

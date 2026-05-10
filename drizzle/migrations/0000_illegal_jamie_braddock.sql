CREATE TABLE "indexer_state" (
	"indexer_name" text PRIMARY KEY NOT NULL,
	"last_processed_block" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "market_manipulability" (
	"token_id" text PRIMARY KEY NOT NULL,
	"score" numeric(5, 2) NOT NULL,
	"factor_outcome_maker" numeric(5, 2),
	"factor_liquidity" numeric(5, 2),
	"factor_time" numeric(5, 2),
	"factor_resolution_source" numeric(5, 2),
	"factor_longshot_combo" numeric(5, 2),
	"is_manipulable" boolean NOT NULL,
	"reasons" text[],
	"computed_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "markets" (
	"token_id" text PRIMARY KEY NOT NULL,
	"condition_id" text,
	"question" text,
	"slug" text,
	"end_date" timestamp with time zone,
	"liquidity" numeric(20, 2),
	"volume" numeric(20, 2),
	"neg_risk" boolean,
	"uma_bond" numeric(20, 6),
	"custom_liveness" integer,
	"description" text,
	"resolution_source" text,
	"tags" text[],
	"outcomes" jsonb,
	"outcome_prices" jsonb,
	"best_ask" numeric(10, 6),
	"best_bid" numeric(10, 6),
	"closed" boolean,
	"enriched_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "trades" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"block_number" bigint NOT NULL,
	"block_timestamp" timestamp with time zone NOT NULL,
	"order_hash" text NOT NULL,
	"maker" text NOT NULL,
	"taker" text NOT NULL,
	"maker_asset_id" text NOT NULL,
	"taker_asset_id" text NOT NULL,
	"maker_amount" numeric(78, 0) NOT NULL,
	"taker_amount" numeric(78, 0) NOT NULL,
	"fee" numeric(78, 0),
	"side" text NOT NULL,
	"token_id" text NOT NULL,
	"usdc_amount" numeric(20, 6) NOT NULL,
	"shares_amount" numeric(20, 6) NOT NULL,
	"price" numeric(10, 8) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_first_funding" (
	"wallet" text PRIMARY KEY NOT NULL,
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"block_number" bigint NOT NULL,
	"block_timestamp" timestamp with time zone NOT NULL,
	"amount" numeric(20, 6) NOT NULL,
	"funded_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_scores" (
	"wallet" text PRIMARY KEY NOT NULL,
	"score" numeric(5, 2) NOT NULL,
	"signal_age" numeric(3, 2),
	"signal_diversity" numeric(3, 2),
	"signal_size" numeric(3, 2),
	"signal_timing" numeric(3, 2),
	"signal_concentration" numeric(3, 2),
	"signal_cashout" numeric(3, 2),
	"n_trades" integer,
	"n_markets" integer,
	"n_manipulable_markets" integer,
	"total_volume_usd" numeric(20, 2),
	"biggest_market_pct" numeric(5, 4),
	"flagged" boolean,
	"is_known_insider" boolean,
	"computed_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "market_manipulability" ADD CONSTRAINT "market_manipulability_token_id_markets_token_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."markets"("token_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "manip_score_idx" ON "market_manipulability" USING btree ("score");--> statement-breakpoint
CREATE INDEX "markets_neg_risk_idx" ON "markets" USING btree ("neg_risk");--> statement-breakpoint
CREATE INDEX "markets_end_date_idx" ON "markets" USING btree ("end_date");--> statement-breakpoint
CREATE UNIQUE INDEX "trades_tx_log_unique" ON "trades" USING btree ("tx_hash","log_index");--> statement-breakpoint
CREATE INDEX "trades_maker_idx" ON "trades" USING btree ("maker");--> statement-breakpoint
CREATE INDEX "trades_taker_idx" ON "trades" USING btree ("taker");--> statement-breakpoint
CREATE INDEX "trades_token_idx" ON "trades" USING btree ("token_id");--> statement-breakpoint
CREATE INDEX "trades_ts_idx" ON "trades" USING btree ("block_timestamp");--> statement-breakpoint
CREATE INDEX "wallet_funding_ts_idx" ON "wallet_first_funding" USING btree ("block_timestamp");--> statement-breakpoint
CREATE INDEX "wallet_score_idx" ON "wallet_scores" USING btree ("score");
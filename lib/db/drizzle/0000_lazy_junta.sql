CREATE TABLE "market_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"asset_id" text NOT NULL,
	"asset_name" text NOT NULL,
	"asset_symbol" text NOT NULL,
	"predicted_direction" text NOT NULL,
	"predicted_magnitude" text NOT NULL,
	"predicted_confidence" text NOT NULL,
	"price_impact_estimate" text NOT NULL,
	"timeframe" text NOT NULL,
	"bull_score" numeric NOT NULL,
	"bear_score" numeric NOT NULL,
	"dominant_narrative" text NOT NULL,
	"verdict" text NOT NULL,
	"trigger_article_ids" text DEFAULT '[]' NOT NULL,
	"trigger_news_summary" text DEFAULT '' NOT NULL,
	"assumptions" text DEFAULT '' NOT NULL,
	"snapshot_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolve_after" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolution_direction" text,
	"real_price_at_snapshot" numeric,
	"real_price_at_resolution" numeric,
	"price_change_pct" numeric,
	"is_correct" boolean,
	"resolution_notes" text,
	"flip_reason" text,
	"lessons_learned" text,
	"regime_at_snapshot" text,
	"active_channels" text,
	"ensemble_votes" text,
	"uncertainty_flag" boolean DEFAULT false,
	"dominant_channel" text,
	"brier_score_contribution" real,
	"price_score" real,
	"flip_confirmed" boolean DEFAULT false,
	"tier3_evidence" text,
	"candle_trust_score" real,
	"candle_flags" text,
	"regime_age" integer,
	"channel_decay_summary" text,
	"max_pain_strike" numeric,
	"max_pain_distance_pct" real,
	"sgx_nifty_change_pct" real,
	"short_covering_signal" text
);
--> statement-breakpoint
CREATE TABLE "prediction_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"template_id" text NOT NULL,
	"cluster_id" text NOT NULL,
	"headline" text NOT NULL,
	"reasoning" text NOT NULL,
	"historical_precedent" text NOT NULL,
	"trigger_summary" text NOT NULL,
	"potential_outcomes" text NOT NULL,
	"confidence" text NOT NULL,
	"risk_level" text NOT NULL,
	"timeframe_text" text NOT NULL,
	"category" text NOT NULL,
	"countries" text NOT NULL,
	"leaders" text NOT NULL,
	"trigger_score" numeric NOT NULL,
	"trigger_article_ids" text NOT NULL,
	"snapshot_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolve_after" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"is_correct" boolean,
	"resolution_notes" text
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_subscriptions_endpoint_unique" UNIQUE("endpoint")
);
--> statement-breakpoint
CREATE TABLE "feed_registry" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"type" text NOT NULL,
	"credibility_tier" integer NOT NULL,
	"is_state_media" boolean DEFAULT false NOT NULL,
	"fetch_interval_seconds" integer NOT NULL,
	"parser" text NOT NULL,
	"quarantine_until" timestamp with time zone,
	"last_fetched_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "article_corroborations" (
	"id" text PRIMARY KEY NOT NULL,
	"primary_article_id" text NOT NULL,
	"corroborating_article_id" text NOT NULL,
	"similarity_score" real NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "raw_articles" (
	"id" text PRIMARY KEY NOT NULL,
	"feed_id" text NOT NULL,
	"url" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"credibility_tier" integer NOT NULL,
	"is_state_media" boolean DEFAULT false NOT NULL,
	"bias_flag" boolean DEFAULT false NOT NULL,
	"embedding" text,
	"dedup_status" text DEFAULT 'pending' NOT NULL,
	"corroboration_count" integer DEFAULT 0 NOT NULL,
	"requires_corroboration" boolean DEFAULT false NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "extracted_events" (
	"id" text PRIMARY KEY NOT NULL,
	"article_id" text NOT NULL,
	"actors" text NOT NULL,
	"action_type" text NOT NULL,
	"action_label" text NOT NULL,
	"target" text NOT NULL,
	"location" text NOT NULL,
	"event_date" text NOT NULL,
	"stated_intent" text NOT NULL,
	"requires_corroboration" boolean DEFAULT false NOT NULL,
	"is_hypothesis" boolean DEFAULT false NOT NULL,
	"confidence" real NOT NULL,
	"story_id" text,
	"extracted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "extraction_errors" (
	"id" text PRIMARY KEY NOT NULL,
	"article_id" text NOT NULL,
	"error_type" text NOT NULL,
	"error_message" text NOT NULL,
	"raw_response" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contradiction_queue" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id_a" text NOT NULL,
	"event_id_b" text NOT NULL,
	"actor_pair" text NOT NULL,
	"cameo_code_a" text NOT NULL,
	"cameo_code_b" text NOT NULL,
	"story_id" text,
	"resolution_status" text DEFAULT 'open' NOT NULL,
	"resolved_by" text,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "story_centroids" (
	"id" text PRIMARY KEY NOT NULL,
	"story_id" text NOT NULL,
	"week_start" timestamp with time zone NOT NULL,
	"centroid" text NOT NULL,
	"article_count" text NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prediction_v2" (
	"id" text PRIMARY KEY NOT NULL,
	"story_id" text NOT NULL,
	"analyst_report" text NOT NULL,
	"historian_precedents" text NOT NULL,
	"forecaster_tree" text NOT NULL,
	"devil_critique" text NOT NULL,
	"final_scenarios" text NOT NULL,
	"flags" text DEFAULT '[]' NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolve_after" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolution_status" text DEFAULT 'pending' NOT NULL,
	"resolved_scenario_index" integer,
	"outcome_description" text,
	"brier_score" real,
	"lessons_learned" text,
	"devil_was_right" text,
	"missed_channel" text,
	"dominant_channel" text,
	"brier_by_story_type" text,
	"brier_by_cameo_action" text,
	"brier_by_channel" text
);
--> statement-breakpoint
CREATE TABLE "market_regimes" (
	"id" text PRIMARY KEY NOT NULL,
	"asset_id" text NOT NULL,
	"regime" text NOT NULL,
	"risk_on_probability" real NOT NULL,
	"risk_off_probability" real NOT NULL,
	"crisis_probability" real NOT NULL,
	"vix_level" real,
	"vix_change_5d" real,
	"fii_net_flow_5d" real,
	"nifty_real_vol_10d" real,
	"inr_usd_change_5d" real,
	"features_json" text NOT NULL,
	"sequence_summary" text,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "flip_guards" (
	"id" text PRIMARY KEY NOT NULL,
	"asset_id" text NOT NULL,
	"pending_direction" text,
	"pending_count" integer DEFAULT 0 NOT NULL,
	"confirmed_direction" text DEFAULT 'uncertain' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "flip_guards_asset_id_unique" UNIQUE("asset_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"firebase_uid" text NOT NULL,
	"email" text NOT NULL,
	"display_name" text,
	"photo_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_firebase_uid_unique" UNIQUE("firebase_uid")
);
--> statement-breakpoint
CREATE TABLE "user_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"duration_ms" integer,
	"login_method" text NOT NULL,
	"ip_address" text,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "page_views" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"page_path" text NOT NULL,
	"entered_at" timestamp with time zone NOT NULL,
	"exited_at" timestamp with time zone,
	"duration_ms" integer,
	"referrer" text
);
--> statement-breakpoint
CREATE TABLE "app_opens" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_agent" text,
	"viewport_width" text,
	"viewport_height" text
);
--> statement-breakpoint
CREATE TABLE "broker_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"broker_name" text DEFAULT 'zerodha' NOT NULL,
	"api_key" text,
	"api_secret" text,
	"access_token" text,
	"refresh_token" text,
	"public_token" text,
	"expires_at" timestamp with time zone,
	"static_ip_registered" text,
	"is_active" boolean DEFAULT false NOT NULL,
	"auto_trade_enabled" boolean DEFAULT false NOT NULL,
	"max_risk_per_trade_pct" integer DEFAULT 2 NOT NULL,
	"default_product" text DEFAULT 'MIS' NOT NULL,
	"default_order_type" text DEFAULT 'MARKET' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "broker_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"broker_account_id" text NOT NULL,
	"kite_order_id" text NOT NULL,
	"variety" text NOT NULL,
	"exchange" text NOT NULL,
	"tradingsymbol" text NOT NULL,
	"transaction_type" text NOT NULL,
	"order_type" text NOT NULL,
	"product" text NOT NULL,
	"quantity" integer NOT NULL,
	"price" numeric,
	"trigger_price" numeric,
	"status" text NOT NULL,
	"status_message" text,
	"filled_qty" integer DEFAULT 0,
	"pending_qty" integer DEFAULT 0,
	"cancelled_qty" integer DEFAULT 0,
	"average_price" numeric,
	"disclosed_quantity" integer,
	"market_protection" numeric,
	"tag" text,
	"signal_snapshot_id" text,
	"placed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "broker_positions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"broker_account_id" text NOT NULL,
	"tradingsymbol" text NOT NULL,
	"exchange" text NOT NULL,
	"instrument_token" text,
	"product" text NOT NULL,
	"quantity" integer NOT NULL,
	"day_quantity" integer DEFAULT 0 NOT NULL,
	"average_price" numeric NOT NULL,
	"last_price" numeric,
	"close_price" numeric,
	"pnl" numeric,
	"m2m" numeric,
	"unrealised" numeric,
	"realised" numeric,
	"buy_quantity" integer,
	"buy_price" numeric,
	"sell_quantity" integer,
	"sell_price" numeric,
	"value" numeric,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "broker_holdings" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"broker_account_id" text NOT NULL,
	"tradingsymbol" text NOT NULL,
	"exchange" text NOT NULL,
	"instrument_token" text,
	"isin" text,
	"quantity" integer NOT NULL,
	"t1_quantity" integer DEFAULT 0,
	"average_price" numeric NOT NULL,
	"last_price" numeric,
	"close_price" numeric,
	"pnl" numeric,
	"day_change" numeric,
	"day_change_percentage" numeric,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signal_executions" (
	"id" text PRIMARY KEY NOT NULL,
	"signal_snapshot_id" text NOT NULL,
	"user_id" text NOT NULL,
	"broker_account_id" text NOT NULL,
	"broker_order_id" text NOT NULL,
	"asset_id" text NOT NULL,
	"asset_symbol" text NOT NULL,
	"direction" text NOT NULL,
	"quantity" integer NOT NULL,
	"entry_price" numeric,
	"exit_price" numeric,
	"realised_pnl" numeric,
	"status" text DEFAULT 'open' NOT NULL,
	"target_price" numeric,
	"stop_loss_price" numeric,
	"highest_price_reached" numeric,
	"trail_gap_pct" numeric,
	"exit_strategy" text,
	"product" text,
	"gtt_trigger_id" text,
	"exit_reason" text,
	"notes" text,
	"executed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "user_trade_preferences" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"asset_id" text NOT NULL,
	"asset_symbol" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"max_risk_per_trade_pct" integer,
	"default_product" text,
	"default_order_type" text,
	"custom_quantity" integer,
	"target_pct" numeric DEFAULT '1.2',
	"stop_loss_pct" numeric DEFAULT '2.0',
	"use_gtt_bracket" boolean DEFAULT true NOT NULL,
	"exit_strategy" text DEFAULT 'trailing_ratchet' NOT NULL,
	"trail_gap_pct" numeric DEFAULT '15',
	"min_confidence" text DEFAULT 'medium' NOT NULL,
	"only_intraday" boolean DEFAULT true NOT NULL,
	"use_options" boolean DEFAULT false NOT NULL,
	"max_capital_per_trade" numeric,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paper_trades" (
	"id" text PRIMARY KEY NOT NULL,
	"signal_snapshot_id" text,
	"asset_id" text NOT NULL,
	"asset_symbol" text NOT NULL,
	"direction" text NOT NULL,
	"signal" text NOT NULL,
	"strike" numeric,
	"quantity" integer NOT NULL,
	"entry_price" numeric NOT NULL,
	"exit_price" numeric,
	"realised_pnl" numeric,
	"status" text DEFAULT 'open' NOT NULL,
	"stop_loss_price" numeric,
	"highest_price_reached" numeric,
	"trail_gap_pct" numeric,
	"exit_strategy" text,
	"exit_reason" text,
	"notes" text,
	"capital_at_entry" numeric NOT NULL,
	"executed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "condor_positions" (
	"id" text PRIMARY KEY NOT NULL,
	"mode" text DEFAULT 'paper' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"spot_at_entry" numeric NOT NULL,
	"expiry_date" text NOT NULL,
	"direction_tilt" text DEFAULT 'neutral' NOT NULL,
	"legs_json" text NOT NULL,
	"net_premium" numeric NOT NULL,
	"max_loss" numeric NOT NULL,
	"max_profit" numeric NOT NULL,
	"lots" integer NOT NULL,
	"quantity" integer NOT NULL,
	"capital_at_entry" numeric NOT NULL,
	"margin_blocked" numeric,
	"realised_pnl" numeric,
	"exit_reason" text,
	"notes_json" text,
	"executed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "chain_metrics_archive" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"spot_price" numeric(12, 4) NOT NULL,
	"call_oi" numeric(20, 0) NOT NULL,
	"put_oi" numeric(20, 0) NOT NULL,
	"option_volume" numeric(20, 0) NOT NULL,
	"atm_iv" numeric(8, 4),
	"atm_gamma" numeric(12, 8),
	"pcr" numeric(8, 4),
	"max_pain_strike" numeric(12, 4),
	"tier3_d" numeric(8, 4),
	"tier3_p" numeric(8, 4),
	"spot_persistence" numeric(8, 4),
	"spot_net_pct" numeric(8, 4)
);
--> statement-breakpoint
CREATE TABLE "tick_archive" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"category" text NOT NULL,
	"token" integer NOT NULL,
	"tradingsymbol" text,
	"ltp" numeric(12, 4) NOT NULL,
	"oi" numeric(20, 0),
	"volume" numeric(20, 0),
	"prev_close" numeric(12, 4),
	"extra" jsonb
);

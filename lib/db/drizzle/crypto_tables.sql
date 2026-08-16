-- Crypto trading module — orders + positions tables
-- Additive: does not modify any existing NSE tables.

CREATE TABLE IF NOT EXISTS "crypto_orders" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "exchange" text NOT NULL DEFAULT 'binance',
  "exchange_order_id" text,
  "client_order_id" text NOT NULL,
  "symbol" text NOT NULL,
  "asset_id" text NOT NULL,
  "side" text NOT NULL,
  "type" text NOT NULL,
  "time_in_force" text NOT NULL DEFAULT 'GTC',
  "quantity" numeric NOT NULL,
  "price" numeric,
  "stop_price" numeric,
  "executed_qty" numeric DEFAULT '0',
  "avg_price" numeric,
  "status" text NOT NULL DEFAULT 'PENDING',
  "status_message" text,
  "reduce_only" boolean DEFAULT false,
  "leverage" integer DEFAULT 1,
  "market_type" text NOT NULL DEFAULT 'spot',
  "signal_snapshot_id" text,
  "is_paper_trade" boolean NOT NULL DEFAULT false,
  "placed_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "crypto_positions" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "exchange" text NOT NULL DEFAULT 'binance',
  "symbol" text NOT NULL,
  "asset_id" text NOT NULL,
  "side" text NOT NULL,
  "quantity" numeric NOT NULL,
  "entry_price" numeric NOT NULL,
  "mark_price" numeric,
  "unrealized_pnl" numeric,
  "realized_pnl" numeric,
  "leverage" integer DEFAULT 1,
  "margin_type" text NOT NULL DEFAULT 'ISOLATED',
  "liquidation_price" numeric,
  "is_paper_trade" boolean NOT NULL DEFAULT false,
  "signal_snapshot_id" text,
  "stop_loss_price" numeric,
  "take_profit_price" numeric,
  "trailing_stop_high" numeric,
  "status" text NOT NULL DEFAULT 'OPEN',
  "opened_at" timestamptz NOT NULL DEFAULT now(),
  "closed_at" timestamptz,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "crypto_orders_user_id_idx" ON "crypto_orders" ("user_id");
CREATE INDEX IF NOT EXISTS "crypto_orders_symbol_idx" ON "crypto_orders" ("symbol");
CREATE INDEX IF NOT EXISTS "crypto_orders_status_idx" ON "crypto_orders" ("status");
CREATE INDEX IF NOT EXISTS "crypto_orders_client_order_id_idx" ON "crypto_orders" ("client_order_id");

CREATE INDEX IF NOT EXISTS "crypto_positions_user_id_idx" ON "crypto_positions" ("user_id");
CREATE INDEX IF NOT EXISTS "crypto_positions_symbol_idx" ON "crypto_positions" ("symbol");
CREATE INDEX IF NOT EXISTS "crypto_positions_status_idx" ON "crypto_positions" ("status");

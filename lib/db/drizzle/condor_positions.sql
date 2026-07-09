-- Iron Condor positions table — additive, no changes to existing tables.
-- Apply on the EC2 server: psql "$DATABASE_URL" -f condor_positions.sql

CREATE TABLE IF NOT EXISTS "condor_positions" (
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

-- Add strategy_preference column to broker_accounts
ALTER TABLE "broker_accounts" ADD COLUMN IF NOT EXISTS "strategy_preference" text NOT NULL DEFAULT 'fno';

-- Add user_id column to condor_positions for per-user real condor tracking
ALTER TABLE "condor_positions" ADD COLUMN IF NOT EXISTS "user_id" text;

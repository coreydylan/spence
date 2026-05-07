-- Wave 7B Track B — ShopAgent reminder write log.
--
-- When a ShopAgent transitions into `active_today` via its alarm, it writes
-- a reminder row here. Notification surfaces (push / Reeve inbox / iOS
-- live activity) poll for `delivered = 0` rows and flip them to
-- `delivered = 1` after sending.
--
-- Idempotent: safe to apply on every deploy.

CREATE TABLE IF NOT EXISTS mise_shop_reminders (
    id TEXT PRIMARY KEY,                    -- ulid-ish
    shop_run_id TEXT NOT NULL,
    plan_id TEXT NOT NULL,
    run_date TEXT NOT NULL,                 -- YYYY-MM-DD the shop should happen
    fired_at_ms INTEGER NOT NULL,           -- when the agent flipped to active_today
    payload_json TEXT,                      -- captured shop run summary at fire time
    delivered INTEGER NOT NULL DEFAULT 0,
    delivered_at_ms INTEGER,
    delivery_channel TEXT,                  -- 'push' | 'reeve' | 'ios_live' | NULL
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_shop_reminders_unique
    ON mise_shop_reminders(shop_run_id, run_date);

CREATE INDEX IF NOT EXISTS idx_shop_reminders_undelivered
    ON mise_shop_reminders(delivered, fired_at_ms ASC);

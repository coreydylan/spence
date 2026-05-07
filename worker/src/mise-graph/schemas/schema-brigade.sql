-- Wave 8 foundation — D1 brigade schema.
--
-- Three new tables that complement the existing mise_cook_sessions row
-- written by the MealAgent active_cook handler:
--   * mise_cook_sessions extension columns (ALTER TABLE ADD ...) for the
--     Wave 8 lifecycle. We don't write a separate table — the foundation
--     keeps all cook-session metadata co-located.
--   * mise_brigade_events — append-only event log for replay/debug.
--   * mise_brigade_pending_tokens — short-lived single-use WS auth tokens.
--
-- All tables are `CREATE TABLE IF NOT EXISTS` to keep the migration step
-- idempotent.

-- The mise_cook_sessions table already exists from Wave 7B Track A
-- (schema-cook-sessions.sql / d1-schemas.ts). The Wave 8 foundation does
-- NOT alter that table — instead the brigade-specific lifecycle is
-- captured in mise_brigade_events. Wave 8B may need to add columns; if
-- so, do it via a NEW migration step in admin-migrate-brigade.

CREATE TABLE IF NOT EXISTS mise_brigade_events (
    id TEXT PRIMARY KEY,
    cook_session_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    member_id TEXT,
    payload_json TEXT,
    emitted_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_brigade_events_session
    ON mise_brigade_events(cook_session_id, emitted_at_ms ASC);

CREATE INDEX IF NOT EXISTS ix_brigade_events_kind
    ON mise_brigade_events(kind, emitted_at_ms DESC);

CREATE TABLE IF NOT EXISTS mise_brigade_pending_tokens (
    token TEXT PRIMARY KEY,
    cook_session_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    expires_at_ms INTEGER NOT NULL,
    consumed_at_ms INTEGER,
    created_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_brigade_tokens_session
    ON mise_brigade_pending_tokens(cook_session_id, created_at_ms DESC);

CREATE INDEX IF NOT EXISTS ix_brigade_tokens_unconsumed
    ON mise_brigade_pending_tokens(member_id, expires_at_ms DESC)
    WHERE consumed_at_ms IS NULL;

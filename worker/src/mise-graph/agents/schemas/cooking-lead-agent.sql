-- Wave 8 foundation + Wave 8B Track B — CookingLeadAgent embedded SQLite schema.
--
-- Per-DO storage. Survives hibernation. Wave 8 foundation defined the
-- baseline tables; Wave 8B Track B extends `task_assignments` with
-- iteration_note and `photo_uploads` with vision_pending + iteration_*.
--
-- DO embedded SQLite is per-instance volatile across DO migrations, so we
-- write the FINAL shape here with CREATE TABLE IF NOT EXISTS — no ALTER.
-- The DO's onStart() mirrors these statements; this file is the human
-- reference + d1-execute target for diffs.

CREATE TABLE IF NOT EXISTS ws_connections (
    connection_id TEXT PRIMARY KEY,
    member_id TEXT NOT NULL,
    joined_at_ms INTEGER NOT NULL,
    closed_at_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_brigade_ws_member
    ON ws_connections(member_id, joined_at_ms DESC);

-- task_assignments — Wave 8B Track B added `iteration_note` so vision
-- suggestions persist on the assignment row (separate from the embedded
-- event log). The note is human-readable, e.g.
-- "[wait] sear is too pale — let it go another 90s".
CREATE TABLE IF NOT EXISTS task_assignments (
    task_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    assigned_at_ms INTEGER NOT NULL,
    started_at_ms INTEGER,
    completed_at_ms INTEGER,
    outcome TEXT,
    iteration_note TEXT,
    PRIMARY KEY (task_id, member_id)
);

CREATE INDEX IF NOT EXISTS idx_brigade_assign_open
    ON task_assignments(member_id, assigned_at_ms DESC)
    WHERE completed_at_ms IS NULL;

CREATE TABLE IF NOT EXISTS lead_events (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    member_id TEXT,
    payload_json TEXT NOT NULL,
    emitted_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_brigade_events_at
    ON lead_events(emitted_at_ms ASC);

-- photo_uploads — Wave 8B Track B added vision_pending, iteration_action,
-- iteration_detail. mime/size_bytes captured at upload time for retrieval.
-- The image bytes are NOT stored here — they live in R2 keyed by `r2_key`.
CREATE TABLE IF NOT EXISTS photo_uploads (
    id TEXT PRIMARY KEY,
    member_id TEXT NOT NULL,
    task_id TEXT,
    r2_key TEXT,
    mime TEXT,
    size_bytes INTEGER,
    uploaded_at_ms INTEGER NOT NULL,
    vision_pending INTEGER NOT NULL DEFAULT 1,
    vision_response_json TEXT,
    vision_response_at_ms INTEGER,
    iteration_action TEXT,
    iteration_detail TEXT
);

CREATE INDEX IF NOT EXISTS idx_brigade_photos_at
    ON photo_uploads(uploaded_at_ms DESC);

CREATE INDEX IF NOT EXISTS idx_brigade_photos_pending
    ON photo_uploads(vision_pending, uploaded_at_ms DESC)
    WHERE vision_pending = 1;

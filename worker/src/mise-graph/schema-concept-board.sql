-- Concept board persistence — Wave 6 of the chef-of-staff agent loop.
--
-- The Phase-1 (inspiration) pass works by canvassing candidate dish concepts
-- before committing them to slots. The agent jots down 8–12 candidates that
-- match the week's theme/movement, then in Phase 2 (tetris fit) scores how
-- each candidate would slot into the calendar and picks the best 7.
--
-- Two tables back this:
--   * mise_plan_movements  — one articulated theme per plan
--   * mise_concept_board   — the sticky-notes-on-the-wall candidate cards
--
-- Both are scoped to plan_id; the agent can build them up across MCP turns.

CREATE TABLE IF NOT EXISTS mise_plan_movements (
    movement_id TEXT PRIMARY KEY,
    plan_id     TEXT NOT NULL,
    household_id TEXT,
    theme_text  TEXT NOT NULL,
    rationale   TEXT,
    created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_movements_plan
    ON mise_plan_movements(plan_id);

CREATE TABLE IF NOT EXISTS mise_concept_board (
    concept_id  TEXT PRIMARY KEY,
    plan_id     TEXT NOT NULL,
    movement_id TEXT,

    title       TEXT NOT NULL,
    format      TEXT,
    cuisine_json TEXT NOT NULL DEFAULT '[]',

    source_kind TEXT NOT NULL,
    source_ref  TEXT,

    raw_ingredients_json TEXT NOT NULL DEFAULT '[]',
    formula_ids_json     TEXT NOT NULL DEFAULT '[]',
    est_active_min       INTEGER,
    est_idle_min         INTEGER,

    rationale       TEXT,
    vibe_tags_json  TEXT DEFAULT '[]',

    status              TEXT NOT NULL DEFAULT 'candidate',
    committed_to_slot   TEXT,

    tetris_score                 REAL,
    tetris_score_breakdown_json  TEXT,

    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_concepts_plan
    ON mise_concept_board(plan_id, status);

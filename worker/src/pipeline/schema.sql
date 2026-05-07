-- Pipeline tracking tables (additions to existing D1 schema)

-- Per-recipe pipeline status
CREATE TABLE IF NOT EXISTS recipe_pipeline (
  recipe_id INTEGER PRIMARY KEY REFERENCES raw_recipes(id),
  stage TEXT NOT NULL DEFAULT 'ingested',
  parse_status TEXT DEFAULT 'pending',
  normalize_status TEXT DEFAULT 'pending',
  classify_status TEXT DEFAULT 'pending',
  composition TEXT,
  cluster_id INTEGER,
  canonical_title TEXT,
  error TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(recipe_id)
);

CREATE INDEX IF NOT EXISTS idx_pipeline_stage ON recipe_pipeline(stage);
CREATE INDEX IF NOT EXISTS idx_pipeline_cluster ON recipe_pipeline(cluster_id);

-- Batch processing jobs
CREATE TABLE IF NOT EXISTS pipeline_batches (
  id TEXT PRIMARY KEY,
  stage TEXT NOT NULL DEFAULT 'idle',
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  trigger TEXT,                    -- 'cron' | 'manual' | 'threshold'
  recipes_processed INTEGER DEFAULT 0,
  dishes_affected INTEGER DEFAULT 0,
  anthropic_batch_id TEXT,         -- Anthropic batch API ID
  cost_usd REAL DEFAULT 0,
  error TEXT,
  meta TEXT                        -- JSON: extra info
);

-- Canonical dish drafts (metadata — full JSON in R2)
CREATE TABLE IF NOT EXISTS canonical_drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  canonical_title TEXT NOT NULL UNIQUE,
  composition TEXT,
  cluster_id INTEGER,
  source_recipe_count INTEGER,
  step_count INTEGER,
  strategy_count INTEGER,
  component_count INTEGER,
  draft_model TEXT,                 -- 'claude-sonnet-4-6'
  draft_cost_usd REAL,
  draft_tokens_in INTEGER,
  draft_tokens_out INTEGER,
  r2_key TEXT,                     -- R2 object key for full drafted JSON
  status TEXT DEFAULT 'draft',     -- 'draft' | 'validated' | 'reviewed' | 'published'
  drafted_at TEXT NOT NULL DEFAULT (datetime('now')),
  published_at TEXT,
  version INTEGER DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_drafts_status ON canonical_drafts(status);
CREATE INDEX IF NOT EXISTS idx_drafts_composition ON canonical_drafts(composition);

-- Mise Graph module for Spence recipe-graph-db.
--
-- This layer sits on top of the existing culinary intelligence tables:
-- canonical_ingredients, ingredient_edges, canonical_dishes,
-- canonical_components, produce_profiles, regional_seasons, and the
-- technique graph tables. It models household cooking states, transitions,
-- prep stations, and weekly plan execution.

CREATE TABLE IF NOT EXISTS mise_ingredient_states (
  id TEXT PRIMARY KEY,
  canonical_ingredient_id INTEGER REFERENCES canonical_ingredients(id),
  produce_profile_id INTEGER REFERENCES produce_profiles(id),
  canonical_name TEXT NOT NULL,
  state_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  state_kind TEXT NOT NULL DEFAULT 'raw',
  component_type TEXT,
  default_storage TEXT,
  default_container TEXT,
  quality_window_hours INTEGER,
  active_window_hours INTEGER,
  prep_level TEXT DEFAULT 'household',
  source TEXT DEFAULT 'mise_graph',
  meta_json TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT,
  UNIQUE(canonical_name, state_name)
);

CREATE INDEX IF NOT EXISTS idx_mise_states_canonical_ingredient
  ON mise_ingredient_states(canonical_ingredient_id);

CREATE INDEX IF NOT EXISTS idx_mise_states_canonical_name
  ON mise_ingredient_states(canonical_name);

CREATE INDEX IF NOT EXISTS idx_mise_states_kind
  ON mise_ingredient_states(state_kind);

CREATE TABLE IF NOT EXISTS mise_edges (
  id TEXT PRIMARY KEY,
  from_state_id TEXT NOT NULL REFERENCES mise_ingredient_states(id),
  to_state_id TEXT NOT NULL REFERENCES mise_ingredient_states(id),
  edge_type TEXT NOT NULL,
  action_label TEXT,
  technique TEXT,
  equipment_json TEXT DEFAULT '[]',
  station_tags_json TEXT DEFAULT '[]',
  cuisine_grammars_json TEXT DEFAULT '[]',
  format_tags_json TEXT DEFAULT '[]',
  active_time_min INTEGER,
  idle_time_min INTEGER,
  lead_time_hours INTEGER,
  yield_ratio REAL,
  storage_effect TEXT,
  quality_window_hours INTEGER,
  difficulty TEXT,
  confidence REAL DEFAULT 0.5,
  source TEXT DEFAULT 'mise_graph',
  rationale TEXT,
  meta_json TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT,
  UNIQUE(from_state_id, to_state_id, edge_type, action_label)
);

CREATE INDEX IF NOT EXISTS idx_mise_edges_from
  ON mise_edges(from_state_id);

CREATE INDEX IF NOT EXISTS idx_mise_edges_to
  ON mise_edges(to_state_id);

CREATE INDEX IF NOT EXISTS idx_mise_edges_type
  ON mise_edges(edge_type);

CREATE INDEX IF NOT EXISTS idx_mise_edges_technique
  ON mise_edges(technique);

CREATE TABLE IF NOT EXISTS mise_station_rules (
  id TEXT PRIMARY KEY,
  station_tag TEXT NOT NULL UNIQUE,
  station_name TEXT NOT NULL,
  trigger_kind TEXT NOT NULL,
  equipment_json TEXT DEFAULT '[]',
  cheap_branches_json TEXT DEFAULT '[]',
  default_questions_json TEXT DEFAULT '[]',
  source TEXT DEFAULT 'mise_graph',
  meta_json TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS mise_week_plans (
  id TEXT PRIMARY KEY,
  household_id TEXT,
  title TEXT,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  timezone TEXT,
  people INTEGER,
  constraints_json TEXT DEFAULT '{}',
  selected_ingredients_json TEXT DEFAULT '[]',
  source_recipe_ids_json TEXT DEFAULT '[]',
  status TEXT DEFAULT 'draft',
  plan_json TEXT NOT NULL,
  created_by TEXT DEFAULT 'mise_graph',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_mise_week_plans_dates
  ON mise_week_plans(start_date, end_date);

CREATE TABLE IF NOT EXISTS mise_plan_components (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES mise_week_plans(id) ON DELETE CASCADE,
  state_id TEXT REFERENCES mise_ingredient_states(id),
  label TEXT NOT NULL,
  quantity REAL,
  unit TEXT,
  storage TEXT,
  container TEXT,
  quality_window_hours INTEGER,
  planned_uses_json TEXT DEFAULT '[]',
  meta_json TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_mise_plan_components_plan
  ON mise_plan_components(plan_id);

CREATE TABLE IF NOT EXISTS mise_plan_tasks (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES mise_week_plans(id) ON DELETE CASCADE,
  scheduled_date TEXT NOT NULL,
  session_order INTEGER DEFAULT 0,
  task_type TEXT NOT NULL,
  title TEXT NOT NULL,
  station_tags_json TEXT DEFAULT '[]',
  equipment_json TEXT DEFAULT '[]',
  depends_on_json TEXT DEFAULT '[]',
  state_inputs_json TEXT DEFAULT '[]',
  state_outputs_json TEXT DEFAULT '[]',
  active_time_min INTEGER,
  idle_time_min INTEGER,
  instructions_json TEXT DEFAULT '[]',
  status TEXT DEFAULT 'planned',
  meta_json TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_mise_plan_tasks_plan_date
  ON mise_plan_tasks(plan_id, scheduled_date, session_order);

CREATE TABLE IF NOT EXISTS household_profiles (
  id TEXT PRIMARY KEY,
  display_name TEXT,
  people INTEGER,
  timezone TEXT,
  location_json TEXT DEFAULT '{}',
  diet_constraints_json TEXT DEFAULT '[]',
  equipment_json TEXT DEFAULT '[]',
  pantry_defaults_json TEXT DEFAULT '[]',
  meal_preferences_json TEXT DEFAULT '{}',
  schedule_defaults_json TEXT DEFAULT '{}',
  source TEXT DEFAULT 'mise_graph',
  meta_json TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_household_profiles_source
  ON household_profiles(source);

CREATE TABLE IF NOT EXISTS household_taste_priors (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES household_profiles(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL,
  target_id TEXT,
  target_name TEXT,
  weight REAL NOT NULL DEFAULT 0,
  evidence_source TEXT,
  evidence_count INTEGER DEFAULT 0,
  last_seen_at TEXT,
  confidence REAL DEFAULT 0.5,
  source TEXT DEFAULT 'mise_graph',
  meta_json TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_household_taste_priors_household
  ON household_taste_priors(household_id);

CREATE INDEX IF NOT EXISTS idx_household_taste_priors_target
  ON household_taste_priors(target_type, target_id, target_name);

CREATE TABLE IF NOT EXISTS household_inventory_snapshots (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES household_profiles(id) ON DELETE CASCADE,
  snapshot_date TEXT NOT NULL,
  item_name TEXT NOT NULL,
  canonical_ingredient_id INTEGER REFERENCES canonical_ingredients(id),
  state_id TEXT REFERENCES mise_ingredient_states(id),
  state_name TEXT,
  quantity REAL,
  unit TEXT,
  storage_location TEXT,
  expires_at TEXT,
  confidence REAL DEFAULT 0.5,
  source TEXT DEFAULT 'mise_graph',
  meta_json TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_household_inventory_household_date
  ON household_inventory_snapshots(household_id, snapshot_date);

CREATE INDEX IF NOT EXISTS idx_household_inventory_item
  ON household_inventory_snapshots(item_name);

CREATE INDEX IF NOT EXISTS idx_household_inventory_state
  ON household_inventory_snapshots(state_id);

CREATE TABLE IF NOT EXISTS mise_context_runs (
  id TEXT PRIMARY KEY,
  household_id TEXT REFERENCES household_profiles(id) ON DELETE SET NULL,
  plan_id TEXT REFERENCES mise_week_plans(id) ON DELETE SET NULL,
  run_date TEXT NOT NULL DEFAULT (datetime('now')),
  start_date TEXT,
  end_date TEXT,
  timezone TEXT,
  location_json TEXT DEFAULT '{}',
  inputs_json TEXT NOT NULL DEFAULT '{}',
  candidate_graph_json TEXT DEFAULT '{}',
  selected_graph_json TEXT DEFAULT '{}',
  model_notes_json TEXT DEFAULT '[]',
  status TEXT DEFAULT 'resolved',
  source TEXT DEFAULT 'mise_graph',
  meta_json TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_mise_context_runs_household_date
  ON mise_context_runs(household_id, run_date);

CREATE INDEX IF NOT EXISTS idx_mise_context_runs_plan
  ON mise_context_runs(plan_id);

CREATE TABLE IF NOT EXISTS mise_edge_scores (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES mise_context_runs(id) ON DELETE CASCADE,
  plan_id TEXT REFERENCES mise_week_plans(id) ON DELETE SET NULL,
  edge_id TEXT NOT NULL REFERENCES mise_edges(id) ON DELETE CASCADE,
  score_total REAL NOT NULL DEFAULT 0,
  score_breakdown_json TEXT NOT NULL DEFAULT '{}',
  activated INTEGER NOT NULL DEFAULT 0,
  rejection_reason TEXT,
  hard_filters_json TEXT DEFAULT '[]',
  soft_penalties_json TEXT DEFAULT '[]',
  source TEXT DEFAULT 'mise_graph',
  meta_json TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT,
  UNIQUE(run_id, edge_id)
);

CREATE INDEX IF NOT EXISTS idx_mise_edge_scores_run
  ON mise_edge_scores(run_id);

CREATE INDEX IF NOT EXISTS idx_mise_edge_scores_edge
  ON mise_edge_scores(edge_id);

CREATE INDEX IF NOT EXISTS idx_mise_edge_scores_plan
  ON mise_edge_scores(plan_id);

CREATE INDEX IF NOT EXISTS idx_mise_edge_scores_activated
  ON mise_edge_scores(activated, score_total);

CREATE TABLE IF NOT EXISTS mise_resource_lots (
  id TEXT PRIMARY KEY,
  plan_id TEXT REFERENCES mise_week_plans(id) ON DELETE CASCADE,
  household_id TEXT,
  label TEXT NOT NULL,
  resource_kind TEXT NOT NULL DEFAULT 'component',
  state_id TEXT REFERENCES mise_ingredient_states(id),
  source_component_id TEXT,
  source_event_id TEXT,
  quantity REAL,
  unit TEXT,
  storage TEXT,
  container TEXT,
  created_at_time TEXT,
  best_until TEXT,
  safe_until TEXT,
  confidence REAL DEFAULT 0.6,
  source TEXT DEFAULT 'projected',
  status TEXT DEFAULT 'available',
  meta_json TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_mise_resource_lots_plan
  ON mise_resource_lots(plan_id);

CREATE INDEX IF NOT EXISTS idx_mise_resource_lots_state
  ON mise_resource_lots(state_id);

CREATE INDEX IF NOT EXISTS idx_mise_resource_lots_status
  ON mise_resource_lots(status);

CREATE TABLE IF NOT EXISTS mise_plan_events (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES mise_week_plans(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  title TEXT NOT NULL,
  event_date TEXT,
  start_at TEXT,
  end_at TEXT,
  sort_order INTEGER DEFAULT 0,
  status TEXT DEFAULT 'planned',
  active_time_min INTEGER,
  idle_time_min INTEGER,
  parent_event_id TEXT,
  source_id TEXT,
  locked INTEGER DEFAULT 0,
  meta_json TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_mise_plan_events_plan_time
  ON mise_plan_events(plan_id, start_at, sort_order);

CREATE INDEX IF NOT EXISTS idx_mise_plan_events_type
  ON mise_plan_events(event_type);

CREATE TABLE IF NOT EXISTS mise_event_inputs (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES mise_week_plans(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES mise_plan_events(id) ON DELETE CASCADE,
  resource_lot_id TEXT REFERENCES mise_resource_lots(id) ON DELETE SET NULL,
  resource_ref TEXT,
  label TEXT,
  quantity REAL,
  unit TEXT,
  required INTEGER DEFAULT 1,
  role TEXT,
  meta_json TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_mise_event_inputs_plan_event
  ON mise_event_inputs(plan_id, event_id);

CREATE INDEX IF NOT EXISTS idx_mise_event_inputs_resource
  ON mise_event_inputs(resource_lot_id);

CREATE TABLE IF NOT EXISTS mise_event_outputs (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES mise_week_plans(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES mise_plan_events(id) ON DELETE CASCADE,
  resource_lot_id TEXT REFERENCES mise_resource_lots(id) ON DELETE SET NULL,
  resource_ref TEXT,
  label TEXT,
  quantity REAL,
  unit TEXT,
  role TEXT,
  meta_json TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_mise_event_outputs_plan_event
  ON mise_event_outputs(plan_id, event_id);

CREATE INDEX IF NOT EXISTS idx_mise_event_outputs_resource
  ON mise_event_outputs(resource_lot_id);

CREATE TABLE IF NOT EXISTS mise_resource_reservations (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES mise_week_plans(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES mise_plan_events(id) ON DELETE CASCADE,
  resource_lot_id TEXT REFERENCES mise_resource_lots(id) ON DELETE SET NULL,
  component_id TEXT,
  reservation_type TEXT DEFAULT 'hard',
  quantity REAL,
  unit TEXT,
  status TEXT DEFAULT 'reserved',
  meta_json TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_mise_resource_reservations_plan
  ON mise_resource_reservations(plan_id);

CREATE INDEX IF NOT EXISTS idx_mise_resource_reservations_resource
  ON mise_resource_reservations(resource_lot_id);

CREATE TABLE IF NOT EXISTS mise_validation_runs (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES mise_week_plans(id) ON DELETE CASCADE,
  run_kind TEXT DEFAULT 'ledger_validation',
  status TEXT DEFAULT 'completed',
  hard_error_count INTEGER DEFAULT 0,
  warning_count INTEGER DEFAULT 0,
  info_count INTEGER DEFAULT 0,
  meta_json TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_mise_validation_runs_plan
  ON mise_validation_runs(plan_id, created_at);

CREATE TABLE IF NOT EXISTS mise_validation_issues (
  id TEXT PRIMARY KEY,
  run_id TEXT REFERENCES mise_validation_runs(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL REFERENCES mise_week_plans(id) ON DELETE CASCADE,
  severity TEXT NOT NULL,
  issue_type TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT,
  event_id TEXT,
  resource_lot_id TEXT,
  component_id TEXT,
  repair_hint TEXT,
  meta_json TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_mise_validation_issues_plan
  ON mise_validation_issues(plan_id, severity, issue_type);

CREATE INDEX IF NOT EXISTS idx_mise_validation_issues_run
  ON mise_validation_issues(run_id);

CREATE TABLE IF NOT EXISTS mise_repair_runs (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES mise_week_plans(id) ON DELETE CASCADE,
  status TEXT DEFAULT 'completed',
  iteration_count INTEGER DEFAULT 0,
  before_hard_errors INTEGER DEFAULT 0,
  after_hard_errors INTEGER DEFAULT 0,
  before_warnings INTEGER DEFAULT 0,
  after_warnings INTEGER DEFAULT 0,
  actions_json TEXT DEFAULT '[]',
  meta_json TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_mise_repair_runs_plan
  ON mise_repair_runs(plan_id, created_at);

-- Unit conversion library, sourced from USDA SR28 (public domain) and supplemented
-- with hand-curated densities for ingredients USDA does not cover by volume.
CREATE TABLE IF NOT EXISTS mise_unit_conversions (
  canonical_name TEXT NOT NULL,
  unit TEXT NOT NULL,
  grams REAL NOT NULL,
  source TEXT DEFAULT 'usda_sr28',
  ndb_no TEXT,
  meta_json TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (canonical_name, unit)
);

CREATE INDEX IF NOT EXISTS idx_mise_unit_conversions_name
  ON mise_unit_conversions(canonical_name);

-- Component formulas: input ingredients (with qty/unit), batch yield,
-- shelf life, make-ahead windows. Used by the ledger compiler to populate
-- real resource quantities and shopping list quantities.
CREATE TABLE IF NOT EXISTS mise_formulas (
  id TEXT PRIMARY KEY,
  output_state_id TEXT REFERENCES mise_ingredient_states(id),
  output_label TEXT NOT NULL,
  output_canonical_name TEXT,
  batch_qty REAL,
  batch_unit TEXT,
  batch_grams REAL,
  serves INTEGER,
  yield_ratio REAL,
  inputs_json TEXT NOT NULL DEFAULT '[]',
  shelf_life_hours_fridge INTEGER,
  shelf_life_hours_pantry INTEGER,
  shelf_life_hours_freezer INTEGER,
  make_ahead_days_min INTEGER,
  make_ahead_days_max INTEGER,
  make_ahead_best_min INTEGER,
  make_ahead_best_max INTEGER,
  active_time_min INTEGER,
  idle_time_min INTEGER,
  equipment_json TEXT DEFAULT '[]',
  source TEXT DEFAULT 'mise_formulas_seed',
  meta_json TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_mise_formulas_state
  ON mise_formulas(output_state_id);

CREATE INDEX IF NOT EXISTS idx_mise_formulas_label
  ON mise_formulas(output_label);

CREATE INDEX IF NOT EXISTS idx_mise_formulas_canonical
  ON mise_formulas(output_canonical_name);

CREATE TABLE IF NOT EXISTS mise_audit_sessions (
  id TEXT PRIMARY KEY,
  household_id TEXT,
  plan_id TEXT REFERENCES mise_week_plans(id) ON DELETE CASCADE,
  kind TEXT DEFAULT 'user_initiated',
  status TEXT DEFAULT 'open',
  summary TEXT,
  observation_count INTEGER DEFAULT 0,
  meta_json TEXT DEFAULT '{}',
  opened_at TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_mise_audit_sessions_plan
  ON mise_audit_sessions(plan_id);

CREATE TABLE IF NOT EXISTS mise_resource_observations (
  id TEXT PRIMARY KEY,
  audit_session_id TEXT REFERENCES mise_audit_sessions(id) ON DELETE SET NULL,
  plan_id TEXT REFERENCES mise_week_plans(id) ON DELETE CASCADE,
  household_id TEXT,
  target_resource_lot_id TEXT,
  target_canonical_name TEXT,
  target_state_id TEXT,
  observation_kind TEXT NOT NULL,
  quantity REAL,
  unit TEXT,
  grams REAL,
  status TEXT DEFAULT 'observed',
  confidence REAL DEFAULT 0.95,
  source TEXT DEFAULT 'user_observation',
  text TEXT,
  meta_json TEXT DEFAULT '{}',
  observed_at TEXT NOT NULL DEFAULT (datetime('now')),
  applied_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_mise_resource_observations_plan
  ON mise_resource_observations(plan_id, observed_at);

CREATE INDEX IF NOT EXISTS idx_mise_resource_observations_canonical
  ON mise_resource_observations(target_canonical_name);

CREATE INDEX IF NOT EXISTS idx_mise_resource_observations_session
  ON mise_resource_observations(audit_session_id);

CREATE TABLE IF NOT EXISTS mise_plan_revisions (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES mise_week_plans(id) ON DELETE CASCADE,
  parent_revision_id TEXT,
  kind TEXT NOT NULL,
  summary TEXT,
  trigger_json TEXT DEFAULT '{}',
  before_summary_json TEXT DEFAULT '{}',
  after_summary_json TEXT DEFAULT '{}',
  diff_json TEXT DEFAULT '{}',
  applied INTEGER DEFAULT 1,
  meta_json TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_mise_plan_revisions_plan
  ON mise_plan_revisions(plan_id, created_at);

-- Personal recipe bank: user-loved recipes from Paprika exports, social
-- saves, URLs, screenshots. Provenance preserved. Composer uses these as
-- taste evidence and as cookable candidates for slot composition.
CREATE TABLE IF NOT EXISTS personal_recipes (
  id TEXT PRIMARY KEY,
  household_id TEXT,
  source_kind TEXT,           -- "paprika" | "url" | "instagram" | "manual" | "screenshot"
  source_url TEXT,
  source_app TEXT,
  author TEXT,
  original_title TEXT,
  normalized_title TEXT,
  cuisine_json TEXT DEFAULT '[]',
  format TEXT,                -- bowl | salad | tacos | pasta | flatbread | etc
  meal_slots_json TEXT DEFAULT '[]',
  canonical_ingredients_json TEXT DEFAULT '[]',  -- [{name, qty, unit, grams, role}]
  raw_ingredients_text TEXT,
  method_summary TEXT,
  active_time_min INTEGER,
  total_time_min INTEGER,
  servings INTEGER,
  flavor_tags_json TEXT DEFAULT '[]',  -- ["herby", "smoky", "citrusy", ...]
  household_rating INTEGER,   -- 1-5; null if unrated
  household_loved INTEGER DEFAULT 0,  -- 1 if user marked as a favorite
  cooked_count INTEGER DEFAULT 0,
  last_cooked_at TEXT,
  taste_vector_json TEXT,
  raw_snapshot_path TEXT,     -- R2 path for original
  parser_confidence REAL DEFAULT 0.6,
  meta_json TEXT DEFAULT '{}',
  imported_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_personal_recipes_household
  ON personal_recipes(household_id, household_loved DESC, last_cooked_at DESC);

CREATE INDEX IF NOT EXISTS idx_personal_recipes_format
  ON personal_recipes(format);

CREATE INDEX IF NOT EXISTS idx_personal_recipes_loved
  ON personal_recipes(household_loved, household_rating);

-- Recipe lineage: every composer-generated meal links back to the
-- canonical/personal/affinity sources that influenced it.
CREATE TABLE IF NOT EXISTS mise_recipe_lineage (
  id TEXT PRIMARY KEY,
  plan_id TEXT REFERENCES mise_week_plans(id) ON DELETE CASCADE,
  meal_id TEXT NOT NULL,
  source_kind TEXT NOT NULL,        -- "personal_recipe" | "canonical_dish" |
                                     -- "canonical_component" | "affinity" |
                                     -- "season" | "compound" | "household_pattern"
  source_id TEXT,
  source_title TEXT,
  influence TEXT,                    -- "format" | "flavor" | "method" | "seasonality" | etc.
  confidence REAL DEFAULT 0.7,
  meta_json TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_mise_recipe_lineage_meal
  ON mise_recipe_lineage(meal_id);

CREATE INDEX IF NOT EXISTS idx_mise_recipe_lineage_plan
  ON mise_recipe_lineage(plan_id);

-- Lock state on plan events: enables fluid up/down rippling. A grocery_trip
-- starts as "mutable" (composer can add items). When user marks it "in_flight"
-- (going shopping), no more items can be added — proposals must route to
-- the next mutable upstream event. Once "locked" (shopped/cooked/eaten),
-- it's immutable.
CREATE TABLE IF NOT EXISTS mise_event_locks (
  event_id TEXT PRIMARY KEY,
  plan_id TEXT REFERENCES mise_week_plans(id) ON DELETE CASCADE,
  lock_state TEXT NOT NULL DEFAULT 'mutable',
  -- "mutable" | "in_flight" | "locked" | "released"
  locked_at TEXT,
  locked_by TEXT,
  meta_json TEXT DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_mise_event_locks_plan
  ON mise_event_locks(plan_id, lock_state);

-- Proposals: the unit of fluid plan mutation. A proposal expresses a user
-- intent ("add a hummus party Friday for 8") and the system computes both
-- ripple_up (upstream changes — grocery, prep) and ripple_down (downstream —
-- leftovers, future meals). Persisted as a diff that can be applied,
-- rejected, or superseded. Every applied proposal becomes a revision.
CREATE TABLE IF NOT EXISTS mise_plan_proposals (
  id TEXT PRIMARY KEY,
  plan_id TEXT REFERENCES mise_week_plans(id) ON DELETE CASCADE,
  household_id TEXT,
  parent_revision_id TEXT,
  kind TEXT NOT NULL,
  -- "add_meal" | "replace_meal" | "remove_meal" | "shorten_cook" | "move_event"
  -- | "audit_response" | "compose_window" | "user_edit" | "rollforward"
  intent TEXT,
  status TEXT DEFAULT 'draft',
  -- "draft" | "applied" | "rejected" | "superseded"
  proposed_changes_json TEXT DEFAULT '{}',
  ripple_up_json TEXT DEFAULT '{}',
  ripple_down_json TEXT DEFAULT '{}',
  conflict_log_json TEXT DEFAULT '[]',
  meta_json TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  applied_at TEXT,
  rejected_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_mise_plan_proposals_plan
  ON mise_plan_proposals(plan_id, status, created_at);

-- Task graph storage — Wave 7B Track C.
--
-- A task graph is the mechanized form of a recipe: each step is decomposed
-- into one or more atomic TaskNodes with skill, equipment, duration, and
-- dependency metadata. The full TaskNode[] is serialized into tasks_json
-- (no relational explosion needed — graphs are read whole or not at all,
-- and the read side never queries individual task rows in SQL).
--
-- The unique index on meal_id is partial because a graph can be built
-- for a recipe in isolation (meal_id NULL) when we're previewing or
-- testing decomposition before assigning to a meal slot.

CREATE TABLE IF NOT EXISTS mise_task_graphs (
  id TEXT PRIMARY KEY,
  recipe_id TEXT NOT NULL,
  meal_id TEXT,
  tasks_json TEXT NOT NULL,
  critical_path_min INTEGER NOT NULL,
  total_active_min INTEGER NOT NULL,
  total_passive_min INTEGER NOT NULL,
  parallelism_max INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_task_graphs_meal
  ON mise_task_graphs(meal_id) WHERE meal_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_task_graphs_recipe
  ON mise_task_graphs(recipe_id);

-- Mise cuisine fusions + cross-cuisine flavor vibes.
--
-- The mise-graph composer needs grounding for fusion cuisines that have
-- their own established traditions ("Korean-Mexican", "Indo-Chinese",
-- "Nikkei Japanese-Peruvian", "Tex-Mex", "Creole") and for cross-cuisine
-- "vibes" — sauce/spice/method gestures that travel across cuisines and
-- have become common chef shorthand ("gochujang aioli", "miso butter on
-- anything", "preserved-lemon-everything", "chili-crisp on everything").
--
-- mise_cuisine_fusions encodes pairwise affinity between two cuisines
-- with example dishes and example components. is_canon = 1 means the
-- pair has fused into its own recognized cuisine (Tex-Mex, Indo-Chinese,
-- Nikkei, Vietnamese-French banh mi heritage, Chifa, etc.).
--
-- mise_flavor_vibes encodes named flavor gestures with their signature
-- ingredients, example dishes, and example components — a vocabulary the
-- composer can quote when pushing menus toward a vibe ("lean into
-- gochujang-aioli on Tuesday's burger night").
--
-- Loaded by cuisine-fusions.ts via loadCuisineFusions(env) and
-- loadFlavorVibes(env). Read-only at runtime; written only by the seed
-- routine seedCuisineFusions(db).

CREATE TABLE IF NOT EXISTS mise_cuisine_fusions (
  id TEXT PRIMARY KEY,
  cuisine_a TEXT NOT NULL,
  cuisine_b TEXT NOT NULL,
  fusion_label TEXT,                    -- "Korean-Mexican", "Indian-Chinese (Indo-Chinese)"
  affinity REAL,                        -- 0-1 strength
  is_canon INTEGER DEFAULT 0,           -- 1 = recognized as its own cuisine
  example_dishes TEXT DEFAULT '[]',     -- JSON
  example_components TEXT DEFAULT '[]', -- JSON: gochujang aioli, kimchi quesadilla, etc.
  notes TEXT,
  meta_json TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mise_cuisine_fusions_a ON mise_cuisine_fusions(cuisine_a);
CREATE INDEX IF NOT EXISTS idx_mise_cuisine_fusions_b ON mise_cuisine_fusions(cuisine_b);

CREATE TABLE IF NOT EXISTS mise_flavor_vibes (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,                     -- "gochujang-aioli", "smoky-citrus", "herby-creamy-acid"
  description TEXT,
  cross_cuisine_marker TEXT,               -- "Korean-Western fusion", "Mediterranean+Middle East", etc. — null if pure-cuisine
  signature_ingredients TEXT DEFAULT '[]', -- JSON: ["gochujang", "mayo", "rice vinegar"]
  example_dishes TEXT DEFAULT '[]',        -- JSON: ["gochujang-aioli burger", "Korean fried chicken sliders"]
  example_components TEXT DEFAULT '[]',    -- JSON: ["gochujang aioli", "gochujang-glazed mushroom"]
  vibe_kind TEXT,                          -- "sauce" | "spice" | "method" | "produce" | "umami" | "general"
  meta_json TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mise_flavor_vibes_label ON mise_flavor_vibes(label);

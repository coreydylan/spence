// Mise-graph formulas seed.
//
// Provides:
//   - mise_unit_conversions: ingredient density / volume-to-weight conversions
//     (USDA SR28 NDB numbers cited inline; public domain).
//   - mise_formulas: prototype household formulas with real input quantities,
//     batch yields, shelf life, and make-ahead windows.
//
// State IDs match worker/src/mise-graph/seed.ts (mise_state_<canonical>_<state>).

export interface MiseUnitConversionSeed {
	canonical_name: string;
	unit: string;
	grams: number;
	source?: string;
	ndb_no?: string;
}

export interface MiseFormulaInputSeed {
	canonical_name: string;
	role: "primary" | "fat" | "acid" | "season" | "sweet" | "liquid" | "leaven" | "herb" | "fruit" | "spice";
	required: boolean;
	qty: number;
	unit: string;
	grams: number;
	notes?: string;
}

export interface MiseFormulaSeed {
	id: string;
	output_state_id: string | null;
	output_label: string;
	output_canonical_name: string | null;
	batch_qty: number;
	batch_unit: string;
	batch_grams: number;
	serves?: number;
	yield_ratio?: number;
	inputs: MiseFormulaInputSeed[];
	shelf_life_hours_fridge?: number;
	shelf_life_hours_pantry?: number;
	shelf_life_hours_freezer?: number;
	make_ahead_days_min?: number;
	make_ahead_days_max?: number;
	make_ahead_best_min?: number;
	make_ahead_best_max?: number;
	active_time_min?: number;
	idle_time_min?: number;
	equipment?: string[];
	source?: string;
	notes?: string;
}

export const miseUnitConversionsSeed: MiseUnitConversionSeed[] = [
	// chickpea (dry) — USDA NDB 16056
	{ canonical_name: "chickpea", unit: "cup", grams: 200, ndb_no: "16056" },
	{ canonical_name: "chickpea", unit: "tbsp", grams: 12.5, ndb_no: "16056" },
	// chickpea (cooked) — USDA NDB 16057
	{ canonical_name: "cooked chickpea", unit: "cup", grams: 164, ndb_no: "16057" },
	// tahini (sesame butter) — USDA NDB 12166
	{ canonical_name: "tahini", unit: "tbsp", grams: 15, ndb_no: "12166" },
	{ canonical_name: "tahini", unit: "oz", grams: 28.35, ndb_no: "12166" },
	{ canonical_name: "tahini", unit: "cup", grams: 240, ndb_no: "12166", source: "computed_from_tbsp" },
	// olive oil — USDA NDB 04053
	{ canonical_name: "olive oil", unit: "tsp", grams: 4.5, ndb_no: "04053" },
	{ canonical_name: "olive oil", unit: "tbsp", grams: 13.5, ndb_no: "04053" },
	{ canonical_name: "olive oil", unit: "cup", grams: 216, ndb_no: "04053" },
	// lemon juice — USDA NDB 09152
	{ canonical_name: "lemon juice", unit: "cup", grams: 244, ndb_no: "09152" },
	{ canonical_name: "lemon juice", unit: "fl oz", grams: 30.5, ndb_no: "09152" },
	{ canonical_name: "lemon juice", unit: "tbsp", grams: 15.25, ndb_no: "09152", source: "computed_from_fl_oz" },
	{ canonical_name: "lemon juice", unit: "lemon", grams: 48, ndb_no: "09152" },
	// all-purpose flour — USDA NDB 20081
	{ canonical_name: "all-purpose flour", unit: "cup", grams: 125, ndb_no: "20081" },
	{ canonical_name: "all-purpose flour", unit: "tbsp", grams: 7.8, ndb_no: "20081", source: "computed_from_cup" },
	// parsley fresh — USDA NDB 11297
	{ canonical_name: "parsley", unit: "cup", grams: 60, ndb_no: "11297" },
	{ canonical_name: "parsley", unit: "tbsp", grams: 3.8, ndb_no: "11297" },
	{ canonical_name: "parsley", unit: "sprig", grams: 1, ndb_no: "11297" },
	// spearmint fresh — USDA NDB 02065
	{ canonical_name: "mint", unit: "tbsp", grams: 11.4, ndb_no: "02065" },
	{ canonical_name: "mint", unit: "leaf", grams: 0.3, ndb_no: "02065" },
	{ canonical_name: "mint", unit: "cup", grams: 90, ndb_no: "02065", source: "computed_from_tbsp" },
	// cilantro — USDA NDB 11165
	{ canonical_name: "cilantro", unit: "cup", grams: 16, ndb_no: "11165" },
	{ canonical_name: "cilantro", unit: "sprig", grams: 2.2, ndb_no: "11165" },
	// radish — USDA NDB 11429
	{ canonical_name: "radish", unit: "cup", grams: 116, ndb_no: "11429" },
	{ canonical_name: "radish", unit: "medium", grams: 4.5, ndb_no: "11429" },
	{ canonical_name: "radish", unit: "large", grams: 9, ndb_no: "11429" },
	// asparagus — USDA NDB 11011
	{ canonical_name: "asparagus", unit: "cup", grams: 134, ndb_no: "11011" },
	{ canonical_name: "asparagus", unit: "spear", grams: 16, ndb_no: "11011" },
	{ canonical_name: "asparagus", unit: "bunch", grams: 454, ndb_no: "11011", source: "estimated_1_lb" },
	// strawberry — USDA NDB 09316
	{ canonical_name: "strawberry", unit: "cup", grams: 144, ndb_no: "09316" },
	{ canonical_name: "strawberry", unit: "cup sliced", grams: 166, ndb_no: "09316" },
	{ canonical_name: "strawberry", unit: "medium", grams: 12, ndb_no: "09316" },
	{ canonical_name: "strawberry", unit: "pint", grams: 357, ndb_no: "09316" },
	// cucumber — USDA NDB 11205
	{ canonical_name: "cucumber", unit: "cup sliced", grams: 104, ndb_no: "11205", source: "computed_from_half_cup" },
	{ canonical_name: "cucumber", unit: "medium", grams: 301, ndb_no: "11205" },
	// garlic — USDA NDB 11215
	{ canonical_name: "garlic", unit: "cup", grams: 136, ndb_no: "11215" },
	{ canonical_name: "garlic", unit: "tsp", grams: 2.8, ndb_no: "11215" },
	{ canonical_name: "garlic", unit: "clove", grams: 3, ndb_no: "11215" },
	// rolled oats — USDA NDB 08120
	{ canonical_name: "rolled oats", unit: "cup", grams: 81, ndb_no: "08120" },
	// chia seeds — USDA NDB 12006 (only oz; cup density supplemented)
	{ canonical_name: "chia seed", unit: "oz", grams: 28.35, ndb_no: "12006" },
	{ canonical_name: "chia seed", unit: "tbsp", grams: 10.5, source: "supplemented_density" },
	{ canonical_name: "chia seed", unit: "cup", grams: 170, source: "supplemented_density" },
	// plain whole-milk yogurt — USDA NDB 01116
	{ canonical_name: "yogurt", unit: "cup", grams: 245, ndb_no: "01116" },
	{ canonical_name: "yogurt", unit: "tbsp", grams: 15.3, ndb_no: "01116", source: "computed_from_cup" },
	{ canonical_name: "yogurt", unit: "container", grams: 227, ndb_no: "01116", source: "8_oz" },
	// whole milk — USDA NDB 01077
	{ canonical_name: "milk", unit: "cup", grams: 244, ndb_no: "01077" },
	{ canonical_name: "milk", unit: "tbsp", grams: 15, ndb_no: "01077" },
	{ canonical_name: "milk", unit: "fl oz", grams: 30.5, ndb_no: "01077" },
	// salt — USDA NDB 02047
	{ canonical_name: "salt", unit: "tsp", grams: 6, ndb_no: "02047" },
	{ canonical_name: "salt", unit: "tbsp", grams: 18, ndb_no: "02047" },
	{ canonical_name: "salt", unit: "cup", grams: 292, ndb_no: "02047" },
	// granulated sugar — USDA NDB 19335
	{ canonical_name: "sugar", unit: "tsp", grams: 4.2, ndb_no: "19335" },
	{ canonical_name: "sugar", unit: "tbsp", grams: 12.5, ndb_no: "19335", source: "computed_from_cup" },
	{ canonical_name: "sugar", unit: "cup", grams: 200, ndb_no: "19335" },
	// water (standard density)
	{ canonical_name: "water", unit: "cup", grams: 237, source: "standard" },
	{ canonical_name: "water", unit: "tbsp", grams: 14.8, source: "standard" },
	{ canonical_name: "water", unit: "fl oz", grams: 29.6, source: "standard" },
	// vinegar (close to water density)
	{ canonical_name: "vinegar", unit: "cup", grams: 240, source: "standard" },
	{ canonical_name: "vinegar", unit: "tbsp", grams: 15, source: "standard" },
	// active dry yeast
	{ canonical_name: "yeast", unit: "tsp", grams: 3, source: "supplemented_density" },
	{ canonical_name: "yeast", unit: "tbsp", grams: 9, source: "supplemented_density" },
	{ canonical_name: "yeast", unit: "packet", grams: 7, source: "standard_packet" },
	// cumin (ground)
	{ canonical_name: "cumin", unit: "tsp", grams: 2.1, source: "supplemented_density" },
	{ canonical_name: "cumin", unit: "tbsp", grams: 6.3, source: "supplemented_density" },
	// honey / maple syrup (treated as sweetener density)
	{ canonical_name: "maple syrup", unit: "tbsp", grams: 20, source: "supplemented_density" },
	{ canonical_name: "maple syrup", unit: "cup", grams: 322, source: "supplemented_density" },
];

export const miseFormulasSeed: MiseFormulaSeed[] = [
	{
		id: "mise_formula_chickpea_cooked_whole",
		output_state_id: "mise_state_chickpea_cooked_whole",
		output_label: "Cooked Whole Chickpeas",
		output_canonical_name: "cooked chickpea",
		batch_qty: 600,
		batch_unit: "g",
		batch_grams: 600,
		serves: 4,
		yield_ratio: 2.4, // grams cooked / grams dry
		inputs: [
			{ canonical_name: "chickpea", role: "primary", required: true, qty: 1.25, unit: "cup", grams: 250, notes: "Dry chickpeas, soaked overnight or pressure-cooked." },
			{ canonical_name: "water", role: "liquid", required: true, qty: 4, unit: "cup", grams: 948, notes: "Cooking liquid; partially absorbed." },
			{ canonical_name: "salt", role: "season", required: true, qty: 1, unit: "tsp", grams: 6 },
		],
		shelf_life_hours_fridge: 96,
		shelf_life_hours_freezer: 720,
		make_ahead_days_min: 0,
		make_ahead_days_max: 4,
		make_ahead_best_min: 0,
		make_ahead_best_max: 3,
		active_time_min: 10,
		idle_time_min: 60,
		equipment: ["instant pot", "stock pot"],
	},
	{
		id: "mise_formula_chickpea_hummus",
		output_state_id: "mise_state_chickpea_hummus",
		output_label: "Hummus",
		output_canonical_name: "hummus",
		batch_qty: 500,
		batch_unit: "g",
		batch_grams: 500,
		serves: 6,
		yield_ratio: 0.97,
		inputs: [
			{ canonical_name: "cooked chickpea", role: "primary", required: true, qty: 2.5, unit: "cup", grams: 410 },
			{ canonical_name: "tahini", role: "fat", required: true, qty: 4, unit: "tbsp", grams: 60 },
			{ canonical_name: "lemon juice", role: "acid", required: true, qty: 2, unit: "tbsp", grams: 30 },
			{ canonical_name: "garlic", role: "season", required: true, qty: 2, unit: "clove", grams: 6 },
			{ canonical_name: "olive oil", role: "fat", required: true, qty: 2, unit: "tbsp", grams: 27 },
			{ canonical_name: "salt", role: "season", required: true, qty: 1, unit: "tsp", grams: 6 },
			{ canonical_name: "water", role: "liquid", required: false, qty: 2, unit: "tbsp", grams: 30, notes: "Adjust for texture." },
		],
		shelf_life_hours_fridge: 96,
		make_ahead_days_min: 0,
		make_ahead_days_max: 4,
		make_ahead_best_min: 0,
		make_ahead_best_max: 3,
		active_time_min: 12,
		idle_time_min: 0,
		equipment: ["food processor"],
	},
	{
		id: "mise_formula_tahini_lemon_sauce",
		output_state_id: "mise_state_tahini_lemon_sauce",
		output_label: "Lemon Tahini Sauce",
		output_canonical_name: "lemon tahini sauce",
		batch_qty: 260,
		batch_unit: "g",
		batch_grams: 260,
		serves: 8,
		yield_ratio: 0.95,
		inputs: [
			{ canonical_name: "tahini", role: "primary", required: true, qty: 6, unit: "tbsp", grams: 90 },
			{ canonical_name: "lemon juice", role: "acid", required: true, qty: 4, unit: "tbsp", grams: 60 },
			{ canonical_name: "water", role: "liquid", required: true, qty: 6, unit: "tbsp", grams: 90, notes: "Whisk in slowly until creamy." },
			{ canonical_name: "garlic", role: "season", required: true, qty: 1, unit: "clove", grams: 3 },
			{ canonical_name: "salt", role: "season", required: true, qty: 0.5, unit: "tsp", grams: 3 },
			{ canonical_name: "olive oil", role: "fat", required: false, qty: 1, unit: "tbsp", grams: 14 },
		],
		shelf_life_hours_fridge: 120,
		make_ahead_days_min: 0,
		make_ahead_days_max: 5,
		make_ahead_best_min: 0,
		make_ahead_best_max: 3,
		active_time_min: 8,
		idle_time_min: 0,
		equipment: ["jar", "whisk"],
	},
	{
		id: "mise_formula_chickpea_crispy",
		output_state_id: "mise_state_chickpea_crispy",
		output_label: "Crispy Chickpeas",
		output_canonical_name: "crispy chickpea",
		batch_qty: 250,
		batch_unit: "g",
		batch_grams: 250,
		serves: 4,
		yield_ratio: 0.81, // dries down during roast
		inputs: [
			{ canonical_name: "cooked chickpea", role: "primary", required: true, qty: 1.8, unit: "cup", grams: 295 },
			{ canonical_name: "olive oil", role: "fat", required: true, qty: 1, unit: "tbsp", grams: 14 },
			{ canonical_name: "salt", role: "season", required: true, qty: 0.5, unit: "tsp", grams: 3 },
			{ canonical_name: "cumin", role: "spice", required: false, qty: 1, unit: "tsp", grams: 2.1 },
		],
		shelf_life_hours_fridge: 72,
		shelf_life_hours_pantry: 24,
		make_ahead_days_min: 0,
		make_ahead_days_max: 2,
		make_ahead_best_min: 0,
		make_ahead_best_max: 1,
		active_time_min: 8,
		idle_time_min: 25,
		equipment: ["sheet pan", "oven"],
		notes: "Best within 24 hours; loses crispness fast in fridge.",
	},
	{
		id: "mise_formula_chickpea_falafel_mix",
		output_state_id: "mise_state_chickpea_falafel_mix",
		output_label: "Falafel Mix",
		output_canonical_name: "falafel mix",
		batch_qty: 567,
		batch_unit: "g",
		batch_grams: 567,
		serves: 4,
		yield_ratio: 1.0,
		inputs: [
			{ canonical_name: "chickpea", role: "primary", required: true, qty: 1, unit: "cup", grams: 200, notes: "Soaked overnight, NOT cooked. Drained." },
			{ canonical_name: "parsley", role: "herb", required: true, qty: 0.5, unit: "cup", grams: 30 },
			{ canonical_name: "cilantro", role: "herb", required: true, qty: 1, unit: "cup", grams: 16 },
			{ canonical_name: "garlic", role: "season", required: true, qty: 3, unit: "clove", grams: 9 },
			{ canonical_name: "cumin", role: "spice", required: true, qty: 2, unit: "tsp", grams: 4.2 },
			{ canonical_name: "salt", role: "season", required: true, qty: 1.5, unit: "tsp", grams: 9 },
		],
		shelf_life_hours_fridge: 24,
		shelf_life_hours_freezer: 720,
		make_ahead_days_min: 0,
		make_ahead_days_max: 1,
		make_ahead_best_min: 0,
		make_ahead_best_max: 1,
		active_time_min: 20,
		idle_time_min: 30,
		equipment: ["food processor"],
	},
	{
		id: "mise_formula_radish_quick_pickle",
		output_state_id: "mise_state_radish_quick_pickle",
		output_label: "Quick Pickled Radishes",
		output_canonical_name: "quick pickled radish",
		batch_qty: 1, // 1 jar
		batch_unit: "jar",
		batch_grams: 460, // 200g radish + brine
		serves: 6,
		yield_ratio: 1.0,
		inputs: [
			{ canonical_name: "radish", role: "primary", required: true, qty: 1.7, unit: "cup", grams: 200, notes: "Sliced thin." },
			{ canonical_name: "vinegar", role: "acid", required: true, qty: 0.5, unit: "cup", grams: 120 },
			{ canonical_name: "water", role: "liquid", required: true, qty: 0.5, unit: "cup", grams: 119 },
			{ canonical_name: "sugar", role: "sweet", required: true, qty: 2, unit: "tsp", grams: 8.4 },
			{ canonical_name: "salt", role: "season", required: true, qty: 1, unit: "tsp", grams: 6 },
		],
		shelf_life_hours_fridge: 168,
		make_ahead_days_min: 0,
		make_ahead_days_max: 7,
		make_ahead_best_min: 1,
		make_ahead_best_max: 4,
		active_time_min: 10,
		idle_time_min: 30,
		equipment: ["jar", "mandoline"],
	},
	{
		id: "mise_formula_dough_cold_fermented",
		output_state_id: "mise_state_dough_cold_fermented",
		output_label: "Cold-Fermented Dough",
		output_canonical_name: "fermented dough",
		batch_qty: 688,
		batch_unit: "g",
		batch_grams: 688,
		serves: 4, // 4 pita-size or 2 pizzas
		yield_ratio: 1.0,
		inputs: [
			{ canonical_name: "all-purpose flour", role: "primary", required: true, qty: 3.2, unit: "cup", grams: 400 },
			{ canonical_name: "water", role: "liquid", required: true, qty: 1.1, unit: "cup", grams: 260, notes: "65% hydration." },
			{ canonical_name: "yeast", role: "leaven", required: true, qty: 2, unit: "tsp", grams: 6 },
			{ canonical_name: "salt", role: "season", required: true, qty: 1.5, unit: "tsp", grams: 9 },
			{ canonical_name: "olive oil", role: "fat", required: true, qty: 1, unit: "tbsp", grams: 14 },
		],
		shelf_life_hours_fridge: 96,
		shelf_life_hours_freezer: 720,
		make_ahead_days_min: 1,
		make_ahead_days_max: 4,
		make_ahead_best_min: 2,
		make_ahead_best_max: 3,
		active_time_min: 20,
		idle_time_min: 2880, // 48h cold ferment
		equipment: ["mixing bowl", "scale"],
		notes: "Cold ferment 48-72h for best flavor and structure.",
	},
	{
		id: "mise_formula_chia_pudding",
		output_state_id: null, // no state seeded yet
		output_label: "Chia Pudding",
		output_canonical_name: "chia pudding",
		batch_qty: 498,
		batch_unit: "g",
		batch_grams: 498,
		serves: 2,
		yield_ratio: 1.0,
		inputs: [
			{ canonical_name: "chia seed", role: "primary", required: true, qty: 5, unit: "tbsp", grams: 52 },
			{ canonical_name: "milk", role: "liquid", required: true, qty: 1.5, unit: "cup", grams: 366 },
			{ canonical_name: "maple syrup", role: "sweet", required: true, qty: 1, unit: "tbsp", grams: 20 },
			{ canonical_name: "strawberry", role: "fruit", required: false, qty: 0.5, unit: "cup sliced", grams: 60 },
		],
		shelf_life_hours_fridge: 96,
		make_ahead_days_min: 0,
		make_ahead_days_max: 4,
		make_ahead_best_min: 0,
		make_ahead_best_max: 3,
		active_time_min: 5,
		idle_time_min: 240, // 4h to set
		equipment: ["jar"],
		notes: "Needs 4h minimum to set; best within 3 days.",
	},
	{
		id: "mise_formula_overnight_oats",
		output_state_id: null,
		output_label: "Overnight Oats",
		output_canonical_name: "overnight oats",
		batch_qty: 558,
		batch_unit: "g",
		batch_grams: 558,
		serves: 2,
		yield_ratio: 1.0,
		inputs: [
			{ canonical_name: "rolled oats", role: "primary", required: true, qty: 1, unit: "cup", grams: 81 },
			{ canonical_name: "milk", role: "liquid", required: true, qty: 1, unit: "cup", grams: 244 },
			{ canonical_name: "yogurt", role: "fat", required: false, qty: 0.5, unit: "cup", grams: 122 },
			{ canonical_name: "chia seed", role: "primary", required: false, qty: 1.5, unit: "tbsp", grams: 16 },
			{ canonical_name: "maple syrup", role: "sweet", required: false, qty: 1, unit: "tbsp", grams: 20 },
			{ canonical_name: "strawberry", role: "fruit", required: false, qty: 0.5, unit: "cup sliced", grams: 80 },
		],
		shelf_life_hours_fridge: 72,
		make_ahead_days_min: 0,
		make_ahead_days_max: 3,
		make_ahead_best_min: 0,
		make_ahead_best_max: 2,
		active_time_min: 5,
		idle_time_min: 480, // overnight
		equipment: ["jar"],
		notes: "Mix night before; portions hold best 1-2 days.",
	},
	{
		id: "mise_formula_yogurt_herb_sauce",
		output_state_id: "mise_state_yogurt_herb_sauce",
		output_label: "Herb Yogurt Sauce",
		output_canonical_name: "herb yogurt",
		batch_qty: 301,
		batch_unit: "g",
		batch_grams: 301,
		serves: 6,
		yield_ratio: 1.0,
		inputs: [
			{ canonical_name: "yogurt", role: "primary", required: true, qty: 1, unit: "cup", grams: 245 },
			{ canonical_name: "parsley", role: "herb", required: true, qty: 0.25, unit: "cup", grams: 15 },
			{ canonical_name: "mint", role: "herb", required: false, qty: 1.5, unit: "tbsp", grams: 17 },
			{ canonical_name: "garlic", role: "season", required: true, qty: 1, unit: "clove", grams: 3 },
			{ canonical_name: "lemon juice", role: "acid", required: true, qty: 1, unit: "tbsp", grams: 15 },
			{ canonical_name: "olive oil", role: "fat", required: false, qty: 1, unit: "tbsp", grams: 14 },
			{ canonical_name: "salt", role: "season", required: true, qty: 0.5, unit: "tsp", grams: 3 },
		],
		shelf_life_hours_fridge: 96,
		make_ahead_days_min: 0,
		make_ahead_days_max: 4,
		make_ahead_best_min: 0,
		make_ahead_best_max: 2,
		active_time_min: 8,
		idle_time_min: 0,
		equipment: ["bowl"],
	},
];

export async function seedMiseFormulas(db: D1Database): Promise<{
	unit_conversions: number;
	formulas: number;
}> {
	let conversions = 0;
	let formulas = 0;

	for (const row of miseUnitConversionsSeed) {
		await db.prepare(`
			INSERT OR REPLACE INTO mise_unit_conversions
			(canonical_name, unit, grams, source, ndb_no, meta_json)
			VALUES (?, ?, ?, ?, ?, ?)
		`).bind(
			row.canonical_name,
			row.unit,
			row.grams,
			row.source || "usda_sr28",
			row.ndb_no || null,
			"{}",
		).run();
		conversions++;
	}

	for (const formula of miseFormulasSeed) {
		await db.prepare(`
			INSERT OR REPLACE INTO mise_formulas
			(id, output_state_id, output_label, output_canonical_name,
			 batch_qty, batch_unit, batch_grams, serves, yield_ratio,
			 inputs_json, shelf_life_hours_fridge, shelf_life_hours_pantry,
			 shelf_life_hours_freezer, make_ahead_days_min, make_ahead_days_max,
			 make_ahead_best_min, make_ahead_best_max, active_time_min, idle_time_min,
			 equipment_json, source, meta_json, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
		`).bind(
			formula.id,
			formula.output_state_id,
			formula.output_label,
			formula.output_canonical_name,
			formula.batch_qty,
			formula.batch_unit,
			formula.batch_grams,
			formula.serves || null,
			formula.yield_ratio || null,
			JSON.stringify(formula.inputs),
			formula.shelf_life_hours_fridge || null,
			formula.shelf_life_hours_pantry || null,
			formula.shelf_life_hours_freezer || null,
			formula.make_ahead_days_min ?? null,
			formula.make_ahead_days_max ?? null,
			formula.make_ahead_best_min ?? null,
			formula.make_ahead_best_max ?? null,
			formula.active_time_min || null,
			formula.idle_time_min || null,
			JSON.stringify(formula.equipment || []),
			formula.source || "mise_formulas_seed",
			JSON.stringify({ notes: formula.notes }),
		).run();
		formulas++;
	}

	return { unit_conversions: conversions, formulas };
}

// Meal-as-composition shape.
//
// A real plate has parts: a main dish, often a starch / bread / side / sauce.
// The legacy `MisePlanMeal` flattens those parts into one bag of
// `formula_ids + raw_ingredients`, which makes "build vs buy vs reuse"
// decisions per slot impossible. This module introduces the *component*
// shape: each meal carries an array of `MealComponent` records, each with a
// structural role (main, bread, sauce, ...) and a discriminated `source`
// describing whether the component is composed inline, sourced from a prep
// batch, built as a new prep batch, or bought ready-made.
//
// Pure-data, zero-runtime: this file declares the types + the curated
// `FORMAT_SLOT_SPECS` table that maps each format to its required and
// optional structural slots. The composer post-pass uses the table to
// fill components deterministically when the LLM didn't emit them.

export type ComponentRole =
	| "main" | "protein" | "starch" | "bread" | "vegetable_side"
	| "salad" | "sauce" | "garnish" | "drink" | "pickle" | "crunch"
	| "shell" | "topping" | "filling";

export interface ComposerRawIngredientLite {
	name: string;
	qty: number | null;
	unit: string | null;
	grams: number | null;
}

export type ComponentSource =
	| { kind: "compose_inline";   raw_ingredients: ComposerRawIngredientLite[] }
	| { kind: "use_batch";         batch_id: string; qty_g: number }
	| { kind: "build_batch";       formula_id: string; new_batch_id: string }
	| { kind: "buy_ready_made";    shopping_item: { name: string; qty: number; unit: string }; covers_meals: string[] }
	| { kind: "pantry_only";       raw_ingredients: ComposerRawIngredientLite[] }
	| { kind: "personal_recipe";   recipe_id: string; raw_ingredients: ComposerRawIngredientLite[] };

export interface MealComponent {
	role:                 ComponentRole;
	required:             boolean;
	title:                string;
	source:               ComponentSource;
	serves:               number;
	active_time_min:      number;
}

export interface FormatSlotSpec {
	role: ComponentRole;
	required: boolean;
	default_source_hint?: ComponentSource["kind"];
}

// Hand-curated map: format → required + optional structural slots.
//
// The composer / post-pass uses this to (a) decide which roles a meal must
// have, (b) infer reasonable defaults for the source, and (c) drive the
// FormatCompositionCritic. Keys must be lowercase.
//
// Self-contained formats (bowl, mezze, salad, soup, donburi, risotto,
// curry, stir-fry, frittata) declare their internal slots but don't require
// an extra side. Composed plate formats (burger, taco, pizza, sandwich,
// flatbread) declare structural sub-parts.
export const FORMAT_SLOT_SPECS: Record<string, FormatSlotSpec[]> = {
	burger: [
		{ role: "bread",         required: true,  default_source_hint: "buy_ready_made" }, // bun
		{ role: "main",          required: true,  default_source_hint: "compose_inline" }, // patty
		{ role: "sauce",         required: false, default_source_hint: "compose_inline" },
		{ role: "pickle",        required: false, default_source_hint: "compose_inline" },
		{ role: "crunch",        required: false, default_source_hint: "compose_inline" },
		{ role: "salad",         required: false, default_source_hint: "compose_inline" },
	],
	pizza: [
		{ role: "bread",         required: true,  default_source_hint: "use_batch" },     // dough
		{ role: "sauce",         required: false, default_source_hint: "compose_inline" },
		{ role: "topping",       required: true,  default_source_hint: "compose_inline" },
		{ role: "salad",         required: false, default_source_hint: "compose_inline" },
	],
	pasta: [
		{ role: "main",          required: true,  default_source_hint: "compose_inline" }, // pasta + sauce together
		{ role: "sauce",         required: false, default_source_hint: "compose_inline" },
		{ role: "salad",         required: false, default_source_hint: "compose_inline" },
		{ role: "bread",         required: false, default_source_hint: "buy_ready_made" },
	],
	bowl: [
		{ role: "starch",        required: true,  default_source_hint: "compose_inline" },
		{ role: "protein",       required: true,  default_source_hint: "compose_inline" },
		{ role: "vegetable_side",required: false, default_source_hint: "compose_inline" },
		{ role: "sauce",         required: false, default_source_hint: "use_batch" },
		{ role: "garnish",       required: false, default_source_hint: "compose_inline" },
	],
	frittata: [
		{ role: "main",          required: true,  default_source_hint: "compose_inline" },
		{ role: "salad",         required: false, default_source_hint: "compose_inline" },
		{ role: "bread",         required: false, default_source_hint: "use_batch" },
	],
	mezze: [
		{ role: "main",          required: true,  default_source_hint: "use_batch" },     // dip / hummus
		{ role: "bread",         required: false, default_source_hint: "use_batch" },
		{ role: "pickle",        required: false, default_source_hint: "compose_inline" },
		{ role: "vegetable_side",required: false, default_source_hint: "compose_inline" },
	],
	salad: [
		{ role: "main",          required: true,  default_source_hint: "compose_inline" },
		{ role: "protein",       required: false, default_source_hint: "compose_inline" },
		{ role: "sauce",         required: false, default_source_hint: "compose_inline" }, // dressing
		{ role: "crunch",        required: false, default_source_hint: "compose_inline" },
	],
	soup: [
		{ role: "main",          required: true,  default_source_hint: "compose_inline" },
		{ role: "bread",         required: false, default_source_hint: "buy_ready_made" },
		{ role: "garnish",       required: false, default_source_hint: "compose_inline" },
	],
	taco: [
		{ role: "shell",         required: true,  default_source_hint: "buy_ready_made" }, // tortilla
		{ role: "filling",       required: true,  default_source_hint: "compose_inline" },
		{ role: "sauce",         required: false, default_source_hint: "compose_inline" }, // salsa
		{ role: "pickle",        required: false, default_source_hint: "compose_inline" },
		{ role: "crunch",        required: false, default_source_hint: "compose_inline" },
	],
	sandwich: [
		{ role: "bread",         required: true,  default_source_hint: "buy_ready_made" },
		{ role: "filling",       required: true,  default_source_hint: "compose_inline" },
		{ role: "sauce",         required: false, default_source_hint: "compose_inline" },
		{ role: "pickle",        required: false, default_source_hint: "compose_inline" },
	],
	flatbread: [
		{ role: "bread",         required: true,  default_source_hint: "use_batch" },     // dough
		{ role: "topping",       required: true,  default_source_hint: "compose_inline" },
		{ role: "sauce",         required: false, default_source_hint: "compose_inline" },
		{ role: "salad",         required: false, default_source_hint: "compose_inline" },
	],
	curry: [
		{ role: "main",          required: true,  default_source_hint: "compose_inline" },
		{ role: "starch",        required: true,  default_source_hint: "compose_inline" }, // rice/naan
		{ role: "sauce",         required: false, default_source_hint: "compose_inline" },
		{ role: "pickle",        required: false, default_source_hint: "compose_inline" },
	],
	"stir fry": [
		{ role: "main",          required: true,  default_source_hint: "compose_inline" },
		{ role: "starch",        required: true,  default_source_hint: "compose_inline" }, // rice/noodle
		{ role: "sauce",         required: false, default_source_hint: "compose_inline" },
	],
	donburi: [
		{ role: "starch",        required: true,  default_source_hint: "compose_inline" }, // rice
		{ role: "main",          required: true,  default_source_hint: "compose_inline" },
		{ role: "sauce",         required: false, default_source_hint: "compose_inline" },
		{ role: "garnish",       required: false, default_source_hint: "compose_inline" },
	],
	risotto: [
		{ role: "main",          required: true,  default_source_hint: "compose_inline" },
		{ role: "salad",         required: false, default_source_hint: "compose_inline" },
	],
	tagine: [
		{ role: "main",          required: true,  default_source_hint: "compose_inline" },
		{ role: "starch",        required: false, default_source_hint: "compose_inline" }, // couscous
		{ role: "bread",         required: false, default_source_hint: "use_batch" },
	],
	fritter: [
		{ role: "main",          required: true,  default_source_hint: "compose_inline" },
		{ role: "sauce",         required: false, default_source_hint: "use_batch" },
		{ role: "salad",         required: false, default_source_hint: "compose_inline" },
		{ role: "bread",         required: false, default_source_hint: "use_batch" },     // pita
	],
	omelette: [
		{ role: "main",          required: true,  default_source_hint: "compose_inline" },
		{ role: "bread",         required: false, default_source_hint: "buy_ready_made" }, // toast
		{ role: "salad",         required: false, default_source_hint: "compose_inline" },
	],
};

// Format aliases — common variants reduce to a canonical key.
export const FORMAT_ALIASES: Record<string, string> = {
	"stir-fry": "stir fry",
	"stirfry": "stir fry",
	"stir_fry": "stir fry",
	"mezze_plate": "mezze",
	"flat_bread": "flatbread",
	"tacos": "taco",
	"grain bowl": "bowl",
	"rice bowl": "bowl",
	"mezze plate": "mezze",
	"flat bread": "flatbread",
};

// Resolve a format string to its slot spec (case-insensitive, alias-aware).
export function resolveFormatSpec(format: string | null | undefined): FormatSlotSpec[] | null {
	if (!format) return null;
	const lower = format.toLowerCase().trim();
	const canonical = FORMAT_ALIASES[lower] ?? lower;
	return FORMAT_SLOT_SPECS[canonical] ?? null;
}

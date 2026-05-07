// Cascade proposals — concrete fixes attached to grievances. The revision
// loop and the human UI can call plan.preview(proposal.mutation) and
// commit if scores improve. Each kind is a structured action that
// downstream code can deserialize without parsing prose.
//
// This module is intentionally decoupled from RipplePreview's mutation
// surface (which is owned by Agent F): we keep a loose `mutation` blob
// shaped to mirror RipplePreview's expected `kind` strings so downstream
// code can route directly without an additional translation layer.
//
// Shape contracts for `parameters` by kind (informal — kept loose so this
// module doesn't import RipplePreview types):
//
//   "swap_ingredient"     { slot, from_name, to_name, reason? }
//   "replace_meal"        { slot, must_consume?: string[], must_avoid?: string[] }
//   "move_meal"           { from_slot, to_slot }
//   "cancel_meal"         { slot, reason? }
//   "add_meal"            { slot, hint?: string, leftover_source_meal_id?: string }
//   "split_batch"         { batch_id, split_at_date }
//   "merge_batches"       { batch_ids: string[] }
//   "slide_prep_date"     { batch_id, new_prep_date }
//   "move_shop"           { run_id, new_date }
//   "drop_item_from_shop" { run_id, item_name }
//   "add_shop"            { date, items?: string[] }
//   "substitute_recipe"   { slot, from_recipe_id?, to_recipe_id? }
//   "lock_slot"           { slot, reason }

export type CascadeProposalKind =
	| "swap_ingredient"
	| "replace_meal"
	| "move_meal"
	| "cancel_meal"
	| "add_meal"
	| "split_batch"
	| "merge_batches"
	| "slide_prep_date"
	| "move_shop"
	| "drop_item_from_shop"
	| "add_shop"
	| "substitute_recipe"
	| "lock_slot";

export interface CascadeProposal {
	kind: CascadeProposalKind;
	description: string;            // human-readable
	expected_resolves: string[];    // grievance IDs this would clear
	expected_introduces?: string[]; // grievance IDs this might create
	parameters: Record<string, unknown>;  // shape varies by kind; see comment above
	// Optional shape for downstream preview/commit:
	mutation?: {
		kind: string;                 // matches Mutation kind in ripple-preview if applicable
		[key: string]: unknown;
	};
	confidence: number;             // 0..1
}

// ---------------------------------------------------------------------------
// Plant-substitution table for DietaryCritic. Maps animal-derived ingredient
// names (lowercase keys matching the same keywords used by the dietary
// patterns) to a plant alternative description that downstream code can
// pass into the swap_ingredient mutation.
// ---------------------------------------------------------------------------

const PLANT_SUBSTITUTIONS: Record<string, string> = {
	"fish sauce":   "soy sauce + a pinch of dashi-style kombu broth",
	"anchovy":      "capers + a splash of soy sauce",
	"anchovies":    "capers + a splash of soy sauce",
	"oyster sauce": "mushroom-based vegetarian oyster sauce",
	"shrimp paste": "fermented black bean paste",
	"chicken":      "seitan or king oyster mushroom",
	"beef":         "lentil + mushroom blend",
	"pork":         "jackfruit or tempeh",
	"lamb":         "spiced lentil + walnut crumble",
	"veal":         "tempeh cutlet",
	"duck":         "smoked tofu",
	"turkey":       "seitan",
	"goose":        "seitan",
	"bacon":        "smoked tempeh or mushroom bacon",
	"ham":          "smoked tofu or carrot ham",
	"prawn":        "hearts of palm",
	"shrimp":       "hearts of palm",
	"squid":        "king oyster mushroom rings",
	"cuttlefish":   "king oyster mushroom",
	"octopus":      "trumpet mushroom",
	"crab":         "hearts of palm + nori",
	"lobster":      "hearts of palm + Old Bay",
	"salmon":       "marinated carrot 'lox' or tofu",
	"tuna":         "chickpea 'tuna' (mashed chickpeas + nori)",
	"cod":          "tofu or banana blossom",
	"halibut":      "tofu or banana blossom",
	"trout":        "marinated tofu",
	"sardine":      "marinated white beans + nori",
	"mackerel":     "marinated tofu + nori",
	"swordfish":    "grilled hearts of palm",
	"sea bass":     "tofu or tempeh",
	"gelatin":      "agar-agar",
	"lard":         "olive oil or coconut oil",
	// vegan extras
	"milk":         "oat milk",
	"cream":        "cashew cream",
	"butter":       "vegan butter or olive oil",
	"cheese":       "cashew or nut-based cheese",
	"yogurt":       "coconut yogurt",
	"ghee":         "olive oil",
	"whey":         "pea protein",
	"honey":        "maple syrup or agave",
	"egg":          "flax egg or aquafaba",
	"eggs":         "flax egg or aquafaba",
};

/**
 * Look up a plant alternative for an animal-derived ingredient. Tries the
 * exact name first, then falls back to scanning for a substring match (so
 * "pan-seared salmon" still maps to the salmon entry).
 */
export function plantSubstitutionFor(name: string): string | null {
	if (!name) return null;
	const norm = name.toLowerCase().trim();
	if (PLANT_SUBSTITUTIONS[norm]) return PLANT_SUBSTITUTIONS[norm];
	for (const [key, sub] of Object.entries(PLANT_SUBSTITUTIONS)) {
		if (norm.includes(key)) return sub;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Rendering / mutation helpers
// ---------------------------------------------------------------------------

/**
 * Produce a non-empty, human-readable string describing a proposal. Falls
 * back to the structured description, but wraps it with the kind so audit
 * logs can group/filter without parsing the description prose.
 */
export function proposalToHumanString(p: CascadeProposal): string {
	const desc = (p.description || "").trim();
	const params = p.parameters || {};
	switch (p.kind) {
		case "swap_ingredient": {
			const slot = formatSlot(params.slot);
			const from = String(params.from_name ?? "");
			const to = String(params.to_name ?? "");
			const tail = from && to ? ` (${from} → ${to})` : "";
			return `[swap_ingredient${slot ? " " + slot : ""}]${tail}: ${desc || "swap ingredient"}`;
		}
		case "replace_meal": {
			const slot = formatSlot(params.slot);
			return `[replace_meal${slot ? " " + slot : ""}]: ${desc || "replace this meal"}`;
		}
		case "move_meal": {
			const from = formatSlot(params.from_slot);
			const to = formatSlot(params.to_slot);
			return `[move_meal ${from} → ${to}]: ${desc || "move meal to a different slot"}`;
		}
		case "cancel_meal": {
			const slot = formatSlot(params.slot);
			return `[cancel_meal${slot ? " " + slot : ""}]: ${desc || "cancel this meal"}`;
		}
		case "add_meal": {
			const slot = formatSlot(params.slot);
			return `[add_meal${slot ? " " + slot : ""}]: ${desc || "add a meal to fill this slot"}`;
		}
		case "split_batch": {
			const id = String(params.batch_id ?? "");
			const at = String(params.split_at_date ?? "");
			return `[split_batch${id ? " " + id : ""}${at ? " @ " + at : ""}]: ${desc || "split this batch into a fresher run"}`;
		}
		case "merge_batches": {
			const ids = Array.isArray(params.batch_ids) ? (params.batch_ids as unknown[]).join(", ") : "";
			return `[merge_batches${ids ? " " + ids : ""}]: ${desc || "merge batches into one"}`;
		}
		case "slide_prep_date": {
			const id = String(params.batch_id ?? "");
			const date = String(params.new_prep_date ?? "");
			return `[slide_prep_date${id ? " " + id : ""}${date ? " → " + date : ""}]: ${desc || "shift the batch prep date"}`;
		}
		case "move_shop": {
			const id = String(params.run_id ?? "");
			const date = String(params.new_date ?? "");
			return `[move_shop${id ? " " + id : ""}${date ? " → " + date : ""}]: ${desc || "reschedule the shopping run"}`;
		}
		case "drop_item_from_shop": {
			const id = String(params.run_id ?? "");
			const item = String(params.item_name ?? "");
			return `[drop_item_from_shop${id ? " " + id : ""}${item ? " — " + item : ""}]: ${desc || "drop the item from this run"}`;
		}
		case "add_shop": {
			const date = String(params.date ?? "");
			return `[add_shop${date ? " " + date : ""}]: ${desc || "add a new shopping run"}`;
		}
		case "substitute_recipe": {
			const slot = formatSlot(params.slot);
			return `[substitute_recipe${slot ? " " + slot : ""}]: ${desc || "swap in a different recipe"}`;
		}
		case "lock_slot": {
			const slot = formatSlot(params.slot);
			return `[lock_slot${slot ? " " + slot : ""}]: ${desc || "freeze this slot pending human review"}`;
		}
		default: {
			return `[${(p as CascadeProposal).kind}]: ${desc || "(no description)"}`;
		}
	}
}

/**
 * Convert a proposal into a structured mutation object that can be passed
 * directly into RipplePreview-style preview/commit. Returns null for
 * proposals that are purely informational (lock_slot for human review,
 * etc.) and for any proposal that didn't carry an explicit `mutation`
 * blob and isn't directly translatable.
 */
export function proposalToMutation(p: CascadeProposal): { kind: string; [k: string]: unknown } | null {
	// Informational kinds never produce a mutation.
	if (p.kind === "lock_slot") return null;
	// Prefer the explicit mutation blob if the generator attached one.
	if (p.mutation && typeof p.mutation.kind === "string" && p.mutation.kind.length > 0) {
		return p.mutation;
	}
	// Otherwise translate from kind+parameters where the mapping is obvious.
	const params = p.parameters || {};
	switch (p.kind) {
		case "swap_ingredient":
			if (!params.slot) return null;
			return { kind: "swap_ingredient", slot: params.slot, from_name: params.from_name, to_name: params.to_name };
		case "replace_meal":
			if (!params.slot) return null;
			return { kind: "replace_meal", slot: params.slot, must_consume: params.must_consume, must_avoid: params.must_avoid };
		case "move_meal":
			if (!params.from_slot || !params.to_slot) return null;
			return { kind: "move_meal", from_slot: params.from_slot, to_slot: params.to_slot };
		case "cancel_meal":
			if (!params.slot) return null;
			return { kind: "cancel_meal", slot: params.slot };
		case "add_meal":
			if (!params.slot) return null;
			return { kind: "add_meal", slot: params.slot, hint: params.hint, leftover_source_meal_id: params.leftover_source_meal_id };
		case "split_batch":
			if (!params.batch_id) return null;
			return { kind: "split_batch", batch_id: params.batch_id, at_date: params.split_at_date ?? params.at_date };
		case "merge_batches":
			if (!Array.isArray(params.batch_ids)) return null;
			return { kind: "merge_batches", batch_ids: params.batch_ids };
		case "slide_prep_date":
			if (!params.batch_id || !params.new_prep_date) return null;
			return { kind: "slide_prep_date", batch_id: params.batch_id, new_prep_date: params.new_prep_date };
		case "move_shop":
			if (!params.run_id || !params.new_date) return null;
			return { kind: "move_shop", run_id: params.run_id, new_date: params.new_date };
		case "drop_item_from_shop":
			if (!params.run_id || !params.item_name) return null;
			return { kind: "drop_item_from_shop", run_id: params.run_id, item_name: params.item_name };
		case "add_shop":
			if (!params.date) return null;
			return { kind: "add_shop", date: params.date, items: params.items };
		case "substitute_recipe":
			if (!params.slot) return null;
			return { kind: "substitute_recipe", slot: params.slot, from_recipe_id: params.from_recipe_id, to_recipe_id: params.to_recipe_id };
		default:
			return null;
	}
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function formatSlot(slot: unknown): string {
	if (!slot || typeof slot !== "object") return "";
	const s = slot as { date?: unknown; slot?: unknown };
	const date = typeof s.date === "string" ? s.date : "";
	const slotName = typeof s.slot === "string" ? s.slot : "";
	if (!date && !slotName) return "";
	if (!date) return slotName;
	if (!slotName) return date;
	return `${date} ${slotName}`;
}

// Real prep-task instructions, generated from formula data.
//
// The original task generator emitted three generic lines:
//   "Set up prep_station_active. Prepare X. Pack in a labeled container..."
//
// That's useless to a chef. This module reads each formula's `inputs` (with
// canonical name + qty + unit + grams + role notes) plus its `notes`,
// `active_time_min`, `idle_time_min`, and `equipment` to emit a real recipe:
//
//   "Drain the soaked chickpeas (200 g) and rinse."
//   "Combine with 6 cups water and 1 tsp salt in instant pot."
//   "Cook on bean setting 35 min; release pressure naturally for 15 min."
//   "Strain; reserve 1 cup cooking liquid for hummus."
//   "Cool to room temp; pack in labeled airtight container; store in fridge."
//
// We use a per-formula recipe template (keyed by output_label) for the dishes
// in the prototype catalog, falling back to a generic-but-useful template for
// unknown formulas.

import type { MiseFormula } from "./ledger";

export interface PrepInstructionContext {
	storage: string;
	container: string | null;
}

export function generatePrepInstructions(formula: MiseFormula, ctx: PrepInstructionContext): string[] {
	const label = (formula.output_label || "").toLowerCase().trim();
	const builder = TEMPLATE_BY_LABEL[label];
	if (builder) return builder(formula, ctx);
	return genericInstructions(formula, ctx);
}

const TEMPLATE_BY_LABEL: Record<string, (formula: MiseFormula, ctx: PrepInstructionContext) => string[]> = {
	"cooked whole chickpeas": (f, ctx) => [
		"Soak the dried chickpeas overnight in cold water with a pinch of baking soda; drain and rinse.",
		`Combine soaked chickpeas with ${inputQty(f, "water") || "fresh water (8 cups)"} and ${inputQty(f, "salt") || "1 tsp salt"} in the instant pot.`,
		"Cook on bean/chili setting for 35 min, then natural release for 15 min.",
		"Skim any foam; reserve 1 cup of the cooking liquid (aquafaba) — useful for hummus.",
		`Cool to room temperature, then ${pack(ctx)}.`,
	],

	"hummus": (f, ctx) => [
		`In food processor, combine ${inputQty(f, "tahini") || "1 cup tahini"} and ${inputQty(f, "lemon juice") || "1/4 cup lemon juice"}; whip 90 seconds until light and creamy.`,
		`Add ${inputQty(f, "garlic") || "2 cloves garlic"}, ${inputQty(f, "salt") || "1 tsp salt"}, and 2 tbsp ice water; pulse to combine.`,
		"Add the cooked chickpeas in two batches, processing 2-3 minutes between each, until ultra smooth.",
		"Drizzle in olive oil while running until silky. Taste and adjust salt + lemon.",
		`Transfer to ${ctx.container || "a wide, shallow container"}; smooth top, drizzle with olive oil; store in ${ctx.storage}.`,
	],

	"falafel mix": (f, ctx) => [
		"Use SOAKED but UNCOOKED dried chickpeas — the texture depends on this. Soak 12-24h, drain well.",
		`In food processor, pulse the soaked chickpeas with ${inputQty(f, "onion") || "1/2 onion"}, ${inputQty(f, "garlic") || "3 cloves garlic"}, and ${inputQty(f, "fresh parsley") || "1 cup fresh parsley"} until coarse but cohesive.`,
		`Add ${inputQty(f, "cumin") || "1 tbsp cumin"}, ${inputQty(f, "coriander") || "1 tbsp coriander"}, ${inputQty(f, "salt") || "1.5 tsp salt"}, and a pinch of baking soda. Pulse to combine.`,
		"Mixture should hold together when squeezed. If too wet, pulse in 1-2 tbsp chickpea flour.",
		`Cover and chill at least 30 min before frying; ${pack(ctx)}.`,
	],

	"crispy chickpeas": (f, ctx) => [
		"Drain cooked chickpeas thoroughly and pat completely dry with a kitchen towel — moisture is the enemy of crisp.",
		`Toss with ${inputQty(f, "olive oil") || "2 tbsp olive oil"}, ${inputQty(f, "salt") || "3/4 tsp salt"}, and any spices (cumin, smoked paprika, sumac).`,
		"Spread on a sheet pan in single layer. Roast at 425°F for 25-30 min, shaking the pan every 10 min, until deeply golden and crisp.",
		"Cool fully on the sheet pan (chickpeas crisp further as they cool).",
		`${pack(ctx)} but DO NOT seal until cold — trapped steam ruins the crunch. Best eaten within 72h.`,
	],

	"lemon tahini sauce": (f, ctx) => [
		`Whisk ${inputQty(f, "tahini") || "1/2 cup tahini"} with ${inputQty(f, "lemon juice") || "3 tbsp lemon juice"} — it will seize and look broken.`,
		"Add ice water 1 tbsp at a time, whisking constantly, until silky and pourable (typically 4-6 tbsp total).",
		`Stir in ${inputQty(f, "garlic") || "1 small grated garlic clove"} and ${inputQty(f, "salt") || "1/2 tsp salt"}. Taste and balance.`,
		`Transfer to a jar; ${pack(ctx)}. Loosens with cold storage — re-whisk with a splash of water before serving.`,
	],

	"herb yogurt sauce": (f, ctx) => [
		`In food processor, blitz ${inputQty(f, "fresh parsley") || "1 cup parsley"} + ${inputQty(f, "fresh dill") || "1/2 cup dill"} + ${inputQty(f, "fresh mint") || "1/4 cup mint"} with ${inputQty(f, "garlic") || "1 clove garlic"} and ${inputQty(f, "salt") || "1/2 tsp salt"} until finely chopped.`,
		`Fold into ${inputQty(f, "yogurt") || "2 cups Greek yogurt"} with ${inputQty(f, "lemon juice") || "2 tbsp lemon juice"} and ${inputQty(f, "olive oil") || "2 tbsp olive oil"}.`,
		"Taste; adjust salt and lemon. Mixture should be brightly green and tangy.",
		`Transfer to a jar; ${pack(ctx)}. Flavor improves after 30 min rest.`,
	],

	"quick pickled radishes": (f, ctx) => [
		"Slice radishes paper-thin on a mandoline (1-2 mm).",
		`In a small saucepan, warm ${inputQty(f, "rice vinegar") || "1 cup rice vinegar"} with ${inputQty(f, "sugar") || "2 tbsp sugar"} and ${inputQty(f, "salt") || "1.5 tsp salt"} just until dissolved.`,
		"Pack the sliced radishes into a clean jar; pour the warm brine over to cover.",
		"Cool on the counter for 30 min, then refrigerate. Ready to eat after 1 hour; best after 24h.",
		`${pack(ctx)} — keeps 2 weeks in the fridge.`,
	],

	"cold-fermented dough": (f, ctx) => [
		`In a large bowl, whisk ${inputQty(f, "all-purpose flour") || "400 g flour"} with ${inputQty(f, "salt") || "9 g salt"} and ${inputQty(f, "yeast") || "6 g yeast"}.`,
		`Add ${inputQty(f, "water") || "260 g water"} (65% hydration) and ${inputQty(f, "olive oil") || "1 tbsp olive oil"}; mix until shaggy. Cover; rest 20 min.`,
		"Stretch-and-fold the dough in the bowl 4 times, every 15 min, over the next hour.",
		"Divide into desired portions (4 pita-size or 2 pizza-size); shape into tight balls.",
		`Place balls in oiled containers, spaced apart; ${pack(ctx)}. Cold ferment 48-72h for best flavor — pull from fridge 1-2h before shaping/baking.`,
	],

	"chia pudding": (f, ctx) => [
		`In a jar, whisk ${inputQty(f, "chia seed") || "1/3 cup chia seeds"} with ${inputQty(f, "milk") || "2 cups milk (any kind)"}, ${inputQty(f, "maple syrup") || "2 tbsp maple syrup"}, and ${inputQty(f, "vanilla") || "1 tsp vanilla"}.`,
		"Whisk hard for 30 seconds; rest 5 min; whisk again to break up clumps.",
		`Seal and ${pack(ctx)} for at least 4h or overnight. Stir before serving.`,
		"Top with fresh fruit, granola, or nut butter when serving.",
	],

	"overnight oats": (f, ctx) => [
		`In a jar, combine ${inputQty(f, "rolled oats") || "1/2 cup rolled oats"} with ${inputQty(f, "milk") || "3/4 cup milk"} and ${inputQty(f, "yogurt") || "1/4 cup yogurt"}.`,
		`Sweeten with ${inputQty(f, "maple syrup") || "1 tbsp maple syrup"}; add ${inputQty(f, "chia seed") || "1 tsp chia"} for body and ${inputQty(f, "vanilla") || "a splash of vanilla"}.`,
		"Stir well, seal, and refrigerate at least 8h or overnight.",
		`${pack(ctx)}. Top with fresh fruit + nut butter when serving.`,
	],
};

function genericInstructions(formula: MiseFormula, ctx: PrepInstructionContext): string[] {
	const inputs = (formula.inputs || []).filter(i => i.qty && i.unit && i.canonical_name);
	const ingredientLine = inputs.length
		? `Combine ${inputs.map(i => `${trimmedQty(i.qty)} ${i.unit} ${i.canonical_name}`).join(", ")}.`
		: `Gather all the ${formula.output_label} ingredients.`;
	const equipmentLine = formula.equipment && formula.equipment.length
		? `Equipment: ${formula.equipment.join(", ")}.`
		: null;
	const timeLine = formula.idle_time_min && formula.idle_time_min > 30
		? `Allow ${Math.round(formula.idle_time_min / 60 * 10) / 10}h idle/rest after active work.`
		: null;
	return [
		equipmentLine,
		ingredientLine,
		`Combine and prepare to taste, following standard ${formula.output_label} method.`,
		timeLine,
		`Cool to room temp; ${pack(ctx)}.`,
	].filter((l): l is string => !!l);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function inputQty(formula: MiseFormula, canonicalName: string): string | null {
	const target = canonicalName.toLowerCase();
	const hit = (formula.inputs || []).find(i => i.canonical_name.toLowerCase().includes(target));
	if (!hit) return null;
	return `${trimmedQty(hit.qty)} ${hit.unit} ${hit.canonical_name}`;
}

function trimmedQty(n: number): string {
	if (Number.isInteger(n)) return String(n);
	return String(Math.round(n * 100) / 100);
}

function pack(ctx: PrepInstructionContext): string {
	return `pack in ${ctx.container || "a labeled airtight container"}; store in ${ctx.storage}`;
}

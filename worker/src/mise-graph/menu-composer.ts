// LLM-driven menu composer.
//
// Replaces the deterministic index-pick `buildMealsFromSlots` with one
// Claude call that takes the full slot list + formula catalog + cuisine
// direction + user prompt and returns a structured menu with real meal
// titles, cuisine-correct ingredient picks, variety, and per-meal
// component reservations + raw-ingredient lists for things not yet in
// the formula library (tortillas, salsa, lime, etc.).
//
// Routes through the mesh-claude bridge (officemac), so we get Claude's
// chef judgement without API spend.

import type { MeshClaudeEnv } from "./llm-bridge";
import { callMeshClaudeJSON } from "./llm-bridge";
import type { MiseFormula } from "./ledger";
import type { ComposerContextBundle } from "./composer-context";

export interface ComposerSlotInput {
	date: string;
	slot: "breakfast" | "lunch" | "dinner" | "snack";
	people: number;
	cuisine: string[];
	format: string | null;
	title_hint: string | null;
	locked: boolean;
	notes: string[];
}

export interface ComposerInput {
	start_date: string;
	end_date: string;
	people_default: number;
	prompt: string | null;
	cuisine_direction: string[];
	anchor_ingredients: string[];
	pantry: string[];
	equipment: string[];
	household_id: string | null;
	dietary: string[];
	slots: ComposerSlotInput[];
	formulas: MiseFormula[];
	max_active_time_min?: number | null;
	context?: ComposerContextBundle | null;
	overlapping_inventory?: Array<{ name: string; quantity?: number; unit?: string; available_from: string; expires_at?: string | null }>;
}

export interface ComposedMeal {
	date: string;
	slot: "breakfast" | "lunch" | "dinner" | "snack";
	title: string;
	format: string;
	people: number;
	cuisine: string[];
	formula_ids: string[];
	raw_ingredients: ComposerRawIngredient[];
	notes: string[];
	method_summary: string;
	leftovers_to: string[];
	lineage: ComposerLineageRef[];
}

export interface ComposerLineageRef {
	source_kind: "personal_recipe" | "canonical_dish" | "canonical_component" | "affinity" | "season" | "compound" | "household_pattern" | "template";
	source_id?: string;
	source_title?: string;
	influence: string;
	confidence?: number;
}

export interface ComposerRawIngredient {
	name: string;
	qty: number | null;
	unit: string | null;
	grams: number | null;
	category: string | null;
}

export interface ComposerSnackBox {
	date: string;
	title: string;
	people: number;
	formula_ids: string[];
	items: string[];
	raw_ingredients: ComposerRawIngredient[];
}

export interface ComposedMenu {
	ok: boolean;
	meals: ComposedMeal[];
	snack_boxes: ComposerSnackBox[];
	rationale: string;
	error?: string;
	debug?: {
		elapsed_ms: number;
		input_tokens?: number;
		output_tokens?: number;
		cache_read?: number;
		cost_usd?: number;
		raw_text?: string;
	};
}

// Haiku is fast enough to return structured meals; Sonnet was 4-5x slower and
// hit the VPC fetch timeout. Even Haiku struggles at 49 meals in one call when
// the prompt is enriched (corpus context). We split the work into 2 parallel
// calls — dinners+lunches in one, breakfasts+snacks in the other — so each
// call's output is ~half the size and finishes faster.
const COMPOSER_MODEL = "claude-haiku-4-5-20251001";
// Splitting parallelism makes things WORSE because each call's bridge
// claude_code preset incurs ~68k cache_creation tokens that don't share.
// Single call is best; we just have to keep its prompt + output small.
const SPLIT_THRESHOLD_SLOTS = 999;

export async function composeMenuWithLlm(env: MeshClaudeEnv, input: ComposerInput): Promise<ComposedMenu> {
	if (input.slots.length > SPLIT_THRESHOLD_SLOTS) {
		return composeMenuSplit(env, input);
	}
	return composeMenuSingle(env, input);
}

async function composeMenuSplit(env: MeshClaudeEnv, input: ComposerInput): Promise<ComposedMenu> {
	// Group A: dinners + lunches (the hardest part — variety + leftovers)
	// Group B: breakfasts + snacks
	const groupA = input.slots.filter(s => s.slot === "dinner" || s.slot === "lunch");
	const groupB = input.slots.filter(s => s.slot === "breakfast" || s.slot === "snack");
	const inputA: ComposerInput = { ...input, slots: groupA };
	const inputB: ComposerInput = { ...input, slots: groupB };
	const startedAt = Date.now();
	const [resultA, resultB] = await Promise.all([
		composeMenuSingle(env, inputA),
		composeMenuSingle(env, inputB),
	]);
	const elapsed = Date.now() - startedAt;
	const meals = [...resultA.meals, ...resultB.meals];
	const snacks = [...resultA.snack_boxes, ...resultB.snack_boxes];
	const okA = resultA.meals.length > 0 || resultA.snack_boxes.length > 0;
	const okB = resultB.meals.length > 0 || resultB.snack_boxes.length > 0;
	const ok = okA || okB;
	const debug = {
		elapsed_ms: elapsed,
		input_tokens: (resultA.debug?.input_tokens || 0) + (resultB.debug?.input_tokens || 0),
		output_tokens: (resultA.debug?.output_tokens || 0) + (resultB.debug?.output_tokens || 0),
		cache_read: (resultA.debug?.cache_read || 0) + (resultB.debug?.cache_read || 0),
		cost_usd: (resultA.debug?.cost_usd || 0) + (resultB.debug?.cost_usd || 0),
		raw_text: `[split] A: ${resultA.meals.length} meals; B: ${resultB.meals.length} meals + ${resultB.snack_boxes.length} snacks`,
	};
	const errors: string[] = [];
	if (!okA && resultA.error) errors.push(`A: ${resultA.error}`);
	if (!okB && resultB.error) errors.push(`B: ${resultB.error}`);
	return {
		ok,
		meals,
		snack_boxes: snacks,
		rationale: [resultA.rationale, resultB.rationale].filter(Boolean).join("\n\n"),
		error: errors.length ? errors.join("; ") : undefined,
		debug,
	};
}

async function composeMenuSingle(env: MeshClaudeEnv, input: ComposerInput): Promise<ComposedMenu> {
	const formulaCatalog = input.formulas.map(formula => ({
		id: formula.id,
		label: formula.output_label,
		canonical: formula.output_canonical_name,
		batch_grams: formula.batch_grams,
		serves: formula.serves,
		shelf_life_hours_fridge: formula.shelf_life_hours_fridge,
		make_ahead_days_min: formula.make_ahead_days_min,
		make_ahead_days_max: formula.make_ahead_days_max,
		inputs: formula.inputs.map(i => `${i.qty} ${i.unit} ${i.canonical_name}`).join(", "),
		notes: formulaRoleHint(formula.output_label),
	}));

	const slotPayload = input.slots.map(slot => ({
		date: slot.date,
		slot: slot.slot,
		people: slot.people,
		cuisine: slot.cuisine,
		format: slot.format,
		title_hint: slot.title_hint,
		locked: slot.locked,
		notes: slot.notes,
	}));

	const system = composerSystemPrompt();
	const ctx = input.context;
	const userPrompt = JSON.stringify({
		household: {
			people_default: input.people_default,
			dietary: input.dietary,
			equipment: input.equipment,
			pantry: input.pantry,
			anchor_ingredients: input.anchor_ingredients,
			max_active_time_min: input.max_active_time_min ?? 60,
		},
		window: {
			start_date: input.start_date,
			end_date: input.end_date,
		},
		cuisine_direction: input.cuisine_direction,
		user_prompt: input.prompt,
		formula_catalog: formulaCatalog,
		spence_context: ctx ? {
			// Compact: top items only. The LLM needs grounding, not a corpus dump.
			canonical_dishes: (ctx.dish_candidates || []).slice(0, 6).map(d => ({
				id: d.id, title: d.title,
				core: d.core_ingredients.slice(0, 4),
			})),
			canonical_components: (ctx.component_candidates || []).slice(0, 4).map(c => ({
				id: c.id, name: c.canonical_name,
			})),
			top_affinity_pairs: (ctx.affinity_pairs || []).slice(0, 10).map(a => `${a.a} ↔ ${a.b}`),
			seasonal_now: (ctx.seasonal_items || []).slice(0, 8).map(s => `${s.canonical_name} [${s.status}]`),
			technique_hints: (ctx.technique_hints || []).slice(0, 5).map(t => t.technique),
			flavor_compound_pairings: (ctx.flavor_compound_pairings || []).slice(0, 5).map(p => `${p.a} ⇄ ${p.b}`),
			composition_templates: (ctx.composition_templates || []).slice(0, 6).map(t => `${t.name}: [${t.slots.slice(0, 5).join(" + ")}]`),
			format_library: (ctx.format_library || []).slice(0, 14).map(f => ({
				format: f.format,
				anatomy: f.slots,
				cuisine_riffs: f.cuisine_riffs.slice(0, 4).map(r => ({
					cuisine: r.cuisine,
					label: r.label,
					riff: r.top_ingredients_per_slot,
				})),
			})),
			cuisine_fusions: (ctx.cuisine_fusions_lines || []).slice(0, 18),
			flavor_vibes: (ctx.flavor_vibe_lines || []).slice(0, 16),
			personal_recipes_loved: (ctx.personal_recipe_candidates || []).slice(0, 5).map(r => ({
				id: r.id,
				title: r.title,
				cuisine: r.cuisine.slice(0, 2),
				format: r.format,
				ingredients: r.canonical_ingredients.slice(0, 5).map(i => i.name),
				method: r.method_summary?.slice(0, 80),
			})),
			recent_menu: ctx.recent_menu ? {
				lookback_days: ctx.recent_menu.window_days,
				dinners_seen: ctx.recent_menu.recent_dinner_titles.slice(0, 12),
				saturated_anchors: Object.entries(ctx.recent_menu.recent_anchor_pressure)
					.filter(([, v]) => v >= 0.6)
					.sort((a, b) => b[1] - a[1])
					.slice(0, 6)
					.map(([k, v]) => `${k} (${v.toFixed(2)})`),
				recent_formats: ctx.recent_menu.recent_dinner_formats.slice(0, 6).map(f => `${f.format}×${f.count}`),
				recent_cuisines: ctx.recent_menu.recent_cuisines.slice(0, 6).map(c => `${c.cuisine}×${c.count}`),
			} : null,
			pantry_pressure: ctx.pantry_pressure ? {
				expiring_within_window: (ctx.pantry_pressure.expiring_within_window || []).slice(0, 8).map(p => `${p.name} (${p.days_until_expiry}d, urgency ${(p as any).urgency || "?"})`),
				opened_perishable: (ctx.pantry_pressure.opened_perishable || []).slice(0, 6).map(p => `${p.name} (opened ${p.opened_days_ago}d)`),
			} : null,
			feedback_hints: ctx.feedback_hints ? {
				loved_titles: (ctx.feedback_hints.loved_titles || []).slice(0, 6),
				rejected_titles: (ctx.feedback_hints.rejected_titles || []).slice(0, 4),
				loved_anchors: Object.entries(ctx.feedback_hints.loved_anchors || {}).slice(0, 5).map(([k, v]) => `${k}:${v}`),
				loved_cuisines: Object.entries(ctx.feedback_hints.loved_cuisines || {}).slice(0, 5).map(([k, v]) => `${k}:${v}`),
			} : null,
		} : null,
		overlapping_inventory: input.overlapping_inventory || [],
		slots: slotPayload,
	}, null, 2);

	const response = await callMeshClaudeJSON<ComposerOutputShape>(env, {
		prompt: userPrompt,
		system,
		model: COMPOSER_MODEL,
	});

	const debug = {
		elapsed_ms: response.raw.elapsedMs,
		input_tokens: response.raw.usage?.input_tokens,
		output_tokens: response.raw.usage?.output_tokens,
		cache_read: response.raw.usage?.cache_read_input_tokens,
		cost_usd: response.raw.cost_usd,
		raw_text: response.raw.text || "",
	};

	if (!response.ok || !response.data) {
		return {
			ok: false,
			meals: [],
			snack_boxes: [],
			rationale: "",
			error: response.raw.error || "LLM did not return parseable JSON",
			debug,
		};
	}

	const validFormulaIds = new Set(input.formulas.map(formula => formula.id));
	const meals = (response.data.meals || []).map(meal => normalizeMeal(meal, validFormulaIds, input.people_default, input.cuisine_direction));
	const snackBoxes = (response.data.snack_boxes || []).map(snack => normalizeSnack(snack, validFormulaIds, input.people_default));

	return {
		ok: meals.length > 0,
		meals,
		snack_boxes: snackBoxes,
		rationale: response.data.rationale || "",
		debug,
	};
}

function composerSystemPrompt(): string {
	return [
		"You are an experienced household chef and weekly menu planner.",
		"You compose a multi-day menu for a real household based on:",
		"  - their formula library (real prep components with batch sizes, shelf life, make-ahead windows)",
		"  - cuisine direction",
		"  - dietary constraints",
		"  - equipment and anchor ingredients",
		"  - the user's free-form prompt",
		"  - explicit per-slot specifications (people count overrides, locked slots, cuisine/format hints)",
		"",
		"Your output is STRICT JSON with this shape:",
		"{",
		'  "meals": [',
		"    {",
		'      "date": "YYYY-MM-DD",',
		'      "slot": "breakfast" | "lunch" | "dinner",',
		'      "title": "concise dish name a person would write on a menu",',
		'      "format": "bowl | salad | tacos | flatbread | soup | grain bowl | skillet | sandwich | omelette | curry | etc",',
		'      "people": int,',
		'      "cuisine": ["Mexican", "Japanese", ...],   // at least one concrete descriptor',
		'      "formula_ids": ["mise_formula_..."],   // MUST exist in formula_catalog',
		'      "raw_ingredients": [',
		'        { "name": "corn tortilla", "qty": 24, "unit": "tortilla", "grams": 720, "category": "grains" }',
		"      ],",
		'      "notes": ["short cooking note", ...],',
		'      "method_summary": "1-2 sentence description of how the dish comes together",',
		'      "leftovers_to": ["YYYY-MM-DD lunch", ...],   // dates this meal feeds; empty if none',
		'      "lineage": [   // why this dish — cite real sources from spence_context',
		'        { "source_kind": "personal_recipe", "source_id": "pr_abc", "source_title": "Mom\'s shakshuka", "influence": "format" },',
		'        { "source_kind": "canonical_dish", "source_id": "dish_xyz", "source_title": "Hummus", "influence": "method" },',
		'        { "source_kind": "affinity", "source_title": "chickpea ↔ tahini (pmi 12.3)", "influence": "flavor pairing" },',
		'        { "source_kind": "season", "source_title": "asparagus [peak]", "influence": "seasonal anchor" },',
		'        { "source_kind": "compound", "source_title": "chickpea ⇄ cumin (8 shared compounds)", "influence": "molecular pairing" },',
		'        { "source_kind": "template", "source_title": "tacos: shell + filling + slaw + sauce + acid", "influence": "structure" }',
		"      ]",
		"    }",
		"  ],",
		'  "snack_boxes": [',
		"    {",
		'      "date": "YYYY-MM-DD",',
		'      "title": "string",',
		'      "people": int,',
		'      "formula_ids": [...],',
		'      "items": ["specific labels: e.g. \'Hummus + warm pita\', \'Carrot ribbons\'"],',
		'      "raw_ingredients": [...]',
		"    }",
		"  ],",
		'  "rationale": "1-2 paragraphs explaining the arc of the week and the major sources you drew from"',
		"}",
		"",
		"HARD RULES:",
		"1. Reply with ONE valid JSON object and nothing else — no markdown, no prose preamble.",
		"2. EVERY formula_id must appear in the provided formula_catalog. Never invent IDs.",
		"2a. CLAIM FORMULA BATCHES AGGRESSIVELY. If your meal uses hummus, falafel, lemon-tahini sauce, herb yogurt/labneh, crispy chickpea, pickled radish, cold-fermented dough/pizza/flatbread, cooked chickpea, chia pudding, or overnight oats — INCLUDE the matching formula_id in formula_ids. Don't list those items in raw_ingredients; the formula already buys them. A meal that uses hummus without claiming mise_formula_hummus is a failure. Look at the formula_catalog before composing each meal and decide which formulas the dish leans on.",
		"3. Honor every slot's `people` count, `format`, `title_hint`, and `locked` status. If `locked: true`, keep the title hint verbatim.",
		"4. Honor dietary constraints exactly. The household is vegetarian unless dietary says otherwise. NO fish sauce, oyster sauce, anchovy paste, chicken stock, bacon, or any animal-derived ingredient when dietary='vegetarian'. Substitute soy sauce + dashi for fish sauce, miso for anchovy, vegetable stock for chicken stock.",
		"5. PER-SLOT CUISINE: each slot has its own `cuisine` array. If it's NON-EMPTY, that slot must clearly be that cuisine. If it's EMPTY, you are FREE to pick any cuisine that fits the household — don't default to the window's cuisine_direction.",
		"6. WINDOW CUISINE_DIRECTION IS A HINT, NOT A MANDATE. If cuisine_direction is ['Japanese', 'Mexican'], spread those across only PART of the window — typically 2-4 dinners total drawn from those cuisines, NOT every dinner. The rest of the dinners must come from a wide range of other cuisines + household standards (Mediterranean, Italian, Indian, Middle Eastern, Levantine, French, Thai, Vietnamese, Korean, Chinese, North African, Spanish, Peruvian, American, etc.) AND simple seasonal/produce-driven dishes. Variety across cuisines is the explicit goal — a 14-day plan that's only 2 cuisines is a failure.",
		"7. Match cuisine grammar precisely WHEN you do pick one. Mexican tacos NEED tortillas + salsa + acid + crunch. Japanese rice bowls NEED rice + sauce (miso/soy/ponzu) + a vegetable + protein. Don't slap a 'Japanese-style' prefix on a generic dish — only call it Japanese if it actually IS Japanese.",
		"8. Maximize variety across the window. Same dinner format may repeat at most twice in 14 days, and never two days in a row unless it's a clear leftover. Same cuisine should not appear more than ~3 times in 14 dinners.",
		"9. Lunches are usually leftover-driven from the prior dinner. ALWAYS populate `leftovers_to` on dinners that produce more than one meal's worth of food (stews, soups, curries, pasta, pizza, fritters, etc.) — list the future dates+slots that eat the leftovers. Empty `leftovers_to` on a hearty dinner is a failure. Lunches that are NOT leftovers must be real lunches (not just 2 sauces).",
		"10. Breakfasts can be quick (chia jars, oats) on most days but include 2-3 cooked or savory breakfasts across the window.",
		"11. Snack boxes are mezze-style: a dip + a crunch + a fruit + a savory bite. Pull from formula_catalog where possible (hummus, lemon tahini sauce, pickled radish, etc.) plus seasonal fruit.",
		"12. raw_ingredients lists items NOT in the formula library: tortillas, rice, salsa, lime, cilantro, queso fresco, miso paste, nori, ginger, eggs, etc. Always include qty + unit + grams when possible.",
		"13. For meals serving more than the household default (e.g. lunch for 8), scale formula servings AND raw ingredients proportionally.",
		"14. Use anchor_ingredients (chickpea, tahini, asparagus, etc.) prominently across the window. Don't ignore them.",
		"15. Pantry items (flour, rice, etc.) can be used freely without listing as raw_ingredients unless they're a notable quantity.",
		"16. Empty / sparse output is failure. Every slot in the input must produce a meal.",
		"17. The meal `cuisine` field in your output should reflect the DISH'S actual cuisine (e.g. ['Italian'] for a pasta, ['Mediterranean'] for a chickpea bowl, ['California'] or ['American'] for a household standard like avocado toast). Never leave cuisine empty, but don't echo the window's cuisine_direction onto every meal.",
		"",
		"USING SPENCE_CONTEXT (the corpus + household memory):",
		"- `canonical_dishes` is a list of REAL dishes from a 16k-recipe corpus that match the household's anchor ingredients. PREFER picking a real dish from this list when one matches the slot well — your title should match its title, your method should reflect the corpus consensus. Cite via lineage entry { source_kind: 'canonical_dish', source_id: <id>, source_title: <title>, influence: <e.g. 'format' or 'method'> }.",
		"- `canonical_components` lists reusable corpus components (sauces, dips, fillings). When you reuse a component across dishes, pick the same canonical name so the household's prep effort compounds.",
		"- `top_affinity_pairs` are PMI-weighted ingredient pairings from the corpus. Lean on these for flavor logic. Cite { source_kind: 'affinity', source_title: 'chickpea ↔ tahini (pmi 12.3)', influence: 'flavor pairing' } when you used it.",
		"- `seasonal_now` lists what's PEAK / COMING / DEPARTING for the plan dates and the household's region. Build dinners around peak items first. Cite { source_kind: 'season', source_title: 'asparagus [peak]', influence: 'seasonal anchor' }.",
		"- `flavor_compound_pairings` are FoodDB molecular pairings — ingredients sharing aromatic compounds taste good together. Use this for novel pairings.",
		"- `composition_templates` are canonical format templates (e.g. tacos: shell+filling+slaw+sauce+acid+crunch). Use them to ensure each meal is structurally complete.",
		"- `format_library` is the *expanded* format catalog with cuisine_riffs per format. Each entry tells you the structural slots of a format (burger: bun+patty+sauce+pickle+crunch; pizza: dough+sauce+cheese+toppings) AND the top cuisine variants that have been observed in the corpus + curated for this household. PREFER pulling format choices from this library. When you see a riff like 'burger × Korean: gochujang aioli + kimchi slaw' or 'pizza × Mediterranean: harissa + feta + olives', that's a real chef-validated combination — use it. The library is what makes 'gochujang aioli on a smashburger' a normal Tuesday, not a gimmick.",
		"- `cuisine_fusions` lists CHEF-VALIDATED cross-cuisine fusion patterns with affinity scores (Korean-Mexican, Indo-Chinese, Nikkei, Italian-Levantine, Vietnamese-French, Tex-Mex, etc.) AND anti-fusions to avoid. When you compose a fusion meal, lean on these — don't invent random cross-mashups. e.g. 'Korean-Mexican: kimchi quesadilla, bulgogi taco, gochujang carnitas' is real; 'French-Thai: boeuf bourguignon w/ lemongrass' is not.",
		"- `flavor_vibes` are the household's signature flavor *moves* — gochujang-aioli, miso-butter, preserved-lemon-everything, chili-crisp-on-everything, harissa-honey, smoky-citrus, herby-creamy-acid, etc. These are the textures and combos that make food taste 'elevated' rather than 'recipe-following'. SCATTER 2-4 of these vibes across the window, especially on weekend dinners. A grain bowl with 'miso-tahini-lemon dressing' beats a generic 'tahini bowl' every time. Cite via lineage { source_kind: 'household_pattern', source_title: 'gochujang-aioli vibe', influence: 'flavor signature' }.",
		"- `personal_recipes_loved` are the household's saved/loved recipes. PREFER riffing on these when slot fits — your title can reference the source ('Mom's shakshuka with herb yogurt'), and you must cite { source_kind: 'personal_recipe', source_id, source_title, influence: 'format' or 'flavor' }.",
		"- `overlapping_inventory` lists projected resources from PRIOR plans that overlap this window. PREFER using these BEFORE proposing fresh prep.",
		"",
		"LINEAGE:",
		"- Every meal MUST have 1-3 lineage entries (max 3 to keep output compact).",
		"- Genuinely sourced lineage > generic. Don't fabricate IDs — only cite source_ids that actually appeared in spence_context.",
		"- Lineage tells the user why this dish ended up on their plan. Make it informative.",
		"",
		"OUTPUT BUDGET:",
		"- method_summary: keep to 1 short sentence (under 25 words).",
		"- raw_ingredients: only list items NOT in formulas. Don't restate formula contents.",
		"- notes: 0-2 short notes per meal, only when actionable.",
		"- The full JSON should be under 18,000 output tokens. Be terse but informative.",
		"",
		"REAL-CHEF VARIETY (NEW — read carefully):",
		"- `recent_menu` lists what this household ate over the LAST ~28 days. Treat `saturated_anchors` (pressure ≥ 0.6) as a soft AVOID for the new window. Don't build 5 chickpea dinners if chickpea is at 0.95 already. Prefer fresh anchors.",
		"- `recent_formats` shows which formats dominated recently (e.g. bowl × 7). PIVOT to under-represented formats: skillet, gratin, hot-pot, risotto, paella, mezze, omelette, flatbread, sandwich, etc.",
		"- Format variety > cuisine variety. 3 'bowls' in a row feels monotonous EVEN if cuisines differ.",
		"- Heavy/light alternation: stew/risotto/casserole/curry are HEAVY. Salad/mezze-plate/leftover/soup are LIGHT. Don't stack 3+ heavies in a row.",
		"- Same dinner format may repeat at most twice in 14 days. Never two in a row unless explicitly a leftover.",
		"",
		"PANTRY PRESSURE (NEW):",
		"- `pantry_pressure.expiring_within_window` lists items that go bad before this plan ends. PRIORITIZE meals that use these items — losing food is the cardinal sin.",
		"- `pantry_pressure.opened_perishable` is open jars/bags decaying. Lean on them before opening new ones.",
		"",
		"TASTE FEEDBACK (NEW):",
		"- `feedback_hints.loved_titles` are dishes the household rated 4-5★ recently. Riff on these formats/anchors when fitting.",
		"- `feedback_hints.rejected_titles` are dishes they didn't finish or rated low. AVOID these specific dishes; be cautious with their format+anchor combination.",
		"- `feedback_hints.loved_anchors`/`loved_cuisines` show what works for them. Bias toward these on at least 3 dinners per 14-day window.",
		"",
		"OUTPUT TONE:",
		"- Real dishes a chef would name (not 'Reset lunch plate' or 'Japanese-style soup').",
		"- Specific sauces/garnishes/methods that bring it to life.",
		"- Names that honor the cuisine (chankonabe, escabeche, sopa de fideo, oyakodon, machacado, kake udon, tinga, kasha varnishkes, kitsune udon, esquites, etc.).",
		"",
		"COMPOSITION (NEW — think in plate parts, not just dishes):",
		"- A real plate has parts: a main, often a starch / bread / side / sauce. Think in those parts when picking a format.",
		"- Each format implies a set of required + optional structural roles. Examples:",
		"  - burger → bun (bread), patty (main), [sauce, pickle, crunch, salad].",
		"  - pizza → dough (bread), [sauce], topping(s), [salad].",
		"  - frittata → frittata (main), [bread side, salad].",
		"  - taco → shell, filling, [sauce, pickle, crunch].",
		"  - bowl/donburi → starch, protein, [vegetable, sauce, garnish].",
		"  - mezze → main dip, [bread, pickle, vegetable_side].",
		"- For each role you can either: compose inline from raw_ingredients, REUSE an existing prep batch (e.g. Sat dough batch covers Mon flatbread bread role), build a NEW batch via a formula, or buy ready-made (sandwich bread, tortillas, hamburger buns).",
		"- PREFER reusing batches across meals when shelf life allows — Sat dough batch should cover Mon bread instead of buying sourdough. The downstream post-pass infers components deterministically; you don't need to emit them, but if you do, name the role explicitly so the post-pass leaves your choices alone.",
	].join("\n");
}

function formulaRoleHint(label: string): string {
	const normalized = label.toLowerCase();
	if (normalized.includes("hummus")) return "dip / spread / sandwich filling — works in mezze, snack boxes, sandwiches, bowls";
	if (normalized.includes("crispy chickpea")) return "savory crunchy topping — salads, tacos, grain bowls, snacks";
	if (normalized.includes("falafel")) return "fried bean fritter — pita, salad, mezze plate";
	if (normalized.includes("cooked whole chickpea")) return "neutral cooked legume base — bowls, soups, stews, salads";
	if (normalized.includes("lemon tahini")) return "creamy citrus sauce — drizzle on bowls, salads, roasted veg, pita";
	if (normalized.includes("herb yogurt")) return "cooling herb sauce — flatbreads, dips, grilled veg";
	if (normalized.includes("pickled radish")) return "acidic crunch — tacos, snack boxes, mezze";
	if (normalized.includes("dough")) return "fermented dough — flatbread, pizza, focaccia";
	if (normalized.includes("chia pudding")) return "make-ahead breakfast jar";
	if (normalized.includes("overnight oats")) return "make-ahead breakfast jar";
	return "";
}

interface ComposerOutputShape {
	meals?: Array<Partial<ComposedMeal> & {
		date?: string;
		slot?: string;
		title?: string;
		format?: string;
		people?: number;
		cuisine?: string[];
		formula_ids?: string[];
		raw_ingredients?: ComposerRawIngredient[];
		notes?: string[];
		method_summary?: string;
		leftovers_to?: string[];
		lineage?: ComposerLineageRef[];
	}>;
	snack_boxes?: Array<Partial<ComposerSnackBox> & {
		date?: string;
		title?: string;
		people?: number;
		formula_ids?: string[];
		items?: string[];
		raw_ingredients?: ComposerRawIngredient[];
	}>;
	rationale?: string;
}

function normalizeMeal(meal: NonNullable<ComposerOutputShape["meals"]>[number], validFormulaIds: Set<string>, defaultPeople: number, _defaultCuisine: string[]): ComposedMeal {
	const slot = (meal.slot === "breakfast" || meal.slot === "lunch" || meal.slot === "dinner" || meal.slot === "snack") ? meal.slot : "dinner";
	const formulaIds = (meal.formula_ids || []).filter(id => validFormulaIds.has(id));
	return {
		date: typeof meal.date === "string" ? meal.date : "",
		slot,
		title: typeof meal.title === "string" && meal.title ? meal.title : "Untitled meal",
		format: typeof meal.format === "string" ? meal.format : "meal",
		people: typeof meal.people === "number" && meal.people > 0 ? meal.people : defaultPeople,
		// Trust the LLM's per-meal cuisine choice; the post-pass fills misses.
		cuisine: Array.isArray(meal.cuisine) ? meal.cuisine.filter((c): c is string => typeof c === "string") : [],
		formula_ids: formulaIds,
		raw_ingredients: normalizeRawIngredients(meal.raw_ingredients),
		notes: Array.isArray(meal.notes) ? meal.notes.filter((n): n is string => typeof n === "string") : [],
		method_summary: typeof meal.method_summary === "string" ? meal.method_summary : "",
		leftovers_to: Array.isArray(meal.leftovers_to) ? meal.leftovers_to.filter((d): d is string => typeof d === "string") : [],
		lineage: normalizeLineage(meal.lineage),
	};
}

function normalizeLineage(value: ComposerLineageRef[] | undefined): ComposerLineageRef[] {
	if (!Array.isArray(value)) return [];
	const valid: ComposerLineageRef["source_kind"][] = ["personal_recipe", "canonical_dish", "canonical_component", "affinity", "season", "compound", "household_pattern", "template"];
	const out: ComposerLineageRef[] = [];
	for (const ref of value) {
		if (!ref || typeof ref !== "object") continue;
		const kindRaw = typeof ref.source_kind === "string" ? ref.source_kind : "";
		const kind = (valid as string[]).includes(kindRaw) ? kindRaw as ComposerLineageRef["source_kind"] : null;
		if (!kind) continue;
		const influence = typeof ref.influence === "string" ? ref.influence.trim() : "";
		if (!influence) continue;
		out.push({
			source_kind: kind,
			source_id: typeof ref.source_id === "string" ? ref.source_id : undefined,
			source_title: typeof ref.source_title === "string" ? ref.source_title : undefined,
			influence,
			confidence: typeof ref.confidence === "number" ? ref.confidence : undefined,
		});
	}
	return out;
}

function normalizeSnack(snack: NonNullable<ComposerOutputShape["snack_boxes"]>[number], validFormulaIds: Set<string>, defaultPeople: number): ComposerSnackBox {
	return {
		date: typeof snack.date === "string" ? snack.date : "",
		title: typeof snack.title === "string" && snack.title ? snack.title : "Snack box",
		people: typeof snack.people === "number" && snack.people > 0 ? snack.people : defaultPeople,
		formula_ids: (snack.formula_ids || []).filter(id => validFormulaIds.has(id)),
		items: Array.isArray(snack.items) ? snack.items.filter((i): i is string => typeof i === "string") : [],
		raw_ingredients: normalizeRawIngredients(snack.raw_ingredients),
	};
}

function normalizeRawIngredients(raw: ComposerRawIngredient[] | undefined): ComposerRawIngredient[] {
	if (!Array.isArray(raw)) return [];
	const out: ComposerRawIngredient[] = [];
	for (const item of raw) {
		if (!item || typeof item !== "object") continue;
		const name = typeof item.name === "string" ? item.name.trim() : "";
		if (!name) continue;
		out.push({
			name,
			qty: typeof item.qty === "number" && Number.isFinite(item.qty) ? item.qty : null,
			unit: typeof item.unit === "string" ? item.unit : null,
			grams: typeof item.grams === "number" && Number.isFinite(item.grams) ? item.grams : null,
			category: typeof item.category === "string" ? item.category : null,
		});
	}
	return out;
}

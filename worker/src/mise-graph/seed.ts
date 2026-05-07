type JsonObject = Record<string, unknown>;

export interface MiseSeedState {
	id: string;
	canonical_name: string;
	state_name: string;
	display_name: string;
	state_kind: string;
	component_type?: string;
	default_storage?: string;
	default_container?: string;
	quality_window_hours?: number;
	active_window_hours?: number;
	prep_level?: string;
	source?: string;
	meta?: JsonObject;
}

export interface MiseSeedEdge {
	id: string;
	from_state_id: string;
	to_state_id: string;
	edge_type: string;
	action_label: string;
	technique?: string;
	equipment?: string[];
	station_tags?: string[];
	cuisine_grammars?: string[];
	format_tags?: string[];
	active_time_min?: number;
	idle_time_min?: number;
	lead_time_hours?: number;
	yield_ratio?: number;
	storage_effect?: string;
	quality_window_hours?: number;
	difficulty?: string;
	confidence?: number;
	source?: string;
	rationale?: string;
	meta?: JsonObject;
}

export interface MiseSeedStationRule {
	id: string;
	station_tag: string;
	station_name: string;
	trigger_kind: string;
	equipment?: string[];
	cheap_branches?: string[];
	default_questions?: string[];
	source?: string;
	meta?: JsonObject;
}

export interface MiseGraphSeedPayload {
	states: MiseSeedState[];
	edges: MiseSeedEdge[];
	station_rules: MiseSeedStationRule[];
}

export const miseGraphSeed: MiseGraphSeedPayload = {
	station_rules: [
		{
			id: "mise_station_legume_batch_active",
			station_tag: "legume_batch_active",
			station_name: "Legume Batch Active",
			trigger_kind: "active_station",
			equipment: ["instant pot", "stock pot", "sheet pan"],
			cheap_branches: ["cook extra whole legumes", "reserve cooking liquid", "split beans for dip, salad, and crisping"],
			default_questions: ["Should any cooked legumes stay neutral?", "Is there a snack-box dip this week?"],
		},
		{
			id: "mise_station_herb_wash_active",
			station_tag: "herb_wash_active",
			station_name: "Herb Wash Active",
			trigger_kind: "active_station",
			equipment: ["salad spinner", "chef knife"],
			cheap_branches: ["whole-leaf reserve", "chopped herb mix", "stems for sauce or stock"],
			default_questions: ["Which herbs need to stay whole?", "Should stems become sauce base?"],
		},
		{
			id: "mise_station_pickle_active",
			station_tag: "pickle_active",
			station_name: "Quick Pickle Active",
			trigger_kind: "active_station",
			equipment: ["jar", "mandoline", "chef knife"],
			cheap_branches: ["salted crunch", "vinegar pickle", "yogurt-tahini topping"],
			default_questions: ["Does the week need acid or fresh crunch?", "Which vegetables have the shortest window?"],
		},
		{
			id: "mise_station_dough_active",
			station_tag: "dough_active",
			station_name: "Dough Active",
			trigger_kind: "active_station",
			equipment: ["mixing bowl", "scale", "ooni", "oven"],
			cheap_branches: ["cold-fermented dough", "same-day flatbread", "par-baked pocket bread"],
			default_questions: ["Is there a high-heat cooking window?", "Should dough become flatbread or pizza?"],
		},
		{
			id: "mise_station_sauce_active",
			station_tag: "sauce_active",
			station_name: "Sauce Active",
			trigger_kind: "active_station",
			equipment: ["whisk", "jar", "blender"],
			cheap_branches: ["tahini sauce", "yogurt sauce", "herb sauce", "dip base"],
			default_questions: ["Does this sauce need to be thick for dipping or loose for dressing?", "What acid balances it?"],
		},
		{
			id: "mise_station_blender_active",
			station_tag: "blender_active",
			station_name: "Blender or Processor Active",
			trigger_kind: "active_station",
			equipment: ["food processor", "blender", "immersion blender"],
			cheap_branches: ["hummus", "herb sauce", "lentil dip", "falafel mix"],
			default_questions: ["Can two puree/chop tasks share cleanup?", "Is texture meant to be smooth or coarse?"],
		},
	],
	states: [
		state("chickpea", "dry", "dry chickpeas", "raw", 8760, "pantry", "jar"),
		state("chickpea", "soaked", "soaked chickpeas", "soaked", 24, "refrigerator", "covered container"),
		state("chickpea", "cooked_whole", "cooked whole chickpeas", "cooked", 120, "refrigerator", "deli container"),
		state("chickpea", "hummus", "hummus", "dip", 96, "refrigerator", "lidded tub", "dip"),
		state("chickpea", "crispy", "crispy chickpeas", "topping", 24, "room temperature", "loose-lid container", "crunch"),
		state("chickpea", "falafel_mix", "falafel mix", "component", 24, "refrigerator", "covered container", "formed_component"),
		state("herbs", "raw_bunched", "raw bunched herbs", "raw", 72, "refrigerator", "produce bag"),
		state("herbs", "washed", "washed herbs", "washed", 72, "refrigerator", "towel-lined container"),
		state("herbs", "whole_leaf_reserve", "whole-leaf herb reserve", "component", 72, "refrigerator", "towel-lined container", "garnish"),
		state("herbs", "chopped_mix", "chopped herb mix", "component", 24, "refrigerator", "small deli container", "garnish"),
		state("herbs", "stem_reserve", "herb stem reserve", "component", 48, "refrigerator", "small deli container", "sauce_base"),
		state("cucumber", "raw", "raw cucumbers", "raw", 120, "refrigerator", "produce drawer"),
		state("cucumber", "salted", "salted cucumbers", "component", 24, "refrigerator", "deli container", "crunch"),
		state("cucumber", "quick_pickle", "quick-pickled cucumbers", "pickle", 120, "refrigerator", "jar", "pickle"),
		state("radish", "raw", "raw radishes", "raw", 120, "refrigerator", "produce drawer"),
		state("radish", "quick_pickle", "quick-pickled radishes", "pickle", 120, "refrigerator", "jar", "pickle"),
		state("dough", "mixed", "mixed dough", "dough", 12, "room temperature", "covered bowl", "dough"),
		state("dough", "cold_fermented", "cold-fermented dough", "dough", 120, "refrigerator", "covered container", "dough"),
		state("dough", "flatbread", "cooked flatbread", "bread", 48, "room temperature", "bag", "bread"),
		state("dough", "pizza_shell", "par-baked pizza shell", "bread", 48, "room temperature", "bag", "bread"),
		state("tahini", "jarred", "jarred tahini", "pantry", 4320, "pantry", "jar"),
		state("tahini", "lemon_sauce", "lemon tahini sauce", "sauce", 120, "refrigerator", "jar", "sauce"),
		state("yogurt", "plain", "plain yogurt", "refrigerated", 168, "refrigerator", "tub"),
		state("yogurt", "herb_sauce", "herb yogurt sauce", "sauce", 72, "refrigerator", "jar", "sauce"),
		state("lentil", "dry", "dry lentils", "raw", 8760, "pantry", "jar"),
		state("lentil", "cooked", "cooked lentils", "cooked", 120, "refrigerator", "deli container"),
		state("lentil", "marinated_salad", "marinated lentil salad", "component", 120, "refrigerator", "deli container", "salad"),
		state("lentil", "dip", "lentil dip", "dip", 96, "refrigerator", "lidded tub", "dip"),
	],
	edges: [
		edge("chickpea", "dry", "soaked", "soak overnight", "soak", ["mixing bowl"], ["legume_batch_active"], 5, 480, 12, "Soaking opens falafel and shorter cook-time branches."),
		edge("chickpea", "dry", "cooked_whole", "pressure cook", "pressure cook", ["instant pot"], ["legume_batch_active"], 10, 45, 1, "Dry chickpeas can become neutral cooked beans for several weekly components."),
		edge("chickpea", "soaked", "cooked_whole", "simmer soaked chickpeas", "simmer", ["stock pot"], ["legume_batch_active"], 10, 60, 2, "Soaked chickpeas can still become a neutral cooked batch."),
		edge("chickpea", "soaked", "falafel_mix", "grind falafel mix", "chop", ["food processor"], ["legume_batch_active", "blender_active"], 20, 30, 1, "A soaked split supports a project branch without committing the whole batch."),
		edge("chickpea", "cooked_whole", "hummus", "blend hummus", "puree", ["food processor"], ["legume_batch_active", "blender_active", "sauce_active"], 12, 0, 0, "Cooked chickpeas plus tahini produce a durable snack-box dip."),
		edge("chickpea", "cooked_whole", "crispy", "roast crispy chickpeas", "roast", ["sheet pan", "oven"], ["legume_batch_active"], 8, 25, 1, "A small cooked-bean split creates crunch for bowls and salads."),
		edge("herbs", "raw_bunched", "washed", "wash and spin herbs", "wash", ["salad spinner"], ["herb_wash_active"], 10, 0, 0, "Washed herbs become a branching point for garnish, sauce, and chopped mixes."),
		edge("herbs", "washed", "whole_leaf_reserve", "reserve tender leaves", "pick", ["salad spinner"], ["herb_wash_active"], 5, 0, 0, "Whole leaves preserve freshness for bowls, salads, and flatbreads."),
		edge("herbs", "washed", "chopped_mix", "chop herb mix", "chop", ["chef knife"], ["herb_wash_active"], 8, 0, 0, "Chopped herbs are fast finishing insurance for legumes, sauces, and salads."),
		edge("herbs", "washed", "stem_reserve", "reserve stems", "trim", ["chef knife"], ["herb_wash_active", "sauce_active"], 3, 0, 0, "Stems are useful when a blender or sauce station is already active."),
		edge("cucumber", "raw", "salted", "salt cucumbers", "salt", ["chef knife"], ["pickle_active"], 8, 15, 1, "Salted cucumber adds same-day crunch without committing to pickle flavor."),
		edge("cucumber", "raw", "quick_pickle", "quick pickle cucumbers", "pickle", ["jar"], ["pickle_active"], 10, 30, 1, "Quick pickles add acid and extend cucumber utility across snack boxes and bowls."),
		edge("radish", "raw", "quick_pickle", "quick pickle radishes", "pickle", ["jar"], ["pickle_active"], 10, 30, 1, "Radishes become a durable acidic crunch for mezze, tacos, and salads."),
		edge("dough", "mixed", "cold_fermented", "cold ferment dough", "cold ferment", ["mixing bowl"], ["dough_active"], 10, 1440, 24, "Cold fermentation converts one dough task into flexible later bread or pizza options."),
		edge("dough", "mixed", "flatbread", "cook same-day flatbread", "griddle", ["cast iron skillet", "ooni"], ["dough_active"], 20, 30, 1, "Same-day flatbread is a fallback when no long ferment window exists."),
		edge("dough", "cold_fermented", "flatbread", "fire flatbread", "bake", ["ooni", "oven"], ["dough_active"], 20, 0, 0, "Fermented dough turns a high-heat window into bread for dips and salads."),
		edge("dough", "cold_fermented", "pizza_shell", "par-bake pizza shell", "bake", ["ooni", "oven"], ["dough_active"], 25, 0, 0, "Par-baked shells preserve the Ooni session for faster later meals."),
		edge("tahini", "jarred", "lemon_sauce", "whisk lemon tahini sauce", "whisk", ["jar", "whisk"], ["sauce_active"], 8, 0, 0, "A loose tahini sauce bridges chickpeas, roasted vegetables, bowls, and flatbreads."),
		edge("yogurt", "plain", "herb_sauce", "stir herb yogurt sauce", "stir", ["bowl"], ["sauce_active", "herb_wash_active"], 8, 0, 0, "Yogurt sauce is a cooling branch when herbs are already washed."),
		edge("lentil", "dry", "cooked", "simmer lentils", "simmer", ["saucepan"], ["legume_batch_active"], 8, 25, 1, "Lentils cook quickly and add a low-burden legume batch option."),
		edge("lentil", "cooked", "marinated_salad", "marinate lentil salad", "marinate", ["mixing bowl"], ["legume_batch_active"], 12, 30, 1, "Marinated lentils hold well and improve with a short rest."),
		edge("lentil", "cooked", "dip", "blend lentil dip", "puree", ["food processor"], ["legume_batch_active", "blender_active", "sauce_active"], 10, 0, 0, "Lentils can use the same processor cleanup window as hummus or herb sauce."),
	],
};

export async function seedMiseGraph(db: D1Database, seed: MiseGraphSeedPayload = miseGraphSeed): Promise<{
	states: number;
	edges: number;
	station_rules: number;
}> {
	let states = 0;
	let edges = 0;
	let stationRules = 0;

	for (const item of seed.states) {
		await db.prepare(`
			INSERT OR IGNORE INTO mise_ingredient_states
			(id, canonical_name, state_name, display_name, state_kind, component_type,
			 default_storage, default_container, quality_window_hours, active_window_hours,
			 prep_level, source, meta_json)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).bind(
			item.id,
			item.canonical_name,
			item.state_name,
			item.display_name,
			item.state_kind,
			item.component_type || null,
			item.default_storage || null,
			item.default_container || null,
			item.quality_window_hours || null,
			item.active_window_hours || null,
			item.prep_level || "global",
			item.source || "mise_graph_seed",
			JSON.stringify(item.meta || {}),
		).run();
		states++;
	}

	for (const item of seed.edges) {
		await db.prepare(`
			INSERT OR IGNORE INTO mise_edges
			(id, from_state_id, to_state_id, edge_type, action_label, technique,
			 equipment_json, station_tags_json, cuisine_grammars_json, format_tags_json,
			 active_time_min, idle_time_min, lead_time_hours, yield_ratio,
			 storage_effect, quality_window_hours, difficulty, confidence,
			 source, rationale, meta_json)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).bind(
			item.id,
			item.from_state_id,
			item.to_state_id,
			item.edge_type,
			item.action_label,
			item.technique || null,
			JSON.stringify(item.equipment || []),
			JSON.stringify(item.station_tags || []),
			JSON.stringify(item.cuisine_grammars || []),
			JSON.stringify(item.format_tags || []),
			item.active_time_min || null,
			item.idle_time_min || null,
			item.lead_time_hours || null,
			item.yield_ratio || null,
			item.storage_effect || null,
			item.quality_window_hours || null,
			item.difficulty || "easy",
			item.confidence ?? 0.75,
			item.source || "mise_graph_seed",
			item.rationale || null,
			JSON.stringify(item.meta || {}),
		).run();
		edges++;
	}

	for (const item of seed.station_rules) {
		await db.prepare(`
			INSERT OR IGNORE INTO mise_station_rules
			(id, station_tag, station_name, trigger_kind, equipment_json,
			 cheap_branches_json, default_questions_json, source, meta_json)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).bind(
			item.id,
			item.station_tag,
			item.station_name,
			item.trigger_kind,
			JSON.stringify(item.equipment || []),
			JSON.stringify(item.cheap_branches || []),
			JSON.stringify(item.default_questions || []),
			item.source || "mise_graph_seed",
			JSON.stringify(item.meta || {}),
		).run();
		stationRules++;
	}

	return { states, edges, station_rules: stationRules };
}

function state(
	canonicalName: string,
	stateName: string,
	displayName: string,
	stateKind: string,
	qualityWindowHours: number,
	defaultStorage: string,
	defaultContainer: string,
	componentType?: string,
): MiseSeedState {
	return {
		id: `mise_state_${canonicalName}_${stateName}`,
		canonical_name: canonicalName,
		state_name: stateName,
		display_name: displayName,
		state_kind: stateKind,
		component_type: componentType,
		default_storage: defaultStorage,
		default_container: defaultContainer,
		quality_window_hours: qualityWindowHours,
		prep_level: "global",
		source: "mise_graph_seed",
	};
}

function edge(
	canonicalName: string,
	fromStateName: string,
	toStateName: string,
	actionLabel: string,
	technique: string,
	equipment: string[],
	stationTags: string[],
	activeTimeMin: number,
	idleTimeMin: number,
	leadTimeHours: number,
	rationale: string,
): MiseSeedEdge {
	const fromStateId = `mise_state_${canonicalName}_${fromStateName}`;
	const toStateId = `mise_state_${canonicalName}_${toStateName}`;
	return {
		id: `mise_edge_${canonicalName}_${fromStateName}_to_${toStateName}`,
		from_state_id: fromStateId,
		to_state_id: toStateId,
		edge_type: "state_transition",
		action_label: actionLabel,
		technique,
		equipment,
		station_tags: stationTags,
		active_time_min: activeTimeMin,
		idle_time_min: idleTimeMin,
		lead_time_hours: leadTimeHours,
		confidence: 0.8,
		source: "mise_graph_seed",
		rationale,
	};
}

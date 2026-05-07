/** Cloudflare Workers AI binding shape — `env.AI.run(model, options)`. We
 *  type it loosely (record-ish input/output) because the full Workers AI
 *  surface is huge and we only call llama-3.2-3b-instruct from the intent
 *  router. */
export interface WorkersAiBinding {
	run(
		model: string,
		options: Record<string, unknown>,
	): Promise<unknown>;
}

export interface MiseGraphEnv {
	DB: D1Database;
	// Mesh-Claude bridge (optional — only present when wrangler config wires
	// the vpc_networks MESH binding + BRIDGE_HOST/BRIDGE_PORT vars + BRIDGE_SECRET.
	// Used by worker/src/mise-graph/llm-bridge.ts for menu composition / riffs.
	MESH?: { fetch: typeof fetch };
	BRIDGE_HOST?: string;
	BRIDGE_PORT?: string;
	BRIDGE_SECRET?: string;
	// Workers AI binding — cheap fast classifier (Phase 3 intent router uses
	// @cf/meta/llama-3.2-3b-instruct). Optional so older configs / tests that
	// don't wire it still typecheck; the intent router defaults to free_chat
	// when the binding is missing.
	AI?: WorkersAiBinding;
}

export interface MiseIngredientState {
	id: string;
	canonical_ingredient_id: number | null;
	produce_profile_id: number | null;
	canonical_name: string;
	state_name: string;
	display_name: string;
	state_kind: string;
	component_type: string | null;
	default_storage: string | null;
	default_container: string | null;
	quality_window_hours: number | null;
	active_window_hours: number | null;
	prep_level: string | null;
	source: string | null;
	meta_json: string | null;
	created_at: string;
	updated_at: string | null;
}

export interface MiseEdge {
	id: string;
	from_state_id: string;
	to_state_id: string;
	edge_type: string;
	action_label: string | null;
	technique: string | null;
	equipment_json: string | null;
	station_tags_json: string | null;
	cuisine_grammars_json: string | null;
	format_tags_json: string | null;
	active_time_min: number | null;
	idle_time_min: number | null;
	lead_time_hours: number | null;
	yield_ratio: number | null;
	storage_effect: string | null;
	quality_window_hours: number | null;
	difficulty: string | null;
	confidence: number | null;
	source: string | null;
	rationale: string | null;
	meta_json: string | null;
	created_at: string;
	updated_at: string | null;
}

export interface MiseStateTemplate {
	id: string;
	state_name: string;
	display_name: string;
	state_kind: string;
	quality_window_hours: number | null;
	edges: Array<{
		to_state_name: string;
		edge_type: string;
		action_label: string;
		technique: string | null;
		station_tags: string[];
		equipment: string[];
		rationale: string;
	}>;
}

export interface MiseExpansionInput {
	ingredients: string[];
	limit: number;
	include_templates: boolean;
}

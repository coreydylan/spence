// One-shot LLM-driven enrichment for canonical_components.
//
// Backfills the `cuisine_signature` and `variant_names` columns by sending
// batches of component rows to mesh-Claude (via the existing llm-bridge) and
// asking the model to return chef-grade cuisine signatures + cuisine-fusion
// riff names per row. Designed to be called once from a route handler — the
// integrator wires the route, this module just exposes the function.
//
// Cost shape: ~13 batches × 8 components × ~5s/call ≈ 70-90s total for the
// 105-row corpus. Cost runs through Corey's Claude Code subscription via
// the mesh-Claude bridge (no API spend).

import { callMeshClaudeJSON, type MeshClaudeEnv } from "./llm-bridge";
import type { MiseGraphEnv } from "./types";

// ---------------------------------------------------------------------------
// Types

interface CanonicalComponentRow {
	id: number;
	canonical_name: string;
	family: string | null;
	component_type: string | null;
	core_ingredients: string | null;
	common_ingredients: string | null;
	optional_ingredients: string | null;
	cuisine_signature: string | null;
	variant_names: string | null;
}

interface ComponentForLlm {
	id: number;
	canonical_name: string;
	family: string | null;
	component_type: string | null;
	core_ingredients: string[];
	common_ingredients: string[];
	optional_ingredients: string[];
}

interface LlmResultRow {
	id: number;
	cuisine_signature: string[];
	variant_names: string[];
}

interface LlmResponseShape {
	results?: LlmResultRow[];
}

export interface EnrichOptions {
	batch_size?: number;
	dry_run?: boolean;
	only_missing?: boolean;
}

export interface EnrichResult {
	processed: number;
	updated: number;
	skipped: number;
	errors: Array<{ id: number; error: string }>;
	sample: Array<{
		canonical_name: string;
		cuisine_signature: string[];
		variant_names: string[];
	}>;
}

// ---------------------------------------------------------------------------
// Public API

export async function enrichCanonicalComponents(
	env: MiseGraphEnv,
	opts: EnrichOptions = {},
): Promise<EnrichResult> {
	const batchSize = Math.max(1, Math.min(opts.batch_size ?? 8, 16));
	const dryRun = opts.dry_run === true;
	const onlyMissing = opts.only_missing !== false; // default true

	const result: EnrichResult = {
		processed: 0,
		updated: 0,
		skipped: 0,
		errors: [],
		sample: [],
	};

	const rows = await loadComponentRows(env, onlyMissing);
	if (rows.length === 0) return result;

	const components: ComponentForLlm[] = rows.map(row => ({
		id: row.id,
		canonical_name: row.canonical_name,
		family: row.family,
		component_type: row.component_type,
		core_ingredients: parseStringArray(row.core_ingredients),
		common_ingredients: parseStringArray(row.common_ingredients),
		optional_ingredients: parseStringArray(row.optional_ingredients),
	}));

	const system = enrichmentSystemPrompt();

	for (let offset = 0; offset < components.length; offset += batchSize) {
		const batch = components.slice(offset, offset + batchSize);
		result.processed += batch.length;

		let llmResults: LlmResultRow[] = [];
		try {
			llmResults = await runBatch(env, system, batch);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			for (const item of batch) {
				result.errors.push({ id: item.id, error: `batch failed: ${message}` });
				result.skipped += 1;
			}
			continue;
		}

		const byId = new Map<number, LlmResultRow>();
		for (const r of llmResults) {
			if (!r || typeof r.id !== "number") continue;
			byId.set(r.id, r);
		}

		for (const item of batch) {
			const enriched = byId.get(item.id);
			if (!enriched) {
				result.skipped += 1;
				result.errors.push({ id: item.id, error: "no result returned for id" });
				continue;
			}
			const cuisine = sanitizeStringArray(enriched.cuisine_signature, 1, 4);
			const variants = sanitizeStringArray(enriched.variant_names, 4, 8);
			if (cuisine.length === 0 || variants.length === 0) {
				result.skipped += 1;
				result.errors.push({ id: item.id, error: "validation failed: empty cuisine_signature or variant_names" });
				continue;
			}

			if (!dryRun) {
				try {
					await env.DB.prepare(
						"UPDATE canonical_components SET cuisine_signature = ?, variant_names = ? WHERE id = ?",
					)
						.bind(JSON.stringify(cuisine), JSON.stringify(variants), item.id)
						.run();
					result.updated += 1;
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					result.errors.push({ id: item.id, error: `update failed: ${message}` });
					result.skipped += 1;
					continue;
				}
			} else {
				result.updated += 1;
			}

			if (result.sample.length < 10) {
				result.sample.push({
					canonical_name: item.canonical_name,
					cuisine_signature: cuisine,
					variant_names: variants,
				});
			}
		}
	}

	return result;
}

// ---------------------------------------------------------------------------
// System prompt (exported so the integrator can log / inspect it)

export function enrichmentSystemPrompt(): string {
	return [
		"You are a chef-grade culinary taxonomist. Given a batch of canonical sauce/dip/dressing/butter/etc components, return their cuisine_signature and a list of cuisine-fusion variant_names.",
		"",
		"OUTPUT FORMAT — strict JSON only, no markdown fences, no commentary:",
		'{"results":[{"id":<int>,"cuisine_signature":["..."],"variant_names":["..."]},...]}',
		"",
		"`results` MUST contain one entry per input component, keyed by the input id.",
		"",
		"cuisine_signature rules:",
		"- 1 to 4 strings.",
		"- Use legitimate culinary cuisine names, not just countries. Prefer regional/cultural designators that a chef would recognize:",
		'  - "Levantine" (not "Lebanon"), "Provencal" (not "France"), "Sichuan" (not "China"), "Yucatecan" (not "Mexico").',
		"- If the component is a true fusion or modern hybrid, name the fusion explicitly:",
		'  - "Korean-Mexican fusion", "Korean-Western fusion", "Modern American", "California cuisine".',
		"- Order from most specific origin to broader umbrella when both apply (e.g. [\"Lebanese\",\"Levantine\",\"Mediterranean\"]).",
		"- Do NOT pad with generic labels like \"International\" or \"World\".",
		"",
		"variant_names rules:",
		"- 4 to 8 strings, each one a CHEF-GRADE specific riff name.",
		"- Each name must be specific enough that a cook reading it knows exactly what's different (an ingredient, a technique, or a clear cuisine pivot).",
		'- BAD (too generic): "spicy hummus", "fancy aioli", "herb sauce".',
		'- GOOD (specific): "harissa hummus", "muhammara-style hummus", "gochujang aioli", "preserved-lemon aioli", "miso brown butter".',
		"- Embrace cross-cuisine fusion — these are exactly the riffs we want:",
		'  - aioli → "gochujang aioli","calabrian-chili aioli","yuzu-kosho aioli","miso aioli".',
		'  - chimichurri → "calabrian chimichurri","cilantro-mint chimichurri","green-tomato chimichurri".',
		'  - butter → "brown butter","miso butter","anchovy butter","calabrian-chili butter","seaweed butter".',
		"- Do NOT invent names that don't make culinary sense (no \"fish-sauce caesar\", no \"chocolate hummus\").",
		"- For ambiguous base components like plain butter or plain mayonnaise, lean on classic compound-flavor variants (compound butters, infused oils, etc.).",
		"- Names should be lowercase except for proper nouns/cuisines (\"Calabrian-chili aioli\" or \"calabrian-chili aioli\" are both fine; pick one and stay consistent).",
		"",
		"Quality bar:",
		"- Treat the input core_ingredients as the anchor — variants should be recognizable evolutions of that base, not entirely different sauces.",
		"- A working chef should look at the variants and think \"yes, those are real things people make.\"",
		"",
		"Return STRICT JSON. No markdown fences. No prose. No trailing commas.",
	].join("\n");
}

// ---------------------------------------------------------------------------
// Internals

async function loadComponentRows(env: MiseGraphEnv, onlyMissing: boolean): Promise<CanonicalComponentRow[]> {
	const baseSelect = `
		SELECT id, canonical_name, family, component_type,
			core_ingredients, common_ingredients, optional_ingredients,
			cuisine_signature, variant_names
		FROM canonical_components
	`;
	const where = onlyMissing
		? `WHERE cuisine_signature IS NULL OR cuisine_signature = '[]'
			OR variant_names IS NULL OR variant_names = '[]'`
		: "";
	const sql = `${baseSelect} ${where} ORDER BY id ASC`;
	const rs = await env.DB.prepare(sql).all<CanonicalComponentRow>();
	return rs.results || [];
}

async function runBatch(
	env: MiseGraphEnv,
	system: string,
	batch: ComponentForLlm[],
): Promise<LlmResultRow[]> {
	const meshEnv = ensureMeshEnv(env);
	const userPayload = {
		components: batch.map(item => ({
			id: item.id,
			canonical_name: item.canonical_name,
			family: item.family,
			component_type: item.component_type,
			core_ingredients: item.core_ingredients,
			common_ingredients: item.common_ingredients,
			optional_ingredients: item.optional_ingredients,
		})),
	};
	const prompt = [
		"Enrich the following canonical_components. For each one, return a chef-grade cuisine_signature (1-4 strings) and 4-8 specific cuisine-fusion variant_names.",
		"",
		"Input batch (JSON):",
		JSON.stringify(userPayload, null, 2),
		"",
		"Return strict JSON of the form:",
		'{"results":[{"id":<int>,"cuisine_signature":["..."],"variant_names":["..."]},...]}',
	].join("\n");

	const response = await callMeshClaudeJSON<LlmResponseShape>(meshEnv, {
		prompt,
		system,
		model: "claude-haiku-4-5-20251001",
	});

	if (!response.ok || !response.data) {
		const reason = response.raw.error || response.raw.reason || "no data";
		throw new Error(`mesh-claude returned no parseable JSON: ${reason}`);
	}

	const results = response.data.results;
	if (!Array.isArray(results)) {
		throw new Error("response missing `results` array");
	}
	return results;
}

function ensureMeshEnv(env: MiseGraphEnv): MeshClaudeEnv {
	if (!env.MESH || !env.BRIDGE_HOST || !env.BRIDGE_PORT || !env.BRIDGE_SECRET) {
		throw new Error("mesh-claude bridge not configured (MESH binding + BRIDGE_HOST/PORT/SECRET required)");
	}
	return {
		MESH: env.MESH,
		BRIDGE_HOST: env.BRIDGE_HOST,
		BRIDGE_PORT: env.BRIDGE_PORT,
		BRIDGE_SECRET: env.BRIDGE_SECRET,
	};
}

function parseStringArray(raw: string | null | undefined): string[] {
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
	} catch {
		return [];
	}
}

function sanitizeStringArray(raw: unknown, min: number, max: number): string[] {
	if (!Array.isArray(raw)) return [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const value of raw) {
		if (typeof value !== "string") continue;
		const trimmed = value.trim();
		if (!trimmed) continue;
		const key = trimmed.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(trimmed);
		if (out.length >= max) break;
	}
	if (out.length < min) return [];
	return out;
}

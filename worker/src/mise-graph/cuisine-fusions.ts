// cuisine-fusions.ts
// ----------------------------------------------------------------------------
// Cuisine fusions + cross-cuisine flavor vibes loader.
//
// Backs the menu composer with two pieces of grounding the rest of the
// mise-graph never carried:
//
//   1. mise_cuisine_fusions — pairwise cuisine-affinity rows that capture
//      "Korean-Mexican is established," "Indo-Chinese is its own cuisine,"
//      "French-Japanese is delicate but real," "Tex-Mex is canon," and a
//      handful of DIVERGENCES (e.g. classic French + heavy garam-masala
//      tend to clash). Each row carries example dishes and example
//      components (sub-recipes / sauces) so the composer can riff on
//      proven combinations rather than hallucinating.
//
//   2. mise_flavor_vibes — named cross-cuisine flavor "moods" with their
//      signature ingredients and example dishes/components: gochujang
//      aioli, miso-butter on anything, preserved-lemon-everything,
//      chili-crisp-on-everything, herby-creamy-acid, harissa-honey, etc.
//      These travel across cuisines and let the composer push a menu in
//      a flavor direction without locking it to one cuisine label.
//
// Read-only at runtime; written once via seedCuisineFusions(db) — the
// integrator wires that into the deploy pipeline.
//
// Defensive parsing: every JSON column is guarded; bad rows are skipped,
// not thrown. The composer must never crash because grounding data is
// missing or malformed.
// ----------------------------------------------------------------------------

import type { MiseGraphEnv } from "./types";
import {
	cuisineFusionsSeed,
	cuisineDivergencesSeed,
	flavorVibesSeed,
} from "./cuisine-fusions-seed";

// ---------- Public types ----------------------------------------------------

export interface CuisineFusion {
	id: string;
	cuisine_a: string;
	cuisine_b: string;
	fusion_label: string | null;
	affinity: number;
	is_canon: boolean;
	example_dishes: string[];
	example_components: string[];
	notes: string | null;
}

export type FlavorVibeKind =
	| "sauce"
	| "spice"
	| "method"
	| "produce"
	| "umami"
	| "general";

export interface FlavorVibe {
	id: string;
	label: string;
	description: string | null;
	cross_cuisine_marker: string | null;
	signature_ingredients: string[];
	example_dishes: string[];
	example_components: string[];
	vibe_kind: FlavorVibeKind;
}

export interface LoadCuisineFusionsOptions {
	min_affinity?: number;
	cuisine_filter?: string[];
}

export interface LoadFlavorVibesOptions {
	vibe_kind?: string;
	max?: number;
}

// ---------- Internal raw row shapes ----------------------------------------

interface RawFusionRow {
	id: string;
	cuisine_a: string;
	cuisine_b: string;
	fusion_label: string | null;
	affinity: number | null;
	is_canon: number | null;
	example_dishes: string | null;
	example_components: string | null;
	notes: string | null;
}

interface RawVibeRow {
	id: string;
	label: string;
	description: string | null;
	cross_cuisine_marker: string | null;
	signature_ingredients: string | null;
	example_dishes: string | null;
	example_components: string | null;
	vibe_kind: string | null;
}

// ---------- Seeding ---------------------------------------------------------

/**
 * Insert (OR IGNORE) every fusion + divergence row + every vibe row into the
 * mise_cuisine_fusions and mise_flavor_vibes tables. Idempotent.
 *
 * Returns counts of rows attempted (existing rows still count as "seeded" so
 * the integrator can verify the seed list size).
 */
export async function seedCuisineFusions(
	db: D1Database,
): Promise<{ fusions_seeded: number; vibes_seeded: number }> {
	let fusions = 0;
	let vibes = 0;

	const allFusions = [...cuisineFusionsSeed, ...cuisineDivergencesSeed];

	for (const f of allFusions) {
		await db
			.prepare(
				`INSERT OR IGNORE INTO mise_cuisine_fusions
				 (id, cuisine_a, cuisine_b, fusion_label, affinity, is_canon,
				  example_dishes, example_components, notes, meta_json)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				f.id,
				f.cuisine_a,
				f.cuisine_b,
				f.fusion_label,
				f.affinity,
				f.is_canon ? 1 : 0,
				JSON.stringify(f.example_dishes || []),
				JSON.stringify(f.example_components || []),
				f.notes,
				"{}",
			)
			.run();
		fusions++;
	}

	for (const v of flavorVibesSeed) {
		await db
			.prepare(
				`INSERT OR IGNORE INTO mise_flavor_vibes
				 (id, label, description, cross_cuisine_marker, signature_ingredients,
				  example_dishes, example_components, vibe_kind, meta_json)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				v.id,
				v.label,
				v.description,
				v.cross_cuisine_marker,
				JSON.stringify(v.signature_ingredients || []),
				JSON.stringify(v.example_dishes || []),
				JSON.stringify(v.example_components || []),
				v.vibe_kind,
				"{}",
			)
			.run();
		vibes++;
	}

	return { fusions_seeded: fusions, vibes_seeded: vibes };
}

// ---------- Loaders ---------------------------------------------------------

/**
 * Load cuisine fusion rows. Defaults: no filter, no minimum affinity, sorted
 * by affinity DESC then is_canon DESC. Pass `min_affinity` to drop divergences,
 * pass `cuisine_filter` to restrict to fusions involving any of the named
 * cuisines (matched against either cuisine_a or cuisine_b, lowercased).
 *
 * Defensive: returns [] on any DB error or empty table.
 */
export async function loadCuisineFusions(
	env: MiseGraphEnv,
	opts?: LoadCuisineFusionsOptions,
): Promise<CuisineFusion[]> {
	let rows: RawFusionRow[] = [];
	try {
		const result = await env.DB.prepare(
			`SELECT id, cuisine_a, cuisine_b, fusion_label, affinity, is_canon,
			        example_dishes, example_components, notes
			 FROM mise_cuisine_fusions`,
		).all<RawFusionRow>();
		rows = result.results || [];
	} catch {
		return [];
	}

	const minAffinity =
		typeof opts?.min_affinity === "number" && Number.isFinite(opts.min_affinity)
			? opts.min_affinity
			: null;
	const filter = normalizeFilter(opts?.cuisine_filter);

	const out: CuisineFusion[] = [];
	for (const raw of rows) {
		if (!raw || typeof raw.id !== "string" || !raw.id) continue;
		const cuisine_a = typeof raw.cuisine_a === "string" ? raw.cuisine_a : "";
		const cuisine_b = typeof raw.cuisine_b === "string" ? raw.cuisine_b : "";
		if (!cuisine_a || !cuisine_b) continue;
		const affinity = clamp01(toFiniteNumber(raw.affinity, 0));
		if (minAffinity !== null && affinity < minAffinity) continue;
		if (filter && !filter.has(cuisine_a.toLowerCase()) && !filter.has(cuisine_b.toLowerCase())) {
			continue;
		}
		out.push({
			id: raw.id,
			cuisine_a,
			cuisine_b,
			fusion_label: stringOrNull(raw.fusion_label),
			affinity,
			is_canon: raw.is_canon === 1,
			example_dishes: parseStringArray(raw.example_dishes),
			example_components: parseStringArray(raw.example_components),
			notes: stringOrNull(raw.notes),
		});
	}

	out.sort((a, b) => {
		if (b.affinity !== a.affinity) return b.affinity - a.affinity;
		if (a.is_canon !== b.is_canon) return a.is_canon ? -1 : 1;
		return a.cuisine_a.localeCompare(b.cuisine_a);
	});

	return out;
}

/**
 * Load flavor vibe rows. Defaults: no filter, sorted alphabetically by label.
 * Pass `vibe_kind` to filter to one kind, pass `max` to cap result count.
 *
 * Defensive: returns [] on any DB error or empty table.
 */
export async function loadFlavorVibes(
	env: MiseGraphEnv,
	opts?: LoadFlavorVibesOptions,
): Promise<FlavorVibe[]> {
	let rows: RawVibeRow[] = [];
	try {
		const result = await env.DB.prepare(
			`SELECT id, label, description, cross_cuisine_marker, signature_ingredients,
			        example_dishes, example_components, vibe_kind
			 FROM mise_flavor_vibes`,
		).all<RawVibeRow>();
		rows = result.results || [];
	} catch {
		return [];
	}

	const kindFilter =
		typeof opts?.vibe_kind === "string" && opts.vibe_kind
			? opts.vibe_kind.toLowerCase()
			: null;
	const max = clampPositiveInt(opts?.max, Number.MAX_SAFE_INTEGER);

	const out: FlavorVibe[] = [];
	for (const raw of rows) {
		if (!raw || typeof raw.id !== "string" || !raw.id) continue;
		const label = typeof raw.label === "string" ? raw.label : "";
		if (!label) continue;
		const vibe_kind = normalizeVibeKind(raw.vibe_kind);
		if (kindFilter && vibe_kind.toLowerCase() !== kindFilter) continue;
		out.push({
			id: raw.id,
			label,
			description: stringOrNull(raw.description),
			cross_cuisine_marker: stringOrNull(raw.cross_cuisine_marker),
			signature_ingredients: parseStringArray(raw.signature_ingredients),
			example_dishes: parseStringArray(raw.example_dishes),
			example_components: parseStringArray(raw.example_components),
			vibe_kind,
		});
	}

	out.sort((a, b) => a.label.localeCompare(b.label));
	if (out.length > max) out.length = max;
	return out;
}

// ---------- Prompt formatters -----------------------------------------------

/**
 * Render fusion rows as compact chef-shorthand strings ready to inline into
 * the menu-composer LLM payload. Order preserved from the input array.
 *
 * Examples:
 *   "Korean-Mexican (canon, 0.90): kalbi short-rib tacos / kimchi quesadilla / bulgogi torta — uses gochujang aioli, kimchi salsa, sesame-cilantro slaw"
 *   "Italian + Japanese (0.50): miso butter pasta / uni risotto — uses miso butter, yuzu-kosho cream"
 *   "AVOID Indian + Japanese (0.30): heavy garam-masala + dashi/miso usually clash"
 */
export function formatCuisineFusionsForPrompt(
	fusions: CuisineFusion[],
): string[] {
	return fusions.map(formatFusionLine);
}

/**
 * Render vibe rows as compact chef-shorthand strings ready to inline into the
 * menu-composer LLM payload. Order preserved.
 *
 * Example:
 *   "gochujang-aioli (sauce, Korean-Western fusion sauces): gochujang + mayo + sesame oil — components: gochujang aioli, kimchi mayo — works on: Korean smashburger, fried chicken sandwich"
 */
export function formatFlavorVibesForPrompt(vibes: FlavorVibe[]): string[] {
	return vibes.map(formatVibeLine);
}

// ---------- Internal helpers ------------------------------------------------

function formatFusionLine(f: CuisineFusion): string {
	const isDivergence = f.affinity < 0.45;
	const tagBits: string[] = [];
	if (f.is_canon) tagBits.push("canon");
	tagBits.push(f.affinity.toFixed(2));
	const tags = `(${tagBits.join(", ")})`;

	const label = f.fusion_label
		? f.fusion_label
		: `${capitalize(f.cuisine_a)} + ${capitalize(f.cuisine_b)}`;

	if (isDivergence) {
		const note = f.notes ? f.notes.replace(/^DIVERGENCE:\s*/i, "") : "rarely lands";
		return `AVOID ${label} ${tags}: ${note}`;
	}

	const dishBlob = f.example_dishes.slice(0, 3).join(" / ");
	const compBlob =
		f.example_components.length > 0
			? ` — uses ${f.example_components.slice(0, 4).join(", ")}`
			: "";
	const dishPart = dishBlob ? `: ${dishBlob}` : "";
	return `${label} ${tags}${dishPart}${compBlob}`;
}

function formatVibeLine(v: FlavorVibe): string {
	const markerBits: string[] = [v.vibe_kind];
	if (v.cross_cuisine_marker) markerBits.push(v.cross_cuisine_marker);
	const markers = `(${markerBits.join(", ")})`;

	const sig =
		v.signature_ingredients.length > 0
			? v.signature_ingredients.slice(0, 4).join(" + ")
			: "";
	const sigPart = sig ? `: ${sig}` : "";

	const components =
		v.example_components.length > 0
			? ` — components: ${v.example_components.slice(0, 3).join(", ")}`
			: "";

	const dishes =
		v.example_dishes.length > 0
			? ` — works on: ${v.example_dishes.slice(0, 3).join(", ")}`
			: "";

	return `${v.label} ${markers}${sigPart}${components}${dishes}`;
}

function parseStringArray(value: string | null | undefined): string[] {
	if (!value) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const out: string[] = [];
	for (const item of parsed) {
		if (typeof item === "string" && item) out.push(item);
	}
	return out;
}

function normalizeFilter(filter: string[] | undefined): Set<string> | null {
	if (!filter || !Array.isArray(filter) || filter.length === 0) return null;
	const set = new Set<string>();
	for (const c of filter) {
		if (typeof c === "string" && c) set.add(c.toLowerCase());
	}
	return set.size > 0 ? set : null;
}

function normalizeVibeKind(value: string | null | undefined): FlavorVibeKind {
	const allowed: FlavorVibeKind[] = ["sauce", "spice", "method", "produce", "umami", "general"];
	if (typeof value === "string") {
		const lower = value.toLowerCase();
		for (const k of allowed) {
			if (k === lower) return k;
		}
	}
	return "general";
}

function stringOrNull(value: unknown): string | null {
	return typeof value === "string" && value ? value : null;
}

function toFiniteNumber(value: unknown, fallback: number): number {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const n = Number(value);
		if (Number.isFinite(n)) return n;
	}
	return fallback;
}

function clamp01(value: number): number {
	if (value < 0) return 0;
	if (value > 1) return 1;
	return value;
}

function clampPositiveInt(value: number | undefined, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	const n = Math.floor(value);
	return n > 0 ? n : fallback;
}

function capitalize(s: string): string {
	if (!s) return "";
	return s.charAt(0).toUpperCase() + s.slice(1);
}

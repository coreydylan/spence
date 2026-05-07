/**
 * Format Library Loader
 *
 * Reads the `composition_templates` D1 table and surfaces the FULL cuisine-variant
 * frequency data into a shape the menu composer can use.
 *
 * Each composition_templates row stores:
 *   - slots_json:        Slot definitions ({ name, required, min, max })
 *   - variant_sets_json: Corpus-mined cuisine variants. For each cuisine, the most
 *                        common ingredients per slot with frequency (0-1) and count.
 *
 * The existing composer-context loader only surfaces slot NAMES; this loader
 * preserves the rich corpus signals so the LLM can riff on Italian/Japanese/etc.
 * patterns when composing menus.
 */
import type { MiseGraphEnv } from "./types";

// ---------- Public types ----------

export interface FormatTemplate {
	name: string;                       // bowl, taco, pasta, etc.
	slots: Array<{
		name: string;                     // base, protein, vegetable, sauce, finish
		required: boolean;
		min: number;
		max: number;
	}>;
	cuisine_variants: Array<{
		cuisine: string;                  // italian, japanese, mediterranean, mexican, ...
		label: string;                    // "Italian Bowl", "Japanese Bowl", ...
		recipe_count: number;
		slot_signals: Record<string, Array<{
			ingredient: string;
			frequency: number;              // 0-1
			count: number;
		}>>;
	}>;
}

export interface FormatLibrary {
	templates: FormatTemplate[];
	by_name: Map<string, FormatTemplate>;
}

export interface FormatPromptShape {
	// What gets inlined into the composer LLM payload — compact but rich.
	format: string;
	slots: string;                       // "base (req 1) + protein (req 1-2) + vegetable (req 2-5) + sauce (req 1) + finish (opt 0-3)"
	cuisine_riffs: Array<{
		cuisine: string;
		label: string;
		top_ingredients_per_slot: string;  // "vegetable: garlic 87% / olive oil 70% / onion 37%; sauce: parmesan 30% / butter 20%; finish: parsley 30% / lemon juice 27%"
	}>;
}

// ---------- Tunables ----------

const NOISE_FREQUENCY_THRESHOLD = 0.1;
const DEFAULT_MAX_CUISINES_PER_FORMAT = 5;
const DEFAULT_MAX_INGREDIENTS_PER_SLOT = 4;

// ---------- Internal raw shapes (what's in the DB columns) ----------

interface RawSlot {
	name?: unknown;
	required?: unknown;
	min?: unknown;
	max?: unknown;
}

interface RawVariantIngredient {
	name?: unknown;
	frequency?: unknown;
	count?: unknown;
}

interface RawVariantSet {
	cuisine?: unknown;
	label?: unknown;
	recipe_count?: unknown;
	slots?: unknown;
}

// ---------- Public API ----------

/**
 * Read every row from `composition_templates`, parse both JSON columns, and
 * return a structured `FormatLibrary` with cuisine variants sorted by recipe_count
 * (DESC) and slot ingredients sorted by frequency (DESC). Noise (frequency < 0.1)
 * is dropped from slot_signals.
 *
 * Robust to malformed columns: returns an empty library on any DB or parse error.
 */
export async function loadFormatLibrary(env: MiseGraphEnv): Promise<FormatLibrary> {
	const empty: FormatLibrary = { templates: [], by_name: new Map() };
	let rows: Array<{ name: string; slots_json: string | null; variant_sets_json: string | null }>;
	try {
		const result = await env.DB.prepare(`
			SELECT name, slots_json, variant_sets_json
			FROM composition_templates
		`).all<{
			name: string;
			slots_json: string | null;
			variant_sets_json: string | null;
		}>();
		rows = result.results || [];
	} catch {
		return empty;
	}

	const templates: FormatTemplate[] = [];
	for (const row of rows) {
		if (!row || typeof row.name !== "string" || !row.name) continue;
		const slots = parseSlots(row.slots_json);
		const cuisine_variants = parseVariantSets(row.variant_sets_json);
		templates.push({
			name: row.name,
			slots,
			cuisine_variants,
		});
	}

	const by_name = new Map<string, FormatTemplate>();
	for (const t of templates) {
		by_name.set(t.name.toLowerCase(), t);
	}

	return { templates, by_name };
}

/**
 * Convert a `FormatLibrary` into compact `FormatPromptShape[]` strings ready to
 * inline into the menu-composer LLM payload. Output uses chef shorthand, not raw
 * JSON.
 *
 * Defaults: 5 cuisines per format, top 4 ingredients per slot.
 */
export function formatLibraryForComposer(
	library: FormatLibrary,
	opts?: { max_cuisines_per_format?: number; max_ingredients_per_slot?: number },
): FormatPromptShape[] {
	const maxCuisines = clampPositiveInt(opts?.max_cuisines_per_format, DEFAULT_MAX_CUISINES_PER_FORMAT);
	const maxIngredients = clampPositiveInt(opts?.max_ingredients_per_slot, DEFAULT_MAX_INGREDIENTS_PER_SLOT);

	return library.templates.map(template => ({
		format: template.name,
		slots: renderSlotsLine(template.slots),
		cuisine_riffs: template.cuisine_variants.slice(0, maxCuisines).map(variant => ({
			cuisine: variant.cuisine,
			label: variant.label,
			top_ingredients_per_slot: renderCuisineSlotLine(variant.slot_signals, maxIngredients),
		})),
	}));
}

/**
 * Case-insensitive lookup of a single format template.
 */
export function findFormatTemplate(library: FormatLibrary, format: string): FormatTemplate | null {
	if (!format) return null;
	return library.by_name.get(format.toLowerCase()) ?? null;
}

// ---------- Parsing helpers (defensive) ----------

function safeParse(value: string | null | undefined): unknown {
	if (!value) return null;
	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
}

function parseSlots(value: string | null | undefined): FormatTemplate["slots"] {
	const parsed = safeParse(value);
	if (!Array.isArray(parsed)) return [];
	const out: FormatTemplate["slots"] = [];
	for (const raw of parsed as RawSlot[]) {
		if (!raw || typeof raw !== "object") continue;
		const name = typeof raw.name === "string" ? raw.name : "";
		if (!name) continue;
		const required = raw.required === true;
		const min = toFiniteNumber(raw.min, 0);
		const max = toFiniteNumber(raw.max, Math.max(1, min));
		out.push({ name, required, min, max });
	}
	return out;
}

function parseVariantSets(value: string | null | undefined): FormatTemplate["cuisine_variants"] {
	const parsed = safeParse(value);
	if (!Array.isArray(parsed)) return [];
	const out: FormatTemplate["cuisine_variants"] = [];
	for (const raw of parsed as RawVariantSet[]) {
		if (!raw || typeof raw !== "object") continue;
		const cuisine = typeof raw.cuisine === "string" ? raw.cuisine : "";
		if (!cuisine) continue;
		const label = typeof raw.label === "string" && raw.label
			? raw.label
			: defaultLabel(cuisine);
		const recipe_count = toFiniteNumber(raw.recipe_count, 0);
		const slot_signals = parseSlotSignals(raw.slots);
		out.push({ cuisine, label, recipe_count, slot_signals });
	}
	// Most-common cuisines first.
	out.sort((a, b) => b.recipe_count - a.recipe_count);
	return out;
}

function parseSlotSignals(value: unknown): FormatTemplate["cuisine_variants"][number]["slot_signals"] {
	const out: FormatTemplate["cuisine_variants"][number]["slot_signals"] = {};
	if (!value || typeof value !== "object" || Array.isArray(value)) return out;
	const obj = value as Record<string, unknown>;
	for (const slotName of Object.keys(obj)) {
		const raw = obj[slotName];
		if (!Array.isArray(raw)) continue;
		const ings: Array<{ ingredient: string; frequency: number; count: number }> = [];
		for (const item of raw as RawVariantIngredient[]) {
			if (!item || typeof item !== "object") continue;
			const ingredient = typeof item.name === "string" ? item.name : "";
			if (!ingredient) continue;
			const frequency = toFiniteNumber(item.frequency, 0);
			if (frequency < NOISE_FREQUENCY_THRESHOLD) continue;
			const count = toFiniteNumber(item.count, 0);
			ings.push({ ingredient, frequency, count });
		}
		if (ings.length === 0) continue;
		// Highest-frequency ingredients first; preserve raw frequency values.
		ings.sort((a, b) => b.frequency - a.frequency);
		out[slotName] = ings;
	}
	return out;
}

// ---------- Rendering helpers (chef shorthand for the LLM) ----------

function renderSlotsLine(slots: FormatTemplate["slots"]): string {
	return slots.map(slot => {
		const flag = slot.required ? "req" : "opt";
		const range = slot.min === slot.max ? `${slot.min}` : `${slot.min}-${slot.max}`;
		return `${slot.name} (${flag} ${range})`;
	}).join(" + ");
}

function renderCuisineSlotLine(
	slot_signals: Record<string, Array<{ ingredient: string; frequency: number; count: number }>>,
	maxIngredients: number,
): string {
	const parts: string[] = [];
	for (const slotName of Object.keys(slot_signals)) {
		const ings = slot_signals[slotName];
		if (!ings || ings.length === 0) continue;
		const top = ings.slice(0, maxIngredients);
		const inner = top.map(i => `${i.ingredient} ${formatFrequency(i.frequency)}`).join(" / ");
		parts.push(`${slotName}: ${inner}`);
	}
	return parts.join("; ");
}

function formatFrequency(freq: number): string {
	const pct = Math.round(freq * 100);
	return `${pct}%`;
}

function defaultLabel(cuisine: string): string {
	if (!cuisine) return "";
	return cuisine.charAt(0).toUpperCase() + cuisine.slice(1);
}

// ---------- Misc helpers ----------

function toFiniteNumber(value: unknown, fallback: number): number {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const n = Number(value);
		if (Number.isFinite(n)) return n;
	}
	return fallback;
}

function clampPositiveInt(value: number | undefined, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	const n = Math.floor(value);
	return n > 0 ? n : fallback;
}

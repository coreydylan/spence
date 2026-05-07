// Format-vector variety analysis + composer hints.
//
// Real chefs vary FORMAT more than cuisine. Five Italian dishes can feel
// totally different (pasta, pizza, soup, salad, risotto), but five "bowls"
// across five cuisines feels monotonous because the eating experience is
// the same shape: scoop with a spoon out of a deep round vessel.
//
// This module:
//   1. classifies a meal's format heaviness (heavy / light / medium)
//   2. counts format frequencies across a window
//   3. flags consecutive-format runs (≥ 2 in a row, with the rule "two is
//      OK if one is leftover, three is the line")
//   4. flags consecutive-heaviness runs
//   5. produces composer hints — strings that can be injected into the
//      menu-composer system prompt to steer the next pick.
//
// Pure deterministic functions — no async, no I/O.

// --- format buckets ---------------------------------------------------------

// Canonical format buckets we track. The composer picks from a wider pool of
// format strings, so we normalize aggressively.
export const TRACKED_FORMATS = [
	"bowl",
	"rice-bowl",
	"donburi",
	"noodle",
	"pasta",
	"pizza",
	"flatbread",
	"taco",
	"burrito",
	"quesadilla",
	"sandwich",
	"salad",
	"soup",
	"stew",
	"curry",
	"shakshuka",
	"skillet",
	"omelette",
	"gratin",
	"casserole",
	"mezze-plate",
	"dumpling",
	"hot-pot",
	"risotto",
	"paella",
	"pilaf",
	"tagine",
	"plate",
	"leftover",
] as const;

export type TrackedFormat = (typeof TRACKED_FORMATS)[number];

// Heaviness — what the meal *feels* like in the body, not its calorie count.
// Heavy: long-cooked, starch-dense, rich. You don't want two in a row.
// Light: brothy, raw, room-temp; mostly vegetables/legumes/herbs.
// Medium: everything else — a balanced plate, skillet, taco night.
type Heaviness = "heavy" | "light" | "medium";

const HEAVINESS: Record<string, Heaviness> = {
	// heavy
	stew: "heavy",
	pasta: "heavy",
	risotto: "heavy",
	gratin: "heavy",
	casserole: "heavy",
	paella: "heavy",
	tagine: "heavy",
	"hot-pot": "heavy",
	curry: "heavy",
	pizza: "heavy",
	burrito: "heavy",
	pilaf: "medium", // not as heavy as risotto
	donburi: "medium",
	"rice-bowl": "medium",
	noodle: "medium",
	skillet: "medium",
	flatbread: "medium",
	taco: "medium",
	sandwich: "medium",
	quesadilla: "medium",
	dumpling: "medium",
	bowl: "medium",
	plate: "medium",
	shakshuka: "medium",
	omelette: "medium",
	// light
	salad: "light",
	soup: "light",
	"mezze-plate": "light",
	leftover: "light",
};

// Format normalization map. Wider than TRACKED_FORMATS because composer can
// emit raw strings like "pasta-bowl" or "stew-bowl" that we want to bucket
// to the most informative format.
const FORMAT_ALIASES: Record<string, TrackedFormat> = {
	bowl: "bowl",
	"grain-bowl": "rice-bowl",
	"rice-bowl": "rice-bowl",
	"rice bowl": "rice-bowl",
	donburi: "donburi",
	noodle: "noodle",
	noodles: "noodle",
	"noodle-bowl": "noodle",
	"noodle bowl": "noodle",
	ramen: "noodle",
	udon: "noodle",
	pho: "noodle",
	pasta: "pasta",
	"pasta-bowl": "pasta",
	spaghetti: "pasta",
	pizza: "pizza",
	flatbread: "flatbread",
	naan: "flatbread",
	pita: "flatbread",
	taco: "taco",
	tacos: "taco",
	burrito: "burrito",
	quesadilla: "quesadilla",
	sandwich: "sandwich",
	wrap: "sandwich",
	sub: "sandwich",
	salad: "salad",
	"salad-bowl": "salad",
	"big-salad": "salad",
	soup: "soup",
	stew: "stew",
	"stew-bowl": "stew",
	curry: "curry",
	"curry-bowl": "curry",
	shakshuka: "shakshuka",
	skillet: "skillet",
	"skillet-supper": "skillet",
	omelette: "omelette",
	omelet: "omelette",
	frittata: "omelette",
	gratin: "gratin",
	casserole: "casserole",
	bake: "casserole",
	"sheet-pan": "casserole",
	"sheet-pan-dinner": "casserole",
	"mezze-plate": "mezze-plate",
	mezze: "mezze-plate",
	"meze-plate": "mezze-plate",
	dumpling: "dumpling",
	dumplings: "dumpling",
	"hot-pot": "hot-pot",
	hotpot: "hot-pot",
	risotto: "risotto",
	paella: "paella",
	pilaf: "pilaf",
	tagine: "tagine",
	plate: "plate",
	leftover: "leftover",
	leftovers: "leftover",
};

function normalizeFormat(raw: string): TrackedFormat | null {
	const k = (raw ?? "").trim().toLowerCase();
	if (!k) return null;
	const direct = FORMAT_ALIASES[k];
	if (direct) return direct;
	// Try suffix/prefix matches (e.g. "spicy-noodle-bowl" -> noodle).
	for (const alias of Object.keys(FORMAT_ALIASES)) {
		if (k === alias) return FORMAT_ALIASES[alias] ?? null;
	}
	for (const alias of Object.keys(FORMAT_ALIASES)) {
		if (k.endsWith(`-${alias}`) || k.startsWith(`${alias}-`)) {
			return FORMAT_ALIASES[alias] ?? null;
		}
	}
	if (k.includes("bowl")) return "bowl";
	if (k.includes("salad")) return "salad";
	if (k.includes("soup")) return "soup";
	if (k.includes("stew")) return "stew";
	return null;
}

export function formatHeaviness(format: string): Heaviness {
	const norm = normalizeFormat(format);
	if (norm && HEAVINESS[norm]) return HEAVINESS[norm] as Heaviness;
	const direct = HEAVINESS[(format ?? "").trim().toLowerCase()];
	if (direct) return direct;
	return "medium";
}

// --- report types -----------------------------------------------------------

export interface FormatVarietyReport {
	format_counts: Record<string, number>;
	consecutive_format_runs: Array<{ format: string; dates: string[] }>;
	consecutive_heaviness_runs: Array<{ heaviness: Heaviness; dates: string[] }>;
	suggestions: string[];
}

export interface VarietyComposerHints {
	warn_format_repeats: Array<{ date: string; format: string; reason: string }>;
	suggest_alternation: string[];
	constraints_for_prompt: string[];
}

// --- helpers ----------------------------------------------------------------

interface NormalizedMeal {
	id: string;
	date: string;
	slot: string;
	format_raw: string;
	format: TrackedFormat | "unknown";
	heaviness: Heaviness;
	title?: string;
	is_leftover: boolean;
}

function normalizeMeal(m: {
	id: string;
	date: string;
	slot: string;
	format: string;
	title?: string;
}): NormalizedMeal {
	const norm = normalizeFormat(m.format);
	const heaviness = formatHeaviness(m.format);
	const titleLower = (m.title ?? "").toLowerCase();
	const formatLower = (m.format ?? "").toLowerCase();
	const is_leftover =
		norm === "leftover" ||
		formatLower.includes("leftover") ||
		titleLower.includes("leftover") ||
		titleLower.startsWith("rerun") ||
		titleLower.includes("repeat from");
	const meal: NormalizedMeal = {
		id: m.id,
		date: m.date,
		slot: m.slot,
		format_raw: m.format,
		format: norm ?? "unknown",
		heaviness,
		is_leftover,
	};
	if (m.title !== undefined) meal.title = m.title;
	return meal;
}

// Sort by date asc, then by slot in canonical mealtime order.
const SLOT_ORDER: Record<string, number> = {
	breakfast: 0,
	brunch: 1,
	lunch: 2,
	snack: 3,
	dinner: 4,
	supper: 4,
	dessert: 5,
};

function slotRank(slot: string): number {
	const k = (slot ?? "").trim().toLowerCase();
	if (SLOT_ORDER[k] !== undefined) return SLOT_ORDER[k] as number;
	return 9;
}

function sortMeals<T extends { date: string; slot: string }>(meals: T[]): T[] {
	return [...meals].sort((a, b) => {
		if (a.date !== b.date) return a.date < b.date ? -1 : 1;
		return slotRank(a.slot) - slotRank(b.slot);
	});
}

// Find consecutive runs of length >= 2 of equal key. We treat "leftover"
// runs as soft — a bowl followed by a leftover-bowl is fine, but three in
// a row even with one leftover is still a run worth flagging.
function findConsecutiveRuns<T>(
	items: T[],
	key: (t: T) => string,
	dateOf: (t: T) => string,
): Array<{ key: string; dates: string[] }> {
	const runs: Array<{ key: string; dates: string[] }> = [];
	let i = 0;
	while (i < items.length) {
		const item = items[i];
		if (!item) {
			i++;
			continue;
		}
		const k = key(item);
		let j = i + 1;
		const dates: string[] = [dateOf(item)];
		while (j < items.length) {
			const next = items[j];
			if (!next || key(next) !== k) break;
			dates.push(dateOf(next));
			j++;
		}
		if (dates.length >= 2) runs.push({ key: k, dates });
		i = j;
	}
	return runs;
}

// --- public: analyzeFormatVariety ------------------------------------------

export function analyzeFormatVariety(
	meals: Array<{ id: string; date: string; slot: string; format: string; title?: string }>,
): FormatVarietyReport {
	const normalized = meals.map(normalizeMeal);

	// Counts across all meals (regardless of slot — the user might be
	// looking at the dinner stream, the lunch stream, or the whole week).
	const format_counts: Record<string, number> = {};
	for (const m of normalized) {
		const k = m.format === "unknown" ? m.format_raw.trim().toLowerCase() || "unknown" : m.format;
		format_counts[k] = (format_counts[k] ?? 0) + 1;
	}

	// We compute consecutive runs over dinners specifically — that's the
	// "main meal" stream where format monotony hits hardest. If no dinners
	// exist, fall back to all meals so the analysis still runs.
	const dinnerStream = sortMeals(normalized.filter((m) => slotRank(m.slot) === SLOT_ORDER.dinner));
	const stream = dinnerStream.length > 0 ? dinnerStream : sortMeals(normalized);

	const formatRunsRaw = findConsecutiveRuns(
		stream,
		(m) => (m.format === "unknown" ? `unknown:${m.format_raw}` : m.format),
		(m) => m.date,
	);

	// Apply the "leftover softens it" rule:
	//   - a run of length 2 where one is a leftover is FINE (drop it)
	//   - a run of length >= 3 is always reported, even if some are leftovers
	const consecutive_format_runs: Array<{ format: string; dates: string[] }> = [];
	for (const run of formatRunsRaw) {
		const subset = stream.filter((m, i) => {
			const k = m.format === "unknown" ? `unknown:${m.format_raw}` : m.format;
			if (k !== run.key) return false;
			// Only the items contiguous to this run window.
			return run.dates.includes(m.date);
		});
		const leftoverCount = subset.filter((m) => m.is_leftover).length;
		if (run.dates.length === 2 && leftoverCount >= 1) continue;
		consecutive_format_runs.push({ format: run.key, dates: run.dates });
	}

	const heavinessRunsRaw = findConsecutiveRuns(
		stream,
		(m) => m.heaviness,
		(m) => m.date,
	);
	const consecutive_heaviness_runs: Array<{ heaviness: Heaviness; dates: string[] }> = heavinessRunsRaw
		.filter((r) => r.dates.length >= 2)
		.map((r) => ({ heaviness: r.key as Heaviness, dates: r.dates }));

	// Build suggestions.
	const suggestions: string[] = [];

	for (const run of consecutive_format_runs) {
		const fmt = run.format.startsWith("unknown:") ? run.format.slice(8) : run.format;
		if (run.dates.length >= 3) {
			const target = suggestAlternativesFor(fmt as TrackedFormat);
			suggestions.push(
				`${run.dates.length} ${fmt}s in a row (${run.dates.join(", ")}) — break it on ${run.dates[1]} with a ${target.join(" or ")}.`,
			);
		} else if (run.dates.length === 2) {
			const target = suggestAlternativesFor(fmt as TrackedFormat);
			const lastDate = run.dates[run.dates.length - 1];
			suggestions.push(
				`back-to-back ${fmt} on ${run.dates.join(", ")} — fine if ${lastDate} is leftover, otherwise swap to ${target.join(" or ")}.`,
			);
		}
	}

	for (const run of consecutive_heaviness_runs) {
		if (run.heaviness === "heavy" && run.dates.length >= 2) {
			suggestions.push(
				`${run.dates.length} heavy dinners in a row (${run.dates.join(", ")}) — alternate with a soup, salad, or mezze plate.`,
			);
		}
		if (run.heaviness === "light" && run.dates.length >= 3) {
			suggestions.push(
				`${run.dates.length} light dinners in a row (${run.dates.join(", ")}) — anchor one with a stew, pasta, or risotto.`,
			);
		}
	}

	// Catch the "everything is a bowl" case even without consecutive runs.
	const bowlish = (format_counts["bowl"] ?? 0) + (format_counts["rice-bowl"] ?? 0) + (format_counts["noodle"] ?? 0) + (format_counts["donburi"] ?? 0);
	const totalDinners = dinnerStream.length || normalized.length;
	if (totalDinners >= 4 && bowlish / totalDinners >= 0.6) {
		suggestions.push(
			`bowl-shaped formats are ${bowlish}/${totalDinners} of meals — propose at least one flatbread, skillet, or plated dinner this week.`,
		);
	}

	return {
		format_counts,
		consecutive_format_runs,
		consecutive_heaviness_runs,
		suggestions,
	};
}

// --- alternation suggestions ------------------------------------------------

// For a given format, what's a good "swap" candidate that breaks the streak?
// Picked to feel different at the table — different vessel, different
// utensil, different cooking time scale.
function suggestAlternativesFor(format: TrackedFormat | string): string[] {
	switch (format) {
		case "bowl":
		case "rice-bowl":
		case "donburi":
		case "noodle":
			return ["flatbread", "skillet", "plate"];
		case "salad":
			return ["soup", "skillet", "flatbread"];
		case "soup":
			return ["salad", "skillet", "sandwich"];
		case "stew":
		case "curry":
		case "tagine":
			return ["salad", "mezze-plate", "skillet"];
		case "pasta":
		case "risotto":
			return ["salad", "skillet", "soup"];
		case "pizza":
		case "flatbread":
			return ["soup", "salad", "bowl"];
		case "taco":
		case "burrito":
		case "quesadilla":
			return ["salad", "soup", "skillet"];
		case "sandwich":
			return ["soup", "salad", "skillet"];
		case "skillet":
			return ["salad", "soup", "flatbread"];
		case "casserole":
		case "gratin":
			return ["salad", "soup", "mezze-plate"];
		case "shakshuka":
		case "omelette":
			return ["bowl", "salad", "skillet"];
		default:
			return ["salad", "skillet", "soup"];
	}
}

// --- public: varietyComposerHints -------------------------------------------

export function varietyComposerHints(
	recent_dinners: Array<{ date: string; format: string }>,
	current_window_meals: Array<{ date: string; slot: string; format: string }>,
): VarietyComposerHints {
	// Normalize.
	const recent = recent_dinners.map((d, i) => normalizeMeal({ id: `recent-${i}`, slot: "dinner", ...d }));
	const current = current_window_meals.map((m, i) =>
		normalizeMeal({ id: `current-${i}`, ...m }),
	);

	const warn_format_repeats: VarietyComposerHints["warn_format_repeats"] = [];
	const suggest_alternation: string[] = [];
	const constraints_for_prompt: string[] = [];

	// Look at the trailing edge of recent_dinners — what formats are "warm",
	// i.e. used in the last 3 days?
	const recentSorted = sortMeals(recent);
	const trailing = recentSorted.slice(-3);
	const warmFormats = new Map<string, number>();
	for (const m of trailing) {
		if (m.format === "unknown") continue;
		warmFormats.set(m.format, (warmFormats.get(m.format) ?? 0) + 1);
	}

	const trailingHeaviness = trailing.map((m) => m.heaviness);

	// Walk the current window in date order; flag any meal whose format
	// matches the immediately preceding meal (within current+recent merged).
	const dinnerCurrent = sortMeals(current.filter((m) => slotRank(m.slot) === SLOT_ORDER.dinner));
	const fullStream = [...recentSorted, ...dinnerCurrent];

	for (let i = 1; i < fullStream.length; i++) {
		const cur = fullStream[i];
		const prev = fullStream[i - 1];
		if (!cur || !prev) continue;
		// Only flag entries that come from the current window — recent is read-only history.
		const fromCurrent = cur.id.startsWith("current-");
		if (!fromCurrent) continue;
		if (cur.format === "unknown" || prev.format === "unknown") continue;
		if (cur.format !== prev.format) continue;
		if (cur.is_leftover) continue; // leftover repeats are intentional
		warn_format_repeats.push({
			date: cur.date,
			format: cur.format,
			reason: `same format as ${prev.date} (${prev.format}) — two ${cur.format}s in a row; swap unless ${cur.date} is intentionally a leftover.`,
		});
	}

	// Heaviness alternation: if the trailing 2 are both heavy, push light;
	// if trailing 2 are both light, push something with backbone.
	if (trailingHeaviness.length >= 2) {
		const lastTwo = trailingHeaviness.slice(-2);
		if (lastTwo.every((h) => h === "heavy")) {
			suggest_alternation.push(
				"last two dinners were both heavy — next dinner should lean light (salad, soup, mezze plate, or a fresh skillet).",
			);
		} else if (lastTwo.every((h) => h === "light")) {
			suggest_alternation.push(
				"last two dinners were both light — next dinner can carry weight (stew, pasta, risotto, or a substantial skillet).",
			);
		}
	}

	// Suggest formats that haven't appeared recently.
	const usedRecent = new Set([...warmFormats.keys()]);
	const cool: string[] = [];
	for (const f of ["flatbread", "skillet", "soup", "salad", "stew", "pasta", "noodle", "tacos", "mezze-plate"]) {
		const norm = normalizeFormat(f) ?? f;
		if (!usedRecent.has(norm)) cool.push(norm);
	}
	if (cool.length > 0 && warmFormats.size > 0) {
		suggest_alternation.push(
			`formats not seen in the last 3 dinners: ${cool.slice(0, 5).join(", ")} — biased candidates for variety.`,
		);
	}

	// Constraints for the composer system prompt.
	if (warmFormats.size > 0) {
		const warmList = Array.from(warmFormats.entries())
			.map(([k, v]) => `${k}${v > 1 ? `(x${v})` : ""}`)
			.join(", ");
		constraints_for_prompt.push(
			`Recent dinner formats (last 3): ${warmList}. Avoid repeating these on the very next dinner unless that meal is explicitly marked leftover.`,
		);
	}
	constraints_for_prompt.push(
		"Format diversity is more important than cuisine diversity. Five 'bowls' across five cuisines still feels monotonous — vary the vessel and utensil (bowl vs flatbread vs skillet vs plate).",
	);
	constraints_for_prompt.push(
		"Alternate heaviness across consecutive dinners. Avoid two heavy dinners (stew, pasta, risotto, gratin, casserole) back to back. Avoid three light dinners (salad, soup, mezze) in a row.",
	);
	if (warn_format_repeats.length > 0) {
		const dates = warn_format_repeats.map((w) => `${w.date} (${w.format})`).join(", ");
		constraints_for_prompt.push(
			`Currently proposed window has format-repeat conflicts on: ${dates}. Reshape these unless they are leftovers.`,
		);
	}

	return { warn_format_repeats, suggest_alternation, constraints_for_prompt };
}

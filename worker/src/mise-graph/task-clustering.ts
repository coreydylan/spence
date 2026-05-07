// Within-cook-session task clustering.
//
// Real chefs do not iterate prep tasks in arbitrary order — they cluster by
// equipment state and oven temperature so they aren't washing the food
// processor between hummus and falafel mix, or reheating the oven between
// two unrelated bakes. This module groups a list of prep/cook tasks by date
// (each date being one cook session of ~60–90 minutes) and reorders the
// tasks within a session to maximize equipment + heat reuse, while
// respecting each task's own active/idle time budget.
//
// Pure deterministic functions — no async, no I/O, no D1.

export interface ClusterableTask {
	id: string;
	scheduled_date: string;
	active_time_min: number;
	idle_time_min: number;
	equipment: string[];
	station_tags: string[];
	title: string;
	priority?: number;
}

export interface CookSession {
	date: string;
	start_min: number;
	end_min: number;
	tasks: ClusterableTask[];
	equipment_states: Array<{
		equipment: string;
		active_window: [number, number];
		reuse_within_min: number;
	}>;
	reasoning: string[];
}

export interface ClusterReordering {
	task_id: string;
	before: { date: string; index: number };
	after: { date: string; index: number; start_min: number; end_min: number };
	reason: string;
}

export interface ClusterTasksResult {
	sessions: CookSession[];
	reorderings: ClusterReordering[];
}

export interface ClusterTasksOptions {
	default_start_minute?: number; // minutes since midnight, e.g. 16*60 for 4pm
	max_session_minutes?: number; // soft target for a single session
}

// --- equipment classification ----------------------------------------------

// Reuse window per equipment in minutes — how long the equipment "stays
// dirty" / "stays hot" so a follow-up task can use it without an extra wash
// or preheat. 0 means no reuse benefit.
const EQUIPMENT_REUSE_MIN: Record<string, number> = {
	"food processor": 90,
	"food-processor": 90,
	processor: 90,
	blender: 90,
	"high-speed blender": 90,
	"immersion blender": 60,
	"stand mixer": 60,
	"hand mixer": 45,
	mortar: 45,
	"mortar and pestle": 45,
	oven: 60,
	"convection oven": 60,
	"toaster oven": 45,
	"sheet pan": 0,
	"baking sheet": 0,
	"cast iron": 30,
	skillet: 30,
	"non-stick skillet": 30,
	"frying pan": 30,
	"sauté pan": 30,
	wok: 30,
	griddle: 30,
	grill: 60,
	ooni: 90,
	"pizza oven": 90,
	"dutch oven": 45,
	"instant pot": 0,
	"pressure cooker": 0,
	"slow cooker": 0,
	"rice cooker": 15,
	"sous vide": 0,
	"smoker": 90,
};

// Equipment categories — grouping for cluster-affinity decisions.
type EquipmentKind =
	| "dirty-shared" // food processor, blender — wash cost dominates
	| "hot-oven" // oven temp set; multiple bakes batch
	| "hot-fire" // ooni, grill, smoker — single fire
	| "hot-pan" // cast iron, skillet — residual heat
	| "single-batch" // instant pot, pressure cooker — one at a time
	| "passive" // sheet pan, mixing bowl — neutral
	| "cold" // mandoline, knife, salad spinner
	| "other";

const COLD_HINTS = new Set([
	"knife",
	"chef's knife",
	"mandoline",
	"salad spinner",
	"peeler",
	"grater",
	"microplane",
	"box grater",
	"y-peeler",
]);

const PASSIVE_HINTS = new Set([
	"sheet pan",
	"baking sheet",
	"mixing bowl",
	"bowl",
	"whisk",
	"spatula",
	"tongs",
	"strainer",
	"colander",
	"sieve",
	"cutting board",
	"jar",
	"container",
	"measuring cup",
	"scale",
	"thermometer",
]);

function normalizeEquipment(raw: string): string {
	return raw.trim().toLowerCase();
}

function equipmentKind(name: string): EquipmentKind {
	const n = normalizeEquipment(name);
	if (
		n.includes("food processor") ||
		n === "processor" ||
		n.includes("blender") ||
		n.includes("mixer") ||
		n.includes("mortar")
	) {
		return "dirty-shared";
	}
	if (n === "oven" || n.includes("convection oven") || n.includes("toaster oven")) return "hot-oven";
	if (n.includes("ooni") || n.includes("pizza oven") || n === "grill" || n.includes("smoker")) return "hot-fire";
	if (
		n.includes("cast iron") ||
		n.includes("skillet") ||
		n.includes("frying pan") ||
		n.includes("sauté pan") ||
		n.includes("saute pan") ||
		n === "wok" ||
		n === "griddle"
	) {
		return "hot-pan";
	}
	if (
		n.includes("instant pot") ||
		n.includes("pressure cooker") ||
		n.includes("slow cooker") ||
		n.includes("sous vide")
	) {
		return "single-batch";
	}
	if (COLD_HINTS.has(n)) return "cold";
	if (PASSIVE_HINTS.has(n)) return "passive";
	return "other";
}

function reuseWindowFor(name: string): number {
	const n = normalizeEquipment(name);
	if (EQUIPMENT_REUSE_MIN[n] !== undefined) return EQUIPMENT_REUSE_MIN[n] as number;
	// Fallback by kind.
	switch (equipmentKind(n)) {
		case "dirty-shared":
			return 60;
		case "hot-oven":
			return 60;
		case "hot-fire":
			return 90;
		case "hot-pan":
			return 30;
		case "single-batch":
			return 0;
		default:
			return 0;
	}
}

// --- task feature extraction -----------------------------------------------

interface TaskFeatures {
	id: string;
	idx: number; // original index within its date
	equipment_norm: string[];
	kinds: Set<EquipmentKind>;
	is_soak: boolean; // mostly idle time — can run in background
	is_cold: boolean; // chilled / fresh prep; do last
	is_dough_rest: boolean; // dough/ferment/rise-style idle
	is_oven_bake: boolean;
	is_fire_bake: boolean;
	is_dirty_shared: boolean;
	is_single_batch: boolean;
	priority: number;
}

function extractFeatures(task: ClusterableTask, idx: number): TaskFeatures {
	const equipment_norm = (task.equipment ?? []).map(normalizeEquipment);
	const kinds = new Set<EquipmentKind>(equipment_norm.map(equipmentKind));
	const tags = new Set((task.station_tags ?? []).map((t) => t.toLowerCase()));
	const title = (task.title ?? "").toLowerCase();

	const idle_dominates = task.idle_time_min > task.active_time_min * 2 && task.idle_time_min >= 20;
	const is_soak =
		idle_dominates &&
		(/(soak|rinse-soak|hydrate|brine|marinate|rest|chill|cool|ferment|rise|proof)/.test(title) ||
			tags.has("soak") ||
			tags.has("brine") ||
			tags.has("marinate") ||
			tags.has("ferment"));

	const is_dough_rest =
		idle_dominates && /(dough|proof|rise|ferment|autolyse)/.test(title);

	const is_cold =
		!kinds.has("hot-oven") &&
		!kinds.has("hot-fire") &&
		!kinds.has("hot-pan") &&
		!kinds.has("single-batch") &&
		(tags.has("cold") ||
			tags.has("salad") ||
			tags.has("garnish") ||
			/(salad|slice|julienne|chiffonade|garnish|pickle|herb sauce|vinaigrette|dressing|crudité|crudite)/.test(
				title,
			));

	return {
		id: task.id,
		idx,
		equipment_norm,
		kinds,
		is_soak,
		is_cold,
		is_dough_rest,
		is_oven_bake: kinds.has("hot-oven"),
		is_fire_bake: kinds.has("hot-fire"),
		is_dirty_shared: kinds.has("dirty-shared"),
		is_single_batch: kinds.has("single-batch"),
		priority: typeof task.priority === "number" ? task.priority : 0,
	};
}

// --- ordering ---------------------------------------------------------------

// Phase score — lower runs earlier in the session.
// Phases (in order):
//   0 — soak/ferment/rise starters (kick off long idles first)
//   1 — single-batch hot pots (instant pot, pressure cooker; full cycle)
//   2 — dirty-shared cluster (food processor / blender batch)
//   3 — oven cluster (one preheat, multiple bakes)
//   4 — fire cluster (ooni / grill — one fire window)
//   5 — hot-pan finishing (cast iron sears, etc.)
//   6 — cold prep, salads, herb sauces, pickles (last so they stay fresh)
function basePhase(f: TaskFeatures): number {
	if (f.is_soak || f.is_dough_rest) return 0;
	if (f.is_single_batch) return 1;
	if (f.is_dirty_shared && !f.is_oven_bake && !f.is_fire_bake) return 2;
	if (f.is_oven_bake) return 3;
	if (f.is_fire_bake) return 4;
	if (f.kinds.has("hot-pan")) return 5;
	if (f.is_cold) return 6;
	// Default — neutral middle so it doesn't disrupt the dirty/oven clusters.
	return 5;
}

function phaseLabel(phase: number): string {
	switch (phase) {
		case 0:
			return "long-idle starter (soak/ferment/rise)";
		case 1:
			return "single-batch hot pot";
		case 2:
			return "dirty-shared (food processor / blender) cluster";
		case 3:
			return "oven cluster";
		case 4:
			return "fire cluster (Ooni / grill)";
		case 5:
			return "hot pan / mid-prep";
		case 6:
			return "cold finish (salad / herb sauce / pickle)";
		default:
			return "mid-prep";
	}
}

// Within a phase, secondary sort key: tasks sharing equipment must stay
// adjacent. We pick a representative "shared key" per task — the first
// equipment that has reuse value > 0, falling back to the first kind tag.
function sharedKey(f: TaskFeatures): string {
	for (const e of f.equipment_norm) {
		if (reuseWindowFor(e) > 0) return `eq:${e}`;
	}
	for (const k of f.kinds) {
		if (k !== "passive" && k !== "other" && k !== "cold") return `kind:${k}`;
	}
	return f.equipment_norm[0] ? `eq:${f.equipment_norm[0]}` : "none";
}

// --- session assembly -------------------------------------------------------

function tasksForDate(tasks: ClusterableTask[], date: string): ClusterableTask[] {
	return tasks.filter((t) => t.scheduled_date === date);
}

function uniqueDatesPreserveOrder(tasks: ClusterableTask[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const t of tasks) {
		if (!seen.has(t.scheduled_date)) {
			seen.add(t.scheduled_date);
			out.push(t.scheduled_date);
		}
	}
	return out.sort();
}

interface OrderedEntry {
	feature: TaskFeatures;
	task: ClusterableTask;
	phase: number;
	shared: string;
	reason: string;
}

function orderForDate(dateTasks: ClusterableTask[]): OrderedEntry[] {
	const features = dateTasks.map((t, i) => extractFeatures(t, i));
	const entries: Array<OrderedEntry> = features.map((f, i) => {
		const phase = basePhase(f);
		const shared = sharedKey(f);
		return {
			feature: f,
			task: dateTasks[i] as ClusterableTask,
			phase,
			shared,
			reason: phaseLabel(phase),
		};
	});

	// Within each phase, group entries that share an equipment key together.
	// We do a stable bucket sort: phase first, then for entries in the same
	// phase, group by shared key in order of first appearance.
	const byPhase = new Map<number, OrderedEntry[]>();
	for (const e of entries) {
		const arr = byPhase.get(e.phase);
		if (arr) arr.push(e);
		else byPhase.set(e.phase, [e]);
	}

	const phasesSorted = Array.from(byPhase.keys()).sort((a, b) => a - b);
	const ordered: OrderedEntry[] = [];

	for (const p of phasesSorted) {
		const list = byPhase.get(p) ?? [];
		const groupOrder: string[] = [];
		const groups = new Map<string, OrderedEntry[]>();
		for (const e of list) {
			if (!groups.has(e.shared)) {
				groups.set(e.shared, []);
				groupOrder.push(e.shared);
			}
			(groups.get(e.shared) as OrderedEntry[]).push(e);
		}
		// Inside a group, stable by original index, but a higher-priority
		// task floats up.
		for (const key of groupOrder) {
			const g = groups.get(key) ?? [];
			g.sort((a, b) => {
				if (a.feature.priority !== b.feature.priority) return b.feature.priority - a.feature.priority;
				return a.feature.idx - b.feature.idx;
			});
			ordered.push(...g);
		}
	}

	// Annotate reasons with cluster context.
	const seenShared = new Map<string, number>();
	for (let i = 0; i < ordered.length; i++) {
		const e = ordered[i] as OrderedEntry;
		const f = e.feature;
		const phaseTxt = phaseLabel(e.phase);
		const reasons: string[] = [phaseTxt];

		const prev = ordered[i - 1];
		if (prev && prev.shared === e.shared && e.shared !== "none") {
			const eq = e.shared.startsWith("eq:") ? e.shared.slice(3) : e.shared.slice(5);
			const window = e.shared.startsWith("eq:") ? reuseWindowFor(eq) : 60;
			if (window > 0) {
				reasons.push(`reuses ${eq} from previous task (~${window}min reuse window)`);
			} else {
				reasons.push(`groups with previous ${eq} task`);
			}
		}

		if (f.is_soak) reasons.push("kicked off early so its idle time overlaps later active prep");
		if (f.is_cold && i === ordered.length - 1) reasons.push("placed last so it stays fresh for service");
		if (f.is_oven_bake && seenShared.get("oven") === undefined) {
			reasons.push("first oven task — preheat starts here");
		} else if (f.is_oven_bake) {
			reasons.push("rides the oven heat already on");
		}
		if (f.is_fire_bake && seenShared.get("fire") === undefined) {
			reasons.push("first fire task — Ooni/grill light-up");
		} else if (f.is_fire_bake) {
			reasons.push("uses the same fire window");
		}

		if (f.is_oven_bake) seenShared.set("oven", i);
		if (f.is_fire_bake) seenShared.set("fire", i);

		e.reason = reasons.join("; ");
	}

	return ordered;
}

// Schedule ordered tasks onto a wall clock, accounting for parallelism:
// an idle-dominated soak/ferment task that's run early can have its idle
// window overlap subsequent active tasks (we don't block on its idle).
function scheduleOrdered(
	ordered: OrderedEntry[],
	startMin: number,
): { tasks: ClusterableTask[]; placements: Array<{ id: string; start: number; end: number }>; sessionEnd: number } {
	let cursor = startMin;
	let parallelEnd = startMin; // latest moment a backgrounded idle is still running
	const placements: Array<{ id: string; start: number; end: number }> = [];
	const tasksOut: ClusterableTask[] = [];

	for (const e of ordered) {
		const f = e.feature;
		const t = e.task;
		const total = t.active_time_min + t.idle_time_min;

		const start = cursor;
		let end: number;

		if (f.is_soak || f.is_dough_rest) {
			// Active portion blocks; idle runs in background.
			cursor = start + t.active_time_min;
			parallelEnd = Math.max(parallelEnd, start + total);
			end = start + total;
		} else {
			cursor = start + total;
			end = start + total;
			parallelEnd = Math.max(parallelEnd, end);
		}

		placements.push({ id: t.id, start, end });
		tasksOut.push(t);
	}

	return { tasks: tasksOut, placements, sessionEnd: Math.max(parallelEnd, cursor) };
}

// Build the equipment_states audit for a session.
function buildEquipmentStates(
	ordered: OrderedEntry[],
	placements: Array<{ id: string; start: number; end: number }>,
): CookSession["equipment_states"] {
	const idToPlacement = new Map<string, { start: number; end: number }>();
	for (const p of placements) idToPlacement.set(p.id, { start: p.start, end: p.end });

	const states = new Map<string, { start: number; end: number; reuse: number }>();
	for (const e of ordered) {
		const place = idToPlacement.get(e.task.id);
		if (!place) continue;
		for (const eq of e.feature.equipment_norm) {
			const window = reuseWindowFor(eq);
			const prev = states.get(eq);
			if (!prev) {
				states.set(eq, { start: place.start, end: place.end, reuse: window });
			} else {
				prev.start = Math.min(prev.start, place.start);
				prev.end = Math.max(prev.end, place.end);
				prev.reuse = Math.max(prev.reuse, window);
			}
		}
	}

	const out: CookSession["equipment_states"] = [];
	for (const [eq, v] of states) {
		out.push({ equipment: eq, active_window: [v.start, v.end], reuse_within_min: v.reuse });
	}
	out.sort((a, b) => a.active_window[0] - b.active_window[0]);
	return out;
}

// Top-level reasoning summary for a session: phase order + key clusters.
function buildSessionReasoning(ordered: OrderedEntry[]): string[] {
	const out: string[] = [];
	if (ordered.length === 0) return out;

	const phaseSeq: number[] = [];
	for (const e of ordered) {
		if (phaseSeq.length === 0 || phaseSeq[phaseSeq.length - 1] !== e.phase) phaseSeq.push(e.phase);
	}
	out.push(`phase order: ${phaseSeq.map((p) => phaseLabel(p)).join(" -> ")}`);

	// Cluster equipment.
	const clusters = new Map<string, string[]>();
	for (const e of ordered) {
		for (const eq of e.feature.equipment_norm) {
			const window = reuseWindowFor(eq);
			if (window <= 0) continue;
			const arr = clusters.get(eq);
			if (arr) arr.push(e.task.title);
			else clusters.set(eq, [e.task.title]);
		}
	}
	for (const [eq, titles] of clusters) {
		if (titles.length >= 2) {
			const w = reuseWindowFor(eq);
			out.push(`clustered ${titles.length} tasks on ${eq} (${w}-min reuse window): ${titles.join(", ")}`);
		}
	}

	// Soaks kicked early.
	const soaks = ordered.filter((e) => e.feature.is_soak || e.feature.is_dough_rest).map((e) => e.task.title);
	if (soaks.length > 0) {
		out.push(`long-idle starter(s) kicked off first so idle overlaps active prep: ${soaks.join(", ")}`);
	}

	// Cold finish.
	const cold = ordered.filter((e) => e.feature.is_cold).map((e) => e.task.title);
	if (cold.length > 0) {
		out.push(`cold/fresh prep at the end so it stays bright: ${cold.join(", ")}`);
	}

	return out;
}

// --- public API -------------------------------------------------------------

export function clusterTasksWithinSessions(
	tasks: ClusterableTask[],
	opts?: ClusterTasksOptions,
): ClusterTasksResult {
	const startMin = opts?.default_start_minute ?? 16 * 60; // 4pm default
	const dates = uniqueDatesPreserveOrder(tasks);

	const sessions: CookSession[] = [];
	const reorderings: ClusterReordering[] = [];

	for (const date of dates) {
		const dateTasks = tasksForDate(tasks, date);
		// Capture original ordering for reorderings diff.
		const originalIndex = new Map<string, number>();
		dateTasks.forEach((t, i) => originalIndex.set(t.id, i));

		const ordered = orderForDate(dateTasks);
		const { tasks: orderedTasks, placements, sessionEnd } = scheduleOrdered(ordered, startMin);
		const equipment_states = buildEquipmentStates(ordered, placements);
		const reasoning = buildSessionReasoning(ordered);

		// Record reorderings for any task whose new index differs.
		ordered.forEach((e, newIdx) => {
			const oldIdx = originalIndex.get(e.task.id) ?? newIdx;
			const place = placements[newIdx] as { id: string; start: number; end: number };
			if (oldIdx !== newIdx) {
				reorderings.push({
					task_id: e.task.id,
					before: { date, index: oldIdx },
					after: { date, index: newIdx, start_min: place.start, end_min: place.end },
					reason: e.reason,
				});
			}
		});

		sessions.push({
			date,
			start_min: startMin,
			end_min: sessionEnd,
			tasks: orderedTasks,
			equipment_states,
			reasoning,
		});
	}

	// Surface the soft session-length budget if exceeded — informational only,
	// we don't truncate or split. The integrator can decide whether to warn.
	const maxMin = opts?.max_session_minutes ?? 90;
	for (const s of sessions) {
		const length = s.end_min - s.start_min;
		if (length > maxMin) {
			s.reasoning.push(
				`session length ${length}min exceeds soft target ${maxMin}min — consider splitting across days`,
			);
		}
	}

	return { sessions, reorderings };
}

// Convenience exports for the integrator.
export const TASK_CLUSTERING_DEFAULTS = {
	default_start_minute: 16 * 60,
	max_session_minutes: 90,
} as const;

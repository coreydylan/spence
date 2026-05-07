// Plan Map renderer — single-tool view of the entire Spence world model.
// Compresses a full plan (+ edges, ledger, grievances, shopping, coherence)
// into agent-readable markdown with inline ASCII tables, a Mermaid graph,
// and optional JSON fences in `full` mode. Purely additive — never mutates.

import type {
	MisePlanComponentBatch, MisePlanMeal, MisePlanTask,
	MiseShoppingListItem, MiseShoppingListSection, MiseSnackBox, MiseWeeklyPlanDraft,
} from "./planner";
import type { ShoppingRun } from "./shopping-list";
import { ledgerFromPlan, type ResourceItem } from "./resource-ledger";
import { runHardCritics, runWarningCritics, type Grievance, type GrievanceSeverity } from "./critics";
import { deriveDependencyEdges, type DependencyEdge } from "./dependency-edges";
import { scorePlanCoherence } from "./coherence-score";

// ─── Public API ─────────────────────────────────────────────────────────────

export type DetailLevel = "compact" | "full";

export interface PlanMapOptions {
	detail?: DetailLevel;
	highlight_slot?: { date: string; slot: string };
	include_audit_log?: boolean;
	now?: string;
}

export function renderPlanMap(plan: MiseWeeklyPlanDraft, options: PlanMapOptions = {}): string {
	const detail = options.detail || "compact";
	const lines: string[] = [];
	lines.push(`# Plan: ${clean(plan.title) || plan.id}`);
	lines.push("");
	lines.push(renderWindowSection(plan));
	lines.push("");
	lines.push(renderCalendarGrid(plan, options));
	lines.push("");
	lines.push(renderLedgerProjection(plan, detail));
	lines.push("");
	lines.push(renderDependencyGraph(plan, detail));
	lines.push("");
	lines.push(renderShoppingSection(plan, detail));
	lines.push("");
	lines.push(renderGrievancesSection(plan));
	lines.push("");
	lines.push(renderCoherenceSection(plan, detail));
	if (detail === "full") {
		lines.push("");
		lines.push(renderFullDataSection(plan));
	}
	return lines.join("\n");
}

// ─── §1 Window ──────────────────────────────────────────────────────────────

export function renderWindowSection(plan: MiseWeeklyPlanDraft): string {
	const allMeals = collectAllMeals(plan);
	const grievances = collectGrievances(plan);
	const hardCount = grievances.filter(g => g.severity === "hard").length;
	const warningCount = grievances.filter(g => g.severity === "warning").length;
	const total = countSlotCapacity(plan);
	const filled = allMeals.length + (plan.snack_boxes?.length || 0);
	const dietary = extractDietary(plan);
	const anchors = (plan.selected_ingredients || []).slice();
	const coherence = scorePlanCoherence(plan);

	const lines: string[] = [];
	lines.push("## §1 Window");
	lines.push(`${plan.start_date} → ${plan.end_date} · ${plan.people} people · ${dietary.length ? dietary.join(", ") : "no dietary"} · anchors=[${anchors.join(", ")}]`);
	lines.push(`status: ${filled}/${total} slots · ${hardCount} hard grievances · ${warningCount} warnings`);
	lines.push(`coherence_score: ${coherence.score} (lower is better)`);
	return lines.join("\n");
}

// ─── §2 Calendar grid ───────────────────────────────────────────────────────

export function renderCalendarGrid(plan: MiseWeeklyPlanDraft, options: PlanMapOptions = {}): string {
	const calendar = buildCalendar(plan);
	const grievanceSlots = grievanceSlotMap(collectGrievances(plan));
	const highlight = options.highlight_slot;

	const header = "                 SHOP            COOKS                                   B   L   S   D";
	const sep = "─".repeat(header.length);
	const rows: string[] = [];
	rows.push("## §2 Calendar grid");
	rows.push("");
	rows.push("```");
	rows.push(header);
	rows.push(sep);

	if (calendar.length === 0) {
		rows.push("(no slots filled yet)");
	} else {
		for (const day of calendar) {
			rows.push(formatCalendarRow(day, grievanceSlots, highlight));
		}
	}
	rows.push("```");
	rows.push("");
	rows.push("LEGEND: ↻=remake, ★=leftover-of-prior, ?=fresh, [bX]=batch reference, ⚠=grievance flagged on this slot, ↗=new resource, *bold*=highlighted slot");
	return rows.join("\n");
}

// ─── §3 Ledger projection ───────────────────────────────────────────────────

export function renderLedgerProjection(plan: MiseWeeklyPlanDraft, detail: DetailLevel): string {
	const lines: string[] = ["## §3 Resource ledger (compact)", ""];
	const dates = uniqueDates(plan);
	if (dates.length === 0) { lines.push("(no slots filled yet)"); return lines.join("\n"); }

	let ledger: ReturnType<typeof ledgerFromPlan>;
	try { ledger = ledgerFromPlan(plan); }
	catch (err) { lines.push(`(ledger projection failed: ${(err as Error).message})`); return lines.join("\n"); }

	const resourceTotals = new Map<string, number>();
	const dateSnapshots = new Map<string, Map<string, ResourceItem>>();
	for (const date of dates) {
		const byName = new Map<string, ResourceItem>();
		for (const item of ledger.at(date)) {
			const existing = byName.get(item.canonical_name);
			byName.set(item.canonical_name, existing ? { ...existing, qty: existing.qty + item.qty } : item);
			resourceTotals.set(item.canonical_name, (resourceTotals.get(item.canonical_name) || 0) + Math.abs(item.qty));
		}
		dateSnapshots.set(date, byName);
	}

	const allNames = Array.from(resourceTotals.keys()).sort((a, b) =>
		(resourceTotals.get(b) || 0) - (resourceTotals.get(a) || 0) || a.localeCompare(b),
	);
	const topNames = allNames.slice(0, detail === "compact" ? 8 : 16);

	if (topNames.length === 0) {
		lines.push("(no tracked resources yet)");
	} else {
		lines.push("```");
		lines.push(`date         | ${topNames.map(n => padCol(truncate(n, 18), 18)).join(" | ")}`);
		lines.push(`${"─".repeat(13)}┼${topNames.map(() => "─".repeat(20)).join("┼")}`);
		for (const date of dates) {
			const snap = dateSnapshots.get(date) || new Map();
			const cells = topNames.map(name => {
				const item = snap.get(name);
				if (!item) return padCol("—", 18);
				const expiresMark = item.expires_at && item.expires_at <= addDays(date, 2) ? "⚠" : "";
				return padCol(`${roundQty(item.qty)}${item.unit || ""}${expiresMark}`, 18);
			});
			lines.push(`${dayLabel(date).padEnd(12)} | ${cells.join(" | ")}`);
		}
		lines.push("```");
	}

	const wasted = ledger.waste_at_end(plan.end_date);
	if (wasted.length > 0) {
		lines.push("", "waste_at_end:");
		for (const item of wasted) {
			const expires = item.expires_at ? ` (expires ${item.expires_at} unclaimed)` : "";
			lines.push(`- ⚠ ${item.canonical_name} ${roundQty(item.qty)}${item.unit || ""}${expires}`);
		}
	}
	return lines.join("\n");
}

// ─── §4 Dependency edges ────────────────────────────────────────────────────

export function renderDependencyGraph(plan: MiseWeeklyPlanDraft, detail: DetailLevel): string {
	const edges = deriveDependencyEdges(plan);
	const lines: string[] = [];
	lines.push("## §4 Dependency edges");
	lines.push("");

	const violated = edges.filter(e => e.status === "violated");
	const critical = edges.filter(e => e.status !== "violated" && e.critical);
	const marginal = edges.filter(e => e.status === "marginal" && !e.critical);
	const ok = edges.filter(e => e.status === "ok" && !e.critical);

	// Mermaid: nodes referenced by violated/critical/marginal first, plus a
	// sample of ok edges (compact: 5; full: 15).
	const focused = [...violated, ...critical, ...marginal];
	const okSample = detail === "compact" ? ok.slice(0, 5) : ok.slice(0, 15);
	const graphEdges = [...focused, ...okSample].slice(0, detail === "compact" ? 20 : 50);

	lines.push("```mermaid");
	lines.push("graph LR");
	if (graphEdges.length === 0) {
		lines.push("  empty[no edges]");
	} else {
		const seenNodes = new Set<string>();
		for (const edge of graphEdges) {
			const fromId = nodeId(edge.from);
			const toId = nodeId(edge.to);
			const fromLabel = nodeLabel(edge.from, plan);
			const toLabel = nodeLabel(edge.to, plan);
			if (!seenNodes.has(fromId)) {
				lines.push(`  ${fromId}[${escapeMermaid(fromLabel)}]`);
				seenNodes.add(fromId);
			}
			if (!seenNodes.has(toId)) {
				lines.push(`  ${toId}[${escapeMermaid(toLabel)}]`);
				seenNodes.add(toId);
			}
			const arrow = edgeArrow(edge);
			const label = edgeMermaidLabel(edge);
			lines.push(`  ${fromId} ${arrow} ${label}${toId}`);
		}
	}
	lines.push("```");
	lines.push("");

	// Critical path summary.
	lines.push("**Critical path** (zero or violated slack):");
	const summary = [...violated, ...critical, ...marginal];
	if (summary.length === 0) {
		lines.push("- (none — plan satisfies all derivable lead-time rules)");
	} else {
		const limit = detail === "compact" ? 12 : summary.length;
		for (const edge of summary.slice(0, limit)) {
			const symbol = edge.status === "violated" ? "❌" : edge.critical ? "⚠" : "·";
			lines.push(`- ${symbol} ${formatEdgeRef(edge)}: rule=${edge.rule.kind} ${edge.rule.value}h, current=${edge.current_lead_time_hours}h, slack=${edge.slack_hours}h, **${edge.status}**`);
		}
		if (limit < summary.length) {
			lines.push(`- … ${summary.length - limit} more (use detail="full" to see all)`);
		}
	}
	if (detail === "full" && ok.length > 0) {
		lines.push("");
		lines.push(`**OK edges (${ok.length} total)** — ✓ all satisfy lead-time + freshness rules`);
	}
	return lines.join("\n");
}

// ─── §5 Shopping ────────────────────────────────────────────────────────────

export function renderShoppingSection(plan: MiseWeeklyPlanDraft, detail: DetailLevel): string {
	const lines: string[] = [];
	lines.push("## §5 Shopping");
	lines.push("");

	const runs = (plan.shop_runs || []).slice().sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
	if (runs.length === 0) {
		lines.push("(no shop runs yet)");
		return lines.join("\n");
	}

	const itemConsumers = buildItemConsumerIndex(plan);
	const sectionsByCategory = new Map<string, MiseShoppingListSection>();
	for (const section of plan.shopping_list || []) {
		sectionsByCategory.set(section.category, section);
	}

	for (let idx = 0; idx < runs.length; idx++) {
		const run = runs[idx];
		const runLabel = `Run ${idx + 1} ${dayLabel(run.date)} (${run.item_count} items, vendor=any)`;
		lines.push(runLabel + ":");

		const categories = run.categories.length
			? run.categories
			: Array.from(sectionsByCategory.keys());

		for (const category of categories) {
			const section = sectionsByCategory.get(category);
			if (!section || section.items.length === 0) continue;
			const allItems = section.items.slice().sort((a, b) => a.name.localeCompare(b.name));
			const items = detail === "compact" ? allItems.slice(0, 5) : allItems;
			const formatted = items.map(item => formatShoppingItem(item, itemConsumers));
			const tail = detail === "compact" && allItems.length > items.length
				? `, …+${allItems.length - items.length}`
				: "";
			lines.push(`  ${category.padEnd(8)}: ${formatted.join(", ")}${tail}`);
		}
	}
	return lines.join("\n");
}

// ─── §6 Grievances + cascade proposals ──────────────────────────────────────

export function renderGrievancesSection(plan: MiseWeeklyPlanDraft): string {
	const lines: string[] = [];
	lines.push("## §6 Grievances + cascade proposals");
	lines.push("");

	const grievances = collectGrievances(plan).slice().sort(grievanceCompare);
	if (grievances.length === 0) {
		lines.push("(no grievances — plan is clean)");
		return lines.join("\n");
	}

	for (const g of grievances) {
		const tag = `[${g.severity.toUpperCase()}]`;
		const where = g.slot_ref ? ` @ ${g.slot_ref.date}_${g.slot_ref.slot}` : g.batch_id ? ` @ batch=${g.batch_id}` : "";
		const summary = truncate(g.message, 140);
		lines.push(`${tag} ${g.critic}${where} — ${summary}`);

		const proposals = g.cascade_proposals || [];
		if (proposals.length > 0) {
			lines.push("  proposals:");
			const sorted = proposals.slice().sort((a, b) =>
				(b.confidence || 0) - (a.confidence || 0) || String(a.kind).localeCompare(String(b.kind)),
			);
			for (const p of sorted) {
				const conf = typeof p.confidence === "number" ? ` (conf=${p.confidence.toFixed(2)})` : "";
				lines.push(`   • ${p.kind}${conf}: ${truncate(clean(p.description), 120)}`);
			}
		}
	}
	return lines.join("\n");
}

// ─── §7 Coherence score breakdown ───────────────────────────────────────────

function renderCoherenceSection(plan: MiseWeeklyPlanDraft, detail: DetailLevel): string {
	const coherence = scorePlanCoherence(plan);
	const lines: string[] = [];
	lines.push("## §7 Coherence score breakdown");
	lines.push("");
	lines.push(`Total: ${coherence.score}`);

	const categories = Object.entries(coherence.score_by_category)
		.filter(([, score]) => score > 0)
		.sort(([, a], [, b]) => b - a);
	const limit = detail === "compact" ? 3 : categories.length;
	for (const [name, score] of categories.slice(0, limit)) {
		lines.push(`- ${name}: ${score}`);
	}
	if (limit < categories.length) {
		lines.push(`- … ${categories.length - limit} more (use detail="full" to see all)`);
	}
	if (categories.length === 0) {
		lines.push("- (no penalty categories triggered)");
	}
	return lines.join("\n");
}

function renderFullDataSection(plan: MiseWeeklyPlanDraft): string {
	const edges = deriveDependencyEdges(plan);
	const grievances = collectGrievances(plan);
	const coherence = scorePlanCoherence(plan);
	const lines: string[] = [];
	lines.push("## §8 Full data (JSON lookup)");
	lines.push("");
	lines.push("### plan_summary");
	lines.push("```json");
	lines.push(stableJson(planSummary(plan)));
	lines.push("```");
	lines.push("");
	lines.push("### dependency_edges");
	lines.push("```json");
	lines.push(stableJson(edges));
	lines.push("```");
	lines.push("");
	lines.push("### grievances");
	lines.push("```json");
	lines.push(stableJson(grievances));
	lines.push("```");
	lines.push("");
	lines.push("### coherence");
	lines.push("```json");
	lines.push(stableJson(coherence));
	lines.push("```");
	return lines.join("\n");
}

// Trimmed plan slice for full-mode JSON lookup — drops cruft (menu_rationale
// prose, raw_ingredients, top_edges debug blob) so embedded JSON stays focused.
function planSummary(plan: MiseWeeklyPlanDraft): Record<string, unknown> {
	return {
		id: plan.id,
		title: plan.title,
		start_date: plan.start_date,
		end_date: plan.end_date,
		people: plan.people,
		status: plan.status,
		selected_ingredients: plan.selected_ingredients || [],
		dietary: extractDietary(plan),
		meals: collectAllMeals(plan).map(m => ({
			id: m.id, date: m.date, slot: m.slot, title: m.title, format: m.format,
			cuisine: m.cuisine, component_ids: m.component_ids,
			leftovers_to: m.leftovers_to || [], locked: m.locked,
		})),
		breakfasts_count: (plan.breakfasts || []).length,
		snack_boxes: (plan.snack_boxes || []).map(s => ({ id: s.id, date: s.date, title: s.title })),
		component_batches: (plan.component_batches || []).map(b => ({
			id: b.id, label: b.label, quantity: b.quantity, unit: b.unit,
			quality_window_hours: b.quality_window_hours, idle_time_min: b.idle_time_min,
			input_names: b.input_names, planned_uses: b.planned_uses,
		})),
		prep_tasks: (plan.prep_tasks || []).map(t => ({
			id: t.id, scheduled_date: t.scheduled_date, title: t.title,
			state_outputs: t.state_outputs, idle_time_min: t.idle_time_min,
		})),
		shop_runs: plan.shop_runs || [],
	};
}

// ─── Calendar building ──────────────────────────────────────────────────────

interface CalendarDay {
	date: string;
	shop_runs: ShoppingRun[];
	prep_tasks: MisePlanTask[];
	component_batches: MisePlanComponentBatch[];
	breakfasts: MisePlanMeal[];
	lunches: MisePlanMeal[];
	snacks: MiseSnackBox[];
	snack_meals: MisePlanMeal[];
	dinners: MisePlanMeal[];
}

function buildCalendar(plan: MiseWeeklyPlanDraft): CalendarDay[] {
	const map = new Map<string, CalendarDay>();
	for (const date of uniqueDates(plan)) map.set(date, makeEmptyDay(date));
	const ensure = (date: string): CalendarDay => {
		let day = map.get(date);
		if (!day) { day = makeEmptyDay(date); map.set(date, day); }
		return day;
	};
	for (const run of plan.shop_runs || []) ensure(run.date).shop_runs.push(run);
	for (const task of plan.prep_tasks || []) ensure(task.scheduled_date).prep_tasks.push(task);
	for (const batch of plan.component_batches || []) {
		const prepDate = inferBatchPrepDate(batch, plan.prep_tasks || []);
		if (prepDate) ensure(prepDate).component_batches.push(batch);
	}
	const seen = new Set<string>();
	for (const day of plan.meals_by_day || []) {
		for (const meal of day.meals || []) pushMeal(ensure(meal.date || day.date), meal, seen);
	}
	for (const meal of plan.breakfasts || []) pushMeal(ensure(meal.date), meal, seen);
	for (const snack of plan.snack_boxes || []) ensure(snack.date).snacks.push(snack);

	const days = Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
	for (const day of days) {
		day.shop_runs.sort((a, b) => a.id.localeCompare(b.id));
		day.prep_tasks.sort((a, b) => a.session_order - b.session_order || a.id.localeCompare(b.id));
		day.component_batches.sort((a, b) => a.id.localeCompare(b.id));
		day.breakfasts.sort(mealOrder);
		day.lunches.sort(mealOrder);
		day.snack_meals.sort(mealOrder);
		day.dinners.sort(mealOrder);
		day.snacks.sort((a, b) => a.id.localeCompare(b.id));
	}
	return days;
}

function makeEmptyDay(date: string): CalendarDay {
	return {
		date,
		shop_runs: [],
		prep_tasks: [],
		component_batches: [],
		breakfasts: [],
		lunches: [],
		snacks: [],
		snack_meals: [],
		dinners: [],
	};
}

function pushMeal(day: CalendarDay, meal: MisePlanMeal, seen: Set<string>): void {
	if (seen.has(meal.id)) return;
	seen.add(meal.id);
	switch (meal.slot) {
		case "breakfast":
			day.breakfasts.push(meal);
			break;
		case "lunch":
			day.lunches.push(meal);
			break;
		case "snack":
			day.snack_meals.push(meal);
			break;
		case "dinner":
		default:
			day.dinners.push(meal);
			break;
	}
}

function formatCalendarRow(
	day: CalendarDay,
	grievanceSlots: Map<string, number>,
	highlight: PlanMapOptions["highlight_slot"],
): string {
	const dayLbl = dayLabel(day.date).padEnd(10);
	const shopCell = formatShopCell(day.shop_runs).padEnd(13);
	const cookCell = formatCookCell(day.prep_tasks, day.component_batches).padEnd(34);
	const b = formatMealCell(day.breakfasts, "breakfast", day.date, grievanceSlots, highlight).padEnd(3);
	const l = formatMealCell(day.lunches, "lunch", day.date, grievanceSlots, highlight).padEnd(3);
	const s = formatSnackCell(day.snacks, day.snack_meals, day.date, grievanceSlots, highlight).padEnd(3);
	const d = formatMealCell(day.dinners, "dinner", day.date, grievanceSlots, highlight).padEnd(3);
	return `${dayLbl} ${shopCell} ${cookCell}  ${b} ${l} ${s} ${d}`;
}

function formatShopCell(runs: ShoppingRun[]): string {
	if (runs.length === 0) return "";
	return runs.map((r, i) => `─→ S${i + 1}(${r.item_count}i)`).join(" ");
}

function formatCookCell(tasks: MisePlanTask[], batches: MisePlanComponentBatch[]): string {
	if (tasks.length === 0 && batches.length === 0) return "";
	const cookEntries: string[] = [];
	for (let i = 0; i < tasks.length && cookEntries.length < 3; i++) {
		const task = tasks[i];
		const idleHours = Math.round((task.idle_time_min || 0) / 60);
		const idleMark = idleHours >= 24 ? `[idle ${idleHours}h]` : "";
		cookEntries.push(`C${i + 1} ${shortBatchLabel(task)}${idleMark}`);
	}
	if (tasks.length > 3) cookEntries.push(`+${tasks.length - 3}`);
	return cookEntries.join(" ");
}

function shortBatchLabel(task: MisePlanTask): string {
	const title = task.title || task.id;
	return truncate(title.replace(/^(make|prep|blend|mix|whisk)\s+/i, "").toLowerCase(), 14);
}

function formatMealCell(
	meals: MisePlanMeal[],
	slot: string,
	date: string,
	grievanceSlots: Map<string, number>,
	highlight: PlanMapOptions["highlight_slot"],
): string {
	if (meals.length === 0) return "—";
	const m = meals[0];
	const symbol = mealSymbol(m);
	const tag = `${symbol}${truncate(m.title.split(/\s+/).slice(0, 2).join(""), 12)}`;
	const flagged = grievanceSlots.has(slotKey(date, slot)) ? "⚠" : "";
	const cell = `${tag.slice(0, 2)}${flagged}`;
	const isHighlight = highlight && highlight.date === date && highlight.slot === slot;
	return isHighlight ? `*${cell}*` : cell;
}

function formatSnackCell(
	snacks: MiseSnackBox[],
	meals: MisePlanMeal[],
	date: string,
	grievanceSlots: Map<string, number>,
	highlight: PlanMapOptions["highlight_slot"],
): string {
	if (snacks.length === 0 && meals.length === 0) return "—";
	const flagged = grievanceSlots.has(slotKey(date, "snack")) ? "⚠" : "";
	const isHighlight = highlight && highlight.date === date && highlight.slot === "snack";
	const cell = `Sn${flagged}`;
	return isHighlight ? `*${cell}*` : cell;
}

function mealSymbol(meal: MisePlanMeal): string {
	if (meal.source && meal.source.toLowerCase().includes("leftover")) return "★";
	if ((meal.cuisine || []).some(c => /italian/i.test(c))) return "🇮";
	if ((meal.cuisine || []).some(c => /mediterranean|levantine|middle/i.test(c))) return "🌿";
	if ((meal.cuisine || []).some(c => /korean|japanese|thai|vietnamese|chinese/i.test(c))) return "🥢";
	if ((meal.cuisine || []).some(c => /mexican|indian/i.test(c))) return "🌶";
	return "?";
}

// ─── Helpers: dates, names, sources ─────────────────────────────────────────

function uniqueDates(plan: MiseWeeklyPlanDraft): string[] {
	const set = new Set<string>();
	const startMs = parseDateMs(plan.start_date);
	const endMs = parseDateMs(plan.end_date);
	if (Number.isFinite(startMs) && Number.isFinite(endMs) && startMs <= endMs) {
		for (let ms = startMs; ms <= endMs; ms += 86400000) {
			set.add(new Date(ms).toISOString().slice(0, 10));
		}
	} else {
		if (isIsoDate(plan.start_date)) set.add(plan.start_date);
		if (isIsoDate(plan.end_date)) set.add(plan.end_date);
	}
	for (const day of plan.meals_by_day || []) if (isIsoDate(day.date)) set.add(day.date);
	for (const meal of collectAllMeals(plan)) if (isIsoDate(meal.date)) set.add(meal.date);
	for (const snack of plan.snack_boxes || []) if (isIsoDate(snack.date)) set.add(snack.date);
	for (const task of plan.prep_tasks || []) if (isIsoDate(task.scheduled_date)) set.add(task.scheduled_date);
	for (const run of plan.shop_runs || []) if (isIsoDate(run.date)) set.add(run.date);
	return Array.from(set).sort();
}

function collectAllMeals(plan: MiseWeeklyPlanDraft): MisePlanMeal[] {
	const out: MisePlanMeal[] = [];
	const seen = new Set<string>();
	for (const day of plan.meals_by_day || []) for (const meal of day.meals || []) {
		if (seen.has(meal.id)) continue;
		seen.add(meal.id); out.push(meal);
	}
	for (const meal of plan.breakfasts || []) {
		if (seen.has(meal.id)) continue;
		seen.add(meal.id); out.push(meal);
	}
	return out;
}

function collectGrievances(plan: MiseWeeklyPlanDraft): Grievance[] {
	return [...runHardCritics(plan), ...runWarningCritics(plan, { now: deterministicNow(plan) })];
}

function deterministicNow(plan: MiseWeeklyPlanDraft): string {
	const date = isIsoDate(plan.end_date) ? plan.end_date : isIsoDate(plan.start_date) ? plan.start_date : "1970-01-01";
	return `${date}T00:00:00.000Z`;
}

function grievanceSlotMap(grievances: Grievance[]): Map<string, number> {
	const m = new Map<string, number>();
	for (const g of grievances) {
		if (!g.slot_ref) continue;
		const key = slotKey(g.slot_ref.date, g.slot_ref.slot);
		m.set(key, (m.get(key) || 0) + 1);
	}
	return m;
}

function slotKey(date: string, slot: string): string { return `${date}::${slot}`; }

function countSlotCapacity(plan: MiseWeeklyPlanDraft): number {
	// 3 dinners-equivalent slots per day (B/L/D).
	return uniqueDates(plan).length * 3;
}

function extractDietary(plan: MiseWeeklyPlanDraft): string[] {
	const v = (plan.constraints as Record<string, unknown> | undefined)?.dietary;
	return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
}

function inferBatchPrepDate(batch: MisePlanComponentBatch, tasks: MisePlanTask[]): string | null {
	const task = tasks.find(t => (t.state_outputs || []).includes(batch.id));
	if (task) return task.scheduled_date;
	const meta = batch.meta as Record<string, unknown> | undefined;
	const desired = meta?.desired_prep_date;
	if (typeof desired === "string" && isIsoDate(desired)) return desired;
	const firstUse = (batch.planned_uses || []).slice().sort((a, b) => a.date.localeCompare(b.date))[0];
	if (firstUse) return subtractDays(firstUse.date, 1);
	return null;
}

function mealOrder(a: MisePlanMeal, b: MisePlanMeal): number {
	return a.date.localeCompare(b.date) || a.id.localeCompare(b.id);
}

// ─── Edges + nodes (mermaid) ────────────────────────────────────────────────

function nodeId(ref: { entity_type: string; entity_id: string }): string {
	return ref.entity_type[0] + "_" + ref.entity_id.replace(/[^a-zA-Z0-9]/g, "_").slice(-32);
}

function nodeLabel(ref: { entity_type: string; entity_id: string; date: string }, plan: MiseWeeklyPlanDraft): string {
	const wd = weekday(ref.date);
	if (ref.entity_type === "Meal") {
		const meal = collectAllMeals(plan).find(m => m.id === ref.entity_id);
		const title = meal ? truncate(meal.title, 18) : truncate(ref.entity_id, 18);
		return `${wd} ${title}`;
	}
	if (ref.entity_type === "Cook") {
		// Try matching a batch by id.
		const batch = (plan.component_batches || []).find(b => b.id === ref.entity_id);
		if (batch) return `${wd} cook ${truncate(batch.label, 18)}`;
		return `${wd} cook ${truncate(ref.entity_id, 18)}`;
	}
	if (ref.entity_type === "Shop") return `${wd} shop`;
	return `${wd} ${truncate(ref.entity_id, 18)}`;
}

function edgeArrow(edge: DependencyEdge): string {
	if (edge.status === "violated") return "-. ❌ .->";
	if (edge.critical) return "==>";
	if (edge.status === "marginal") return "-.->";
	return "-->";
}

function edgeMermaidLabel(edge: DependencyEdge): string {
	const prefix = edge.status === "violated" ? "⚠" : "";
	const includeValue = edge.status === "violated" || edge.critical;
	const tag = includeValue ? `${prefix}${edge.rule.value}h ${edge.rule.kind}` : edge.rule.kind;
	return `|${escapeMermaid(tag)}|`;
}

function escapeMermaid(text: string): string {
	return text.replace(/[\[\]\|()`"]/g, " ").replace(/\s+/g, " ").trim();
}

function formatEdgeRef(edge: DependencyEdge): string {
	return `${edge.from.entity_type}[${shortRef(edge.from.entity_id)}] → ${edge.to.entity_type}[${shortRef(edge.to.entity_id)}]`;
}

function shortRef(id: string): string {
	return truncate(id.replace(/^(meal|mise_component|mise_task|mise_shop_run):/, ""), 24);
}

// ─── Shopping helpers ───────────────────────────────────────────────────────

function buildItemConsumerIndex(plan: MiseWeeklyPlanDraft): Map<string, string[]> {
	const out = new Map<string, string[]>();
	const allMeals = collectAllMeals(plan);
	for (const section of plan.shopping_list || []) {
		for (const item of section.items) {
			const consumers: string[] = [];
			for (const sourceId of item.source || []) {
				for (const meal of allMeals) {
					if ((meal.component_ids || []).includes(sourceId)) consumers.push(`${meal.date}_${meal.slot}`);
				}
				for (const snack of plan.snack_boxes || []) {
					if ((snack.component_ids || []).includes(sourceId)) consumers.push(`${snack.date}_snack`);
				}
				const batch = (plan.component_batches || []).find(b => b.id === sourceId);
				if (batch) for (const use of batch.planned_uses || []) consumers.push(`${use.date}_${use.slot}`);
			}
			out.set(item.name, Array.from(new Set(consumers)).slice(0, 3));
		}
	}
	return out;
}

function formatShoppingItem(item: MiseShoppingListItem, consumerIndex: Map<string, string[]>): string {
	const grams = typeof item.grams_total === "number" ? ` ${roundQty(item.grams_total)}g` : "";
	const consumers = consumerIndex.get(item.name) || [];
	return `${truncate(item.name, 20)}${grams}${consumers.length ? ` (${consumers.join("+")})` : ""}`;
}

// ─── Grievance ordering ─────────────────────────────────────────────────────

const SEVERITY_RANK: Record<GrievanceSeverity, number> = { hard: 0, warning: 1, preference: 2 };
const CRITIC_PRIORITY: Record<string, number> = {
	WasteCritic: 0,
	ShelfLifeCritic: 1,
	DietaryCritic: 2,
	LeftoverGraphCritic: 3,
	EdgeViolationCritic: 4,
	ShopCoverageCritic: 5,
	ShopFreshnessCritic: 5,
	ResourceContinuityCritic: 6,
	FormatCompositionCritic: 7,
	FormulaExistenceCritic: 8,
	LockStaleCritic: 9,
};

function grievanceCompare(a: Grievance, b: Grievance): number {
	const sev = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
	if (sev !== 0) return sev;
	const pa = CRITIC_PRIORITY[a.critic] ?? 99;
	const pb = CRITIC_PRIORITY[b.critic] ?? 99;
	if (pa !== pb) return pa - pb;
	const da = a.slot_ref?.date || "";
	const db = b.slot_ref?.date || "";
	if (da !== db) return da.localeCompare(db);
	return (a.message || "").localeCompare(b.message || "");
}

// ─── Generic helpers ────────────────────────────────────────────────────────

function clean(value: unknown): string { return String(value ?? "").replace(/\s+/g, " ").trim(); }
function truncate(value: string, max: number): string {
	const v = clean(value);
	return v.length <= max ? v : v.slice(0, Math.max(0, max - 1)) + "…";
}
function padCol(value: string, width: number): string {
	return value.length >= width ? value.slice(0, width) : value + " ".repeat(width - value.length);
}
function roundQty(qty: number): string {
	if (!Number.isFinite(qty)) return "0";
	const abs = Math.abs(qty);
	if (abs >= 1000) return Math.round(qty).toString();
	if (abs >= 10) return (Math.round(qty / 10) * 10).toString();
	if (abs >= 1) return qty.toFixed(0);
	return qty.toFixed(2).replace(/\.?0+$/, "");
}
function dayLabel(date: string): string {
	const wd = weekday(date);
	if (!wd) return date;
	return `${wd} ${date.slice(5, 7).replace(/^0/, "")}/${date.slice(8, 10).replace(/^0/, "")}`;
}
function weekday(date: string): string {
	const ms = parseDateMs(date);
	return Number.isFinite(ms) ? ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(ms).getUTCDay()] : "";
}
function parseDateMs(date: string): number { return Date.parse(`${date}T00:00:00.000Z`); }
function isIsoDate(value: string): boolean {
	return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(parseDateMs(value));
}
function addDays(iso: string, days: number): string {
	const ms = parseDateMs(iso);
	if (!Number.isFinite(ms)) return iso;
	const d = new Date(ms); d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}
function subtractDays(iso: string, days: number): string { return addDays(iso, -days); }
function stableJson(value: unknown): string { return JSON.stringify(sortJsonValue(value), null, 2); }
function sortJsonValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortJsonValue);
	if (!value || typeof value !== "object") return value;
	const record = value as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(record).sort()) {
		const child = record[key];
		if (child !== undefined) out[key] = sortJsonValue(child);
	}
	return out;
}

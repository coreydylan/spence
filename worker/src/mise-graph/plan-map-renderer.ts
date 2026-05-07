import type {
	MiseMealSlot,
	MisePlanComponentBatch,
	MisePlanMeal,
	MisePlanTask,
	MiseShoppingListItem,
	MiseShoppingListSection,
	MiseSnackBox,
	MiseWeeklyPlanDraft,
} from "./planner";
import type { ShoppingRun } from "./shopping-list";
import { runHardCritics, runWarningCritics, type Grievance, type GrievanceSeverity } from "./critics";
import { deriveDependencyEdges, type DependencyEdge } from "./dependency-edges";
import { scorePlanCoherence, type CoherenceScoreResult } from "./coherence-score";

export type PlanMapRenderMode = "compact" | "full";

export interface RenderPlanMapOptions {
	mode?: PlanMapRenderMode;
	includeJson?: boolean;
	edges?: DependencyEdge[];
	grievances?: Grievance[];
	includeWarningCritics?: boolean;
	now?: string;
}

interface CalendarDay {
	date: string;
	shop_runs: ShoppingRun[];
	prep_tasks: MisePlanTask[];
	breakfasts: MisePlanMeal[];
	lunches: MisePlanMeal[];
	snacks: MiseSnackBox[];
	snack_meals: MisePlanMeal[];
	dinners: MisePlanMeal[];
}

const SEVERITY_ORDER: GrievanceSeverity[] = ["hard", "warning", "preference"];
const SLOT_ORDER: Record<string, number> = { breakfast: 1, lunch: 2, snack: 3, dinner: 4 };

export function renderPlanMap(plan: MiseWeeklyPlanDraft, options: RenderPlanMapOptions = {}): string {
	const edges = sortEdges(options.edges || deriveDependencyEdges(plan));
	const grievances = sortGrievances(options.grievances || derivePlanGrievances(plan, options));
	const coherence = scorePlanCoherence(plan);
	const calendar = buildCalendar(plan);
	const lines: string[] = [];

	lines.push("# Plan Map");
	lines.push("");
	renderWindowSummary(lines, plan, calendar, edges, grievances, coherence, options);
	renderCalendarGrid(lines, calendar);
	renderComponentBatches(lines, plan);
	renderDependencyEdges(lines, edges);
	renderShopping(lines, plan);
	renderGrievances(lines, grievances);
	renderCoherence(lines, coherence);

	const includeJson = options.includeJson === true || options.mode === "full";
	if (includeJson) {
		renderFullJson(lines, plan, calendar, edges, grievances, coherence);
	}

	return lines.join("\n");
}

function renderWindowSummary(
	lines: string[],
	plan: MiseWeeklyPlanDraft,
	calendar: CalendarDay[],
	edges: DependencyEdge[],
	grievances: Grievance[],
	coherence: CoherenceScoreResult,
	options: RenderPlanMapOptions,
): void {
	const allMeals = collectAllMeals(plan);
	const edgeCounts = countEdges(edges);
	const grievanceCounts = countGrievances(grievances);
	const mode = options.mode || (options.includeJson ? "full" : "compact");
	const deterministic = plan.meta?.deterministic === true ? "true" : "false";

	lines.push("## Window / Status");
	lines.push(`- plan: ${plan.id} - ${clean(plan.title)}`);
	lines.push(`- window: ${plan.start_date} to ${plan.end_date}; timezone=${plan.timezone || "unspecified"}; people=${plan.people}`);
	lines.push(`- status: ${plan.status}; deterministic=${deterministic}; render_mode=${mode}`);
	lines.push(`- calendar: ${calendar.length} days; meals=${allMeals.length}; snack_boxes=${plan.snack_boxes.length}; prep_tasks=${plan.prep_tasks.length}; component_batches=${plan.component_batches.length}; shop_runs=${(plan.shop_runs || []).length}`);
	lines.push(`- edges: total=${edges.length}; ok=${edgeCounts.ok}; marginal=${edgeCounts.marginal}; violated=${edgeCounts.violated}; critical=${edgeCounts.critical}`);
	lines.push(`- grievances: hard=${grievanceCounts.hard}; warning=${grievanceCounts.warning}; preference=${grievanceCounts.preference}`);
	lines.push(`- coherence: score=${coherence.score}; issues=${coherence.issues.length}; hard_critics=${coherence.hard_grievance_count}; edge_violations=${coherence.edge_violation_count}`);
	lines.push("");
}

function renderCalendarGrid(lines: string[], calendar: CalendarDay[]): void {
	lines.push("## Calendar Grid");
	lines.push("");
	lines.push("| Day | Shop | Prep | Breakfast | Lunch | Snack | Dinner |");
	lines.push("|---|---|---|---|---|---|---|");
	for (const day of calendar) {
		lines.push([
			dayLabel(day.date),
			joinCell(day.shop_runs.map(formatShopRun)),
			joinCell(day.prep_tasks.map(formatPrepTask)),
			joinCell(day.breakfasts.map(formatMeal)),
			joinCell(day.lunches.map(formatMeal)),
			joinCell([...day.snack_meals.map(formatMeal), ...day.snacks.map(formatSnack)]),
			joinCell(day.dinners.map(formatMeal)),
		].map(tableCell).join(" | "));
	}
	lines.push("");
}

function renderComponentBatches(lines: string[], plan: MiseWeeklyPlanDraft): void {
	lines.push("## Component Batches");
	lines.push("");
	const batches = (plan.component_batches || []).slice().sort(byBatch);
	if (batches.length === 0) {
		lines.push("- none");
		lines.push("");
		return;
	}

	for (const batch of batches) {
		const prepDate = findBatchPrepDate(batch, plan.prep_tasks || []);
		const qty = formatQty(batch.quantity, batch.unit);
		const attrs = [
			qty ? `qty=${qty}` : "",
			batch.storage ? `storage=${batch.storage}` : "",
			batch.container ? `container=${batch.container}` : "",
			batch.quality_window_hours != null ? `quality_window=${batch.quality_window_hours}h` : "",
			batch.active_time_min ? `active=${batch.active_time_min}m` : "",
			batch.idle_time_min ? `idle=${batch.idle_time_min}m` : "",
			prepDate ? `prep=${prepDate}` : "",
		].filter(Boolean);
		lines.push(`- ${batch.id}: ${clean(batch.label)}${attrs.length ? ` (${attrs.join("; ")})` : ""}`);
		if (batch.input_names.length) lines.push(`  - inputs: ${batch.input_names.map(clean).join(", ")}`);
		if (batch.planned_uses.length) {
			lines.push(`  - planned uses: ${batch.planned_uses.map(formatPlannedUse).join("; ")}`);
		} else {
			lines.push("  - planned uses: none");
		}
	}
	lines.push("");
}

function renderDependencyEdges(lines: string[], edges: DependencyEdge[]): void {
	lines.push("## Dependency Edges");
	lines.push("");
	renderEdgeGroup(lines, "Violated Edges", edges.filter(edge => edge.status === "violated"));
	renderEdgeGroup(lines, "Critical Edges", edges.filter(edge => edge.critical));
	renderEdgeGroup(lines, "Marginal Edges", edges.filter(edge => edge.status === "marginal"));
	renderEdgeGroup(lines, "Ok Edges", edges.filter(edge => edge.status === "ok" && !edge.critical));
}

function renderEdgeGroup(lines: string[], heading: string, edges: DependencyEdge[]): void {
	lines.push(`### ${heading} (${edges.length})`);
	if (edges.length === 0) {
		lines.push("- none");
		lines.push("");
		return;
	}
	for (const edge of edges) {
		const flags = [
			`status=${edge.status}`,
			edge.critical ? "critical=true" : "critical=false",
			`rule=${edge.rule.kind}:${edge.rule.value}h`,
			`lead=${edge.current_lead_time_hours}h`,
			`slack=${edge.slack_hours}h`,
		];
		lines.push(`- ${edgeStatusLabel(edge)} ${edge.id} (${flags.join("; ")})`);
		lines.push(`  - from: ${formatEntityRef(edge.from)}; to: ${formatEntityRef(edge.to)}`);
		lines.push(`  - derived_from: ${edge.derived_from.parent_entity_type}/${edge.derived_from.parent_entity_id} child=${edge.derived_from.child_id} property=${edge.derived_from.child_property}`);
		lines.push(`  - rule text: ${clean(edge.rule.description)}`);
	}
	lines.push("");
}

function renderShopping(lines: string[], plan: MiseWeeklyPlanDraft): void {
	lines.push("## Shopping");
	lines.push("");
	const runs = (plan.shop_runs || []).slice().sort(byShopRun);
	lines.push("### Runs");
	if (runs.length === 0) {
		lines.push("- none");
	} else {
		for (const run of runs) lines.push(`- ${formatShopRun(run)}`);
	}
	lines.push("");

	lines.push("### List");
	const sections = (plan.shopping_list || []).slice().sort(byShoppingSection);
	if (sections.length === 0) {
		lines.push("- none");
		lines.push("");
		return;
	}
	for (const section of sections) {
		const items = section.items.slice().sort(byShoppingItem).map(formatShoppingItem);
		lines.push(`- ${clean(section.category)}: ${items.length ? items.join("; ") : "none"}`);
	}
	lines.push("");
}

function renderGrievances(lines: string[], grievances: Grievance[]): void {
	lines.push("## Grievances");
	lines.push("");
	for (const severity of SEVERITY_ORDER) {
		const group = grievances.filter(g => g.severity === severity);
		lines.push(`### ${titleCase(severity)} (${group.length})`);
		if (group.length === 0) {
			lines.push("- none");
			lines.push("");
			continue;
		}
		for (const grievance of group) {
			const refs = [
				grievance.slot_ref ? `slot=${grievance.slot_ref.date} ${grievance.slot_ref.slot || "(day)"}` : "",
				grievance.batch_id ? `batch=${grievance.batch_id}` : "",
				grievance.component_id ? `component=${grievance.component_id}` : "",
			].filter(Boolean);
			lines.push(`- ${grievance.critic}${refs.length ? ` (${refs.join("; ")})` : ""}: ${clean(grievance.message)}`);
			if (grievance.suggested_repair) lines.push(`  - repair: ${clean(grievance.suggested_repair)}`);
			const proposals = grievance.cascade_proposals || [];
			if (proposals.length) {
				const summaries = proposals
					.slice()
					.sort((a, b) => String(a.kind).localeCompare(String(b.kind)) || clean(a.description).localeCompare(clean(b.description)))
					.map(formatCascadeProposal);
				lines.push(`  - cascade proposals: ${summaries.join("; ")}`);
			}
		}
		lines.push("");
	}
}

function renderCoherence(lines: string[], coherence: CoherenceScoreResult): void {
	lines.push("## Coherence Score");
	lines.push("");
	lines.push(`- score: ${coherence.score}`);
	lines.push(`- issues: ${coherence.issues.length}`);
	lines.push(`- hard critic grievances: ${coherence.hard_grievance_count}`);
	lines.push(`- dependency edge violations: ${coherence.edge_violation_count}`);
	lines.push("- score by category:");
	for (const [category, score] of Object.entries(coherence.score_by_category).sort(([a], [b]) => a.localeCompare(b))) {
		lines.push(`  - ${category}: ${score}`);
	}
	lines.push("");
	lines.push("### Coherence Issues");
	if (coherence.issues.length === 0) {
		lines.push("- none");
		lines.push("");
		return;
	}
	for (const issue of coherence.issues) {
		const refs = [
			issue.date ? `date=${issue.date}` : "",
			issue.slot ? `slot=${issue.slot}` : "",
			issue.meal_ids?.length ? `meals=${issue.meal_ids.join(",")}` : "",
			issue.batch_ids?.length ? `batches=${issue.batch_ids.join(",")}` : "",
		].filter(Boolean);
		lines.push(`- ${issue.kind} (${issue.severity}; score=${issue.score}${refs.length ? `; ${refs.join("; ")}` : ""}): ${clean(issue.message)}`);
	}
	lines.push("");
}

function renderFullJson(
	lines: string[],
	plan: MiseWeeklyPlanDraft,
	calendar: CalendarDay[],
	edges: DependencyEdge[],
	grievances: Grievance[],
	coherence: CoherenceScoreResult,
): void {
	lines.push("## Full Data");
	lines.push("");
	renderJsonBlock(lines, "plan", plan);
	renderJsonBlock(lines, "calendar_index", calendar);
	renderJsonBlock(lines, "dependency_edges", edges);
	renderJsonBlock(lines, "grievances", grievances);
	renderJsonBlock(lines, "coherence", coherence);
}

function renderJsonBlock(lines: string[], label: string, value: unknown): void {
	lines.push(`### ${label}`);
	lines.push("```json");
	lines.push(stableJson(value));
	lines.push("```");
	lines.push("");
}

function derivePlanGrievances(plan: MiseWeeklyPlanDraft, options: RenderPlanMapOptions): Grievance[] {
	const out = runHardCritics(plan);
	if (options.includeWarningCritics === false) return out;
	out.push(...runWarningCritics(plan, { now: options.now || deterministicNow(plan) }));
	return out;
}

function buildCalendar(plan: MiseWeeklyPlanDraft): CalendarDay[] {
	const dates = collectDates(plan);
	const days = dates.map(date => ({
		date,
		shop_runs: [] as ShoppingRun[],
		prep_tasks: [] as MisePlanTask[],
		breakfasts: [] as MisePlanMeal[],
		lunches: [] as MisePlanMeal[],
		snacks: [] as MiseSnackBox[],
		snack_meals: [] as MisePlanMeal[],
		dinners: [] as MisePlanMeal[],
	}));
	const byDate = new Map(days.map(day => [day.date, day]));
	const ensureDay = (date: string): CalendarDay => {
		let day = byDate.get(date);
		if (!day) {
			day = {
				date,
				shop_runs: [],
				prep_tasks: [],
				breakfasts: [],
				lunches: [],
				snacks: [],
				snack_meals: [],
				dinners: [],
			};
			byDate.set(date, day);
			days.push(day);
		}
		return day;
	};

	for (const run of plan.shop_runs || []) ensureDay(run.date).shop_runs.push(run);
	for (const task of plan.prep_tasks || []) ensureDay(task.scheduled_date).prep_tasks.push(task);

	const seenMealIds = new Set<string>();
	for (const day of plan.meals_by_day || []) {
		for (const meal of day.meals || []) {
			addMealToDay(ensureDay(meal.date || day.date), meal, seenMealIds);
		}
	}
	for (const meal of plan.breakfasts || []) addMealToDay(ensureDay(meal.date), meal, seenMealIds);
	for (const snack of plan.snack_boxes || []) ensureDay(snack.date).snacks.push(snack);

	for (const day of days) {
		day.shop_runs.sort(byShopRun);
		day.prep_tasks.sort(byPrepTask);
		day.breakfasts.sort(byMeal);
		day.lunches.sort(byMeal);
		day.snack_meals.sort(byMeal);
		day.snacks.sort(bySnack);
		day.dinners.sort(byMeal);
	}
	return days.sort((a, b) => a.date.localeCompare(b.date));
}

function addMealToDay(day: CalendarDay, meal: MisePlanMeal, seenMealIds: Set<string>): void {
	if (seenMealIds.has(meal.id)) return;
	seenMealIds.add(meal.id);
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

function collectDates(plan: MiseWeeklyPlanDraft): string[] {
	const dates = new Set<string>();
	const startMs = parseDateMs(plan.start_date);
	const endMs = parseDateMs(plan.end_date);
	if (Number.isFinite(startMs) && Number.isFinite(endMs) && startMs <= endMs) {
		for (let ms = startMs; ms <= endMs; ms += 86400000) {
			dates.add(new Date(ms).toISOString().slice(0, 10));
		}
	} else {
		if (isIsoDate(plan.start_date)) dates.add(plan.start_date);
		if (isIsoDate(plan.end_date)) dates.add(plan.end_date);
	}

	for (const day of plan.meals_by_day || []) if (isIsoDate(day.date)) dates.add(day.date);
	for (const meal of collectAllMeals(plan)) if (isIsoDate(meal.date)) dates.add(meal.date);
	for (const snack of plan.snack_boxes || []) if (isIsoDate(snack.date)) dates.add(snack.date);
	for (const task of plan.prep_tasks || []) if (isIsoDate(task.scheduled_date)) dates.add(task.scheduled_date);
	for (const run of plan.shop_runs || []) if (isIsoDate(run.date)) dates.add(run.date);
	for (const batch of plan.component_batches || []) {
		for (const use of batch.planned_uses || []) if (isIsoDate(use.date)) dates.add(use.date);
	}

	return Array.from(dates).sort();
}

function collectAllMeals(plan: MiseWeeklyPlanDraft): MisePlanMeal[] {
	const out: MisePlanMeal[] = [];
	const seen = new Set<string>();
	for (const day of plan.meals_by_day || []) {
		for (const meal of day.meals || []) {
			if (seen.has(meal.id)) continue;
			seen.add(meal.id);
			out.push(meal);
		}
	}
	for (const meal of plan.breakfasts || []) {
		if (seen.has(meal.id)) continue;
		seen.add(meal.id);
		out.push(meal);
	}
	return out.sort(byMeal);
}

function formatMeal(meal: MisePlanMeal): string {
	const attrs = [
		`format=${clean(meal.format)}`,
		meal.component_ids.length ? `components=${meal.component_ids.join(",")}` : "",
		meal.leftovers_to && meal.leftovers_to.length ? `leftovers_to=${meal.leftovers_to.join(",")}` : "",
		meal.locked ? "locked=true" : "",
	].filter(Boolean);
	return `${meal.id}: ${clean(meal.title)}${attrs.length ? ` [${attrs.join("; ")}]` : ""}`;
}

function formatSnack(snack: MiseSnackBox): string {
	const attrs = [
		snack.items.length ? `items=${snack.items.map(clean).join(",")}` : "",
		snack.component_ids.length ? `components=${snack.component_ids.join(",")}` : "",
		snack.locked ? "locked=true" : "",
	].filter(Boolean);
	return `${snack.id}: ${clean(snack.title)}${attrs.length ? ` [${attrs.join("; ")}]` : ""}`;
}

function formatPrepTask(task: MisePlanTask): string {
	const attrs = [
		`order=${task.session_order}`,
		task.active_time_min ? `active=${task.active_time_min}m` : "",
		task.idle_time_min ? `idle=${task.idle_time_min}m` : "",
		task.state_inputs.length ? `inputs=${task.state_inputs.join(",")}` : "",
		task.state_outputs.length ? `outputs=${task.state_outputs.join(",")}` : "",
		task.depends_on.length ? `depends_on=${task.depends_on.join(",")}` : "",
	].filter(Boolean);
	return `${task.id}: ${clean(task.title)} [${attrs.join("; ")}]`;
}

function formatShopRun(run: ShoppingRun): string {
	const attrs = [
		`date=${run.date}`,
		run.categories.length ? `categories=${run.categories.join(",")}` : "",
		`item_count=${run.item_count}`,
	].filter(Boolean);
	return `${run.id}: ${clean(run.label)} [${attrs.join("; ")}]`;
}

function formatShoppingItem(item: MiseShoppingListItem): string {
	const attrs = [
		formatQty(item.quantity, item.unit),
		item.grams_total != null ? `${trimNumber(item.grams_total)}g` : "",
		item.source.length ? `sources=${item.source.join(",")}` : "",
	].filter(Boolean);
	return `${clean(item.name)}${attrs.length ? ` (${attrs.join("; ")})` : ""}`;
}

function formatPlannedUse(use: { date: string; slot: MiseMealSlot; meal_id: string; title: string }): string {
	return `${use.date} ${use.slot} ${use.meal_id} "${clean(use.title)}"`;
}

function formatCascadeProposal(proposal: NonNullable<Grievance["cascade_proposals"]>[number]): string {
	const confidence = typeof proposal.confidence === "number" ? ` confidence=${trimNumber(proposal.confidence)}` : "";
	const resolves = Array.isArray(proposal.expected_resolves) && proposal.expected_resolves.length
		? ` resolves=${proposal.expected_resolves.join(",")}`
		: "";
	const mutation = proposal.mutation && typeof proposal.mutation.kind === "string"
		? ` mutation=${proposal.mutation.kind}`
		: "";
	return `[${proposal.kind}${confidence}${mutation}${resolves}] ${clean(proposal.description)}`;
}

function formatEntityRef(ref: DependencyEdge["from"]): string {
	return `${ref.entity_type} ${ref.entity_id} @ ${ref.date}`;
}

function edgeStatusLabel(edge: DependencyEdge): string {
	if (edge.status === "violated") return "VIOLATED";
	if (edge.critical) return "CRITICAL";
	if (edge.status === "marginal") return "MARGINAL";
	return "OK";
}

function countEdges(edges: DependencyEdge[]): { ok: number; marginal: number; violated: number; critical: number } {
	const counts = { ok: 0, marginal: 0, violated: 0, critical: 0 };
	for (const edge of edges) {
		if (edge.status === "ok") counts.ok++;
		if (edge.status === "marginal") counts.marginal++;
		if (edge.status === "violated") counts.violated++;
		if (edge.critical) counts.critical++;
	}
	return counts;
}

function countGrievances(grievances: Grievance[]): Record<GrievanceSeverity, number> {
	const counts: Record<GrievanceSeverity, number> = { hard: 0, warning: 0, preference: 0 };
	for (const grievance of grievances) counts[grievance.severity]++;
	return counts;
}

function findBatchPrepDate(batch: MisePlanComponentBatch, tasks: MisePlanTask[]): string | null {
	const task = tasks
		.slice()
		.sort(byPrepTask)
		.find(candidate => (candidate.state_outputs || []).includes(batch.id));
	if (task) return task.scheduled_date;

	const desired = batch.meta?.desired_prep_date;
	if (typeof desired === "string" && isIsoDate(desired)) return desired;

	const firstUse = (batch.planned_uses || []).slice().sort((a, b) => a.date.localeCompare(b.date))[0];
	return firstUse ? subtractDays(firstUse.date, 1) : null;
}

function deterministicNow(plan: MiseWeeklyPlanDraft): string {
	const date = isIsoDate(plan.end_date) ? plan.end_date : isIsoDate(plan.start_date) ? plan.start_date : "1970-01-01";
	return `${date}T00:00:00.000Z`;
}

function joinCell(items: string[]): string {
	return items.length ? items.join("<br>") : "none";
}

function tableCell(value: string): string {
	return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function dayLabel(date: string): string {
	return `${date} ${weekday(date)}`;
}

function weekday(date: string): string {
	const ms = parseDateMs(date);
	if (!Number.isFinite(ms)) return "";
	return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(ms).getUTCDay()];
}

function formatQty(qty: number | null, unit: string | null): string {
	if (qty == null) return "";
	return unit ? `${trimNumber(qty)} ${unit}` : trimNumber(qty);
}

function trimNumber(value: number): string {
	if (Number.isInteger(value)) return String(value);
	return value.toFixed(3).replace(/\.?0+$/, "");
}

function titleCase(value: string): string {
	return value.replace(/\b[a-z]/g, char => char.toUpperCase());
}

function clean(value: unknown): string {
	return String(value ?? "")
		.replace(/\s+/g, " ")
		.trim();
}

function parseDateMs(date: string): number {
	return Date.parse(`${date}T00:00:00.000Z`);
}

function isIsoDate(value: string): boolean {
	return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(parseDateMs(value));
}

function subtractDays(iso: string, days: number): string {
	const ms = parseDateMs(iso);
	if (!Number.isFinite(ms)) return iso;
	const date = new Date(ms);
	date.setUTCDate(date.getUTCDate() - days);
	return date.toISOString().slice(0, 10);
}

function sortEdges(edges: DependencyEdge[]): DependencyEdge[] {
	return edges.slice().sort((a, b) =>
		edgeSortKey(a).localeCompare(edgeSortKey(b)),
	);
}

function edgeSortKey(edge: DependencyEdge): string {
	const statusRank = edge.status === "violated" ? "0" : edge.critical ? "1" : edge.status === "marginal" ? "2" : "3";
	return [
		statusRank,
		edge.to.date,
		edge.from.date,
		edge.rule.kind,
		edge.id,
	].join("|");
}

function sortGrievances(grievances: Grievance[]): Grievance[] {
	return grievances.slice().sort((a, b) => grievanceSortKey(a).localeCompare(grievanceSortKey(b)));
}

function grievanceSortKey(grievance: Grievance): string {
	return [
		SEVERITY_ORDER.indexOf(grievance.severity),
		grievance.slot_ref?.date || "",
		SLOT_ORDER[grievance.slot_ref?.slot || ""] || 0,
		grievance.critic,
		grievance.batch_id || "",
		grievance.component_id || "",
		grievance.message,
	].join("|");
}

function byMeal(a: MisePlanMeal, b: MisePlanMeal): number {
	return [
		a.date.localeCompare(b.date),
		(SLOT_ORDER[a.slot] || 99) - (SLOT_ORDER[b.slot] || 99),
		a.id.localeCompare(b.id),
	].find(n => n !== 0) || 0;
}

function bySnack(a: MiseSnackBox, b: MiseSnackBox): number {
	return a.date.localeCompare(b.date) || a.id.localeCompare(b.id);
}

function byPrepTask(a: MisePlanTask, b: MisePlanTask): number {
	return a.scheduled_date.localeCompare(b.scheduled_date)
		|| a.session_order - b.session_order
		|| a.id.localeCompare(b.id);
}

function byBatch(a: MisePlanComponentBatch, b: MisePlanComponentBatch): number {
	return a.id.localeCompare(b.id);
}

function byShopRun(a: ShoppingRun, b: ShoppingRun): number {
	return a.date.localeCompare(b.date) || a.id.localeCompare(b.id);
}

function byShoppingSection(a: MiseShoppingListSection, b: MiseShoppingListSection): number {
	return a.category.localeCompare(b.category);
}

function byShoppingItem(a: MiseShoppingListItem, b: MiseShoppingListItem): number {
	return a.name.localeCompare(b.name);
}

function stableJson(value: unknown): string {
	return JSON.stringify(sortJsonValue(value), null, 2);
}

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

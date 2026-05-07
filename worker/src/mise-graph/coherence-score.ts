import { runHardCritics } from "./critics";
import { deriveDependencyEdges, edgesViolated } from "./dependency-edges";
import { FORMAT_ALIASES, FORMAT_SLOT_SPECS, resolveFormatSpec } from "./meal-component";
import type { MiseMealSlot, MisePlanComponentBatch, MisePlanMeal, MisePlanTask, MiseWeeklyPlanDraft } from "./planner";

export type CoherenceIssueSeverity = "info" | "warning" | "hard";

export type CoherenceIssueKind =
	| "duplicate_exact_meal_title"
	| "duplicate_similar_meal_title"
	| "repeated_same_day_cuisine"
	| "repeated_same_day_format"
	| "missing_cuisine"
	| "unknown_cuisine"
	| "missing_format"
	| "unknown_format"
	| "malformed_leftover_claim"
	| "reverse_time_leftover_claim"
	| "missing_leftover_target"
	| "undeclared_leftover_lunch"
	| "placeholder_lunch"
	| "redundant_prep_batch"
	| "hard_critic_grievances"
	| "dependency_edge_violations";

export interface CoherenceIssue {
	id: string;
	kind: CoherenceIssueKind;
	severity: CoherenceIssueSeverity;
	score: number;
	message: string;
	date?: string;
	slot?: string;
	meal_ids?: string[];
	batch_ids?: string[];
	meta?: Record<string, unknown>;
}

export interface CoherenceScoreResult {
	score: number;
	issues: CoherenceIssue[];
	duplicate_title_issues: CoherenceIssue[];
	same_day_cuisine_issues: CoherenceIssue[];
	same_day_format_issues: CoherenceIssue[];
	missing_descriptor_issues: CoherenceIssue[];
	leftover_issues: CoherenceIssue[];
	prep_batch_issues: CoherenceIssue[];
	hard_grievance_count: number;
	edge_violation_count: number;
	score_by_category: Record<string, number>;
}

const WEIGHTS: Record<CoherenceIssueKind, number> = {
	duplicate_exact_meal_title: 8,
	duplicate_similar_meal_title: 5,
	repeated_same_day_cuisine: 3,
	repeated_same_day_format: 3,
	missing_cuisine: 2,
	unknown_cuisine: 2,
	missing_format: 2,
	unknown_format: 2,
	malformed_leftover_claim: 8,
	reverse_time_leftover_claim: 8,
	missing_leftover_target: 5,
	undeclared_leftover_lunch: 4,
	placeholder_lunch: 2,
	redundant_prep_batch: 5,
	hard_critic_grievances: 10,
	dependency_edge_violations: 8,
};

const SLOT_ORDER: Record<string, number> = {
	breakfast: 1,
	lunch: 2,
	snack: 3,
	dinner: 4,
};

const UNKNOWN_DESCRIPTOR_VALUES = new Set([
	"",
	"unknown",
	"tbd",
	"to be decided",
	"placeholder",
	"misc",
	"miscellaneous",
	"none",
	"n/a",
	"na",
]);

const KNOWN_FORMATS = new Set([
	...Object.keys(FORMAT_SLOT_SPECS),
	...Object.keys(FORMAT_ALIASES),
	...Object.values(FORMAT_ALIASES),
	"skillet",
	"noodle",
	"noodles",
	"wrap",
	"toast",
	"scramble",
	"porridge",
	"oats",
	"oatmeal",
	"yogurt bowl",
	"snack box",
	"plate",
	"rice plate",
]);

/**
 * Scores deterministic plan coherence. Higher scores are worse.
 *
 * This is intentionally a pure structural pass: it does not call an LLM or load
 * external data. The return object keeps category arrays stable so planner
 * tests and revision heuristics can depend on concrete issue records instead of
 * parsing text.
 */
export function scorePlanCoherence(plan: MiseWeeklyPlanDraft): CoherenceScoreResult {
	const allMeals = collectAllMeals(plan);
	const sortedMeals = allMeals.slice().sort(compareMeals);
	const slotIndex = buildSlotIndex(sortedMeals);
	const leftoverLinks = buildDeclaredLeftoverLinks(sortedMeals);

	const duplicateTitleIssues = scoreDuplicateMealTitles(sortedMeals, leftoverLinks);
	const sameDayCuisineIssues = scoreRepeatedSameDayCuisine(sortedMeals);
	const sameDayFormatIssues = scoreRepeatedSameDayFormat(sortedMeals);
	const missingDescriptorIssues = scoreMissingDescriptors(sortedMeals);
	const leftoverIssues = scoreLeftoverClaims(sortedMeals, slotIndex, leftoverLinks);
	const prepBatchIssues = scoreRedundantPrepBatches(plan.component_batches || [], plan.prep_tasks || []);

	const hardGrievances = runHardCritics(plan);
	const edgeViolations = edgesViolated(deriveDependencyEdges(plan));

	const summaryIssues: CoherenceIssue[] = [];
	if (hardGrievances.length > 0) {
		const score = hardGrievances.length * WEIGHTS.hard_critic_grievances;
		summaryIssues.push({
			id: "hard_critic_grievances",
			kind: "hard_critic_grievances",
			severity: "hard",
			score,
			message: `${hardGrievances.length} hard critic grievance(s) reported by runHardCritics().`,
			meta: { critic_counts: countBy(hardGrievances.map(g => g.critic)) },
		});
	}
	if (edgeViolations.length > 0) {
		const score = edgeViolations.length * WEIGHTS.dependency_edge_violations;
		summaryIssues.push({
			id: "dependency_edge_violations",
			kind: "dependency_edge_violations",
			severity: "hard",
			score,
			message: `${edgeViolations.length} dependency edge violation(s) reported by deriveDependencyEdges().`,
			meta: { edge_ids: edgeViolations.map(e => e.id) },
		});
	}

	const issues = [
		...duplicateTitleIssues,
		...sameDayCuisineIssues,
		...sameDayFormatIssues,
		...missingDescriptorIssues,
		...leftoverIssues,
		...prepBatchIssues,
		...summaryIssues,
	].sort(compareIssues);

	const scoreByCategory = {
		duplicate_titles: sumScores(duplicateTitleIssues),
		same_day_cuisine: sumScores(sameDayCuisineIssues),
		same_day_format: sumScores(sameDayFormatIssues),
		missing_descriptors: sumScores(missingDescriptorIssues),
		leftovers: sumScores(leftoverIssues),
		prep_batches: sumScores(prepBatchIssues),
		hard_critics: hardGrievances.length * WEIGHTS.hard_critic_grievances,
		dependency_edges: edgeViolations.length * WEIGHTS.dependency_edge_violations,
	};

	return {
		score: sumScores(issues),
		issues,
		duplicate_title_issues: duplicateTitleIssues.sort(compareIssues),
		same_day_cuisine_issues: sameDayCuisineIssues.sort(compareIssues),
		same_day_format_issues: sameDayFormatIssues.sort(compareIssues),
		missing_descriptor_issues: missingDescriptorIssues.sort(compareIssues),
		leftover_issues: leftoverIssues.sort(compareIssues),
		prep_batch_issues: prepBatchIssues.sort(compareIssues),
		hard_grievance_count: hardGrievances.length,
		edge_violation_count: edgeViolations.length,
		score_by_category: scoreByCategory,
	};
}

function scoreDuplicateMealTitles(meals: MisePlanMeal[], leftoverLinks: Set<string>): CoherenceIssue[] {
	const out: CoherenceIssue[] = [];
	for (let i = 0; i < meals.length; i++) {
		for (let j = i + 1; j < meals.length; j++) {
			const a = meals[i];
			const b = meals[j];
			if (!isSameDay(a, b) && !areAdjacentInSequence(meals, i, j)) continue;
			if (areLinkedByLeftovers(a, b, leftoverLinks)) continue;

			const exact = normalizeTitle(a.title) === normalizeTitle(b.title);
			const similar = exact || titlesLookSimilar(a.title, b.title);
			if (!similar) continue;

			const kind: CoherenceIssueKind = exact ? "duplicate_exact_meal_title" : "duplicate_similar_meal_title";
			out.push({
				id: `${kind}:${a.date}:${a.slot}:${b.date}:${b.slot}`,
				kind,
				severity: exact ? "hard" : "warning",
				score: WEIGHTS[kind],
				message: exact
					? `Exact duplicate meal title "${a.title}" appears in nearby slots.`
					: `Similar meal titles "${a.title}" and "${b.title}" appear in nearby slots.`,
				date: a.date,
				slot: a.slot,
				meal_ids: [a.id, b.id],
				meta: {
					first_slot: slotRef(a),
					second_slot: slotRef(b),
					first_title: a.title,
					second_title: b.title,
				},
			});
		}
	}
	return out;
}

function scoreRepeatedSameDayCuisine(meals: MisePlanMeal[]): CoherenceIssue[] {
	const out: CoherenceIssue[] = [];
	for (const [date, dayMeals] of groupMealsByDate(meals)) {
		const byCuisine = new Map<string, MisePlanMeal[]>();
		for (const meal of dayMeals) {
			for (const cuisine of validCuisineLabels(meal.cuisine || [])) {
				pushMap(byCuisine, cuisine, meal);
			}
		}
		for (const [cuisine, hits] of byCuisine) {
			if (hits.length < 2) continue;
			const score = WEIGHTS.repeated_same_day_cuisine * (hits.length - 1);
			out.push({
				id: `repeated_same_day_cuisine:${date}:${cuisine}`,
				kind: "repeated_same_day_cuisine",
				severity: "warning",
				score,
				message: `${hits.length} meals on ${date} repeat cuisine "${cuisine}".`,
				date,
				meal_ids: hits.map(m => m.id),
				meta: {
					cuisine,
					slots: hits.map(slotRef),
				},
			});
		}
	}
	return out;
}

function scoreRepeatedSameDayFormat(meals: MisePlanMeal[]): CoherenceIssue[] {
	const out: CoherenceIssue[] = [];
	for (const [date, dayMeals] of groupMealsByDate(meals)) {
		const byFormat = new Map<string, MisePlanMeal[]>();
		for (const meal of dayMeals) {
			const format = canonicalFormat(meal.format);
			if (!format || UNKNOWN_DESCRIPTOR_VALUES.has(format)) continue;
			pushMap(byFormat, format, meal);
		}
		for (const [format, hits] of byFormat) {
			if (hits.length < 2) continue;
			const score = WEIGHTS.repeated_same_day_format * (hits.length - 1);
			out.push({
				id: `repeated_same_day_format:${date}:${format}`,
				kind: "repeated_same_day_format",
				severity: "warning",
				score,
				message: `${hits.length} meals on ${date} repeat format "${format}".`,
				date,
				meal_ids: hits.map(m => m.id),
				meta: {
					format,
					slots: hits.map(slotRef),
				},
			});
		}
	}
	return out;
}

function scoreMissingDescriptors(meals: MisePlanMeal[]): CoherenceIssue[] {
	const out: CoherenceIssue[] = [];
	for (const meal of meals) {
		const cuisineValues = (meal.cuisine || []).map(normalizeDescriptor).filter(v => v.length > 0);
		if (cuisineValues.length === 0) {
			out.push(descriptorIssue("missing_cuisine", meal, `Meal "${meal.title}" is missing cuisine metadata.`));
		} else {
			const unknown = cuisineValues.filter(v => UNKNOWN_DESCRIPTOR_VALUES.has(v));
			if (unknown.length > 0 || validCuisineLabels(meal.cuisine || []).length === 0) {
				out.push(descriptorIssue("unknown_cuisine", meal, `Meal "${meal.title}" has unknown cuisine metadata.`));
			}
		}

		const rawFormat = normalizeDescriptor(meal.format);
		if (!rawFormat) {
			out.push(descriptorIssue("missing_format", meal, `Meal "${meal.title}" is missing format metadata.`));
		} else if (UNKNOWN_DESCRIPTOR_VALUES.has(rawFormat) || !isKnownFormat(meal.format)) {
			out.push(descriptorIssue("unknown_format", meal, `Meal "${meal.title}" has unknown format "${meal.format}".`));
		}
	}
	return out;
}

function scoreLeftoverClaims(
	meals: MisePlanMeal[],
	slotIndex: Map<string, MisePlanMeal>,
	leftoverLinks: Set<string>,
): CoherenceIssue[] {
	const out: CoherenceIssue[] = [];
	for (const meal of meals) {
		for (const claim of meal.leftovers_to || []) {
			const parsed = parseLeftoverClaim(claim);
			if (!parsed) {
				out.push({
					id: `malformed_leftover_claim:${meal.id}:${normalizeIdPart(claim)}`,
					kind: "malformed_leftover_claim",
					severity: "hard",
					score: WEIGHTS.malformed_leftover_claim,
					message: `Meal "${meal.title}" has malformed leftovers_to claim "${claim}".`,
					date: meal.date,
					slot: meal.slot,
					meal_ids: [meal.id],
					meta: { claim, expected_format: "YYYY-MM-DD slot" },
				});
				continue;
			}

			if (isReverseTimeClaim(meal, parsed)) {
				out.push({
					id: `reverse_time_leftover_claim:${meal.id}:${parsed.date}:${parsed.slot}`,
					kind: "reverse_time_leftover_claim",
					severity: "hard",
					score: WEIGHTS.reverse_time_leftover_claim,
					message: `Meal "${meal.title}" claims leftovers flow backward to ${parsed.date} ${parsed.slot}.`,
					date: meal.date,
					slot: meal.slot,
					meal_ids: [meal.id],
					meta: { claim, target: parsed },
				});
			}

			const target = slotIndex.get(slotKey(parsed.date, parsed.slot));
			if (!target) {
				out.push({
					id: `missing_leftover_target:${meal.id}:${parsed.date}:${parsed.slot}`,
					kind: "missing_leftover_target",
					severity: "warning",
					score: WEIGHTS.missing_leftover_target,
					message: `Meal "${meal.title}" claims leftovers_to ${parsed.date} ${parsed.slot}, but that slot is not in the plan.`,
					date: meal.date,
					slot: meal.slot,
					meal_ids: [meal.id],
					meta: { claim, target: parsed },
				});
			}
		}
	}

	for (const lunch of meals.filter(m => m.slot === "lunch")) {
		const incomingDeclared = meals.some(source => leftoverLinks.has(leftoverLinkKey(source, lunch)));
		const text = lunchText(lunch);
		if (looksLikeLeftoverLunch(text) && !incomingDeclared) {
			out.push({
				id: `undeclared_leftover_lunch:${lunch.id}`,
				kind: "undeclared_leftover_lunch",
				severity: "warning",
				score: WEIGHTS.undeclared_leftover_lunch,
				message: `Lunch "${lunch.title}" looks like leftovers, but no earlier meal declares leftovers_to this slot.`,
				date: lunch.date,
				slot: lunch.slot,
				meal_ids: [lunch.id],
			});
		}
		if (looksLikePlaceholderLunch(lunch)) {
			out.push({
				id: `placeholder_lunch:${lunch.id}`,
				kind: "placeholder_lunch",
				severity: "info",
				score: WEIGHTS.placeholder_lunch,
				message: `Lunch "${lunch.title}" looks like a placeholder rather than a resolved meal.`,
				date: lunch.date,
				slot: lunch.slot,
				meal_ids: [lunch.id],
			});
		}
	}

	return out;
}

function scoreRedundantPrepBatches(batches: MisePlanComponentBatch[], tasks: MisePlanTask[]): CoherenceIssue[] {
	const out: CoherenceIssue[] = [];
	const indexed = batches
		.map(batch => ({
			batch,
			prepDate: prepDateForBatch(batch, tasks),
			label: normalizeTitle(batch.label),
			qualityWindowHours: positiveNumber(batch.quality_window_hours),
		}))
		.filter(item => item.prepDate && item.label && item.qualityWindowHours !== null);

	for (let i = 0; i < indexed.length; i++) {
		for (let j = i + 1; j < indexed.length; j++) {
			const a = indexed[i];
			const b = indexed[j];
			const exact = a.label === b.label;
			const similar = exact || titlesLookSimilar(a.batch.label, b.batch.label);
			if (!similar || !a.prepDate || !b.prepDate || a.qualityWindowHours === null || b.qualityWindowHours === null) continue;

			const gapHours = Math.abs(hoursBetween(a.prepDate, b.prepDate));
			const windowHours = Math.min(a.qualityWindowHours, b.qualityWindowHours);
			if (gapHours > windowHours) continue;

			out.push({
				id: `redundant_prep_batch:${a.batch.id}:${b.batch.id}`,
				kind: "redundant_prep_batch",
				severity: "warning",
				score: exact ? WEIGHTS.redundant_prep_batch : Math.max(1, WEIGHTS.redundant_prep_batch - 2),
				message: `Prep batches "${a.batch.label}" and "${b.batch.label}" look redundant within a ${windowHours}h quality window.`,
				batch_ids: [a.batch.id, b.batch.id],
				meta: {
					first_prep_date: a.prepDate,
					second_prep_date: b.prepDate,
					gap_hours: gapHours,
					quality_window_hours: windowHours,
					exact_label_match: exact,
				},
			});
		}
	}
	return out;
}

function descriptorIssue(kind: Extract<CoherenceIssueKind, "missing_cuisine" | "unknown_cuisine" | "missing_format" | "unknown_format">, meal: MisePlanMeal, message: string): CoherenceIssue {
	return {
		id: `${kind}:${meal.id}`,
		kind,
		severity: "warning",
		score: WEIGHTS[kind],
		message,
		date: meal.date,
		slot: meal.slot,
		meal_ids: [meal.id],
		meta: {
			cuisine: meal.cuisine || [],
			format: meal.format || null,
		},
	};
}

function collectAllMeals(plan: MiseWeeklyPlanDraft): MisePlanMeal[] {
	const out: MisePlanMeal[] = [];
	for (const day of plan.meals_by_day || []) {
		for (const meal of day.meals || []) out.push(meal);
	}
	for (const breakfast of plan.breakfasts || []) out.push(breakfast);
	return out;
}

function compareMeals(a: MisePlanMeal, b: MisePlanMeal): number {
	const byDate = a.date.localeCompare(b.date);
	if (byDate !== 0) return byDate;
	return slotOrder(a.slot) - slotOrder(b.slot) || a.id.localeCompare(b.id);
}

function compareIssues(a: CoherenceIssue, b: CoherenceIssue): number {
	return a.id.localeCompare(b.id);
}

function isSameDay(a: MisePlanMeal, b: MisePlanMeal): boolean {
	return a.date === b.date;
}

function areAdjacentInSequence(meals: MisePlanMeal[], i: number, j: number): boolean {
	return j === i + 1 && !isSameDay(meals[i], meals[j]);
}

function areLinkedByLeftovers(a: MisePlanMeal, b: MisePlanMeal, leftoverLinks: Set<string>): boolean {
	return leftoverLinks.has(leftoverLinkKey(a, b)) || leftoverLinks.has(leftoverLinkKey(b, a));
}

function buildSlotIndex(meals: MisePlanMeal[]): Map<string, MisePlanMeal> {
	const out = new Map<string, MisePlanMeal>();
	for (const meal of meals) out.set(slotKey(meal.date, meal.slot), meal);
	return out;
}

function buildDeclaredLeftoverLinks(meals: MisePlanMeal[]): Set<string> {
	const out = new Set<string>();
	const slotIndex = buildSlotIndex(meals);
	for (const source of meals) {
		for (const claim of source.leftovers_to || []) {
			const parsed = parseLeftoverClaim(claim);
			if (!parsed) continue;
			const target = slotIndex.get(slotKey(parsed.date, parsed.slot));
			if (!target) continue;
			out.add(leftoverLinkKey(source, target));
		}
	}
	return out;
}

function leftoverLinkKey(source: MisePlanMeal, target: MisePlanMeal): string {
	return `${source.id}->${target.id}`;
}

function groupMealsByDate(meals: MisePlanMeal[]): Map<string, MisePlanMeal[]> {
	const out = new Map<string, MisePlanMeal[]>();
	for (const meal of meals) pushMap(out, meal.date, meal);
	return out;
}

function pushMap<K, V>(map: Map<K, V[]>, key: K, value: V): void {
	const current = map.get(key);
	if (current) current.push(value);
	else map.set(key, [value]);
}

function validCuisineLabels(cuisines: string[]): string[] {
	const out: string[] = [];
	for (const cuisine of cuisines) {
		const normalized = normalizeDescriptor(cuisine);
		if (!normalized || UNKNOWN_DESCRIPTOR_VALUES.has(normalized)) continue;
		out.push(normalized);
	}
	return out;
}

function isKnownFormat(format: string | null | undefined): boolean {
	const normalized = normalizeDescriptor(format || "");
	if (!normalized || UNKNOWN_DESCRIPTOR_VALUES.has(normalized)) return false;
	return resolveFormatSpec(format) !== null || KNOWN_FORMATS.has(normalized);
}

function canonicalFormat(format: string | null | undefined): string {
	const normalized = normalizeDescriptor(format || "");
	if (!normalized) return "";
	return FORMAT_ALIASES[normalized] || normalized;
}

function parseLeftoverClaim(claim: string): { date: string; slot: MiseMealSlot } | null {
	const match = claim.match(/^(\d{4}-\d{2}-\d{2})\s+(breakfast|lunch|dinner|snack)$/i);
	if (!match || !isValidIsoDate(match[1])) return null;
	return { date: match[1], slot: match[2].toLowerCase() as MiseMealSlot };
}

function isReverseTimeClaim(source: MisePlanMeal, target: { date: string; slot: string }): boolean {
	return target.date < source.date || (target.date === source.date && slotOrder(target.slot) <= slotOrder(source.slot));
}

function looksLikeLeftoverLunch(text: string): boolean {
	return /\b(leftover|leftovers|reheat|rerun|next day|next-day|from dinner|remix)\b/i.test(text);
}

function looksLikePlaceholderLunch(meal: MisePlanMeal): boolean {
	const title = normalizeTitle(meal.title);
	const format = normalizeDescriptor(meal.format);
	if (/\b(tbd|placeholder|leftover fresh|leftover\/fresh)\b/.test(title)) return true;
	if (format === "placeholder" || format === "tbd") return true;

	const tokens = titleTokens(meal.title);
	if (tokens.length > 3 || !tokens.includes("fresh")) return false;
	const generic = new Set(["lunch", "bowl", "salad", "wrap", "plate"]);
	return tokens.every(t => t === "fresh" || generic.has(t));
}

function lunchText(meal: MisePlanMeal): string {
	return [
		meal.title || "",
		meal.format || "",
		meal.method_summary || "",
		...(meal.notes || []),
	].join(" ");
}

function slotRef(meal: MisePlanMeal): { date: string; slot: string } {
	return { date: meal.date, slot: meal.slot };
}

function slotKey(date: string, slot: string): string {
	return `${date}::${slot.toLowerCase()}`;
}

function slotOrder(slot: string): number {
	return SLOT_ORDER[slot.toLowerCase()] || 0;
}

function normalizeTitle(value: string): string {
	return normalizeWords(value).join(" ");
}

function titleTokens(value: string): string[] {
	return normalizeWords(value).filter(token => !TITLE_STOP_WORDS.has(token));
}

const TITLE_STOP_WORDS = new Set([
	"a",
	"an",
	"and",
	"batch",
	"component",
	"dinner",
	"easy",
	"fresh",
	"leftover",
	"leftovers",
	"lunch",
	"quick",
	"simple",
	"style",
	"the",
	"with",
]);

function titlesLookSimilar(a: string, b: string): boolean {
	const aTokens = titleTokens(a);
	const bTokens = titleTokens(b);
	if (aTokens.length === 0 || bTokens.length === 0) return false;
	if (aTokens.join(" ") === bTokens.join(" ")) return true;

	const aSet = new Set(aTokens);
	const bSet = new Set(bTokens);
	let intersection = 0;
	for (const token of aSet) {
		if (bSet.has(token)) intersection++;
	}
	const minSize = Math.min(aSet.size, bSet.size);
	const unionSize = new Set([...aSet, ...bSet]).size;
	return intersection >= 2 && (intersection / minSize >= 0.75 || intersection / unionSize >= 0.6);
}

function normalizeWords(value: string): string[] {
	return value
		.toLowerCase()
		.replace(/['']/g, "")
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
		.split(/\s+/)
		.filter(Boolean)
		.map(stemToken);
}

function stemToken(token: string): string {
	if (token === "herby") return "herb";
	if (token.endsWith("ies") && token.length > 4) return token.slice(0, -3) + "y";
	if (token.endsWith("oes") && token.length > 4) return token.slice(0, -2);
	if (token.endsWith("ed") && token.length > 4) return token.slice(0, -2);
	if (token.endsWith("s") && !token.endsWith("ss") && token.length > 3) return token.slice(0, -1);
	return token;
}

function normalizeDescriptor(value: string): string {
	return value.toLowerCase().trim().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

function normalizeIdPart(value: string): string {
	return normalizeDescriptor(value).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "empty";
}

function prepDateForBatch(batch: MisePlanComponentBatch, tasks: MisePlanTask[]): string | null {
	for (const task of tasks) {
		if ((task.state_outputs || []).includes(batch.id) && isValidIsoDate(task.scheduled_date)) return task.scheduled_date;
	}

	const meta = batch.meta as Record<string, unknown> | undefined;
	for (const key of ["desired_prep_date", "prep_date", "scheduled_date"]) {
		const value = meta?.[key];
		if (typeof value === "string" && isValidIsoDate(value)) return value;
	}

	const firstUse = (batch.planned_uses || []).slice().sort((a, b) => a.date.localeCompare(b.date))[0];
	if (firstUse && isValidIsoDate(firstUse.date)) return addDays(firstUse.date, -1);
	return null;
}

function positiveNumber(value: number | null | undefined): number | null {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function hoursBetween(a: string, b: string): number {
	const da = Date.parse(`${a}T00:00:00Z`);
	const db = Date.parse(`${b}T00:00:00Z`);
	if (!Number.isFinite(da) || !Number.isFinite(db)) return 0;
	return (db - da) / 3_600_000;
}

function addDays(iso: string, days: number): string {
	const ms = Date.parse(`${iso}T00:00:00Z`);
	if (!Number.isFinite(ms)) return iso;
	const date = new Date(ms);
	date.setUTCDate(date.getUTCDate() + days);
	return date.toISOString().slice(0, 10);
}

function isValidIsoDate(value: string): boolean {
	const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (!match) return false;
	const ms = Date.parse(`${value}T00:00:00Z`);
	if (!Number.isFinite(ms)) return false;
	return new Date(ms).toISOString().slice(0, 10) === value;
}

function countBy(values: string[]): Record<string, number> {
	const out: Record<string, number> = {};
	for (const value of values) out[value] = (out[value] || 0) + 1;
	return out;
}

function sumScores(issues: CoherenceIssue[]): number {
	return issues.reduce((sum, issue) => sum + issue.score, 0);
}

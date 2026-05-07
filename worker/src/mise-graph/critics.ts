// Pure-function critics for the LLM-Modulo loop.
//
// Each critic takes a plan + (eventually) a ResourceLedger and returns a list
// of structured grievances. Critics MUST be pure: same input → same output,
// no I/O, no LLM calls. The agentic revision loop reads grievances and
// proposes fixes via the preview/commit surface.
//
// Hard critics (this file) are non-negotiable correctness checks. They can
// be expressed as deterministic invariants over plan + ledger state.
// Soft critics (future) handle variety, anchor adherence, taste feedback,
// effort distribution, etc. — they may use LLM scoring for nuance.

import type { MiseWeeklyPlanDraft, MisePlanComponentBatch, MisePlanMeal } from "./planner";
import { resolveFormatSpec } from "./meal-component";
import { deriveDependencyEdges, edgesViolated, type DependencyEdge } from "./dependency-edges";
import { listLockedEntities, isStaleLock } from "./locks";
import { computeItemWindowsFromParts, type ShopItemWindow } from "./shopping-runs";
import { lookupShelfLife } from "./shelf-life-table";
import { plantSubstitutionFor, type CascadeProposal } from "./cascade-proposals";

export type GrievanceSeverity = "hard" | "warning" | "preference";

export interface SlotRef {
	date: string;
	slot: string;            // "breakfast" | "lunch" | "dinner" | "snack"
}

export interface Grievance {
	critic: string;          // e.g. "ShelfLifeCritic"
	severity: GrievanceSeverity;
	slot_ref?: SlotRef;
	component_id?: string;
	batch_id?: string;
	message: string;
	suggested_repair?: string;
	meta?: Record<string, unknown>;
	cascade_proposals?: CascadeProposal[];   // structured fixes downstream code can preview/commit
}

/**
 * Stable grievance ID derived from critic + slot/component/batch identity.
 * Used by cascade proposals to declare which grievance(s) they would resolve.
 */
function grievanceIdOf(g: Pick<Grievance, "critic" | "slot_ref" | "component_id" | "batch_id"> & { extra?: string }): string {
	const parts = [
		g.critic,
		g.slot_ref ? `${g.slot_ref.date}/${g.slot_ref.slot}` : "-",
		g.component_id || "-",
		g.batch_id || "-",
		g.extra || "-",
	];
	return parts.join("::");
}

const DAY_MS = 86400000;

// ---------------------------------------------------------------------------
// HARD CRITICS — deterministic, soundness-bearing.
// ---------------------------------------------------------------------------

/**
 * ShelfLifeCritic — every batch.planned_use must fall within the batch's
 * quality_window_hours from its prep/desired_prep date.
 */
export function shelfLifeCritic(plan: MiseWeeklyPlanDraft): Grievance[] {
	const out: Grievance[] = [];
	for (const batch of plan.component_batches) {
		const shelfHours = batch.quality_window_hours;
		if (!shelfHours) continue;
		const meta = batch.meta as Record<string, unknown> | undefined;
		const desiredPrepDate = typeof meta?.desired_prep_date === "string" ? meta.desired_prep_date as string : null;
		const uses = batch.planned_uses || [];
		if (uses.length === 0) continue;
		const usesByDate = uses.slice().sort((a, b) => a.date.localeCompare(b.date));
		const firstUse = usesByDate[0].date;
		const prepDate = desiredPrepDate || subtractDays(firstUse, 1);
		for (const use of uses) {
			const ageHours = hoursBetween(prepDate, use.date);
			if (ageHours > shelfHours) {
				const slotRef: SlotRef = { date: use.date, slot: use.slot };
				const grievanceId = grievanceIdOf({ critic: "ShelfLifeCritic", slot_ref: slotRef, batch_id: batch.id });
				const proposals: CascadeProposal[] = [
					{
						kind: "split_batch",
						description: `Split ${batch.label} into a fresher batch prepped closer to ${use.date}.`,
						expected_resolves: [grievanceId],
						parameters: { batch_id: batch.id, split_at_date: use.date },
						mutation: { kind: "split_batch", batch_id: batch.id, at_date: use.date },
						confidence: 0.85,
					},
					{
						kind: "replace_meal",
						description: `Replace meal "${use.title}" with one that doesn't depend on ${batch.label}.`,
						expected_resolves: [grievanceId],
						parameters: { slot: slotRef, must_avoid: [batch.label] },
						mutation: { kind: "replace_meal", slot: slotRef, must_avoid: [batch.label] },
						confidence: 0.7,
					},
				];
				out.push({
					critic: "ShelfLifeCritic",
					severity: "hard",
					slot_ref: slotRef,
					component_id: batch.id,
					batch_id: batch.id,
					message: `Meal "${use.title}" on ${use.date} ${use.slot} uses batch ${batch.label} (id=${batch.id}); age ${Math.round(ageHours)}h exceeds use_by ${shelfHours}h from prep ${prepDate}.`,
					suggested_repair: `Either split this batch (rebatch with second prep closer to ${use.date}) or replace this meal with one that doesn't use ${batch.label}.`,
					meta: { age_hours: Math.round(ageHours), shelf_hours: shelfHours, prep_date: prepDate },
					cascade_proposals: proposals,
				});
			}
		}
	}
	return out;
}

/**
 * DietaryCritic — when household.dietary contains 'vegetarian', any
 * raw_ingredient or component name matching meat/fish/animal-derived
 * patterns is a hard violation.
 */
export function dietaryCritic(plan: MiseWeeklyPlanDraft): Grievance[] {
	const dietary = (plan.constraints?.dietary as string[] | undefined)
		|| (plan.meta?.dietary as string[] | undefined)
		|| [];
	const isVegetarian = dietary.some(d => /vegetarian|vegan/i.test(d));
	const isVegan = dietary.some(d => /vegan/i.test(d));
	if (!isVegetarian && !isVegan) return [];

	const violations: Array<{ pattern: RegExp; reason: string }> = [
		{ pattern: /\bfish sauce\b/i,                       reason: "fish sauce is not vegetarian" },
		{ pattern: /\banchov(y|ies)\b/i,                    reason: "anchovy is not vegetarian" },
		{ pattern: /\boyster sauce\b/i,                     reason: "oyster sauce is not vegetarian" },
		{ pattern: /\bshrimp paste\b/i,                     reason: "shrimp paste is not vegetarian" },
		{ pattern: /\b(chicken|beef|pork|lamb|veal|duck|turkey|goose)\b/i, reason: "contains meat" },
		{ pattern: /\bbacon\b/i,                            reason: "bacon is not vegetarian" },
		{ pattern: /\bham\b/i,                              reason: "ham is not vegetarian" },
		{ pattern: /\b(prawn|shrimp|squid|cuttlefish|octopus|crab|lobster)\b/i, reason: "shellfish is not vegetarian" },
		{ pattern: /\b(salmon|tuna|cod|halibut|trout|sardine|mackerel|swordfish|sea bass)\b/i, reason: "fish is not vegetarian" },
		{ pattern: /\bgelatin\b/i,                          reason: "gelatin is animal-derived" },
		{ pattern: /\blard\b/i,                             reason: "lard is animal-derived" },
	];
	if (isVegan) {
		violations.push(
			{ pattern: /\b(milk|cream|butter|cheese|yogurt|ghee|whey|honey|egg|eggs)\b/i, reason: "contains animal product (vegan rule)" },
		);
	}

	const out: Grievance[] = [];
	const allMeals = collectAllMeals(plan);
	for (const meal of allMeals) {
		const candidateNames: string[] = [
			...(meal.raw_ingredients || []).map(r => r.name || ""),
			...(meal.ingredient_names || []),
			meal.title || "",
		].filter(s => !!s);
		const haystack = [
			meal.title || "",
			meal.method_summary || "",
			...(meal.raw_ingredients || []).map(r => r.name || ""),
			...(meal.ingredient_names || []),
			...(meal.notes || []),
		].join(" || ");
		for (const v of violations) {
			if (v.pattern.test(haystack)) {
				// Identify the most specific offending ingredient name to use in the
				// swap_ingredient proposal. Prefer raw_ingredients/ingredient_names over title.
				const offending = candidateNames.find(n => v.pattern.test(n)) || candidateNames[0] || "";
				const slotRef: SlotRef = { date: meal.date, slot: meal.slot };
				const grievanceId = grievanceIdOf({ critic: "DietaryCritic", slot_ref: slotRef, extra: v.pattern.source });
				const proposals: CascadeProposal[] = [];
				const swapTo = plantSubstitutionFor(offending);
				if (swapTo) {
					proposals.push({
						kind: "swap_ingredient",
						description: `Swap ${offending} for ${swapTo} in "${meal.title}".`,
						expected_resolves: [grievanceId],
						parameters: { slot: slotRef, from_name: offending, to_name: swapTo, reason: v.reason },
						mutation: { kind: "swap_ingredient", slot: slotRef, from_name: offending, to_name: swapTo },
						confidence: 0.8,
					});
				}
				proposals.push({
					kind: "replace_meal",
					description: `Replace "${meal.title}" with a plant-only alternative for the household's vegetarian rule.`,
					expected_resolves: [grievanceId],
					parameters: { slot: slotRef, must_avoid: offending ? [offending] : [] },
					mutation: { kind: "replace_meal", slot: slotRef, must_avoid: offending ? [offending] : [] },
					confidence: 0.6,
				});
				out.push({
					critic: "DietaryCritic",
					severity: "hard",
					slot_ref: slotRef,
					message: `Meal "${meal.title}" on ${meal.date} ${meal.slot} contains animal-derived ingredient (${v.reason}); household dietary requires vegetarian.`,
					suggested_repair: `Substitute with a plant alternative or replace this meal entirely.`,
					meta: { matched: v.pattern.source, reason: v.reason, offending_name: offending },
					cascade_proposals: proposals,
				});
				break; // one grievance per meal even if multiple matches
			}
		}
	}
	return out;
}

/**
 * LeftoverGraphCritic — every meal that declares leftovers_to must reference
 * a slot+date that exists in the plan AND is later than the producing meal.
 */
export function leftoverGraphCritic(plan: MiseWeeklyPlanDraft): Grievance[] {
	const out: Grievance[] = [];
	const allMeals = collectAllMeals(plan);
	const slotIndex = new Set(allMeals.map(m => `${m.date}::${m.slot}`));

	for (const meal of allMeals) {
		const claims = meal.leftovers_to || [];
		const sourceSlot: SlotRef = { date: meal.date, slot: meal.slot };
		for (const claim of claims) {
			// Format: "YYYY-MM-DD slot"
			const match = claim.match(/^(\d{4}-\d{2}-\d{2})\s+(breakfast|lunch|dinner|snack)$/i);
			if (!match) {
				const grievanceId = grievanceIdOf({ critic: "LeftoverGraphCritic", slot_ref: sourceSlot, extra: `bad-format:${claim}` });
				out.push({
					critic: "LeftoverGraphCritic",
					severity: "hard",
					slot_ref: sourceSlot,
					message: `Meal "${meal.title}" on ${meal.date} ${meal.slot} has leftovers_to claim "${claim}" in unrecognized format. Expected "YYYY-MM-DD slot".`,
					suggested_repair: `Reformat the leftovers_to entry or remove the claim.`,
					cascade_proposals: [
						{
							kind: "swap_ingredient",
							// Surgical edit on the upstream meal's leftovers_to list — modeled as
							// a swap on the leftovers_to field (downstream code interprets
							// from_name="" as "drop this claim").
							description: `Drop the malformed leftovers_to claim "${claim}" from "${meal.title}".`,
							expected_resolves: [grievanceId],
							parameters: { slot: sourceSlot, from_name: claim, to_name: "", field: "leftovers_to" },
							mutation: { kind: "swap_ingredient", slot: sourceSlot, from_name: claim, to_name: "", field: "leftovers_to" },
							confidence: 0.9,
						},
					],
				});
				continue;
			}
			const [, claimDate, claimSlot] = match;
			const key = `${claimDate}::${claimSlot.toLowerCase()}`;
			const claimSlotRef: SlotRef = { date: claimDate, slot: claimSlot.toLowerCase() };
			if (!slotIndex.has(key)) {
				const grievanceId = grievanceIdOf({ critic: "LeftoverGraphCritic", slot_ref: sourceSlot, extra: `missing:${claim}` });
				out.push({
					critic: "LeftoverGraphCritic",
					severity: "hard",
					slot_ref: sourceSlot,
					message: `Meal "${meal.title}" on ${meal.date} ${meal.slot} claims leftover_to "${claim}" but ${claimSlot} on ${claimDate} is not in plan.`,
					suggested_repair: `Either add the ${claimSlot} slot for ${claimDate} or remove this leftover claim.`,
					meta: { claim, claim_date: claimDate, claim_slot: claimSlot },
					cascade_proposals: [
						{
							kind: "add_meal",
							description: `Add a ${claimSlot} on ${claimDate} that consumes leftovers from "${meal.title}".`,
							expected_resolves: [grievanceId],
							parameters: { slot: claimSlotRef, hint: `consume leftovers from ${meal.title}`, leftover_source_meal_id: meal.id },
							mutation: { kind: "add_meal", slot: claimSlotRef, hint: `consume leftovers from ${meal.title}`, leftover_source_meal_id: meal.id },
							confidence: 0.75,
						},
						{
							kind: "swap_ingredient",
							// Surgical edit: drop the dangling claim from the upstream meal.
							description: `Drop the leftovers_to claim "${claim}" from "${meal.title}" so the graph is consistent.`,
							expected_resolves: [grievanceId],
							parameters: { slot: sourceSlot, from_name: claim, to_name: "", field: "leftovers_to" },
							mutation: { kind: "swap_ingredient", slot: sourceSlot, from_name: claim, to_name: "", field: "leftovers_to" },
							confidence: 0.7,
						},
					],
				});
				continue;
			}
			if (claimDate < meal.date || (claimDate === meal.date && slotOrder(claimSlot) <= slotOrder(meal.slot))) {
				const grievanceId = grievanceIdOf({ critic: "LeftoverGraphCritic", slot_ref: sourceSlot, extra: `backward:${claim}` });
				out.push({
					critic: "LeftoverGraphCritic",
					severity: "hard",
					slot_ref: sourceSlot,
					message: `Meal "${meal.title}" claims leftover_to "${claim}" but that slot is at or before this meal — leftovers can't flow backward.`,
					suggested_repair: `Reorder the leftover claim to a later slot.`,
					cascade_proposals: [
						{
							kind: "swap_ingredient",
							description: `Drop the backward leftovers_to claim "${claim}" from "${meal.title}".`,
							expected_resolves: [grievanceId],
							parameters: { slot: sourceSlot, from_name: claim, to_name: "", field: "leftovers_to" },
							mutation: { kind: "swap_ingredient", slot: sourceSlot, from_name: claim, to_name: "", field: "leftovers_to" },
							confidence: 0.85,
						},
					],
				});
			}
		}
	}
	return out;
}

/**
 * FormulaExistenceCritic — every formula_id referenced by a meal must exist
 * in the formula catalog.
 */
export function formulaExistenceCritic(plan: MiseWeeklyPlanDraft, validFormulaIds: Set<string>): Grievance[] {
	const out: Grievance[] = [];
	const allMeals = collectAllMeals(plan);
	for (const meal of allMeals) {
		// On the legacy shape we have component_ids (resolved batch IDs);
		// the formula_ids live on the composer output. For now check both:
		const componentIds = meal.component_ids || [];
		for (const cid of componentIds) {
			// component_ids look like "mise_component:hummus" — ensure batch exists in plan
			const exists = (plan.component_batches || []).some(b => b.id === cid || b.id.startsWith(cid));
			if (!exists) {
				const slotRef: SlotRef = { date: meal.date, slot: meal.slot };
				const grievanceId = grievanceIdOf({ critic: "FormulaExistenceCritic", slot_ref: slotRef, component_id: cid });
				out.push({
					critic: "FormulaExistenceCritic",
					severity: "hard",
					slot_ref: slotRef,
					component_id: cid,
					message: `Meal "${meal.title}" references component_id "${cid}" but no such batch is in the plan.`,
					suggested_repair: `Add the missing batch or remove the reference.`,
					cascade_proposals: [
						{
							kind: "lock_slot",
							description: `Lock ${slotRef.date} ${slotRef.slot} pending human review — referenced component "${cid}" is missing from the plan and the data is broken.`,
							expected_resolves: [grievanceId],
							parameters: { slot: slotRef, reason: `dangling component reference: ${cid}` },
							confidence: 0.5,
						},
					],
				});
			}
		}
	}
	for (const batch of plan.component_batches || []) {
		const meta = batch.meta as Record<string, unknown> | undefined;
		const formulaId = typeof meta?.formula_id === "string" ? meta.formula_id : null;
		if (formulaId && !validFormulaIds.has(formulaId)) {
			const grievanceId = grievanceIdOf({ critic: "FormulaExistenceCritic", batch_id: batch.id, extra: `formula:${formulaId}` });
			out.push({
				critic: "FormulaExistenceCritic",
				severity: "hard",
				batch_id: batch.id,
				message: `Batch "${batch.label}" claims formula_id "${formulaId}" but the formula isn't in the catalog.`,
				suggested_repair: `Either remove the formula reference or seed the formula.`,
				cascade_proposals: [
					{
						kind: "lock_slot",
						description: `Pause downstream uses of batch ${batch.label} pending human review — formula "${formulaId}" is missing from the catalog.`,
						expected_resolves: [grievanceId],
						parameters: { slot: { date: "", slot: "" }, reason: `missing formula ${formulaId} on batch ${batch.id}` },
						confidence: 0.5,
					},
				],
			});
		}
	}
	return out;
}

/**
 * ResourceContinuityCritic — every component a meal claims must be available
 * (i.e. produced by a batch with a planned_use covering that meal's date).
 * This is the "no phantom resources" check.
 */
export function resourceContinuityCritic(plan: MiseWeeklyPlanDraft): Grievance[] {
	const out: Grievance[] = [];
	const batchById = new Map<string, MisePlanComponentBatch>();
	for (const b of plan.component_batches || []) batchById.set(b.id, b);

	const allMeals = collectAllMeals(plan);
	for (const meal of allMeals) {
		for (const cid of meal.component_ids || []) {
			const batch = batchById.get(cid);
			if (!batch) continue; // covered by FormulaExistenceCritic
			const claimed = (batch.planned_uses || []).some(u => u.date === meal.date && u.slot === meal.slot);
			if (!claimed) {
				const slotRef: SlotRef = { date: meal.date, slot: meal.slot };
				const grievanceId = grievanceIdOf({ critic: "ResourceContinuityCritic", slot_ref: slotRef, component_id: cid });
				out.push({
					critic: "ResourceContinuityCritic",
					severity: "hard",
					slot_ref: slotRef,
					component_id: cid,
					message: `Meal "${meal.title}" claims component "${cid}" but the batch's planned_uses doesn't include this slot.`,
					suggested_repair: `Update the batch's planned_uses to claim this slot, or remove the component reference.`,
					cascade_proposals: [
						{
							kind: "split_batch",
							description: `Extend ${batch.label}'s planned_uses to cover ${slotRef.date} ${slotRef.slot} (or split off a fresh sub-batch for that slot).`,
							expected_resolves: [grievanceId],
							parameters: { batch_id: batch.id, split_at_date: slotRef.date },
							mutation: { kind: "split_batch", batch_id: batch.id, at_date: slotRef.date },
							confidence: 0.7,
						},
						{
							kind: "replace_meal",
							description: `Replace "${meal.title}" with a meal that doesn't depend on ${batch.label}.`,
							expected_resolves: [grievanceId],
							parameters: { slot: slotRef, must_avoid: [batch.label] },
							mutation: { kind: "replace_meal", slot: slotRef, must_avoid: [batch.label] },
							confidence: 0.6,
						},
					],
				});
			}
		}
	}
	return out;
}

/**
 * FormatCompositionCritic — every meal whose format declares REQUIRED slots
 * (per FORMAT_SLOT_SPECS) must carry a MealComponent for each. Missing
 * components or required components with empty `compose_inline` raw_ingredients
 * are flagged.
 */
export function formatCompositionCritic(plan: MiseWeeklyPlanDraft): Grievance[] {
	const out: Grievance[] = [];
	const allMeals = collectAllMeals(plan);
	for (const meal of allMeals) {
		// Backward compat: meals without a `components` field are legacy
		// (pre-composition) shape — skip. Meals that opt in by setting
		// components (even an empty array) get validated.
		if (meal.components === undefined) continue;
		const spec = resolveFormatSpec(meal.format);
		if (!spec) continue; // unknown format, no required slots — skip
		const requiredRoles = spec.filter(s => s.required).map(s => s.role);
		if (requiredRoles.length === 0) continue;
		const components = meal.components;
		const haveByRole = new Map(components.map(c => [c.role, c]));
		for (const role of requiredRoles) {
			const comp = haveByRole.get(role);
			if (!comp) {
				out.push({
					critic: "FormatCompositionCritic",
					severity: "hard",
					slot_ref: { date: meal.date, slot: meal.slot },
					message: `Meal "${meal.title}" (${meal.format}) on ${meal.date} ${meal.slot} is missing a required component for role "${role}".`,
					suggested_repair: `Add a ${role} component (compose inline, build a batch, or buy ready-made).`,
					meta: { format: meal.format, missing_role: role },
				});
				continue;
			}
			// Empty compose_inline raw_ingredients is a hollow placeholder.
			if (comp.source.kind === "compose_inline" && comp.source.raw_ingredients.length === 0) {
				out.push({
					critic: "FormatCompositionCritic",
					severity: "hard",
					slot_ref: { date: meal.date, slot: meal.slot },
					message: `Meal "${meal.title}" has an empty placeholder for required component "${role}" — no raw_ingredients, no batch, no shopping item.`,
					suggested_repair: `Fill the ${role} component with a real source (raw ingredients, a batch reference, or a buy_ready_made item).`,
					meta: { format: meal.format, missing_role: role, hollow: true },
				});
			}
		}
	}
	return out;
}

/**
 * EdgeViolationCritic — emit a grievance for every dependency edge whose
 * derived rule is violated (slack < 0). Each grievance's slot_ref points at
 * the edge.to side — that's where the violation is felt on the calendar.
 */
export function edgeViolationCritic(plan: MiseWeeklyPlanDraft): Grievance[] {
	const out: Grievance[] = [];
	const edges = deriveDependencyEdges(plan);
	const allMeals = collectAllMeals(plan);
	const mealsById = new Map<string, MisePlanMeal>();
	for (const m of allMeals) mealsById.set(m.id, m);

	for (const edge of edgesViolated(edges)) {
		const slotRef = slotRefForEntity(edge.to, mealsById);
		const grievanceId = grievanceIdOf({ critic: "EdgeViolationCritic", slot_ref: slotRef, extra: edge.id });
		out.push({
			critic: "EdgeViolationCritic",
			severity: "hard",
			slot_ref: slotRef,
			message: edgeViolationMessage(edge),
			suggested_repair: edgeViolationRepair(edge),
			meta: {
				edge_id: edge.id,
				rule_kind: edge.rule.kind,
				rule_value_hours: edge.rule.value,
				current_lead_hours: edge.current_lead_time_hours,
				slack_hours: edge.slack_hours,
				from: edge.from,
				to: edge.to,
				derived_from: edge.derived_from,
			},
			cascade_proposals: edgeViolationProposals(edge, slotRef, grievanceId),
		});
	}
	return out;
}

function edgeViolationProposals(edge: DependencyEdge, slotRef: SlotRef | undefined, grievanceId: string): CascadeProposal[] {
	const proposals: CascadeProposal[] = [];
	const fromIsCook = edge.from.entity_type === "Cook";
	const fromIsMeal = edge.from.entity_type === "Meal";
	const toIsMeal = edge.to.entity_type === "Meal";

	switch (edge.rule.kind) {
		case "min_lead_time": {
			// Slide the upstream prep earlier or move the downstream meal later.
			if (fromIsCook) {
				const newPrep = subtractDays(edge.to.date, Math.max(1, Math.ceil(edge.rule.value / 24)));
				proposals.push({
					kind: "slide_prep_date",
					description: `Slide batch ${edge.from.entity_id} prep date to ${newPrep} so the ${edge.rule.value}h lead time is satisfied.`,
					expected_resolves: [grievanceId],
					parameters: { batch_id: edge.from.entity_id, new_prep_date: newPrep },
					mutation: { kind: "slide_prep_date", batch_id: edge.from.entity_id, new_prep_date: newPrep },
					confidence: 0.75,
				});
			}
			if (toIsMeal && slotRef) {
				const laterDate = addDays(edge.to.date, 1);
				const laterSlot: SlotRef = { date: laterDate, slot: slotRef.slot };
				proposals.push({
					kind: "move_meal",
					description: `Push the dependent meal to ${laterDate} ${slotRef.slot} so the ${edge.rule.value}h lead time clears.`,
					expected_resolves: [grievanceId],
					parameters: { from_slot: slotRef, to_slot: laterSlot },
					mutation: { kind: "move_meal", from_slot: slotRef, to_slot: laterSlot },
					confidence: 0.55,
				});
			}
			break;
		}
		case "max_lead_time":
		case "freshness_window": {
			// Shelf-life-class violation — split the upstream batch.
			if (fromIsCook) {
				proposals.push({
					kind: "split_batch",
					description: `Split batch ${edge.from.entity_id} so a fresher prep covers ${edge.to.date}.`,
					expected_resolves: [grievanceId],
					parameters: { batch_id: edge.from.entity_id, split_at_date: edge.to.date },
					mutation: { kind: "split_batch", batch_id: edge.from.entity_id, at_date: edge.to.date },
					confidence: 0.75,
				});
			}
			if (toIsMeal && slotRef) {
				proposals.push({
					kind: "replace_meal",
					description: `Replace the downstream meal with a shelf-stable alternative.`,
					expected_resolves: [grievanceId],
					parameters: { slot: slotRef },
					mutation: { kind: "replace_meal", slot: slotRef },
					confidence: 0.5,
				});
			}
			break;
		}
		case "leftover_window": {
			if (fromIsMeal && toIsMeal && slotRef) {
				proposals.push({
					kind: "cancel_meal",
					description: `Drop the leftover claim by cancelling or replacing the dependent meal.`,
					expected_resolves: [grievanceId],
					parameters: { slot: slotRef, reason: "leftover_window violated" },
					mutation: { kind: "cancel_meal", slot: slotRef },
					confidence: 0.55,
				});
			}
			break;
		}
		case "prep_chain": {
			if (fromIsCook) {
				const newPrep = subtractDays(edge.to.date, 1);
				proposals.push({
					kind: "slide_prep_date",
					description: `Reorder so batch ${edge.from.entity_id} finishes before its dependent task — slide prep to ${newPrep}.`,
					expected_resolves: [grievanceId],
					parameters: { batch_id: edge.from.entity_id, new_prep_date: newPrep },
					mutation: { kind: "slide_prep_date", batch_id: edge.from.entity_id, new_prep_date: newPrep },
					confidence: 0.65,
				});
			}
			break;
		}
		case "equipment_conflict":
		case "household_rule":
		case "recipe_rule":
		default: {
			if (slotRef) {
				proposals.push({
					kind: "lock_slot",
					description: `Hold ${slotRef.date} ${slotRef.slot} for human review — the conflicting rule (${edge.rule.kind}) needs a judgement call.`,
					expected_resolves: [grievanceId],
					parameters: { slot: slotRef, reason: `${edge.rule.kind} conflict on edge ${edge.id}` },
					confidence: 0.4,
				});
			}
			break;
		}
	}
	return proposals;
}

function slotRefForEntity(ref: { entity_type: string; entity_id: string; date: string }, mealsById: Map<string, MisePlanMeal>): SlotRef | undefined {
	if (ref.entity_type === "Meal") {
		const meal = mealsById.get(ref.entity_id);
		if (meal) return { date: meal.date, slot: meal.slot };
	}
	// For Cook / Shop entities we don't have a slot — return the date with an
	// empty slot so the UI can still localize the grievance to a day.
	return { date: ref.date, slot: "" };
}

function edgeViolationMessage(edge: DependencyEdge): string {
	const fromLabel = `${edge.from.entity_type} on ${edge.from.date}`;
	const toLabel = `${edge.to.entity_type} on ${edge.to.date}`;
	return `Dependency edge ${edge.id} violated: ${edge.rule.description} (rule: ${edge.rule.kind}=${edge.rule.value}h; current lead ${edge.current_lead_time_hours}h between ${fromLabel} and ${toLabel}; slack ${edge.slack_hours}h).`;
}

function edgeViolationRepair(edge: DependencyEdge): string {
	switch (edge.rule.kind) {
		case "min_lead_time":
			return `Move ${edge.from.entity_type} earlier by ${Math.abs(edge.slack_hours)}h or push ${edge.to.entity_type} later so the ${edge.rule.value}h lead time is satisfied.`;
		case "max_lead_time":
			return `Tighten the gap between ${edge.from.entity_type} and ${edge.to.entity_type} to ≤${edge.rule.value}h or substitute a shelf-stable alternative.`;
		case "leftover_window":
			return `Consume the leftover within ${edge.rule.value}h of its source meal, or drop the leftover claim.`;
		case "prep_chain":
			return `Reorder so the dependency task finishes before the dependent task starts.`;
		case "freshness_window":
			return `Adjust the cook-to-meal interval to fit the freshness window.`;
		case "equipment_conflict":
			return `Reschedule one of the conflicting cooks to a different time slot.`;
		case "household_rule":
		case "recipe_rule":
			return `Review the rule and either reschedule or remove the rule reference.`;
		default:
			return `Review the dependency edge and reschedule one side.`;
	}
}

// ---------------------------------------------------------------------------
// WARNING CRITICS — non-blocking, advisory.
// ---------------------------------------------------------------------------

/**
 * lockStaleCritic — warns when a plan has locked entities whose locked_at is
 * older than 30 days. Stale locks may have outlived their context (a recipe
 * pinned a month ago might no longer be relevant) and the user should be
 * prompted to refresh or release them.
 */
export function lockStaleCritic(plan: MiseWeeklyPlanDraft, now?: string): Grievance[] {
	const checkAt = now || new Date().toISOString();
	const out: Grievance[] = [];
	for (const ref of listLockedEntities(plan)) {
		if (!isStaleLock(ref.meta, checkAt)) continue;
		out.push({
			critic: "LockStaleCritic",
			severity: "warning",
			message: `${ref.type} ${ref.id} has been locked since ${ref.meta.locked_at} (>30d). Reason: "${ref.meta.lock_reason || "unspecified"}". Consider releasing the lock if the pin is no longer relevant.`,
			suggested_repair: `Review the lock and either refresh its reason, extend it deliberately, or release it.`,
			meta: {
				entity_type: ref.type,
				entity_id: ref.id,
				locked_at: ref.meta.locked_at || null,
				lock_reason: ref.meta.lock_reason || null,
				lock_by: ref.meta.lock_by || null,
				lock_scope: ref.meta.lock_scope || null,
			},
		});
	}
	return out;
}

/**
 * ShopFreshnessCritic — for every shopping item × shop_run, check that the
 * gap between purchase date and first must_have_by date does NOT exceed the
 * item's shelf life. If it does, emit a hard grievance.
 *
 * The critic looks at plan.shop_runs and plan.shopping_list. For each item
 * in shopping_list it finds the earliest scheduled run that COULD have
 * carried it (run.date ≤ item.must_have_by). If (must_have_by - run.date) >
 * shelf_life, that's a violation.
 */
export function shopFreshnessCritic(plan: MiseWeeklyPlanDraft): Grievance[] {
	const out: Grievance[] = [];
	const runs = plan.shop_runs || [];
	if (runs.length === 0) return out;

	// Build the windows once so we know each item's must_have_by date.
	let windows: ShopItemWindow[] = [];
	try {
		windows = computeItemWindowsFromParts({
			startDate: plan.start_date,
			mealsByDay: plan.meals_by_day || [],
			breakfasts: plan.breakfasts || [],
			snackBoxes: plan.snack_boxes || [],
			componentBatches: plan.component_batches || [],
			sections: plan.shopping_list || [],
		});
	} catch {
		return out;
	}

	const sortedRuns = runs.slice().sort((a, b) => a.date.localeCompare(b.date));
	for (const window of windows) {
		const candidateRuns = sortedRuns.filter(r =>
			r.date <= window.must_have_by
			&& runCanCarryShopWindow(r, window)
		);
		const freshCarrier = candidateRuns.findLast(r => r.date >= window.earliest_purchase);
		if (freshCarrier) continue;
		const carrier = candidateRuns[candidateRuns.length - 1];
		if (!carrier) continue;   // covered by ShopCoverageCritic
		const gapHours = hoursBetween(carrier.date, window.must_have_by);
		const shelfHours = window.shelf_life_hours;
		if (gapHours > shelfHours) {
			const gapDays = Math.round(gapHours / 24);
			const shelfDays = Math.round(shelfHours / 24);
			const grievanceId = grievanceIdOf({ critic: "ShopFreshnessCritic", extra: `${carrier.id}/${window.item.name}` });
			// Aim the move so the gap fits inside shelf life: shift to one day before
			// must_have_by (or as close as possible, never earlier than the start).
			const targetDate = subtractDays(window.must_have_by, Math.max(0, Math.floor(shelfHours / 24) - 1));
			out.push({
				critic: "ShopFreshnessCritic",
				severity: "hard",
				message: `Shopping item "${window.item.name}" is purchased on ${carrier.date} but not used until ${window.must_have_by} (${gapDays}d gap exceeds ${shelfDays}d shelf life).`,
				suggested_repair: `Move the shop run for ${window.item.name} closer to ${window.must_have_by}, or split into a refresh run.`,
				meta: {
					item_name: window.item.name,
					shop_date: carrier.date,
					must_have_by: window.must_have_by,
					gap_hours: Math.round(gapHours),
					shelf_life_hours: shelfHours,
				},
				cascade_proposals: [
					{
						kind: "move_shop",
						description: `Move shop run ${carrier.id} from ${carrier.date} to ${targetDate} so ${window.item.name} arrives within its ${shelfDays}d shelf life.`,
						expected_resolves: [grievanceId],
						parameters: { run_id: carrier.id, new_date: targetDate },
						mutation: { kind: "move_shop", run_id: carrier.id, new_date: targetDate },
						confidence: 0.8,
					},
					{
						kind: "drop_item_from_shop",
						description: `Drop ${window.item.name} from run ${carrier.id} and add a refresh shop on ${window.must_have_by}.`,
						expected_resolves: [grievanceId],
						parameters: { run_id: carrier.id, item_name: window.item.name },
						mutation: { kind: "drop_item_from_shop", run_id: carrier.id, item_name: window.item.name },
						confidence: 0.7,
					},
					{
						kind: "add_shop",
						description: `Add a fresh shop run on ${window.must_have_by} that carries ${window.item.name}.`,
						expected_resolves: [grievanceId],
						parameters: { date: window.must_have_by, items: [window.item.name] },
						mutation: { kind: "add_shop", date: window.must_have_by, items: [window.item.name] },
						confidence: 0.65,
					},
				],
			});
		}
	}
	return out;
}

function runCanCarryShopWindow(run: { categories?: string[] }, window: ShopItemWindow): boolean {
	const categories = (run.categories || []).map(c => c.toLowerCase());
	if (categories.length === 0) return true;
	const category = window.category.toLowerCase();
	if (categories.includes(category)) return true;
	if (category === "cheese" && categories.includes("dairy")) return true;
	return categories.includes("general");
}

/**
 * ShopCoverageCritic — every shopping item must have at least one shop_run
 * scheduled on or before its must_have_by date. If not, the household has
 * nothing to cook with on that meal.
 */
export function shopCoverageCritic(plan: MiseWeeklyPlanDraft): Grievance[] {
	const out: Grievance[] = [];
	const runs = plan.shop_runs || [];

	let windows: ShopItemWindow[] = [];
	try {
		windows = computeItemWindowsFromParts({
			startDate: plan.start_date,
			mealsByDay: plan.meals_by_day || [],
			breakfasts: plan.breakfasts || [],
			snackBoxes: plan.snack_boxes || [],
			componentBatches: plan.component_batches || [],
			sections: plan.shopping_list || [],
		});
	} catch {
		return out;
	}

	for (const window of windows) {
		const covered = runs.some(r => r.date <= window.must_have_by);
		if (!covered) {
			const grievanceId = grievanceIdOf({ critic: "ShopCoverageCritic", extra: window.item.name });
			out.push({
				critic: "ShopCoverageCritic",
				severity: "hard",
				message: `Shopping item "${window.item.name}" must be on hand by ${window.must_have_by} but no shop_run is scheduled on or before that date.`,
				suggested_repair: `Add a shop_run on or before ${window.must_have_by} that includes ${window.item.name}.`,
				meta: {
					item_name: window.item.name,
					must_have_by: window.must_have_by,
				},
				cascade_proposals: [
					{
						kind: "add_shop",
						description: `Add a shop run on ${window.must_have_by} that carries ${window.item.name}.`,
						expected_resolves: [grievanceId],
						parameters: { date: window.must_have_by, items: [window.item.name] },
						mutation: { kind: "add_shop", date: window.must_have_by, items: [window.item.name] },
						confidence: 0.8,
					},
				],
			});
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// AGGREGATOR
// ---------------------------------------------------------------------------

export interface CriticAuditOptions {
	validFormulaIds?: Set<string>;
	now?: string;
}

export function runHardCritics(plan: MiseWeeklyPlanDraft, options: CriticAuditOptions = {}): Grievance[] {
	const out: Grievance[] = [];
	out.push(...shelfLifeCritic(plan));
	out.push(...dietaryCritic(plan));
	out.push(...leftoverGraphCritic(plan));
	if (options.validFormulaIds) {
		out.push(...formulaExistenceCritic(plan, options.validFormulaIds));
	}
	out.push(...resourceContinuityCritic(plan));
	out.push(...formatCompositionCritic(plan));
	out.push(...edgeViolationCritic(plan));
	out.push(...shopFreshnessCritic(plan));
	out.push(...shopCoverageCritic(plan));
	return out;
}

export function runWarningCritics(plan: MiseWeeklyPlanDraft, options: CriticAuditOptions = {}): Grievance[] {
	const out: Grievance[] = [];
	out.push(...lockStaleCritic(plan, options.now));
	return out;
}

// Re-export the household-aware aggregator so callers can wire one import
// path. The household critics live in their own module to keep this file
// dependency-light (and to avoid a circular import — household-critics
// imports `Grievance`/`SlotRef` types from here).
export { runHouseholdAwareCritics, loadHouseholdContextForAudit } from "./household-critics";
export type { HouseholdAuditContext, TraditionWithMeta } from "./household-critics";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function collectAllMeals(plan: MiseWeeklyPlanDraft): MisePlanMeal[] {
	const out: MisePlanMeal[] = [];
	for (const day of plan.meals_by_day || []) for (const m of day.meals) out.push(m);
	for (const b of plan.breakfasts || []) out.push(b);
	return out;
}

function hoursBetween(a: string, b: string): number {
	const da = new Date(a + "T00:00:00Z").getTime();
	const db = new Date(b + "T00:00:00Z").getTime();
	return (db - da) / 3600_000;
}

function subtractDays(iso: string, days: number): string {
	const d = new Date(iso + "T00:00:00Z");
	d.setUTCDate(d.getUTCDate() - days);
	return d.toISOString().slice(0, 10);
}

function addDays(iso: string, days: number): string {
	const d = new Date(iso + "T00:00:00Z");
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}

function slotOrder(slot: string): number {
	const order: Record<string, number> = { breakfast: 1, lunch: 2, snack: 3, dinner: 4 };
	return order[slot.toLowerCase()] || 0;
}

// Dynamic shopping-run scheduler.
//
// Replaces the previous hardcoded "day 0 + day 7" run pattern with a real
// bin-packing scheduler that:
//   1. Computes a (earliest_purchase, latest_purchase) window for every
//      shopping item, derived from its first must_have_by date minus the
//      ingredient's shelf life.
//   2. Honors recurring vendor splits (CSA, fish-monger Tues, etc.) — those
//      runs are anchored first, and any matching items are pulled into them.
//   3. Sweeps the household's available shop slots in date order, packing
//      remaining items into runs while honoring max_runs_per_week and
//      min_items_per_run.
//   4. Performs an economics pass that merges adjacent under-filled runs.
//
// All functions here are pure — same input, same output, no I/O.

import type { MisePlanComponentBatch, MisePlanDay, MisePlanMeal, MiseShoppingListItem, MiseShoppingListSection, MiseSnackBox, MiseWeeklyPlanDraft } from "./planner";
import type { ShoppingRun } from "./shopping-list";
import { lookupShelfLife } from "./shelf-life-table";

export interface HouseholdShopPreferences {
	available_slots: Array<{ day_of_week: 0 | 1 | 2 | 3 | 4 | 5 | 6; window: "morning" | "afternoon" | "evening" }>;
	preferred_strategy: "weekly_big" | "twice_weekly" | "just_in_time" | "csa_plus_top_up";
	max_runs_per_week: number;
	min_items_per_run: number;
	vendor_splits: Array<{ vendor: string; cadence: "weekly" | "biweekly" | "monthly"; day_of_week: number }>;
	delivery_available: boolean;
}

export const DEFAULT_HOUSEHOLD_PREFS: HouseholdShopPreferences = {
	// Default: shop Sunday morning + Wednesday evening — twice-weekly cadence.
	available_slots: [
		{ day_of_week: 0, window: "morning" },     // Sunday
		{ day_of_week: 3, window: "evening" },     // Wednesday
	],
	preferred_strategy: "twice_weekly",
	max_runs_per_week: 3,
	min_items_per_run: 4,
	vendor_splits: [],
	delivery_available: false,
};

export interface ShopItemWindow {
	item: MiseShoppingListItem;
	must_have_by: string;          // earliest date the item is consumed
	earliest_purchase: string;     // = must_have_by - shelf_life_days
	latest_purchase: string;       // = must_have_by
	vendor_hint: string;
	shelf_life_hours: number;
	category: string;              // section category passed through ("produce", etc.)
}

const DAY_MS = 86400000;

// ---------------------------------------------------------------------------
// computeItemWindows — cross-references shopping items with the plan's meal /
// breakfast / batch dates to figure out when each item is first needed.
// ---------------------------------------------------------------------------

export interface ItemWindowParts {
	startDate: string;
	mealsByDay: MisePlanDay[];
	breakfasts: MisePlanMeal[];
	snackBoxes: MiseSnackBox[];
	componentBatches: MisePlanComponentBatch[];
	sections: MiseShoppingListSection[];
}

/**
 * computeItemWindowsFromParts — same as computeItemWindows but accepts the
 * raw inputs the shopping-list builder already has on hand, so it can be
 * invoked before a full MiseWeeklyPlanDraft is assembled.
 */
export function computeItemWindowsFromParts(parts: ItemWindowParts): ShopItemWindow[] {
	const synthPlan: MiseWeeklyPlanDraft = {
		id: "synthetic",
		household_id: null,
		title: "synthetic",
		start_date: parts.startDate,
		end_date: parts.startDate,
		timezone: null,
		people: 0,
		status: "draft",
		constraints: {},
		selected_ingredients: [],
		source_recipe_ids: [],
		meals_by_day: parts.mealsByDay,
		component_batches: parts.componentBatches,
		prep_tasks: [],
		breakfasts: parts.breakfasts,
		snack_boxes: parts.snackBoxes,
		shopping_list: parts.sections,
		storage_labels: [],
		meta: { generated_by: "mise_graph_planner", deterministic: true },
	};
	const itemsWithCategory: MiseShoppingListItem[] = [];
	for (const section of parts.sections) {
		for (const item of section.items) {
			// Tag with category so the scheduler can group/categorize without re-deriving.
			(item as MiseShoppingListItem & { _category?: string })._category = section.category;
			itemsWithCategory.push(item);
		}
	}
	return computeItemWindows(synthPlan, itemsWithCategory);
}

export function computeItemWindows(
	plan: MiseWeeklyPlanDraft,
	items: MiseShoppingListItem[],
): ShopItemWindow[] {
	// Build a map of canonical-name → earliest use date by sweeping every meal,
	// breakfast, snack, and component batch in the plan.
	const firstUseByName = new Map<string, string>();
	const note = (rawName: string, date: string) => {
		const key = canonical(rawName);
		if (!key || !date) return;
		const prev = firstUseByName.get(key);
		if (!prev || date < prev) firstUseByName.set(key, date);
	};

	for (const day of plan.meals_by_day || []) {
		for (const meal of day.meals) {
			for (const n of meal.ingredient_names || []) note(n, meal.date);
			for (const r of meal.raw_ingredients || []) note(r.name || "", meal.date);
		}
	}
	for (const meal of plan.breakfasts || []) {
		for (const n of meal.ingredient_names || []) note(n, meal.date);
		for (const r of meal.raw_ingredients || []) note(r.name || "", meal.date);
	}
	for (const box of plan.snack_boxes || []) {
		for (const r of box.raw_ingredients || []) note(r.name || "", box.date);
	}
	for (const batch of plan.component_batches || []) {
		for (const inputName of batch.input_names || []) {
			const firstUse = (batch.planned_uses || []).map(u => u.date).sort()[0];
			const meta = batch.meta as Record<string, unknown> | undefined;
			const desiredPrep = typeof meta?.desired_prep_date === "string" ? meta.desired_prep_date : null;
			const target = desiredPrep || firstUse;
			if (target) note(inputName, target);
		}
	}

	const planStart = plan.start_date;
	const out: ShopItemWindow[] = [];
	for (const item of items) {
		const key = canonical(item.name);
		const mustHaveBy = firstUseByName.get(key) || planStart;
		const shelf = lookupShelfLife(key);
		const shelfHours = shelf.shelf_life_fridge_hours;
		const shelfDays = Math.max(1, Math.floor(shelfHours / 24));
		const earliest = addDays(mustHaveBy, -shelfDays);
		// Don't go before the plan's start date — we can't shop in the past.
		const earliestClamped = earliest < planStart ? planStart : earliest;
		out.push({
			item,
			must_have_by: mustHaveBy,
			earliest_purchase: earliestClamped,
			latest_purchase: mustHaveBy,
			vendor_hint: vendorHintFor(item),
			shelf_life_hours: shelfHours,
			category: categoryGuess(item),
		});
	}
	return out;
}

// ---------------------------------------------------------------------------
// computeRuns — main scheduler.
// ---------------------------------------------------------------------------

export function computeRuns(
	startDate: string,
	endDate: string,
	windows: ShopItemWindow[],
	prefs: HouseholdShopPreferences = DEFAULT_HOUSEHOLD_PREFS,
): ShoppingRun[] {
	if (windows.length === 0) return [];

	const allDates = enumerateDates(startDate, endDate);
	const remaining = new Map<string, ShopItemWindow>();
	for (const w of windows) remaining.set(w.item.name.toLowerCase(), w);

	const runs: RunBucket[] = [];

	// 1. Anchor recurring vendor splits first.
	for (const split of prefs.vendor_splits) {
		for (const date of allDates) {
			const dow = dayOfWeek(date);
			if (dow !== split.day_of_week) continue;
			const matchedKeys: string[] = [];
			for (const [key, w] of remaining) {
				if (vendorMatches(w.vendor_hint, split.vendor) && date >= w.earliest_purchase && date <= w.latest_purchase) {
					matchedKeys.push(key);
				}
			}
			if (matchedKeys.length === 0) continue;
			const bucket: RunBucket = { date, vendor: split.vendor, items: [] };
			for (const key of matchedKeys) {
				bucket.items.push(remaining.get(key)!);
				remaining.delete(key);
			}
			runs.push(bucket);
			if (split.cadence !== "weekly") break;   // simple: biweekly/monthly = first occurrence only
		}
	}

	// 2. Sort remaining by latest_purchase ASC so we drain urgent items first.
	const remainingSorted = Array.from(remaining.values()).sort((a, b) => a.latest_purchase.localeCompare(b.latest_purchase));

	// 3. Compute the candidate slot dates from household.available_slots.
	const slotDates = allDates.filter(d => prefs.available_slots.some(s => s.day_of_week === dayOfWeek(d)));

	// 4. Sweep slot dates, pulling items whose window contains the slot.
	for (let i = 0; i < slotDates.length; i++) {
		const slotDate = slotDates[i];
		const isLastSlot = i === slotDates.length - 1;
		const matched: ShopItemWindow[] = [];
		for (const w of remainingSorted) {
			if (!remaining.has(w.item.name.toLowerCase())) continue;
			if (slotDate >= w.earliest_purchase && slotDate <= w.latest_purchase) {
				matched.push(w);
			}
		}
		// Items that MUST be bought before the next slot (their window closes
		// before then) — always include those, even if total < min_items_per_run.
		const nextSlot = slotDates[i + 1];
		const urgent = matched.filter(w => !nextSlot || w.latest_purchase < nextSlot);

		// Defer if under-filled and not the last viable slot AND no urgent items.
		if (matched.length < prefs.min_items_per_run && !isLastSlot && urgent.length === 0) continue;

		if (matched.length === 0) continue;
		const bucket: RunBucket = { date: slotDate, vendor: "general", items: [] };
		for (const w of matched) {
			bucket.items.push(w);
			remaining.delete(w.item.name.toLowerCase());
		}
		runs.push(bucket);
	}

	// 5. Anything still remaining (e.g. window starts after last slot, or no
	// slot fell inside its window) — schedule on its latest_purchase date.
	if (remaining.size > 0) {
		const fallbackByDate = new Map<string, ShopItemWindow[]>();
		for (const w of remaining.values()) {
			if (!fallbackByDate.has(w.latest_purchase)) fallbackByDate.set(w.latest_purchase, []);
			fallbackByDate.get(w.latest_purchase)!.push(w);
		}
		for (const [date, items] of fallbackByDate) {
			runs.push({ date, vendor: "general", items });
		}
	}

	// 6. Economics pass: merge adjacent (≤2 days apart) general runs whose
	// combined size stays under ~25 items. Vendor-split runs are NOT merged.
	const merged = mergeAdjacent(runs);

	// 7. Enforce max_runs_per_week (best-effort: if we exceed, merge the two
	// smallest adjacent runs further).
	const finalRuns = enforceMaxRunsPerWeek(merged, prefs.max_runs_per_week);

	// 8. Emit ShoppingRun[] in date order.
	finalRuns.sort((a, b) => a.date.localeCompare(b.date));
	return finalRuns.map((bucket, idx) => bucketToShoppingRun(bucket, idx));
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

interface RunBucket {
	date: string;
	vendor: string;        // "general" | "csa" | "butcher" | etc.
	items: ShopItemWindow[];
}

function bucketToShoppingRun(bucket: RunBucket, idx: number): ShoppingRun {
	const categories = Array.from(new Set(bucket.items.map(i => i.category))).sort();
	const labelKind = bucket.vendor === "general"
		? (bucket.items.length >= 12 ? "Big shop" : "Top-up")
		: titleCase(bucket.vendor);
	const label = `${formatDate(bucket.date)} — ${labelKind} (${bucket.items.length} items)`;
	const id = `mise_shop_run:${bucket.date}:${bucket.vendor}:${idx}`;
	return {
		id,
		date: bucket.date,
		label,
		categories,
		item_count: bucket.items.length,
	};
}

function mergeAdjacent(runs: RunBucket[]): RunBucket[] {
	if (runs.length < 2) return runs.slice();
	const sorted = runs.slice().sort((a, b) => a.date.localeCompare(b.date));
	const out: RunBucket[] = [];
	for (const bucket of sorted) {
		const last = out[out.length - 1];
		if (
			last &&
			last.vendor === "general" &&
			bucket.vendor === "general" &&
			daysBetween(last.date, bucket.date) <= 2 &&
			(last.items.length + bucket.items.length) <= 25
		) {
			// Merge: keep earlier date, but only if all items can still be bought
			// that early without violating their earliest_purchase.
			const allOk = bucket.items.every(item => last.date >= item.earliest_purchase && last.date <= item.latest_purchase);
			if (allOk) {
				last.items.push(...bucket.items);
				continue;
			}
		}
		out.push(bucket);
	}
	return out;
}

function enforceMaxRunsPerWeek(runs: RunBucket[], maxPerWeek: number): RunBucket[] {
	if (runs.length === 0) return runs;
	// Group runs into rolling 7-day windows starting from the first run.
	const sorted = runs.slice().sort((a, b) => a.date.localeCompare(b.date));
	const out = sorted.slice();
	let guard = 0;
	while (guard++ < 50) {
		let violation = -1;
		for (let i = 0; i < out.length; i++) {
			let countInWindow = 0;
			for (let j = i; j < out.length; j++) {
				if (daysBetween(out[i].date, out[j].date) <= 6) countInWindow++;
				else break;
			}
			if (countInWindow > maxPerWeek) { violation = i; break; }
		}
		if (violation < 0) break;
		// Merge the two smallest adjacent general runs in [violation, violation+countInWindow-1].
		let bestIdx = -1;
		let bestCombined = Infinity;
		for (let k = violation; k < out.length - 1; k++) {
			if (out[k].vendor !== "general" || out[k + 1].vendor !== "general") continue;
			if (daysBetween(out[k].date, out[k + 1].date) > 6) break;
			const combined = out[k].items.length + out[k + 1].items.length;
			const allOk = out[k + 1].items.every(item => out[k].date >= item.earliest_purchase && out[k].date <= item.latest_purchase);
			if (allOk && combined < bestCombined) {
				bestCombined = combined;
				bestIdx = k;
			}
		}
		if (bestIdx < 0) break;     // can't safely merge any further
		out[bestIdx].items.push(...out[bestIdx + 1].items);
		out.splice(bestIdx + 1, 1);
	}
	return out;
}

function vendorMatches(hint: string, vendor: string): boolean {
	const h = hint.toLowerCase();
	const v = vendor.toLowerCase();
	if (h === v) return true;
	if (v === "csa" && /produce|fruit/.test(h)) return true;
	if (v === "butcher" && /protein|meat/.test(h)) return true;
	if (v === "fishmonger" && /fish|seafood/.test(h)) return true;
	return false;
}

function vendorHintFor(item: MiseShoppingListItem): string {
	const sources = item.source || [];
	const cat = (item as MiseShoppingListItem & { _category?: string })._category;
	if (cat) return cat.toLowerCase();
	// Fall back to source-based guess
	const joined = sources.join(" ").toLowerCase();
	if (/fish|seafood|salmon|tuna/.test(joined)) return "fishmonger";
	return "general";
}

function categoryGuess(item: MiseShoppingListItem): string {
	const cat = (item as MiseShoppingListItem & { _category?: string })._category;
	return (cat || "general").toString();
}

function canonical(s: string): string {
	return (s || "").toLowerCase().trim().replace(/\s+/g, " ");
}

function enumerateDates(startDate: string, endDate: string): string[] {
	const out: string[] = [];
	let cursor = startDate;
	let guard = 0;
	while (cursor <= endDate && guard++ < 200) {
		out.push(cursor);
		cursor = addDays(cursor, 1);
	}
	return out;
}

function addDays(iso: string, days: number): string {
	const d = new Date(iso + "T00:00:00Z");
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
	const da = new Date(a + "T00:00:00Z").getTime();
	const db = new Date(b + "T00:00:00Z").getTime();
	return Math.abs(Math.round((db - da) / DAY_MS));
}

function dayOfWeek(iso: string): number {
	return new Date(iso + "T00:00:00Z").getUTCDay();
}

function formatDate(iso: string): string {
	const d = new Date(iso + "T00:00:00Z");
	const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()];
	const m = d.getUTCMonth() + 1;
	const day = d.getUTCDate();
	return `${dow} ${m}/${day}`;
}

function titleCase(s: string): string {
	return s.split(/\s+/).map(w => w.length ? w[0].toUpperCase() + w.slice(1) : w).join(" ");
}

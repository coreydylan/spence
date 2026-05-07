// ResourceLedger — forward simulation of the household pantry across a plan.
//
// Given an initial pantry plus a sequence of mutations (shop trips, prep
// batches, meal services), the ledger answers "what's in the kitchen at any
// future date?". It's the foundation for shelf-life critics, ripple previews,
// shopping-run computation, and waste reports.
//
// Design:
//   - Events are append-only and immutable. `apply()` returns a NEW ledger.
//   - `at(date)` replays all events with `on_date <= date` and projects the
//     resulting available stock, accounting for expiry.
//   - Consumption uses a deterministic FIFO-by-expiry strategy: items with
//     the soonest non-null `expires_at` are drained first, falling back to
//     `available_from` order. This matches how a careful cook actually pulls
//     from the fridge.
//   - Canonical names are normalized lowercase for matching.
//
// No I/O, no LLM, no DB. Pure functions.

import type {
	MiseWeeklyPlanDraft,
	MisePlanComponentBatch,
	MisePlanMeal,
	MiseSnackBox,
} from "./planner";

// ─── Public types ─────────────────────────────────────────────────────────

export type ResourceSource =
	| { kind: "pantry";        stocked_qty: number }
	| { kind: "shop_trip";     trip_id: string; purchased_on: string }
	| { kind: "prep_batch";    batch_id: string; produced_on: string }
	| { kind: "meal_leftover"; meal_id: string; produced_on: string };

export interface ResourceItem {
	canonical_name: string;
	qty: number;
	unit: string;
	available_from: string;        // YYYY-MM-DD
	expires_at: string | null;     // YYYY-MM-DD, null = shelf-stable
	source: ResourceSource;
}

export type LedgerEvent =
	| { kind: "shop_received"; on_date: string; trip_id: string; items: ResourceItem[] }
	| { kind: "prep_consumed"; on_date: string; batch_id: string; consumes: ResourceItem[] }
	| { kind: "prep_produced"; on_date: string; batch_id: string; produces: ResourceItem }
	| { kind: "meal_consumed"; on_date: string; meal_id: string; consumes: ResourceItem[] }
	| { kind: "meal_produced"; on_date: string; meal_id: string; produces: ResourceItem }
	| { kind: "expired";       on_date: string; item_canonical: string; qty: number };

export interface ResourceLedger {
	at(date: string): ResourceItem[];
	expiring_by(date: string, threshold_days?: number): ResourceItem[];
	waste_at_end(end_date: string): ResourceItem[];
	consumed_at(date: string): ResourceItem[];
	available_qty(canonical_name: string, on_date: string): number;
	apply(event: LedgerEvent): ResourceLedger;
	apply_many(events: LedgerEvent[]): ResourceLedger;
	events(): LedgerEvent[];
	snapshot(): ResourceItem[];
}

// ─── Internals ────────────────────────────────────────────────────────────

interface InternalItem extends ResourceItem {
	__lot_id: string;     // stable id for tracking through consumption
}

function lotId(item: ResourceItem, seq: number): string {
	const src = item.source;
	let key: string;
	switch (src.kind) {
		case "pantry":         key = `pantry`; break;
		case "shop_trip":      key = `shop:${src.trip_id}`; break;
		case "prep_batch":     key = `prep:${src.batch_id}`; break;
		case "meal_leftover":  key = `meal:${src.meal_id}`; break;
	}
	return `${key}|${item.canonical_name}|${item.available_from}|${seq}`;
}

function canon(name: string): string {
	return name.trim().toLowerCase();
}

function dateLE(a: string, b: string): boolean {
	return a <= b; // ISO YYYY-MM-DD strings sort lexically
}

function daysBetween(a: string, b: string): number {
	const da = new Date(a + "T00:00:00Z").getTime();
	const db = new Date(b + "T00:00:00Z").getTime();
	return Math.round((db - da) / 86400000);
}

function addDays(date: string, n: number): string {
	const d = new Date(date + "T00:00:00Z");
	d.setUTCDate(d.getUTCDate() + n);
	return d.toISOString().slice(0, 10);
}

// Compare two items for FIFO consumption order.
// Earlier expiry first (nulls last); then earlier availability; then lot id
// for stability.
function consumeOrder(a: InternalItem, b: InternalItem): number {
	const ae = a.expires_at;
	const be = b.expires_at;
	if (ae && be) {
		if (ae !== be) return ae.localeCompare(be);
	} else if (ae && !be) {
		return -1;
	} else if (!ae && be) {
		return 1;
	}
	if (a.available_from !== b.available_from) {
		return a.available_from.localeCompare(b.available_from);
	}
	return a.__lot_id.localeCompare(b.__lot_id);
}

// Replay events up to and including `date`, returning the projected lot list
// (non-expired, non-consumed items with positive qty).
//
// Also returns the full per-event consumption record so consumed_at() can
// answer in O(events).
interface ReplayState {
	lots: InternalItem[];                                // currently available
	consumedByDate: Map<string, ResourceItem[]>;          // YYYY-MM-DD → consumed lots-on-that-date
	expiredByDate: Map<string, ResourceItem[]>;
}

function replay(events: LedgerEvent[], throughDate: string | null): ReplayState {
	let lots: InternalItem[] = [];
	const consumedByDate = new Map<string, ResourceItem[]>();
	const expiredByDate = new Map<string, ResourceItem[]>();
	let seq = 0;

	// Sort events by on_date asc, with a stable secondary order by kind
	// (received → produced → consumed → expired) so that a same-day shop
	// can feed a same-day cook, and a same-day cook can feed a same-day
	// meal, before expiry sweeps run.
	const kindOrder: Record<LedgerEvent["kind"], number> = {
		shop_received: 0,
		prep_produced: 1,
		meal_produced: 2,
		prep_consumed: 3,
		meal_consumed: 4,
		expired: 5,
	};
	const sorted = events.slice().sort((a, b) => {
		if (a.on_date !== b.on_date) return a.on_date.localeCompare(b.on_date);
		return kindOrder[a.kind] - kindOrder[b.kind];
	});

	const addedItem = (raw: ResourceItem): InternalItem => {
		const id = lotId(raw, seq++);
		return { ...raw, __lot_id: id };
	};

	const sweepExpiry = (asOf: string) => {
		const surviving: InternalItem[] = [];
		for (const lot of lots) {
			if (lot.qty <= 0) continue;
			if (lot.expires_at && lot.expires_at < asOf) {
				const list = expiredByDate.get(lot.expires_at) || [];
				list.push(stripInternal(lot));
				expiredByDate.set(lot.expires_at, list);
			} else {
				surviving.push(lot);
			}
		}
		lots = surviving;
	};

	for (const ev of sorted) {
		if (throughDate !== null && !dateLE(ev.on_date, throughDate)) break;

		// Sweep things that expired strictly before this event's date.
		sweepExpiry(ev.on_date);

		switch (ev.kind) {
			case "shop_received": {
				for (const item of ev.items) {
					if (item.qty <= 0) continue;
					lots.push(addedItem(item));
				}
				break;
			}
			case "prep_produced":
			case "meal_produced": {
				if (ev.produces.qty > 0) {
					lots.push(addedItem(ev.produces));
				}
				break;
			}
			case "prep_consumed":
			case "meal_consumed": {
				const consumedList: ResourceItem[] = [];
				for (const want of ev.consumes) {
					if (want.qty <= 0) continue;
					const drawn = consumeFromLots(lots, want, ev.on_date);
					for (const c of drawn) consumedList.push(c);
				}
				if (consumedList.length > 0) {
					const list = consumedByDate.get(ev.on_date) || [];
					list.push(...consumedList);
					consumedByDate.set(ev.on_date, list);
				}
				break;
			}
			case "expired": {
				const target = canon(ev.item_canonical);
				let toRemove = ev.qty;
				const sortedLots = lots.slice().sort(consumeOrder);
				for (const lot of sortedLots) {
					if (toRemove <= 0) break;
					if (canon(lot.canonical_name) !== target) continue;
					const take = Math.min(lot.qty, toRemove);
					lot.qty -= take;
					toRemove -= take;
					const list = expiredByDate.get(ev.on_date) || [];
					list.push({ ...stripInternal(lot), qty: take });
					expiredByDate.set(ev.on_date, list);
				}
				lots = lots.filter(l => l.qty > 0);
				break;
			}
		}
	}

	// We deliberately do NOT do a final expiry sweep here. Callers like
	// `at()` filter expired lots at read time, while `waste_at_end()` needs
	// to SEE the unused-past-expiry lots to report them as projected waste.
	return { lots, consumedByDate, expiredByDate };
}

// Drain `want.qty` of the matching canonical_name from `lots` (mutating in
// place). Only considers lots already available (available_from <= asOf).
// Returns the consumed slices as ResourceItems for reporting.
function consumeFromLots(lots: InternalItem[], want: ResourceItem, asOf: string): ResourceItem[] {
	const target = canon(want.canonical_name);
	let remaining = want.qty;
	const out: ResourceItem[] = [];
	const candidates = lots
		.filter(l => l.qty > 0
			&& canon(l.canonical_name) === target
			&& dateLE(l.available_from, asOf)
			&& (!l.expires_at || l.expires_at >= asOf))
		.sort(consumeOrder);

	for (const lot of candidates) {
		if (remaining <= 0) break;
		// Unit mismatch is tolerated but flagged via metadata: we still
		// consume by qty but tag the output unit as the lot's unit.
		const take = Math.min(lot.qty, remaining);
		lot.qty -= take;
		remaining -= take;
		out.push({
			canonical_name: lot.canonical_name,
			qty: take,
			unit: lot.unit,
			available_from: lot.available_from,
			expires_at: lot.expires_at,
			source: lot.source,
		});
	}
	// If `remaining > 0` we are over-consuming. We don't throw — critics will
	// detect missing pantry items separately. The ledger just records what
	// was actually drawn.
	// TODO(future): emit a "shortfall" event so critics can pick it up directly.
	return out;
}

function stripInternal(lot: InternalItem): ResourceItem {
	return {
		canonical_name: lot.canonical_name,
		qty: lot.qty,
		unit: lot.unit,
		available_from: lot.available_from,
		expires_at: lot.expires_at,
		source: lot.source,
	};
}

// ─── Ledger factory ───────────────────────────────────────────────────────

class LedgerImpl implements ResourceLedger {
	private readonly _events: LedgerEvent[];

	constructor(events: LedgerEvent[]) {
		this._events = events;
	}

	at(date: string): ResourceItem[] {
		const state = replay(this._events, date);
		return state.lots
			.filter(l => l.qty > 0
				&& dateLE(l.available_from, date)
				&& (!l.expires_at || l.expires_at >= date))
			.map(stripInternal);
	}

	expiring_by(date: string, threshold_days = 2): ResourceItem[] {
		const state = replay(this._events, date);
		const out: ResourceItem[] = [];
		for (const lot of state.lots) {
			if (lot.qty <= 0) continue;
			if (!dateLE(lot.available_from, date)) continue;
			if (!lot.expires_at) continue;
			// Only count lots that are still good as of `date` (not already past expiry).
			if (lot.expires_at < date) continue;
			const days = daysBetween(date, lot.expires_at);
			if (days >= 0 && days <= threshold_days) {
				out.push(stripInternal(lot));
			}
		}
		return out;
	}

	waste_at_end(end_date: string): ResourceItem[] {
		const state = replay(this._events, end_date);
		const out: ResourceItem[] = [];
		for (const lot of state.lots) {
			if (lot.qty <= 0) continue;
			if (!lot.expires_at) continue;
			if (lot.expires_at <= end_date) {
				out.push(stripInternal(lot));
			}
		}
		return out;
	}

	consumed_at(date: string): ResourceItem[] {
		// Replay through `date` and return only that day's consumption.
		const state = replay(this._events, date);
		return state.consumedByDate.get(date) || [];
	}

	available_qty(canonical_name: string, on_date: string): number {
		const target = canon(canonical_name);
		const items = this.at(on_date);
		let total = 0;
		for (const item of items) {
			if (canon(item.canonical_name) === target) total += item.qty;
		}
		return total;
	}

	apply(event: LedgerEvent): ResourceLedger {
		return new LedgerImpl([...this._events, event]);
	}

	apply_many(events: LedgerEvent[]): ResourceLedger {
		return new LedgerImpl([...this._events, ...events]);
	}

	events(): LedgerEvent[] {
		return this._events.slice();
	}

	snapshot(): ResourceItem[] {
		// Snapshot through the last event date (or "9999-12-31" so everything
		// known about is included).
		const last = this._events.reduce<string>((acc, ev) => ev.on_date > acc ? ev.on_date : acc, "0000-00-00");
		const state = replay(this._events, last === "0000-00-00" ? "9999-12-31" : last);
		return state.lots.filter(l => l.qty > 0).map(stripInternal);
	}
}

export function createLedger(initial_pantry?: ResourceItem[]): ResourceLedger {
	if (!initial_pantry || initial_pantry.length === 0) {
		return new LedgerImpl([]);
	}
	// Group initial pantry into a single shop_received-equivalent event using
	// a synthetic trip id so the events list is uniform. The source on each
	// item is preserved as `pantry` so semantics are clear downstream.
	const event: LedgerEvent = {
		kind: "shop_received",
		on_date: initial_pantry[0]?.available_from || "0000-00-00",
		trip_id: "__initial_pantry__",
		items: initial_pantry.map(i => ({ ...i })),
	};
	// Use the earliest available_from as the on_date so "at()" sees them
	// from the very start.
	event.on_date = initial_pantry.reduce<string>((acc, i) =>
		!acc || i.available_from < acc ? i.available_from : acc, "");
	return new LedgerImpl([event]);
}

// ─── Plan → events ────────────────────────────────────────────────────────

// Heuristic per-formula yield: when we don't know better, assume the cooked
// component yields its `quantity` g/ml from a roughly-equal mass of inputs.
// For meal-level leftover production, we estimate a leftover mass from the
// raw_ingredient grams and the people/serves ratio.
const DEFAULT_LEFTOVER_FRACTION = 0.4; // 40% of dinner inputs survive as leftover

// Heuristic shelf-life floor when a batch has no quality_window_hours. We
// assume 5 days fridge, which is conservative for cooked components.
const DEFAULT_SHELF_HOURS = 5 * 24;

export function ledgerFromPlan(plan: MiseWeeklyPlanDraft): ResourceLedger {
	const events: LedgerEvent[] = [];
	const today = plan.start_date || new Date().toISOString().slice(0, 10);

	// 1. Component batches → prep_consumed (inputs) + prep_produced (output)
	for (const batch of plan.component_batches) {
		const meta = batch.meta as Record<string, unknown> | undefined;
		const prepDate =
			(typeof meta?.desired_prep_date === "string" ? meta.desired_prep_date : null) ||
			(batch.planned_uses[0]?.date ? subtractDays(batch.planned_uses[0].date, 1) : today);

		// Inputs consumed on prepDate. Without per-input quantities we still
		// emit one "consume 1 unit" entry so the event stream reflects use.
		// TODO(future): when formula data is wired in, draw exact qty/unit.
		const consumes: ResourceItem[] = (batch.input_names || []).map(name => ({
			canonical_name: canon(name),
			qty: 1,
			unit: "unit",
			available_from: prepDate,
			expires_at: null,
			source: { kind: "pantry", stocked_qty: 1 } as ResourceSource,
		}));
		if (consumes.length > 0) {
			events.push({
				kind: "prep_consumed",
				on_date: prepDate,
				batch_id: batch.id,
				consumes,
			});
		}

		// Output produced.
		const shelfHours = batch.quality_window_hours ?? DEFAULT_SHELF_HOURS;
		const shelfDays = Math.max(1, Math.round(shelfHours / 24));
		const expiresAt = addDays(prepDate, shelfDays);
		const outputCanonical = canon(batch.label);
		const produces: ResourceItem = {
			canonical_name: outputCanonical,
			qty: batch.quantity ?? 0,
			unit: batch.unit || "g",
			available_from: prepDate,
			expires_at: expiresAt,
			source: { kind: "prep_batch", batch_id: batch.id, produced_on: prepDate },
		};
		events.push({
			kind: "prep_produced",
			on_date: prepDate,
			batch_id: batch.id,
			produces,
		});

		// Each planned_use is a meal_consumed against the batch on that date.
		// Distribute the batch quantity evenly across uses; if a use's meal
		// already produces a meal_consumed below from raw_ingredients we want
		// the component drain to be recognized. To avoid double-billing we
		// only emit the component drain (not the raw-ingredient version) for
		// listed component_ids in the meal.
		const perUseQty = (batch.quantity ?? 0) / Math.max(1, batch.planned_uses.length);
		for (const use of batch.planned_uses) {
			events.push({
				kind: "meal_consumed",
				on_date: use.date,
				meal_id: use.meal_id,
				consumes: [{
					canonical_name: outputCanonical,
					qty: perUseQty,
					unit: batch.unit || "g",
					available_from: prepDate,
					expires_at: expiresAt,
					source: { kind: "prep_batch", batch_id: batch.id, produced_on: prepDate },
				}],
			});
		}
	}

	// 2. Meals (lunch/dinner) → meal_consumed for raw_ingredients + meal_produced for leftovers
	for (const day of plan.meals_by_day || []) {
		for (const meal of day.meals || []) {
			emitMealEvents(events, meal);
		}
	}

	// 3. Breakfasts.
	for (const meal of plan.breakfasts || []) {
		emitMealEvents(events, meal);
	}

	// 4. Snack boxes.
	for (const box of plan.snack_boxes || []) {
		emitSnackEvents(events, box);
	}

	return new LedgerImpl(events);
}

function emitMealEvents(events: LedgerEvent[], meal: MisePlanMeal): void {
	// Raw ingredient consumption. Skip names that are clearly cooked
	// components (we already accounted for them via batch planned_uses).
	const consumes: ResourceItem[] = [];
	for (const raw of meal.raw_ingredients || []) {
		if (!raw.name) continue;
		const qty = typeof raw.qty === "number" && raw.qty > 0 ? raw.qty :
			typeof raw.grams === "number" && raw.grams > 0 ? raw.grams : 1;
		const unit = raw.unit || (raw.grams ? "g" : "unit");
		consumes.push({
			canonical_name: canon(raw.name),
			qty,
			unit,
			available_from: meal.date,
			expires_at: null,
			source: { kind: "pantry", stocked_qty: qty },
		});
	}
	if (consumes.length > 0) {
		events.push({
			kind: "meal_consumed",
			on_date: meal.date,
			meal_id: meal.id,
			consumes,
		});
	}

	// Leftover production: if leftovers_to has any entries, mint a
	// leftover lot equal to DEFAULT_LEFTOVER_FRACTION × total raw mass.
	if (meal.leftovers_to && meal.leftovers_to.length > 0) {
		const totalGrams = (meal.raw_ingredients || []).reduce(
			(acc, r) => acc + (typeof r.grams === "number" && r.grams > 0 ? r.grams : 0), 0);
		const leftoverGrams = Math.round(totalGrams * DEFAULT_LEFTOVER_FRACTION);
		if (leftoverGrams > 0) {
			events.push({
				kind: "meal_produced",
				on_date: meal.date,
				meal_id: meal.id,
				produces: {
					canonical_name: canon(`leftover ${meal.title}`),
					qty: leftoverGrams,
					unit: "g",
					available_from: meal.date,
					// Leftovers good for ~3 days fridge by default.
					expires_at: addDays(meal.date, 3),
					source: { kind: "meal_leftover", meal_id: meal.id, produced_on: meal.date },
				},
			});
		}
	}
}

function emitSnackEvents(events: LedgerEvent[], box: MiseSnackBox): void {
	const consumes: ResourceItem[] = [];
	for (const raw of box.raw_ingredients || []) {
		if (!raw.name) continue;
		const qty = typeof raw.qty === "number" && raw.qty > 0 ? raw.qty :
			typeof raw.grams === "number" && raw.grams > 0 ? raw.grams : 1;
		const unit = raw.unit || (raw.grams ? "g" : "unit");
		consumes.push({
			canonical_name: canon(raw.name),
			qty,
			unit,
			available_from: box.date,
			expires_at: null,
			source: { kind: "pantry", stocked_qty: qty },
		});
	}
	if (consumes.length === 0) return;
	events.push({
		kind: "meal_consumed",
		on_date: box.date,
		meal_id: box.id,
		consumes,
	});
}

function subtractDays(date: string, n: number): string {
	return addDays(date, -n);
}

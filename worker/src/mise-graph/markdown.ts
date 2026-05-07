// Markdown renderer for a persisted mise plan + its compiled ledger.
//
// Reads the plan's draft and the compiled ledger (resources, events, inputs,
// reservations, validation issues) and emits a single human-readable document
// suitable for printing or pasting into Notes.

import type { MiseWeeklyPlanDraft } from "./planner";

interface LedgerSnapshot {
	resources: ResourceRow[];
	events: EventRow[];
	inputs: IORow[];
	outputs: IORow[];
	reservations: ReservationRow[];
	validation_issues: ValidationIssueRow[];
}

interface ResourceRow {
	id: string;
	label: string;
	resource_kind: string;
	quantity: number | null;
	unit: string | null;
	storage: string | null;
	created_at_time: string | null;
	best_until: string | null;
	safe_until: string | null;
	confidence: number | null;
	source: string | null;
	status: string | null;
	source_event_id?: string | null;
	source_component_id?: string | null;
	meta?: Record<string, unknown> | null;
	meta_json?: string | null;
}

interface EventRow {
	id: string;
	title: string;
	event_type: string;
	event_date: string | null;
	start_at: string | null;
	end_at: string | null;
	active_time_min: number | null;
	idle_time_min: number | null;
	sort_order?: number | null;
	meta?: Record<string, unknown> | null;
	meta_json?: string | null;
}

interface IORow {
	id: string;
	event_id: string;
	resource_lot_id: string | null;
	resource_ref: string | null;
	label: string;
	quantity: number | null;
	unit: string | null;
	required?: number | boolean | null;
	role: string | null;
	meta?: Record<string, unknown> | null;
	meta_json?: string | null;
}

interface ReservationRow {
	id: string;
	event_id: string;
	resource_lot_id: string | null;
	component_id: string;
	reservation_type: string | null;
	quantity: number | null;
	unit: string | null;
	status: string | null;
	meta?: Record<string, unknown> | null;
	meta_json?: string | null;
}

interface ValidationIssueRow {
	severity: string;
	issue_type: string;
	title: string;
	detail: string | null;
	event_id: string | null;
	resource_lot_id: string | null;
	component_id: string | null;
	repair_hint: string | null;
}

export function renderMiseLedgerMarkdown(plan: MiseWeeklyPlanDraft, ledger: LedgerSnapshot): string {
	const lines: string[] = [];
	const eventById = new Map(ledger.events.map(event => [event.id, event]));
	const resourceById = new Map(ledger.resources.map(resource => [resource.id, resource]));
	const inputsByEvent = groupBy(ledger.inputs, item => item.event_id);
	const reservationsByEvent = groupBy(ledger.reservations, item => item.event_id);
	const planMealById = new Map<string, {
		raw_ingredients?: Array<{ name: string; qty: number | null; unit: string | null; grams: number | null; category: string | null }>;
		method_summary?: string | null;
		lineage?: Array<{ source_kind: string; source_title?: string; source_id?: string; influence: string }>;
	}>();
	for (const day of plan.meals_by_day) for (const m of day.meals) planMealById.set(m.id, m as any);
	for (const m of plan.breakfasts) planMealById.set(m.id, m as any);
	const planSnackById = new Map<string, { raw_ingredients?: Array<{ name: string; qty: number | null; unit: string | null; grams: number | null; category: string | null }>; items?: string[] }>();
	for (const s of plan.snack_boxes) planSnackById.set(s.id, s as any);

	const constraintsRecord = recordValue(plan.constraints);
	const promptValue = stringValue(constraintsRecord.prompt);
	const cuisineDirection = stringList(constraintsRecord.cuisine_direction);
	const dietaryList = stringList(constraintsRecord.dietary);

	lines.push(`# ${plan.title}`);
	lines.push("");
	lines.push(`**${plan.start_date} → ${plan.end_date}** · ${plan.people} people${plan.timezone ? ` · ${plan.timezone}` : ""}`);
	if (cuisineDirection.length) lines.push(`**Cuisine direction:** ${cuisineDirection.join(", ")}`);
	if (dietaryList.length) lines.push(`**Diet:** ${dietaryList.join(", ")}`);
	if (promptValue) lines.push(`**Prompt:** ${promptValue}`);
	if (plan.selected_ingredients.length) {
		lines.push(`**Anchor ingredients:** ${plan.selected_ingredients.map(titleCase).join(", ")}`);
	}
	const summary = summarizeValidation(ledger.validation_issues);
	if (summary) lines.push(`**Validation:** ${summary}`);
	lines.push("");

	const groceryEvents = ledger.events.filter(event => event.event_type === "grocery_trip");
	if (groceryEvents.length) {
		lines.push("## Shopping");
		lines.push("");
		const inputsByCanonical = aggregateShoppingTotals(ledger);
		const shoppingByCategory = groupShoppingByCategory(plan, inputsByCanonical, ledger);
		const sortedCategories = Object.keys(shoppingByCategory).sort();
		for (const category of sortedCategories) {
			lines.push(`### ${titleCase(category)}`);
			for (const item of shoppingByCategory[category]) {
				const requiredGrams = item.required_grams ? ` — ~${item.required_grams}g` : "";
				const consumers = item.consumer_count ? ` (used in ${item.consumer_count} prep)` : "";
				lines.push(`- **${item.label}**${requiredGrams}${consumers}`);
			}
			lines.push("");
		}
	}

	lines.push("## Daily Plan");
	lines.push("");
	const datesInPlan = collectPlanDates(plan, ledger);
	for (const date of datesInPlan) {
		lines.push(`### ${formatDateHeader(date)}`);
		lines.push("");

		const dayMeals = ledger.events
			.filter(event => event.event_date === date && event.event_type === "meal_service")
			.sort((a, b) => (a.start_at || "").localeCompare(b.start_at || ""));
		const daySnacks = ledger.events.filter(event => event.event_date === date && event.event_type === "snack_pack");
		const dayPrep = ledger.events
			.filter(event => event.event_date === date && (event.event_type === "prep_task" || event.event_type === "audit_prompt"))
			.sort((a, b) => (a.start_at || "").localeCompare(b.start_at || ""));

		for (const meal of dayMeals) {
			const meta = readEventMeta(meal);
			const slot = stringValue(meta.slot) || guessSlot(meal.start_at);
			const formatHint = stringValue(meta.format);
			const peopleHint = numberValue(meta.people) || plan.people;
			const cuisineHint = stringList(meta.cuisine).join(", ");
			const planMeal = planMealById.get(meal.id);
			lines.push(`**${slot ? slot.toUpperCase() : "MEAL"}** — ${meal.title}`);
			const subtitleParts: string[] = [];
			if (peopleHint) subtitleParts.push(`for ${peopleHint}`);
			if (formatHint && !meal.title.toLowerCase().includes(formatHint.toLowerCase())) subtitleParts.push(formatHint);
			if (cuisineHint) subtitleParts.push(cuisineHint);
			if (meal.start_at) subtitleParts.push(formatTime(meal.start_at));
			if (subtitleParts.length) lines.push(`*${subtitleParts.join(" · ")}*`);
			if (planMeal?.method_summary) lines.push(`> ${planMeal.method_summary}`);

			const reservations = (reservationsByEvent.get(meal.id) || [])
				.filter(reservation => reservation.status !== "released")
				.sort((a, b) => (a.component_id || "").localeCompare(b.component_id || ""));
			if (reservations.length) {
				for (const reservation of reservations) {
					const resource = reservation.resource_lot_id ? resourceById.get(reservation.resource_lot_id) : null;
					const label = resource?.label || reservationLabel(reservation.component_id);
					const qty = formatQty(reservation.quantity, reservation.unit);
					lines.push(`- ${label}${qty ? ` — ${qty}` : ""}`);
				}
			}
			if (planMeal?.raw_ingredients && planMeal.raw_ingredients.length) {
				for (const ing of planMeal.raw_ingredients) {
					const qty = ing.qty != null && ing.unit ? `${trimNumber(ing.qty)} ${ing.unit}` : (ing.grams ? `${ing.grams}g` : "");
					lines.push(`- ${titleCase(ing.name)}${qty ? ` — ${qty}` : ""}`);
				}
			}
			if (planMeal?.lineage && planMeal.lineage.length) {
				const refs = planMeal.lineage.slice(0, 4).map(l => {
					const tag = l.source_kind === "personal_recipe" ? "❤️" : l.source_kind === "canonical_dish" ? "📖" : l.source_kind === "season" ? "🌱" : l.source_kind === "affinity" ? "🔗" : l.source_kind === "compound" ? "🧪" : l.source_kind === "template" ? "🧱" : "·";
					const title = l.source_title || l.source_id || l.source_kind;
					return `${tag} ${title} _(${l.influence})_`;
				});
				lines.push(`*Sources:* ${refs.join(" · ")}`);
			}
			const issues = ledger.validation_issues.filter(issue => issue.event_id === meal.id);
			for (const issue of issues) {
				lines.push(`> ⚠️ ${issue.title}${issue.repair_hint ? ` _(${issue.repair_hint})_` : ""}`);
			}
			lines.push("");
		}

		for (const snack of daySnacks) {
			const meta = readEventMeta(snack);
			const planSnack = planSnackById.get(snack.id);
			const items = planSnack?.items && planSnack.items.length ? planSnack.items : stringList(meta.items);
			lines.push(`**SNACK** — ${snack.title}`);
			if (items.length) lines.push(`*${items.join(", ")}*`);
			const reservations = reservationsByEvent.get(snack.id) || [];
			for (const reservation of reservations) {
				const resource = reservation.resource_lot_id ? resourceById.get(reservation.resource_lot_id) : null;
				const label = resource?.label || reservationLabel(reservation.component_id);
				const qty = formatQty(reservation.quantity, reservation.unit);
				lines.push(`- ${label}${qty ? ` — ${qty}` : ""}`);
			}
			if (planSnack?.raw_ingredients && planSnack.raw_ingredients.length) {
				for (const ing of planSnack.raw_ingredients) {
					const qty = ing.qty != null && ing.unit ? `${trimNumber(ing.qty)} ${ing.unit}` : (ing.grams ? `${ing.grams}g` : "");
					lines.push(`- ${titleCase(ing.name)}${qty ? ` — ${qty}` : ""}`);
				}
			}
			lines.push("");
		}

		if (dayPrep.length) {
			lines.push(`**Prep this day**`);
			for (const event of dayPrep) {
				const time = event.start_at ? formatTime(event.start_at) : "";
				const active = event.active_time_min ? `${event.active_time_min}m active` : "";
				const idle = event.idle_time_min ? ` + ${event.idle_time_min}m idle` : "";
				const inputs = (inputsByEvent.get(event.id) || []).filter(input => input.role === "transformation_input");
				const inputSummary = inputs.length
					? inputs.map(input => `${formatInputQty(input)} ${input.label}`).join(", ")
					: "";
				lines.push(`- ${time ? `${time} · ` : ""}${event.title}${active ? ` _(${active}${idle})_` : ""}`);
				if (inputSummary) lines.push(`  - inputs: ${inputSummary}`);
			}
			lines.push("");
		}
	}

	const componentLots = ledger.resources.filter(resource =>
		resource.resource_kind === "component"
		&& resource.status !== "consumed"
		&& !(resource.quantity === 0 && (resource.status || "available") === "available"),
	);
	if (componentLots.length) {
		lines.push("## Component Batches");
		lines.push("");
		lines.push("| Component | Quantity | Storage | Made | Best Until |");
		lines.push("|---|---|---|---|---|");
		for (const lot of componentLots.sort((a, b) => (a.created_at_time || "").localeCompare(b.created_at_time || ""))) {
			const made = lot.created_at_time ? formatDateTime(lot.created_at_time) : "—";
			const best = lot.best_until ? formatDateTime(lot.best_until) : "—";
			const qty = formatQty(lot.quantity, lot.unit);
			lines.push(`| ${lot.label} | ${qty || "—"} | ${lot.storage || "—"} | ${made} | ${best} |`);
		}
		lines.push("");
	}

	const expiryEvents = ledger.events.filter(event => event.event_type === "resource_expiry");
	if (expiryEvents.length) {
		lines.push("## Quality Windows");
		lines.push("");
		for (const event of expiryEvents.sort((a, b) => (a.start_at || "").localeCompare(b.start_at || ""))) {
			lines.push(`- ${formatDateTime(event.start_at || "")} — ${event.title}`);
		}
		lines.push("");
	}

	if (ledger.validation_issues.length) {
		lines.push("## Validation Notes");
		lines.push("");
		for (const issue of ledger.validation_issues) {
			const icon = issue.severity === "hard_error" ? "❌" : issue.severity === "warning" ? "⚠️" : "ℹ️";
			lines.push(`- ${icon} **${issue.title}**`);
			if (issue.detail) lines.push(`  - ${issue.detail}`);
			if (issue.repair_hint) lines.push(`  - _Suggested:_ ${issue.repair_hint}`);
		}
		lines.push("");
	}

	return lines.join("\n");
}

interface ShoppingItem {
	canonical: string;
	label: string;
	required_grams: number;
	consumer_count: number;
}

function aggregateShoppingTotals(ledger: LedgerSnapshot): Map<string, ShoppingItem> {
	const totals = new Map<string, ShoppingItem>();
	for (const resource of ledger.resources) {
		if (resource.resource_kind !== "raw") continue;
		const meta = recordValue(resource.meta) || {};
		const requiredGrams = numberValue(meta.required_grams_total) || 0;
		const consumers = stringList(meta.required_consumer_events).length;
		if (requiredGrams === 0 && consumers === 0) continue;
		const key = normalizeName(resource.label);
		totals.set(key, {
			canonical: key,
			label: resource.label,
			required_grams: requiredGrams,
			consumer_count: consumers,
		});
	}
	return totals;
}

function groupShoppingByCategory(plan: MiseWeeklyPlanDraft, totals: Map<string, ShoppingItem>, ledger: LedgerSnapshot): Record<string, ShoppingItem[]> {
	const categoryByCanonical = new Map<string, string>();
	for (const section of plan.shopping_list) {
		for (const item of section.items) {
			categoryByCanonical.set(normalizeName(item.name), section.category);
		}
	}
	const out: Record<string, ShoppingItem[]> = {};
	for (const item of totals.values()) {
		const category = categoryByCanonical.get(item.canonical) || inferCategory(item.label);
		if (!out[category]) out[category] = [];
		out[category].push(item);
	}
	for (const category of Object.keys(out)) {
		out[category].sort((a, b) => a.label.localeCompare(b.label));
	}
	return out;
}

function inferCategory(name: string): string {
	const normalized = normalizeName(name);
	if (/apple|berry|citrus|orange|lemon|lime|grape|fruit|strawberry/.test(normalized)) return "fruit";
	if (/cucumber|radish|carrot|greens|herb|onion|garlic|pepper|tomato|asparagus|cabbage|cilantro|parsley|mint|vegetable/.test(normalized)) return "produce";
	if (/yogurt|milk|cheese|egg|butter|cream/.test(normalized)) return "dairy";
	if (/chickpea|lentil|bean|tofu/.test(normalized)) return "protein";
	if (/rice|oat|flour|bread|pita|pasta|grain/.test(normalized)) return "grains";
	if (/tahini|oil|vinegar|spice|salt|nut|seed|sugar|yeast|cumin|maple/.test(normalized)) return "pantry";
	return "other";
}

function readEventMeta(event: EventRow): Record<string, unknown> {
	if (event.meta) return event.meta;
	if (event.meta_json) {
		try {
			const parsed = JSON.parse(event.meta_json);
			return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
		} catch {
			return {};
		}
	}
	return {};
}

function reservationLabel(componentId: string): string {
	return titleCase(componentId.replace(/^mise_component:/, "").replace(/_/g, " "));
}

function formatInputQty(input: IORow): string {
	if (input.quantity != null && input.unit) return `${trimNumber(input.quantity)} ${input.unit}`;
	const meta = recordValue(input.meta) || (input.meta_json ? safeParseJSON(input.meta_json) : {});
	const grams = numberValue(meta.grams);
	if (grams) return `${grams}g`;
	return "";
}

function formatQty(qty: number | null, unit: string | null): string {
	if (qty == null) return "";
	if (!unit) return `${trimNumber(qty)}`;
	return `${trimNumber(qty)} ${unit}`;
}

function trimNumber(value: number): string {
	if (Number.isInteger(value)) return String(value);
	return value.toFixed(2).replace(/\.?0+$/, "");
}

function summarizeValidation(issues: ValidationIssueRow[]): string {
	const hard = issues.filter(issue => issue.severity === "hard_error").length;
	const warn = issues.filter(issue => issue.severity === "warning").length;
	if (!hard && !warn) return "✅ 0 hard errors, 0 warnings";
	const parts: string[] = [];
	if (hard) parts.push(`${hard} hard ${hard === 1 ? "error" : "errors"}`);
	if (warn) parts.push(`${warn} ${warn === 1 ? "warning" : "warnings"}`);
	return `${hard ? "❌" : "⚠️"} ${parts.join(", ")}`;
}

function collectPlanDates(plan: MiseWeeklyPlanDraft, _ledger: LedgerSnapshot): string[] {
	// Strict: only dates between plan.start_date and plan.end_date (inclusive).
	// Resource expiry events past end_date should NOT add empty days to the menu.
	const dates: string[] = [];
	const startTs = plan.start_date ? Date.parse(`${plan.start_date}T00:00:00.000Z`) : NaN;
	const endTs = plan.end_date ? Date.parse(`${plan.end_date}T00:00:00.000Z`) : NaN;
	if (Number.isFinite(startTs) && Number.isFinite(endTs)) {
		for (let ts = startTs; ts <= endTs; ts += 86400000) {
			dates.push(new Date(ts).toISOString().slice(0, 10));
		}
		return dates;
	}
	// Fallback for plans without strict bounds.
	const set = new Set<string>();
	if (plan.start_date) set.add(plan.start_date);
	if (plan.end_date) set.add(plan.end_date);
	for (const day of plan.meals_by_day) set.add(day.date);
	return Array.from(set).sort();
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
	const out = new Map<string, T[]>();
	for (const item of items) {
		const k = key(item);
		const list = out.get(k) || [];
		list.push(item);
		out.set(k, list);
	}
	return out;
}

function formatDateHeader(isoDate: string): string {
	const parsed = new Date(`${isoDate}T12:00:00.000Z`);
	if (Number.isNaN(parsed.getTime())) return isoDate;
	return parsed.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
}

function formatDateTime(value: string): string {
	if (!value) return "—";
	const isoLike = value.includes("T") ? value : value.replace(" ", "T");
	const parsed = new Date(isoLike + (isoLike.endsWith("Z") ? "" : "Z"));
	if (Number.isNaN(parsed.getTime())) return value;
	const date = parsed.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
	const time = parsed.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" });
	return `${date} ${time}`;
}

function formatTime(value: string): string {
	const time = value.slice(11, 16);
	if (!/^\d{2}:\d{2}$/.test(time)) return "";
	const [hourStr, minStr] = time.split(":");
	const hour = Number(hourStr);
	const minute = Number(minStr);
	const ampm = hour >= 12 ? "pm" : "am";
	const display = hour % 12 || 12;
	return `${display}:${minute.toString().padStart(2, "0")}${ampm}`;
}

function guessSlot(startAt: string | null): string {
	if (!startAt) return "meal";
	const time = startAt.slice(11, 16);
	if (time < "10:00") return "breakfast";
	if (time < "14:00") return "lunch";
	if (time < "17:00") return "snack";
	return "dinner";
}

function recordValue(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function stringList(value: unknown): string[] {
	if (Array.isArray(value)) return value.filter(item => typeof item === "string") as string[];
	if (typeof value === "string") return value.split(",").map(item => item.trim()).filter(Boolean);
	return [];
}

function numberValue(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

function safeParseJSON(value: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(value);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
	} catch {
		return {};
	}
}

function normalizeName(value: string): string {
	return String(value || "")
		.toLowerCase()
		.trim()
		.replace(/[_-]+/g, " ")
		.replace(/\s+/g, " ");
}

function titleCase(value: string): string {
	return normalizeName(value).replace(/\b\w/g, char => char.toUpperCase());
}

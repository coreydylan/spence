// Kitchen inventory — persistent pantry/fridge/freezer state.
// "What's in the kitchen right now," distinct from a week-plan's pantry
// list (a snapshot of plan inputs). Items get added on shop receive,
// sweep observation, or recipe-input residual; consumed when a meal eats
// them or by explicit user action. Storage: `mise_kitchen_inventory`.
//
// `consumed` is a soft delete — kept for history; default queries filter
// it out. `expiringSoon` thresholds on `expires_at`; un-consumed only;
// no expiry → never returned. `reconcileWithShopRun` matches by
// canonical_name only; existing un-consumed item → add to qty, else
// insert new row. Keeps inventory tidy across grocery runs.

import type { MiseGraphEnv } from "./types";
import { round3, slugify } from "./household-memory-utils";

export type KitchenStorage = "pantry" | "fridge" | "freezer" | "counter";

export interface KitchenItem {
	inventory_id: string;
	household_id: string;
	canonical_name: string;
	qty: number | null;
	unit: string | null;
	storage: KitchenStorage | null;
	acquired_at: string | null;
	expires_at: string | null;
	source: string | null;
	consumed: boolean;
	notes: string | null;
}

export interface ListInventoryOptions {
	include_consumed?: boolean;
}

interface InventoryRow {
	inventory_id: string;
	household_id: string;
	canonical_name: string;
	qty: number | null;
	unit: string | null;
	storage: string | null;
	acquired_at: string | null;
	expires_at: string | null;
	source: string | null;
	consumed: number | boolean | string | null;
	notes: string | null;
	created_at?: string;
	updated_at?: string;
}

export async function listInventory(
	env: MiseGraphEnv,
	household_id: string,
	opts: ListInventoryOptions = {},
): Promise<KitchenItem[]> {
	const hh = (household_id || "").trim();
	if (!hh) return [];
	const includeConsumed = !!opts.include_consumed;
	let rows: InventoryRow[] = [];
	try {
		const result = includeConsumed
			? await env.DB.prepare(
				`SELECT inventory_id, household_id, canonical_name, qty, unit, storage,
				        acquired_at, expires_at, source, consumed, notes,
				        created_at, updated_at
				 FROM mise_kitchen_inventory
				 WHERE household_id = ?
				 ORDER BY (expires_at IS NULL), expires_at ASC, canonical_name ASC
				 LIMIT 1000`,
			).bind(hh).all<InventoryRow>()
			: await env.DB.prepare(
				`SELECT inventory_id, household_id, canonical_name, qty, unit, storage,
				        acquired_at, expires_at, source, consumed, notes,
				        created_at, updated_at
				 FROM mise_kitchen_inventory
				 WHERE household_id = ?
				   AND (consumed IS NULL OR consumed = 0 OR consumed = FALSE)
				 ORDER BY (expires_at IS NULL), expires_at ASC, canonical_name ASC
				 LIMIT 1000`,
			).bind(hh).all<InventoryRow>();
		rows = (result.results || []) as InventoryRow[];
	} catch {
		return [];
	}
	return rows.map(rowToItem);
}

export async function addItem(
	env: MiseGraphEnv,
	item: Omit<KitchenItem, "inventory_id" | "consumed">,
): Promise<KitchenItem> {
	const hh = (item.household_id || "").trim();
	const name = (item.canonical_name || "").trim();
	if (!hh) throw new Error("addItem: household_id required");
	if (!name) throw new Error("addItem: canonical_name required");

	const inventory_id = generateInventoryId(hh, name);
	const now = new Date().toISOString();

	const created: KitchenItem = {
		inventory_id,
		household_id: hh,
		canonical_name: name,
		qty: typeof item.qty === "number" && Number.isFinite(item.qty) ? item.qty : null,
		unit: item.unit ? item.unit.trim() : null,
		storage: item.storage ?? null,
		acquired_at: item.acquired_at || null,
		expires_at: item.expires_at || null,
		source: item.source ?? null,
		consumed: false,
		notes: item.notes ?? null,
	};

	await env.DB.prepare(
		`INSERT OR REPLACE INTO mise_kitchen_inventory
			(inventory_id, household_id, canonical_name, qty, unit, storage,
			 acquired_at, expires_at, source, consumed, notes, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			created.inventory_id,
			created.household_id,
			created.canonical_name,
			created.qty,
			created.unit,
			created.storage,
			created.acquired_at,
			created.expires_at,
			created.source,
			0,
			created.notes,
			now,
			now,
		)
		.run();

	return created;
}

export async function consumeItem(
	env: MiseGraphEnv,
	inventory_id: string,
	qty?: number,
): Promise<KitchenItem> {
	const id = (inventory_id || "").trim();
	if (!id) throw new Error("consumeItem: inventory_id required");

	let row: InventoryRow | null = null;
	try {
		row = await env.DB.prepare(
			`SELECT inventory_id, household_id, canonical_name, qty, unit, storage,
			        acquired_at, expires_at, source, consumed, notes
			 FROM mise_kitchen_inventory
			 WHERE inventory_id = ?`,
		).bind(id).first<InventoryRow>();
	} catch {
		throw new Error(`consumeItem: lookup failed for ${id}`);
	}
	if (!row) throw new Error(`consumeItem: not found ${id}`);

	const now = new Date().toISOString();
	const currentQty = typeof row.qty === "number" ? row.qty : null;
	let nextQty: number | null = currentQty;
	let nextConsumed = true;

	if (typeof qty === "number" && Number.isFinite(qty) && qty > 0 && currentQty !== null) {
		const remaining = currentQty - qty;
		if (remaining > 0.0001) {
			nextQty = round3(remaining);
			nextConsumed = false;
		} else {
			nextQty = 0;
			nextConsumed = true;
		}
	}

	await env.DB.prepare(
		`UPDATE mise_kitchen_inventory
		    SET qty = ?,
		        consumed = ?,
		        updated_at = ?
		  WHERE inventory_id = ?`,
	)
		.bind(nextQty, nextConsumed ? 1 : 0, now, id)
		.run();

	return {
		inventory_id: row.inventory_id,
		household_id: row.household_id,
		canonical_name: row.canonical_name,
		qty: nextQty,
		unit: row.unit,
		storage: normalizeStorage(row.storage),
		acquired_at: row.acquired_at,
		expires_at: row.expires_at,
		source: row.source,
		consumed: nextConsumed,
		notes: row.notes,
	};
}

export async function expiringSoon(
	env: MiseGraphEnv,
	household_id: string,
	withinDays: number,
): Promise<KitchenItem[]> {
	const hh = (household_id || "").trim();
	if (!hh) return [];
	const days = Number.isFinite(withinDays) && withinDays >= 0 ? Math.floor(withinDays) : 0;
	const now = new Date();
	const horizon = new Date(now.getTime());
	horizon.setUTCDate(horizon.getUTCDate() + days);
	const horizonIso = horizon.toISOString().slice(0, 10);
	const todayIso = now.toISOString().slice(0, 10);

	let rows: InventoryRow[] = [];
	try {
		const result = await env.DB.prepare(
			`SELECT inventory_id, household_id, canonical_name, qty, unit, storage,
			        acquired_at, expires_at, source, consumed, notes
			 FROM mise_kitchen_inventory
			 WHERE household_id = ?
			   AND (consumed IS NULL OR consumed = 0 OR consumed = FALSE)
			   AND expires_at IS NOT NULL
			   AND expires_at <= ?
			 ORDER BY expires_at ASC
			 LIMIT 500`,
		).bind(hh, horizonIso).all<InventoryRow>();
		rows = (result.results || []) as InventoryRow[];
	} catch {
		return [];
	}
	// Filter out items already past — caller can find those via separate query if needed.
	// We include everything <= horizon and >= today (i.e. expiring within the window from now).
	return rows
		.filter(r => !!r.expires_at && r.expires_at >= todayIso.slice(0, 10) && r.expires_at <= horizonIso)
		.map(rowToItem);
}

export async function reconcileWithShopRun(
	env: MiseGraphEnv,
	household_id: string,
	items: Array<{ name: string; qty: number; unit: string }>,
): Promise<{ added: number; matched: number }> {
	const hh = (household_id || "").trim();
	if (!hh) return { added: 0, matched: 0 };
	if (!Array.isArray(items) || items.length === 0) return { added: 0, matched: 0 };

	let rows: InventoryRow[] = [];
	try {
		const result = await env.DB.prepare(
			`SELECT inventory_id, household_id, canonical_name, qty, unit, storage,
			        acquired_at, expires_at, source, consumed, notes
			 FROM mise_kitchen_inventory
			 WHERE household_id = ?
			   AND (consumed IS NULL OR consumed = 0 OR consumed = FALSE)`,
		).bind(hh).all<InventoryRow>();
		rows = (result.results || []) as InventoryRow[];
	} catch {
		// continue with empty index
	}

	const index = new Map<string, InventoryRow>();
	for (const row of rows) {
		const key = (row.canonical_name || "").trim().toLowerCase();
		if (key && !index.has(key)) index.set(key, row);
	}

	let added = 0;
	let matched = 0;
	const now = new Date().toISOString();

	for (const incoming of items) {
		const name = (incoming?.name || "").trim();
		const qty = typeof incoming?.qty === "number" && Number.isFinite(incoming.qty) ? incoming.qty : null;
		const unit = (incoming?.unit || "").trim() || null;
		if (!name) continue;
		const key = name.toLowerCase();
		const match = index.get(key);
		if (match) {
			matched++;
			const matchQty = typeof match.qty === "number" ? match.qty : 0;
			const newQty = qty !== null ? round3(matchQty + qty) : match.qty;
			await env.DB.prepare(
				`UPDATE mise_kitchen_inventory
				    SET qty = ?,
				        unit = COALESCE(unit, ?),
				        source = COALESCE(source, 'shop_run'),
				        updated_at = ?
				  WHERE inventory_id = ?`,
			).bind(newQty, unit, now, match.inventory_id).run();
		} else {
			added++;
			await addItem(env, {
				household_id: hh,
				canonical_name: name,
				qty,
				unit,
				storage: null,
				acquired_at: now.slice(0, 10),
				expires_at: null,
				source: "shop_run",
				notes: null,
			});
		}
	}

	return { added, matched };
}

// ---------- helpers ----------

function rowToItem(row: InventoryRow): KitchenItem {
	const consumedRaw = row.consumed;
	const consumed = consumedRaw === 1 || consumedRaw === true || consumedRaw === "1" || consumedRaw === "true";
	return {
		inventory_id: row.inventory_id,
		household_id: row.household_id,
		canonical_name: row.canonical_name,
		qty: typeof row.qty === "number" ? row.qty : null,
		unit: row.unit,
		storage: normalizeStorage(row.storage),
		acquired_at: row.acquired_at,
		expires_at: row.expires_at,
		source: row.source,
		consumed,
		notes: row.notes,
	};
}

function normalizeStorage(value: string | null): KitchenStorage | null {
	if (!value) return null;
	const v = value.trim().toLowerCase();
	if (v === "pantry" || v === "fridge" || v === "freezer" || v === "counter") return v;
	return null;
}

function generateInventoryId(household_id: string, canonical_name: string): string {
	const slug = slugify(canonical_name, 32);
	const stamp = Date.now().toString(36);
	const rand = Math.random().toString(36).slice(2, 8);
	return `inv_${household_id}__${slug}__${stamp}_${rand}`;
}

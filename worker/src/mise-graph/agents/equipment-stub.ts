// Equipment-claim stub for Wave 7B Track A — now backed by the real
// household-scoped tracker in src/mise-graph/equipment.ts (Wave 7B-C).
//
// The original Track A stub used the MealAgent's per-DO embedded SQLite
// because there was no household-scoped store yet. Wave 7B-C ships
// `src/mise-graph/equipment.ts` which lives in D1 and can see across
// meals/tasks/shop runs. Phase 2 will swap meal-phase-handlers.cook_window_entry
// to call the real D1-backed module directly.
//
// Until then we keep the per-DO stub call shape (sink + meal_id + equipment +
// claim_window) so meal-phase-handlers compiles unchanged. Internally each
// call still routes through the per-DO sink so the existing isolation
// semantics are preserved. The real module is also re-exported below so
// any new callers (or Phase 2) can use it directly.

import type { AgentSqlSink } from "./base";

// Re-export the real Wave 7B-C equipment tracker so callers can pull from
// either path. The names match equipment.ts so a one-line refactor in
// Phase 2 will swap meal-phase-handlers off the per-DO stub.
export {
	claimEquipment,
	defineEquipment,
	findFreeWindow,
	getEquipmentLoad,
	listEquipment,
	migrateEquipmentSchema,
	releaseClaimsFor,
	releaseEquipment,
} from "../equipment";
export type {
	ClaimConflict,
	ClaimRequest,
	ClaimResult,
	EquipmentClaim as EquipmentClaimRecord,
	EquipmentClaimKind,
	EquipmentClaimRef,
	EquipmentClaimStatus,
	EquipmentDefinition,
	EquipmentKind,
	EquipmentLoad,
} from "../equipment-types";

export interface EquipmentClaimWindow {
	start_ms: number;
	end_ms: number;
}

export interface ClaimEquipmentInput {
	meal_id: string;
	equipment: ReadonlyArray<string>;
	claim_window: EquipmentClaimWindow;
}

export interface EquipmentClaim {
	claim_id: string;
	meal_id: string;
	equipment: string;
	start_ms: number;
	end_ms: number;
	claimed_at_ms: number;
}

export interface EquipmentConflict {
	equipment: string;
	conflicting_meal_id: string;
	conflicting_window: EquipmentClaimWindow;
}

export interface ClaimEquipmentResult {
	ok: boolean;
	claims: EquipmentClaim[];
	conflicts: EquipmentConflict[];
}

/**
 * Ensure the per-DO claim table exists. Idempotent — call from `onStart` of
 * any agent that wants to record equipment claims locally.
 *
 * Wave 7B-C will replace with real equipment tracker.
 */
export function ensureEquipmentClaimsStubTable(sink: AgentSqlSink): void {
	sink.sql`
		CREATE TABLE IF NOT EXISTS mise_equipment_claims_stub (
			claim_id TEXT PRIMARY KEY,
			meal_id TEXT NOT NULL,
			equipment TEXT NOT NULL,
			start_ms INTEGER NOT NULL,
			end_ms INTEGER NOT NULL,
			claimed_at_ms INTEGER NOT NULL,
			released_at_ms INTEGER
		)
	`;
	sink.sql`
		CREATE INDEX IF NOT EXISTS idx_equip_meal
			ON mise_equipment_claims_stub(meal_id)
	`;
}

/**
 * Claim each piece of equipment in `input.equipment` for the given window.
 * Stub semantics:
 *   - Detects intra-DO conflicts (same meal_id claiming overlapping windows
 *     for the same item).
 *   - Returns a `claims` row per piece of equipment with a synthetic
 *     `claim_id` (no cross-meal coordination — that's Wave 7B-C).
 *
 * Wave 7B-C will replace with real equipment tracker.
 */
export async function claimEquipmentForMeal(
	sink: AgentSqlSink,
	input: ClaimEquipmentInput,
): Promise<ClaimEquipmentResult> {
	const meal_id = (input.meal_id || "").trim();
	if (!meal_id) {
		return {
			ok: false,
			claims: [],
			conflicts: [{
				equipment: "<none>",
				conflicting_meal_id: "<missing-meal-id>",
				conflicting_window: input.claim_window,
			}],
		};
	}
	const equipment = (input.equipment || []).filter(
		e => typeof e === "string" && e.trim().length > 0,
	);
	if (equipment.length === 0) {
		return { ok: true, claims: [], conflicts: [] };
	}
	const start_ms = Math.floor(input.claim_window.start_ms);
	const end_ms = Math.floor(input.claim_window.end_ms);
	if (!Number.isFinite(start_ms) || !Number.isFinite(end_ms) || end_ms <= start_ms) {
		return { ok: true, claims: [], conflicts: [] };
	}

	ensureEquipmentClaimsStubTable(sink);

	const conflicts: EquipmentConflict[] = [];
	const claims: EquipmentClaim[] = [];
	const claimed_at_ms = Date.now();

	for (const item of equipment) {
		// Check overlap with any prior claim for the same equipment.
		const existing = sink.sql<{
			claim_id: string;
			meal_id: string;
			start_ms: number;
			end_ms: number;
			released_at_ms: number | null;
		}>`
			SELECT claim_id, meal_id, start_ms, end_ms, released_at_ms
			FROM mise_equipment_claims_stub
			WHERE equipment = ${item}
			  AND released_at_ms IS NULL
			  AND start_ms < ${end_ms}
			  AND end_ms > ${start_ms}
		`;
		const overlapping = existing.find(row => row.meal_id !== meal_id);
		if (overlapping) {
			conflicts.push({
				equipment: item,
				conflicting_meal_id: overlapping.meal_id,
				conflicting_window: {
					start_ms: overlapping.start_ms,
					end_ms: overlapping.end_ms,
				},
			});
			continue;
		}

		const claim_id = `equip_${claimed_at_ms.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
		sink.sql`
			INSERT INTO mise_equipment_claims_stub
				(claim_id, meal_id, equipment, start_ms, end_ms, claimed_at_ms, released_at_ms)
			VALUES (${claim_id}, ${meal_id}, ${item}, ${start_ms}, ${end_ms}, ${claimed_at_ms}, ${null})
		`;
		claims.push({
			claim_id,
			meal_id,
			equipment: item,
			start_ms,
			end_ms,
			claimed_at_ms,
		});
	}

	return {
		ok: conflicts.length === 0,
		claims,
		conflicts,
	};
}

/**
 * Release all active claims for a given meal_id. Used by cancellation /
 * archival to free the equipment a meal was holding.
 *
 * Wave 7B-C will replace with real equipment tracker.
 */
export function releaseEquipmentForMeal(
	sink: AgentSqlSink,
	meal_id: string,
): { released: number } {
	const id = (meal_id || "").trim();
	if (!id) return { released: 0 };
	ensureEquipmentClaimsStubTable(sink);
	const now = Date.now();
	const before = sink.sql<{ n: number }>`
		SELECT COUNT(*) AS n
		FROM mise_equipment_claims_stub
		WHERE meal_id = ${id} AND released_at_ms IS NULL
	`;
	const count = Number(before[0]?.n || 0);
	sink.sql`
		UPDATE mise_equipment_claims_stub
		SET released_at_ms = ${now}
		WHERE meal_id = ${id} AND released_at_ms IS NULL
	`;
	return { released: count };
}

/**
 * Read active claims for a meal — useful for tests and `/state` debugging.
 *
 * Wave 7B-C will replace with real equipment tracker.
 */
export function listEquipmentClaimsForMeal(
	sink: AgentSqlSink,
	meal_id: string,
): EquipmentClaim[] {
	const id = (meal_id || "").trim();
	if (!id) return [];
	ensureEquipmentClaimsStubTable(sink);
	const rows = sink.sql<{
		claim_id: string;
		meal_id: string;
		equipment: string;
		start_ms: number;
		end_ms: number;
		claimed_at_ms: number;
	}>`
		SELECT claim_id, meal_id, equipment, start_ms, end_ms, claimed_at_ms
		FROM mise_equipment_claims_stub
		WHERE meal_id = ${id} AND released_at_ms IS NULL
		ORDER BY claimed_at_ms ASC
	`;
	return rows.map(r => ({
		claim_id: r.claim_id,
		meal_id: r.meal_id,
		equipment: r.equipment,
		start_ms: r.start_ms,
		end_ms: r.end_ms,
		claimed_at_ms: r.claimed_at_ms,
	}));
}

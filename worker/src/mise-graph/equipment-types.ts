// Equipment resource types — Wave 7B Track C.
//
// Kitchens have limited resources. The MealAgent's cook_window phase needs
// to claim them atomically: an oven, two burners, the chef's knife. When a
// claim conflicts with an existing held claim, the agent must back off or
// reschedule. This module provides the type-level contract; the runtime
// lives in equipment.ts.
//
// EquipmentKind is the top-level resource taxonomy. EquipmentDefinition is
// per-household — the same kitchen can have one main oven and one wall
// oven, two stovetop burners + a hob, a 10in chef's knife and an 8in santoku.
// EquipmentClaim is the active reservation row — a single row per claim
// per resource per window.

export type EquipmentKind =
	| "oven" | "stove_burner" | "instant_pot" | "skillet" | "saucepan"
	| "fryer" | "blender" | "food_processor" | "stand_mixer"
	| "chefs_knife" | "cutting_board"
	| "counter_space" | "sink_basin"
	| "grill" | "smoker";

export interface EquipmentDefinition {
	slug: string;            // "oven_main", "burner_1"
	kind: EquipmentKind;
	household_id: string;
	exclusive: boolean;      // true = single claimant at a time; false = shared up to capacity
	capacity?: number;       // for shared: max concurrent (e.g. 4 burners share "stove" capacity)
	notes?: string;
}

export type EquipmentClaimKind = "meal" | "task" | "shop" | "cook_session";

export interface EquipmentClaimRef {
	kind: EquipmentClaimKind;
	id: string;
}

export type EquipmentClaimStatus = "held" | "released" | "expired";

export interface EquipmentClaim {
	id: string;              // ulid-like
	equipment_slug: string;
	claim_for: EquipmentClaimRef;
	start_ts: number;        // epoch_ms
	end_ts: number;
	status: EquipmentClaimStatus;
	claimed_by: string;      // member_id or agent_id
	released_at_ms?: number | null;
	created_at_ms?: number;
}

export interface ClaimRequest {
	equipment_slug: string;
	claim_for: EquipmentClaimRef;
	start_ts: number;
	end_ts: number;
	claimed_by: string;
}

export interface ClaimConflict {
	requested: EquipmentClaim;
	conflicts_with: EquipmentClaim[];
}

export interface ClaimResult {
	ok: boolean;
	granted: EquipmentClaim[];
	conflicts: ClaimConflict[];
}

export interface EquipmentLoad {
	active_claims: EquipmentClaim[];
	load_pct: number;        // 0..1; (sum of overlap_min) / window_min, capped at 1
}

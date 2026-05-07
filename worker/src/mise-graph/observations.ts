// Observations and audits for mise-graph.
//
// An observation is a real-world fact about household inventory: "we used all
// the hummus", "there are 3 dough balls left", "the mayo was never made".
// Observations override projections in the resource ledger and trigger the
// repair loop to fix downstream events.

import type { MiseGraphEnv } from "./types";
import type {
	MiseLedgerCompileResult,
	MiseResourceLot,
} from "./ledger";

export type MiseObservationKind =
	| "consumed"     // resource is gone (qty 0)
	| "remaining"    // user reports remaining qty
	| "missing"      // never made / not present
	| "gained"       // extra found / unplanned addition
	| "condition";   // quality compromised but still present

export interface MiseObservation {
	id: string;
	plan_id: string | null;
	household_id: string | null;
	audit_session_id: string | null;
	target_resource_lot_id: string | null;
	target_canonical_name: string | null;
	target_state_id: string | null;
	observation_kind: MiseObservationKind;
	quantity: number | null;
	unit: string | null;
	grams: number | null;
	status: string;
	confidence: number;
	source: string;
	text: string | null;
	meta: Record<string, unknown>;
	observed_at: string;
	applied_at: string | null;
}

export interface MiseObservationInput {
	id?: string;
	resource?: string;
	canonical_name?: string;
	resource_lot_id?: string;
	state_id?: string;
	kind?: MiseObservationKind | string;
	quantity?: number | null;
	unit?: string | null;
	grams?: number | null;
	confidence?: number | null;
	text?: string | null;
	source?: string | null;
	meta?: Record<string, unknown>;
}

export function normalizeObservation(input: MiseObservationInput, planId: string | null, householdId: string | null, sessionId: string | null): MiseObservation {
	const canonical = stringValue(input.canonical_name) || stringValue(input.resource);
	const kindRaw = stringValue(input.kind).toLowerCase();
	const kind: MiseObservationKind = (["consumed", "remaining", "missing", "gained", "condition"].includes(kindRaw) ? kindRaw : "consumed") as MiseObservationKind;
	const id = stringValue(input.id) || slugId("obs", planId || "", canonical || "resource", kind, Date.now(), Math.floor(Math.random() * 9999));
	return {
		id,
		plan_id: planId,
		household_id: householdId,
		audit_session_id: sessionId,
		target_resource_lot_id: stringValue(input.resource_lot_id) || null,
		target_canonical_name: canonical ? canonical.toLowerCase().trim() : null,
		target_state_id: stringValue(input.state_id) || null,
		observation_kind: kind,
		quantity: numberValue(input.quantity),
		unit: stringValue(input.unit) || null,
		grams: numberValue(input.grams),
		status: "observed",
		confidence: numberValue(input.confidence) ?? 0.95,
		source: stringValue(input.source) || "user_observation",
		text: stringValue(input.text) || null,
		meta: input.meta || {},
		observed_at: new Date().toISOString(),
		applied_at: null,
	};
}

export async function persistMiseObservations(env: MiseGraphEnv, observations: MiseObservation[]): Promise<void> {
	for (const obs of observations) {
		await env.DB.prepare(`
			INSERT OR REPLACE INTO mise_resource_observations
			(id, audit_session_id, plan_id, household_id, target_resource_lot_id, target_canonical_name,
			 target_state_id, observation_kind, quantity, unit, grams, status, confidence, source, text,
			 meta_json, observed_at, applied_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).bind(
			obs.id,
			obs.audit_session_id,
			obs.plan_id,
			obs.household_id,
			obs.target_resource_lot_id,
			obs.target_canonical_name,
			obs.target_state_id,
			obs.observation_kind,
			obs.quantity,
			obs.unit,
			obs.grams,
			obs.status,
			obs.confidence,
			obs.source,
			obs.text,
			JSON.stringify(obs.meta),
			obs.observed_at,
			obs.applied_at,
		).run();
	}
}

export async function loadMiseObservations(env: MiseGraphEnv, planId: string): Promise<MiseObservation[]> {
	try {
		const result = await env.DB.prepare(`
			SELECT id, audit_session_id, plan_id, household_id, target_resource_lot_id, target_canonical_name,
				target_state_id, observation_kind, quantity, unit, grams, status, confidence, source, text,
				meta_json, observed_at, applied_at
			FROM mise_resource_observations
			WHERE plan_id = ?
			ORDER BY observed_at
		`).bind(planId).all<Record<string, unknown>>();
		return (result.results || []).map(row => ({
			id: stringValue(row.id),
			plan_id: stringValue(row.plan_id) || null,
			household_id: stringValue(row.household_id) || null,
			audit_session_id: stringValue(row.audit_session_id) || null,
			target_resource_lot_id: stringValue(row.target_resource_lot_id) || null,
			target_canonical_name: stringValue(row.target_canonical_name) || null,
			target_state_id: stringValue(row.target_state_id) || null,
			observation_kind: (stringValue(row.observation_kind) || "consumed") as MiseObservationKind,
			quantity: numberValue(row.quantity),
			unit: stringValue(row.unit) || null,
			grams: numberValue(row.grams),
			status: stringValue(row.status) || "observed",
			confidence: numberValue(row.confidence) ?? 0.95,
			source: stringValue(row.source) || "user_observation",
			text: stringValue(row.text) || null,
			meta: parseJsonObject(row.meta_json),
			observed_at: stringValue(row.observed_at),
			applied_at: stringValue(row.applied_at) || null,
		}));
	} catch {
		return [];
	}
}

export interface ObservationOverlayResult {
	affected_lots: string[];
	added_lots: MiseResourceLot[];
}

export function applyObservationsToLedger(compiled: MiseLedgerCompileResult, observations: MiseObservation[]): ObservationOverlayResult {
	const affectedLots: string[] = [];
	const addedLots: MiseResourceLot[] = [];

	for (const observation of observations) {
		const matches = findMatchingLots(compiled.resources, observation);
		switch (observation.observation_kind) {
			case "consumed":
			case "missing": {
				if (matches.length === 0) {
					if (observation.target_canonical_name) {
						compiled.resources.push(makeOrphanLot(observation, "consumed"));
					}
					continue;
				}
				for (const lot of matches) {
					lot.status = "consumed";
					lot.quantity = 0;
					lot.confidence = Math.max(observation.confidence, lot.confidence);
					lot.source = "observed";
					lot.meta = { ...lot.meta, observed_kind: observation.observation_kind, observation_id: observation.id, observation_text: observation.text };
					affectedLots.push(lot.id);
				}
				break;
			}
			case "remaining": {
				if (matches.length === 0) {
					if (observation.target_canonical_name) {
						compiled.resources.push(makeOrphanLot(observation, "available"));
					}
					continue;
				}
				const target = matches[0];
				target.quantity = observation.quantity ?? observation.grams ?? target.quantity;
				if (observation.unit) target.unit = observation.unit;
				target.confidence = Math.max(observation.confidence, target.confidence);
				target.source = "observed";
				target.meta = { ...target.meta, observed_kind: observation.observation_kind, observation_id: observation.id };
				affectedLots.push(target.id);
				break;
			}
			case "gained": {
				const lot = makeOrphanLot(observation, "available");
				compiled.resources.push(lot);
				addedLots.push(lot);
				affectedLots.push(lot.id);
				break;
			}
			case "condition": {
				for (const lot of matches) {
					lot.confidence = Math.min(lot.confidence, observation.confidence * 0.8);
					lot.source = "observed";
					lot.meta = { ...lot.meta, observed_kind: observation.observation_kind, observation_id: observation.id, observation_text: observation.text };
					affectedLots.push(lot.id);
				}
				break;
			}
		}
	}

	return { affected_lots: unique(affectedLots), added_lots: addedLots };
}

function findMatchingLots(resources: MiseResourceLot[], observation: MiseObservation): MiseResourceLot[] {
	if (observation.target_resource_lot_id) {
		return resources.filter(lot => lot.id === observation.target_resource_lot_id);
	}
	const canonical = (observation.target_canonical_name || "").toLowerCase().trim();
	if (!canonical) return [];
	return resources.filter(lot => {
		if (lot.status === "consumed") return false;
		const labelNorm = (lot.label || "").toLowerCase().trim();
		if (labelNorm === canonical) return true;
		if (labelNorm.includes(canonical)) return true;
		const componentMeta = (lot.meta || {}) as Record<string, unknown>;
		const formulaCanonical = (componentMeta.component as Record<string, unknown> | undefined)?.label as string | undefined;
		if (formulaCanonical && String(formulaCanonical).toLowerCase().includes(canonical)) return true;
		return false;
	});
}

function makeOrphanLot(observation: MiseObservation, status: "consumed" | "available"): MiseResourceLot {
	const label = observation.target_canonical_name
		? observation.target_canonical_name.replace(/\b\w/g, char => char.toUpperCase())
		: "Observed Resource";
	return {
		id: slugId("lot_obs", observation.id),
		plan_id: observation.plan_id || "",
		household_id: observation.household_id,
		label,
		resource_kind: "raw",
		state_id: observation.target_state_id,
		source_component_id: null,
		source_event_id: null,
		quantity: observation.quantity ?? observation.grams ?? (status === "consumed" ? 0 : null),
		unit: observation.unit,
		storage: null,
		container: null,
		created_at_time: observation.observed_at,
		best_until: null,
		safe_until: null,
		confidence: observation.confidence,
		source: "observed",
		status,
		meta: { observed_kind: observation.observation_kind, observation_id: observation.id, observation_text: observation.text },
	};
}

function stringValue(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

function parseJsonObject(value: unknown): Record<string, unknown> {
	if (typeof value !== "string" || !value) return {};
	try {
		const parsed = JSON.parse(value);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
	} catch {
		return {};
	}
}

function unique<T>(items: T[]): T[] {
	return Array.from(new Set(items));
}

function slugId(...parts: Array<string | number | null | undefined>): string {
	return parts
		.map(part => String(part || "").toLowerCase().trim())
		.filter(Boolean)
		.join(":")
		.replace(/[^a-z0-9:]+/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_|_$/g, "");
}

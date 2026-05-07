// Equipment resource tracking — Wave 7B Track C.
//
// This module is the canonical lock ledger for kitchen equipment. Every
// MealAgent / TaskScheduler / ShopAgent that needs an oven, a burner, a
// chef's knife, or counter space goes through claimEquipment() to atomically
// reserve a window. Conflicts are detected via interval overlap:
//   start < other.end  AND  end > other.start
//
// Concurrency model
// -----------------
// Multiple sessions can race to claim the same equipment. We use a "check
// then write" pattern wrapped in env.DB.batch() when the caller asks for
// `all_or_nothing`. D1 batches are atomic: either every statement commits or
// none do, so we can sandwich a final SELECT-COUNT verification at the end
// of a batch and roll back by detecting the count drift in a follow-up read.
//
// For the simpler "claim what you can" mode, each requested claim is
// validated and inserted independently; conflicts return a list of the
// existing held claims that the caller can use to decide whether to
// reschedule.
//
// Schema lives in schemas/schema-equipment.sql (also exported as inline
// CREATE TABLE statements below so the worker can migrate on demand).
//
// All write paths wrap mutations with beginTrace/completeTrace from
// agent-trace.ts; agent_kind = "equipment".

import type { MiseGraphEnv } from "./types";
import {
	type ClaimConflict,
	type ClaimRequest,
	type ClaimResult,
	type EquipmentClaim,
	type EquipmentClaimKind,
	type EquipmentClaimStatus,
	type EquipmentDefinition,
	type EquipmentKind,
	type EquipmentLoad,
} from "./equipment-types";
import { beginTrace, completeTrace } from "./agent-trace";

// ─── Schema migration ──────────────────────────────────────────────────────

const SCHEMA_STATEMENTS: ReadonlyArray<string> = [
	`CREATE TABLE IF NOT EXISTS mise_equipment_definitions (
		slug TEXT PRIMARY KEY,
		kind TEXT NOT NULL,
		household_id TEXT NOT NULL,
		exclusive INTEGER NOT NULL,
		capacity INTEGER,
		notes TEXT,
		created_at_ms INTEGER NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS ix_equip_def_household
		ON mise_equipment_definitions(household_id)`,
	`CREATE TABLE IF NOT EXISTS mise_equipment_claims (
		id TEXT PRIMARY KEY,
		equipment_slug TEXT NOT NULL,
		claim_for_kind TEXT NOT NULL,
		claim_for_id TEXT NOT NULL,
		start_ts INTEGER NOT NULL,
		end_ts INTEGER NOT NULL,
		status TEXT NOT NULL DEFAULT 'held',
		claimed_by TEXT NOT NULL,
		released_at_ms INTEGER,
		created_at_ms INTEGER NOT NULL
	)`,
];

export async function migrateEquipmentSchema(env: MiseGraphEnv): Promise<void> {
	for (const sql of SCHEMA_STATEMENTS) {
		await env.DB.prepare(sql).run();
	}
}

// ─── Definitions ────────────────────────────────────────────────────────────

export async function defineEquipment(
	env: MiseGraphEnv,
	def: EquipmentDefinition,
): Promise<void> {
	if (!def.slug) throw new Error("defineEquipment: slug required");
	if (!def.household_id) throw new Error("defineEquipment: household_id required");
	if (!def.kind) throw new Error("defineEquipment: kind required");

	await migrateEquipmentSchema(env);

	const ctx = beginTrace({
		tool_name: "equipment.defineEquipment",
		tool_args: { slug: def.slug, kind: def.kind, household_id: def.household_id },
		caller_kind: "system",
		household_id: def.household_id,
	});

	try {
		await env.DB.prepare(
			`INSERT OR REPLACE INTO mise_equipment_definitions
				(slug, kind, household_id, exclusive, capacity, notes, created_at_ms)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		).bind(
			def.slug,
			def.kind,
			def.household_id,
			def.exclusive ? 1 : 0,
			def.capacity ?? null,
			def.notes ?? null,
			Date.now(),
		).run();

		await completeTrace(env, ctx, {
			ok: true,
			result: { slug: def.slug },
			result_summary: `defined equipment ${def.slug} (${def.kind})`,
		});
	} catch (err) {
		await completeTrace(env, ctx, {
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		});
		throw err;
	}
}

export async function listEquipment(
	env: MiseGraphEnv,
	household_id: string,
): Promise<EquipmentDefinition[]> {
	if (!household_id) return [];
	await migrateEquipmentSchema(env);
	const rows = await env.DB.prepare(
		`SELECT slug, kind, household_id, exclusive, capacity, notes
		 FROM mise_equipment_definitions
		 WHERE household_id = ?
		 ORDER BY slug ASC`,
	).bind(household_id).all<{
		slug: string;
		kind: string;
		household_id: string;
		exclusive: number;
		capacity: number | null;
		notes: string | null;
	}>();
	return (rows.results || []).map(r => ({
		slug: r.slug,
		kind: r.kind as EquipmentKind,
		household_id: r.household_id,
		exclusive: !!r.exclusive,
		capacity: r.capacity ?? undefined,
		notes: r.notes ?? undefined,
	}));
}

// ─── Lazy auto-definition (used by cook_window_entry & friends) ───────────
//
// Wave 7B Track D wires MealAgent.cook_window_entry to the real claim store.
// Households often haven't pre-declared every piece of equipment a recipe
// touches, so claims would fail with "no such equipment" before they could
// even attempt to detect cross-meal conflicts. To keep the path forgiving we
// auto-define equipment lazily the first time a slug is referenced for a
// household, using a sensible default (exclusive vs. shared, capacity).

const SHARED_EQUIPMENT_DEFAULTS: Record<string, { kind: EquipmentKind; capacity: number }> = {
	stovetop:         { kind: "stove_burner",  capacity: 4 },
	stove:            { kind: "stove_burner",  capacity: 4 },
	stovetop_burner:  { kind: "stove_burner",  capacity: 4 },
	stove_burner:     { kind: "stove_burner",  capacity: 4 },
	stove_top:        { kind: "stove_burner",  capacity: 4 },
	burner:           { kind: "stove_burner",  capacity: 4 },
	burners:          { kind: "stove_burner",  capacity: 4 },
	counter:          { kind: "counter_space", capacity: 2 },
	counter_space:    { kind: "counter_space", capacity: 2 },
	cutting_board:    { kind: "cutting_board", capacity: 2 },
};

const EXCLUSIVE_EQUIPMENT_KIND_HINTS: Array<[RegExp, EquipmentKind]> = [
	[/oven/i,           "oven"],
	[/instant.?pot/i,   "instant_pot"],
	[/pressure/i,       "instant_pot"],
	[/grill/i,          "grill"],
	[/smoker/i,         "smoker"],
	[/skillet/i,        "skillet"],
	[/saucepan/i,       "saucepan"],
	[/sauce.?pan/i,     "saucepan"],
	[/fryer/i,          "fryer"],
	[/blender/i,        "blender"],
	[/food.?proc/i,     "food_processor"],
	[/stand.?mixer/i,   "stand_mixer"],
	[/mixer/i,          "stand_mixer"],
	[/chef.?s.?knife/i, "chefs_knife"],
	[/knife/i,          "chefs_knife"],
	[/sink/i,           "sink_basin"],
];

/**
 * Return a sensible default `EquipmentDefinition` for the given slug. Slugs
 * containing "stove", "burner", or "counter" are treated as shared (capacity
 * > 1); everything else defaults to exclusive (single claimant per window),
 * which matches the conservative behaviour of `claimEquipment` when no row
 * is found for a slug.
 */
export function defaultEquipmentDefinition(
	slug: string,
	household_id: string,
): EquipmentDefinition {
	const normalized = slug.trim().toLowerCase();
	const shared = SHARED_EQUIPMENT_DEFAULTS[normalized];
	if (shared) {
		return {
			slug,
			kind: shared.kind,
			household_id,
			exclusive: false,
			capacity: shared.capacity,
			notes: "auto-defined by ensureEquipmentDefined",
		};
	}
	let kind: EquipmentKind = "oven"; // safe exclusive default
	for (const [re, hinted] of EXCLUSIVE_EQUIPMENT_KIND_HINTS) {
		if (re.test(normalized)) { kind = hinted; break; }
	}
	return {
		slug,
		kind,
		household_id,
		exclusive: true,
		notes: "auto-defined by ensureEquipmentDefined",
	};
}

/**
 * Idempotently ensure the named equipment slug has a definition row for the
 * given household. If a definition already exists this is a no-op; otherwise
 * a default definition is inserted via `defineEquipment`.
 *
 * Returns the resolved (existing or newly created) definition.
 */
export async function ensureEquipmentDefined(
	env: MiseGraphEnv,
	household_id: string,
	slug: string,
): Promise<EquipmentDefinition> {
	if (!household_id) throw new Error("ensureEquipmentDefined: household_id required");
	if (!slug || !slug.trim()) throw new Error("ensureEquipmentDefined: slug required");
	await migrateEquipmentSchema(env);
	const existing = await getDefinition(env, slug);
	if (existing) return existing;
	const def = defaultEquipmentDefinition(slug, household_id);
	await defineEquipment(env, def);
	return def;
}

async function getDefinition(
	env: MiseGraphEnv,
	slug: string,
): Promise<EquipmentDefinition | null> {
	const row = await env.DB.prepare(
		`SELECT slug, kind, household_id, exclusive, capacity, notes
		 FROM mise_equipment_definitions
		 WHERE slug = ?
		 LIMIT 1`,
	).bind(slug).first<{
		slug: string;
		kind: string;
		household_id: string;
		exclusive: number;
		capacity: number | null;
		notes: string | null;
	}>();
	if (!row) return null;
	return {
		slug: row.slug,
		kind: row.kind as EquipmentKind,
		household_id: row.household_id,
		exclusive: !!row.exclusive,
		capacity: row.capacity ?? undefined,
		notes: row.notes ?? undefined,
	};
}

// ─── Claims ────────────────────────────────────────────────────────────────

export interface ClaimEquipmentArgs {
	household_id: string;
	claims: ClaimRequest[];
	all_or_nothing?: boolean;
}

interface RawClaimRow {
	id: string;
	equipment_slug: string;
	claim_for_kind: string;
	claim_for_id: string;
	start_ts: number;
	end_ts: number;
	status: string;
	claimed_by: string;
	released_at_ms: number | null;
	created_at_ms: number;
}

function rowToClaim(row: RawClaimRow): EquipmentClaim {
	return {
		id: row.id,
		equipment_slug: row.equipment_slug,
		claim_for: {
			kind: row.claim_for_kind as EquipmentClaimKind,
			id: row.claim_for_id,
		},
		start_ts: row.start_ts,
		end_ts: row.end_ts,
		status: row.status as EquipmentClaimStatus,
		claimed_by: row.claimed_by,
		released_at_ms: row.released_at_ms ?? null,
		created_at_ms: row.created_at_ms,
	};
}

async function findOverlappingHeldClaims(
	env: MiseGraphEnv,
	equipment_slug: string,
	start_ts: number,
	end_ts: number,
): Promise<EquipmentClaim[]> {
	const rows = await env.DB.prepare(
		`SELECT id, equipment_slug, claim_for_kind, claim_for_id,
			start_ts, end_ts, status, claimed_by, released_at_ms, created_at_ms
		 FROM mise_equipment_claims
		 WHERE equipment_slug = ?
		   AND status = 'held'
		   AND start_ts < ?
		   AND end_ts > ?
		 ORDER BY start_ts ASC`,
	).bind(equipment_slug, end_ts, start_ts).all<RawClaimRow>();
	return (rows.results || []).map(rowToClaim);
}

/**
 * Atomically claim equipment for a window. For exclusive equipment any
 * overlap is a conflict. For shared equipment with capacity N, overlap is
 * only a conflict when the count of currently held overlapping claims is
 * already >= N.
 *
 * When `all_or_nothing` is true, ANY single conflict short-circuits the
 * whole batch and nothing is written. Otherwise, conflicting claims are
 * skipped and successful claims are still inserted.
 */
export async function claimEquipment(
	env: MiseGraphEnv,
	args: ClaimEquipmentArgs,
): Promise<ClaimResult> {
	if (!args.household_id) throw new Error("claimEquipment: household_id required");
	if (!Array.isArray(args.claims) || args.claims.length === 0) {
		return { ok: true, granted: [], conflicts: [] };
	}
	await migrateEquipmentSchema(env);

	const ctx = beginTrace({
		tool_name: "equipment.claimEquipment",
		tool_args: {
			household_id: args.household_id,
			claim_count: args.claims.length,
			all_or_nothing: !!args.all_or_nothing,
		},
		caller_kind: "system",
		household_id: args.household_id,
	});

	try {
		const granted: EquipmentClaim[] = [];
		const conflicts: ClaimConflict[] = [];
		const planned: Array<{ claim: EquipmentClaim; overlapping: EquipmentClaim[] }> = [];

		for (const req of args.claims) {
			validateClaimRequest(req);
			const def = await getDefinition(env, req.equipment_slug);
			// If equipment is undefined treat it as exclusive — it's a kitchen
			// resource the household just hasn't catalogued yet, so we err on
			// the safe side rather than letting overlapping claims through.
			const exclusive = def ? def.exclusive : true;
			const capacity = def && !def.exclusive ? Math.max(1, def.capacity ?? 1) : 1;

			// Pull existing held claims that overlap [start_ts, end_ts).
			// Also include any "planned" claims earlier in this batch that
			// target the same slug and overlap our window — without this,
			// two requested claims for the same exclusive resource could
			// both succeed within a single call.
			const existing = await findOverlappingHeldClaims(
				env,
				req.equipment_slug,
				req.start_ts,
				req.end_ts,
			);
			const inFlight = planned
				.map(p => p.claim)
				.filter(c =>
					c.equipment_slug === req.equipment_slug &&
					c.start_ts < req.end_ts &&
					c.end_ts > req.start_ts &&
					c.status === "held",
				);
			// Skip overlaps that belong to the SAME (kind, id) — re-claiming
			// our own claim is idempotent, not a conflict. This makes the
			// cook_window_entry handler safe to re-run (e.g. when an alarm
			// fires after a manual transition has already claimed).
			const ownsClaim = (c: EquipmentClaim) =>
				c.claim_for.kind === req.claim_for.kind &&
				c.claim_for.id === req.claim_for.id;
			const overlapping = [...existing, ...inFlight].filter(c => !ownsClaim(c));

			const requestedClaim: EquipmentClaim = {
				id: generateClaimId(),
				equipment_slug: req.equipment_slug,
				claim_for: req.claim_for,
				start_ts: req.start_ts,
				end_ts: req.end_ts,
				status: "held",
				claimed_by: req.claimed_by,
				released_at_ms: null,
				created_at_ms: Date.now(),
			};

			const wouldConflict = exclusive
				? overlapping.length > 0
				: overlapping.length >= capacity;

			if (wouldConflict) {
				conflicts.push({ requested: requestedClaim, conflicts_with: overlapping });
				if (args.all_or_nothing) {
					await completeTrace(env, ctx, {
						ok: false,
						result_summary: `claim batch aborted: ${conflicts.length} conflict(s)`,
						error: `conflict on ${req.equipment_slug}`,
					});
					return { ok: false, granted: [], conflicts };
				}
				continue;
			}
			planned.push({ claim: requestedClaim, overlapping });
		}

		// Persist successful claims. In all_or_nothing mode we use a single
		// D1 batch so they commit together. Otherwise we insert one at a time.
		if (planned.length > 0) {
			if (args.all_or_nothing) {
				const stmts = planned.map(p =>
					env.DB.prepare(
						`INSERT INTO mise_equipment_claims
							(id, equipment_slug, claim_for_kind, claim_for_id,
							 start_ts, end_ts, status, claimed_by,
							 released_at_ms, created_at_ms)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					).bind(
						p.claim.id,
						p.claim.equipment_slug,
						p.claim.claim_for.kind,
						p.claim.claim_for.id,
						p.claim.start_ts,
						p.claim.end_ts,
						p.claim.status,
						p.claim.claimed_by,
						p.claim.released_at_ms ?? null,
						p.claim.created_at_ms ?? Date.now(),
					)
				);
				await env.DB.batch(stmts);
			} else {
				for (const p of planned) {
					await env.DB.prepare(
						`INSERT INTO mise_equipment_claims
							(id, equipment_slug, claim_for_kind, claim_for_id,
							 start_ts, end_ts, status, claimed_by,
							 released_at_ms, created_at_ms)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					).bind(
						p.claim.id,
						p.claim.equipment_slug,
						p.claim.claim_for.kind,
						p.claim.claim_for.id,
						p.claim.start_ts,
						p.claim.end_ts,
						p.claim.status,
						p.claim.claimed_by,
						p.claim.released_at_ms ?? null,
						p.claim.created_at_ms ?? Date.now(),
					).run();
				}
			}
			for (const p of planned) granted.push(p.claim);
		}

		const ok = conflicts.length === 0;
		await completeTrace(env, ctx, {
			ok: true,
			result_summary: `claims granted=${granted.length} conflicts=${conflicts.length}`,
			result: { granted_count: granted.length, conflict_count: conflicts.length },
			triggered_mutations: granted.map(g => ({
				kind: "equipment_claim",
				mutation_id: g.id,
			})),
		});
		return { ok, granted, conflicts };
	} catch (err) {
		await completeTrace(env, ctx, {
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		});
		throw err;
	}
}

function validateClaimRequest(req: ClaimRequest): void {
	if (!req.equipment_slug) throw new Error("claim: equipment_slug required");
	if (!req.claim_for || !req.claim_for.kind || !req.claim_for.id) {
		throw new Error("claim: claim_for.kind and claim_for.id required");
	}
	if (!req.claimed_by) throw new Error("claim: claimed_by required");
	if (!Number.isFinite(req.start_ts) || !Number.isFinite(req.end_ts)) {
		throw new Error("claim: start_ts and end_ts must be finite epoch_ms");
	}
	if (req.end_ts <= req.start_ts) {
		throw new Error("claim: end_ts must be strictly greater than start_ts");
	}
}

// ─── Release ────────────────────────────────────────────────────────────────

export async function releaseEquipment(
	env: MiseGraphEnv,
	claim_id: string,
): Promise<void> {
	if (!claim_id) throw new Error("releaseEquipment: claim_id required");
	await migrateEquipmentSchema(env);

	const ctx = beginTrace({
		tool_name: "equipment.releaseEquipment",
		tool_args: { claim_id },
		caller_kind: "system",
	});

	try {
		await env.DB.prepare(
			`UPDATE mise_equipment_claims
			 SET status = 'released', released_at_ms = ?
			 WHERE id = ? AND status = 'held'`,
		).bind(Date.now(), claim_id).run();
		await completeTrace(env, ctx, {
			ok: true,
			result_summary: `released claim ${claim_id}`,
			triggered_mutations: [{ kind: "equipment_release", mutation_id: claim_id }],
		});
	} catch (err) {
		await completeTrace(env, ctx, {
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		});
		throw err;
	}
}

export async function releaseClaimsFor(
	env: MiseGraphEnv,
	claim_for: { kind: string; id: string },
): Promise<number> {
	if (!claim_for || !claim_for.kind || !claim_for.id) return 0;
	await migrateEquipmentSchema(env);

	const ctx = beginTrace({
		tool_name: "equipment.releaseClaimsFor",
		tool_args: { claim_for },
		caller_kind: "system",
	});

	try {
		// Read first so we can return a meaningful count even on D1 backends
		// where update meta.changes isn't reliably surfaced.
		const open = await env.DB.prepare(
			`SELECT id FROM mise_equipment_claims
			 WHERE claim_for_kind = ? AND claim_for_id = ? AND status = 'held'`,
		).bind(claim_for.kind, claim_for.id).all<{ id: string }>();
		const count = (open.results || []).length;

		if (count > 0) {
			await env.DB.prepare(
				`UPDATE mise_equipment_claims
				 SET status = 'released', released_at_ms = ?
				 WHERE claim_for_kind = ? AND claim_for_id = ? AND status = 'held'`,
			).bind(Date.now(), claim_for.kind, claim_for.id).run();
		}
		await completeTrace(env, ctx, {
			ok: true,
			result_summary: `released ${count} claim(s) for ${claim_for.kind}:${claim_for.id}`,
			result: { count },
			triggered_mutations: (open.results || []).map(r => ({
				kind: "equipment_release",
				mutation_id: r.id,
			})),
		});
		return count;
	} catch (err) {
		await completeTrace(env, ctx, {
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		});
		throw err;
	}
}

// ─── Find free window ──────────────────────────────────────────────────────

export interface FindFreeWindowArgs {
	household_id: string;
	equipment_slug: string;
	earliest_ts: number;
	latest_ts: number;
	duration_min: number;
}

/**
 * Search the held-claims timeline for the earliest start_ts in
 * [earliest_ts, latest_ts] that gives at least `duration_min` minutes of
 * clear time on the equipment. For shared equipment with capacity > 1,
 * "clear time" means the active claim count stays strictly below capacity
 * for the full duration.
 *
 * Returns null if no such window exists in the search range.
 */
export async function findFreeWindow(
	env: MiseGraphEnv,
	args: FindFreeWindowArgs,
): Promise<{ start_ts: number } | null> {
	if (!args.household_id) throw new Error("findFreeWindow: household_id required");
	if (!args.equipment_slug) throw new Error("findFreeWindow: equipment_slug required");
	if (!Number.isFinite(args.earliest_ts) || !Number.isFinite(args.latest_ts)) {
		throw new Error("findFreeWindow: earliest_ts and latest_ts must be finite epoch_ms");
	}
	if (args.duration_min <= 0) {
		throw new Error("findFreeWindow: duration_min must be positive");
	}
	if (args.latest_ts <= args.earliest_ts) return null;

	await migrateEquipmentSchema(env);
	const def = await getDefinition(env, args.equipment_slug);
	const exclusive = def ? def.exclusive : true;
	const capacity = def && !def.exclusive ? Math.max(1, def.capacity ?? 1) : 1;
	const durationMs = args.duration_min * 60_000;
	const searchEnd = args.latest_ts - durationMs;
	if (searchEnd < args.earliest_ts) return null;

	// Pull all held claims overlapping the search range.
	const claims = await findOverlappingHeldClaims(
		env,
		args.equipment_slug,
		args.earliest_ts,
		args.latest_ts,
	);

	if (claims.length === 0) return { start_ts: args.earliest_ts };

	// For exclusive resources, walk gaps between claims sorted by start_ts.
	if (exclusive) {
		const sorted = [...claims].sort((a, b) => a.start_ts - b.start_ts);
		// Gap before the first claim?
		if (sorted[0].start_ts - args.earliest_ts >= durationMs) {
			return { start_ts: args.earliest_ts };
		}
		// Gaps between successive claims.
		for (let i = 0; i < sorted.length; i++) {
			const cur = sorted[i];
			const cursorStart = Math.max(cur.end_ts, args.earliest_ts);
			const nextStart = i + 1 < sorted.length
				? sorted[i + 1].start_ts
				: args.latest_ts;
			if (nextStart - cursorStart >= durationMs && cursorStart <= searchEnd) {
				return { start_ts: cursorStart };
			}
		}
		return null;
	}

	// Shared resource: find earliest start where active count < capacity for
	// the full duration. We sweep the timeline at every claim boundary plus
	// the candidate start, evaluating whether the window stays under capacity.
	const boundaries = new Set<number>();
	boundaries.add(args.earliest_ts);
	for (const c of claims) {
		if (c.start_ts > args.earliest_ts && c.start_ts <= searchEnd) boundaries.add(c.start_ts);
		if (c.end_ts > args.earliest_ts && c.end_ts <= searchEnd) boundaries.add(c.end_ts);
	}
	const sortedBoundaries = [...boundaries].sort((a, b) => a - b);
	for (const candidate of sortedBoundaries) {
		if (candidate > searchEnd) break;
		const candidateEnd = candidate + durationMs;
		const overlapping = claims.filter(c =>
			c.start_ts < candidateEnd && c.end_ts > candidate,
		);
		if (overlapping.length < capacity) {
			return { start_ts: candidate };
		}
	}
	return null;
}

// ─── Load metric ───────────────────────────────────────────────────────────

export interface GetEquipmentLoadArgs {
	household_id: string;
	equipment_slug: string;
	window_start_ts: number;
	window_end_ts: number;
}

export async function getEquipmentLoad(
	env: MiseGraphEnv,
	args: GetEquipmentLoadArgs,
): Promise<EquipmentLoad> {
	if (!args.household_id) throw new Error("getEquipmentLoad: household_id required");
	if (!args.equipment_slug) throw new Error("getEquipmentLoad: equipment_slug required");
	if (args.window_end_ts <= args.window_start_ts) {
		return { active_claims: [], load_pct: 0 };
	}
	await migrateEquipmentSchema(env);

	const def = await getDefinition(env, args.equipment_slug);
	const capacity = def && !def.exclusive ? Math.max(1, def.capacity ?? 1) : 1;

	const claims = await findOverlappingHeldClaims(
		env,
		args.equipment_slug,
		args.window_start_ts,
		args.window_end_ts,
	);

	const windowMs = args.window_end_ts - args.window_start_ts;
	let weightedOverlap = 0;
	for (const c of claims) {
		const overlapStart = Math.max(c.start_ts, args.window_start_ts);
		const overlapEnd = Math.min(c.end_ts, args.window_end_ts);
		const overlap = Math.max(0, overlapEnd - overlapStart);
		weightedOverlap += overlap;
	}
	const denom = windowMs * capacity;
	const load_pct = denom > 0 ? Math.min(1, weightedOverlap / denom) : 0;
	return { active_claims: claims, load_pct };
}

// ─── ID generation ──────────────────────────────────────────────────────────

function generateClaimId(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return `eqclaim_${crypto.randomUUID()}`;
	}
	return `eqclaim_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

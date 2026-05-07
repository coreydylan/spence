// FakeD1 implementations for the Wave 7B Track C scenarios (task graph +
// equipment). The shared mock-d1.ts is calibrated to household-memory's
// SQL grammar; equipment has range predicates, status filters, and
// batch() semantics it doesn't cover. Each fake here is targeted at the
// SQL surface its module actually issues — no general SQL emulator.

// ─── Task-graph fake ──────────────────────────────────────────────────────

interface TaskGraphRow {
	id: string;
	recipe_id: string;
	meal_id: string | null;
	tasks_json: string;
	critical_path_min: number;
	total_active_min: number;
	total_passive_min: number;
	parallelism_max: number;
	created_at_ms: number;
	updated_at_ms: number;
}

interface PersonalRecipeRow {
	id: string;
	normalized_title?: string | null;
	original_title?: string | null;
	canonical_ingredients_json?: string | null;
	raw_ingredients_text?: string | null;
	method_summary?: string | null;
	servings?: number | null;
	active_time_min?: number | null;
	total_time_min?: number | null;
}

interface AgentTraceRow {
	trace_id: string;
}

export class TaskGraphFakeD1 {
	taskGraphs = new Map<string, TaskGraphRow>();
	personalRecipes = new Map<string, PersonalRecipeRow>();
	agentTraces: AgentTraceRow[] = [];

	prepare(sql: string): TaskGraphFakeStatement {
		return new TaskGraphFakeStatement(this, sql);
	}

	seedRecipe(row: PersonalRecipeRow): void {
		this.personalRecipes.set(row.id, row);
	}
}

class TaskGraphFakeStatement {
	private bindings: unknown[] = [];

	constructor(private readonly db: TaskGraphFakeD1, private readonly sql: string) {}

	bind(...values: unknown[]): this {
		this.bindings = values;
		return this;
	}

	async run(): Promise<{ success: boolean; meta: { changes: number } }> {
		// Schema migrations no-op.
		if (/^\s*create\s+(?:unique\s+)?(table|index)/i.test(this.sql)) {
			return { success: true, meta: { changes: 0 } };
		}
		// Insert task graph.
		if (/INSERT\s+OR\s+REPLACE\s+INTO\s+mise_task_graphs/i.test(this.sql)) {
			const b = this.bindings;
			this.db.taskGraphs.set(String(b[0]), {
				id: String(b[0]),
				recipe_id: String(b[1]),
				meal_id: b[2] === null ? null : String(b[2]),
				tasks_json: String(b[3]),
				critical_path_min: Number(b[4]),
				total_active_min: Number(b[5]),
				total_passive_min: Number(b[6]),
				parallelism_max: Number(b[7]),
				created_at_ms: Number(b[8]),
				updated_at_ms: Number(b[9]),
			});
			return { success: true, meta: { changes: 1 } };
		}
		// Insert agent trace — capture trace_id only; we don't read these.
		if (/INSERT\s+INTO\s+mise_agent_traces/i.test(this.sql)) {
			this.db.agentTraces.push({ trace_id: String(this.bindings[0]) });
			return { success: true, meta: { changes: 1 } };
		}
		if (/INSERT\s+OR\s+REPLACE\s+INTO\s+mise_mutation_traces/i.test(this.sql)) {
			return { success: true, meta: { changes: 1 } };
		}
		throw new Error(`task-graph fake: unsupported run(): ${this.sql.slice(0, 80)}`);
	}

	async first<T = unknown>(): Promise<T | null> {
		// Recipe lookup.
		if (/FROM\s+personal_recipes/i.test(this.sql)) {
			const id = String(this.bindings[0]);
			const row = this.db.personalRecipes.get(id);
			return (row || null) as T | null;
		}
		// Task graph lookup by meal_id.
		if (/FROM\s+mise_task_graphs/i.test(this.sql)) {
			const meal_id = String(this.bindings[0]);
			for (const row of this.db.taskGraphs.values()) {
				if (row.meal_id === meal_id) return row as unknown as T;
			}
			return null;
		}
		return null;
	}

	async all<T = unknown>(): Promise<{ results: T[] }> {
		return { results: [] };
	}
}

// ─── Equipment fake ───────────────────────────────────────────────────────

interface EquipmentDefRow {
	slug: string;
	kind: string;
	household_id: string;
	exclusive: number;
	capacity: number | null;
	notes: string | null;
	created_at_ms: number;
}

interface EquipmentClaimRow {
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

export class EquipmentFakeD1 {
	definitions = new Map<string, EquipmentDefRow>();
	claims = new Map<string, EquipmentClaimRow>();
	agentTraces: AgentTraceRow[] = [];

	prepare(sql: string): EquipmentFakeStatement {
		return new EquipmentFakeStatement(this, sql);
	}

	async batch(stmts: EquipmentFakeStatement[]): Promise<Array<{ success: boolean }>> {
		// D1 batch is atomic — but in this fake we'll just sequentially run
		// the statements. The equipment.ts caller has already validated
		// conflicts, so a batch failure here would mean a code bug.
		const out: Array<{ success: boolean }> = [];
		for (const stmt of stmts) {
			await stmt.run();
			out.push({ success: true });
		}
		return out;
	}
}

class EquipmentFakeStatement {
	private bindings: unknown[] = [];

	constructor(private readonly db: EquipmentFakeD1, private readonly sql: string) {}

	bind(...values: unknown[]): this {
		this.bindings = values;
		return this;
	}

	async run(): Promise<{ success: boolean; meta: { changes: number } }> {
		if (/^\s*create\s+(?:unique\s+)?(table|index)/i.test(this.sql)) {
			return { success: true, meta: { changes: 0 } };
		}
		if (/INSERT\s+OR\s+REPLACE\s+INTO\s+mise_equipment_definitions/i.test(this.sql)) {
			const b = this.bindings;
			this.db.definitions.set(String(b[0]), {
				slug: String(b[0]),
				kind: String(b[1]),
				household_id: String(b[2]),
				exclusive: Number(b[3]),
				capacity: b[4] === null ? null : Number(b[4]),
				notes: b[5] === null ? null : String(b[5]),
				created_at_ms: Number(b[6]),
			});
			return { success: true, meta: { changes: 1 } };
		}
		if (/INSERT\s+INTO\s+mise_equipment_claims/i.test(this.sql)) {
			const b = this.bindings;
			this.db.claims.set(String(b[0]), {
				id: String(b[0]),
				equipment_slug: String(b[1]),
				claim_for_kind: String(b[2]),
				claim_for_id: String(b[3]),
				start_ts: Number(b[4]),
				end_ts: Number(b[5]),
				status: String(b[6]),
				claimed_by: String(b[7]),
				released_at_ms: b[8] === null || b[8] === undefined ? null : Number(b[8]),
				created_at_ms: Number(b[9]),
			});
			return { success: true, meta: { changes: 1 } };
		}
		// UPDATE single claim by id.
		if (/UPDATE\s+mise_equipment_claims\s+SET[\s\S]+WHERE\s+id\s*=\s*\?\s+AND\s+status\s*=\s*'held'/i.test(this.sql)) {
			const b = this.bindings;
			const released_at = Number(b[0]);
			const id = String(b[1]);
			const row = this.db.claims.get(id);
			let changes = 0;
			if (row && row.status === "held") {
				row.status = "released";
				row.released_at_ms = released_at;
				changes = 1;
			}
			return { success: true, meta: { changes } };
		}
		// UPDATE all claims for a claim_for kind/id.
		if (/UPDATE\s+mise_equipment_claims\s+SET[\s\S]+WHERE\s+claim_for_kind\s*=\s*\?\s+AND\s+claim_for_id\s*=\s*\?\s+AND\s+status\s*=\s*'held'/i.test(this.sql)) {
			const b = this.bindings;
			const released_at = Number(b[0]);
			const kind = String(b[1]);
			const id = String(b[2]);
			let changes = 0;
			for (const row of this.db.claims.values()) {
				if (row.claim_for_kind === kind && row.claim_for_id === id && row.status === "held") {
					row.status = "released";
					row.released_at_ms = released_at;
					changes++;
				}
			}
			return { success: true, meta: { changes } };
		}
		// Agent trace inserts (best-effort; we don't read them but they must not throw).
		if (/INSERT\s+INTO\s+mise_agent_traces/i.test(this.sql)) {
			this.db.agentTraces.push({ trace_id: String(this.bindings[0]) });
			return { success: true, meta: { changes: 1 } };
		}
		if (/INSERT\s+OR\s+REPLACE\s+INTO\s+mise_mutation_traces/i.test(this.sql)) {
			return { success: true, meta: { changes: 1 } };
		}
		throw new Error(`equipment fake: unsupported run(): ${this.sql.slice(0, 80)}`);
	}

	async first<T = unknown>(): Promise<T | null> {
		if (/FROM\s+mise_equipment_definitions/i.test(this.sql)) {
			const slug = String(this.bindings[0]);
			const row = this.db.definitions.get(slug);
			return (row || null) as T | null;
		}
		return null;
	}

	async all<T = unknown>(): Promise<{ results: T[] }> {
		// listEquipment: SELECT … WHERE household_id = ?
		if (/FROM\s+mise_equipment_definitions[\s\S]+WHERE\s+household_id\s*=\s*\?/i.test(this.sql)) {
			const hh = String(this.bindings[0]);
			const matched = [...this.db.definitions.values()]
				.filter(r => r.household_id === hh)
				.sort((a, b) => a.slug.localeCompare(b.slug));
			return { results: matched as unknown as T[] };
		}
		// findOverlappingHeldClaims: SELECT … WHERE equipment_slug=? AND status='held' AND start_ts < ? AND end_ts > ?
		if (/FROM\s+mise_equipment_claims[\s\S]+equipment_slug\s*=\s*\?[\s\S]+start_ts\s*<\s*\?[\s\S]+end_ts\s*>\s*\?/i.test(this.sql)) {
			const slug = String(this.bindings[0]);
			const upperEnd = Number(this.bindings[1]);   // bound for start_ts < ?
			const lowerStart = Number(this.bindings[2]); // bound for end_ts > ?
			const matched = [...this.db.claims.values()]
				.filter(r =>
					r.equipment_slug === slug &&
					r.status === "held" &&
					r.start_ts < upperEnd &&
					r.end_ts > lowerStart,
				)
				.sort((a, b) => a.start_ts - b.start_ts);
			return { results: matched as unknown as T[] };
		}
		// releaseClaimsFor read-back: SELECT id FROM mise_equipment_claims WHERE claim_for_kind=? AND claim_for_id=? AND status='held'
		if (/FROM\s+mise_equipment_claims[\s\S]+claim_for_kind\s*=\s*\?[\s\S]+claim_for_id\s*=\s*\?[\s\S]+status\s*=\s*'held'/i.test(this.sql)) {
			const kind = String(this.bindings[0]);
			const id = String(this.bindings[1]);
			const matched = [...this.db.claims.values()]
				.filter(r => r.claim_for_kind === kind && r.claim_for_id === id && r.status === "held")
				.map(r => ({ id: r.id }));
			return { results: matched as unknown as T[] };
		}
		return { results: [] };
	}
}

// ─── Brigade (Wave 8) fake D1 ─────────────────────────────────────────────
//
// Backs the brigade scenarios — token grant/verify and event log inserts.
// Same dispatch shape as the equipment fake: prepare(sql).bind(...).run()
// or .first(). Rejects unknown SQL loudly so tests fail fast on a typo.

interface BrigadeTokenRow {
	token: string;
	cook_session_id: string;
	member_id: string;
	expires_at_ms: number;
	consumed_at_ms: number | null;
	created_at_ms: number;
}

interface BrigadeEventRow {
	id: string;
	cook_session_id: string;
	kind: string;
	member_id: string | null;
	payload_json: string | null;
	emitted_at_ms: number;
}

export class BrigadeFakeD1 {
	tokens = new Map<string, BrigadeTokenRow>();
	events: BrigadeEventRow[] = [];
	cook_sessions = new Map<string, Record<string, unknown>>();
	cookingLeadInits: Array<{ url: string; body: Record<string, unknown> }> = [];
	agentTraces: AgentTraceRow[] = [];

	prepare(sql: string): BrigadeFakeStatement {
		return new BrigadeFakeStatement(this, sql);
	}
}

class BrigadeFakeStatement {
	private bindings: unknown[] = [];

	constructor(private readonly db: BrigadeFakeD1, private readonly sql: string) {}

	bind(...values: unknown[]): this {
		this.bindings = values;
		return this;
	}

	async run(): Promise<{ success: boolean; meta: { changes: number } }> {
		if (/^\s*create\s+(?:unique\s+)?(table|index)/i.test(this.sql)) {
			return { success: true, meta: { changes: 0 } };
		}
		// Token insert. The grantToken SQL writes literal NULL for
		// consumed_at_ms (so it's NOT in the bindings array). Order:
		// token, cook_session_id, member_id, expires_at_ms, created_at_ms.
		if (/INSERT\s+INTO\s+mise_brigade_pending_tokens/i.test(this.sql)) {
			const b = this.bindings;
			const row: BrigadeTokenRow = {
				token: String(b[0]),
				cook_session_id: String(b[1]),
				member_id: String(b[2]),
				expires_at_ms: Number(b[3]),
				consumed_at_ms: null,
				created_at_ms: Number(b[4]),
			};
			this.db.tokens.set(row.token, row);
			return { success: true, meta: { changes: 1 } };
		}
		// Token consume — UPDATE … SET consumed_at_ms=? WHERE token=? AND consumed_at_ms IS NULL.
		if (/UPDATE\s+mise_brigade_pending_tokens[\s\S]+consumed_at_ms\s+IS\s+NULL/i.test(this.sql)) {
			const b = this.bindings;
			const consumed = Number(b[0]);
			const token = String(b[1]);
			const row = this.db.tokens.get(token);
			if (row && row.consumed_at_ms === null) {
				row.consumed_at_ms = consumed;
				return { success: true, meta: { changes: 1 } };
			}
			return { success: true, meta: { changes: 0 } };
		}
		// Event insert.
		if (/INSERT\s+INTO\s+mise_brigade_events/i.test(this.sql)) {
			const b = this.bindings;
			this.db.events.push({
				id: String(b[0]),
				cook_session_id: String(b[1]),
				kind: String(b[2]),
				member_id: b[3] === null || b[3] === undefined ? null : String(b[3]),
				payload_json: b[4] === null || b[4] === undefined ? null : String(b[4]),
				emitted_at_ms: Number(b[5]),
			});
			return { success: true, meta: { changes: 1 } };
		}
		// Cook session insert (for u59 scenario; minimal coverage).
		if (/INSERT\s+INTO\s+mise_cook_sessions/i.test(this.sql)) {
			const b = this.bindings;
			this.db.cook_sessions.set(String(b[0]), {
				cook_session_id: b[0],
				household_id: b[1],
				plan_id: b[2],
				meal_id: b[3],
				state: b[4],
				started_at: b[5],
				stale_at: b[6],
				ended_at: b[7],
				ended_reason: b[8],
				meta_json: b[9],
			});
			return { success: true, meta: { changes: 1 } };
		}
		// Agent trace inserts.
		if (/INSERT\s+INTO\s+mise_agent_traces/i.test(this.sql)) {
			this.db.agentTraces.push({ trace_id: String(this.bindings[0]) });
			return { success: true, meta: { changes: 1 } };
		}
		if (/INSERT\s+OR\s+REPLACE\s+INTO\s+mise_mutation_traces/i.test(this.sql)) {
			return { success: true, meta: { changes: 1 } };
		}
		throw new Error(`brigade fake: unsupported run(): ${this.sql.slice(0, 80)}`);
	}

	async first<T = unknown>(): Promise<T | null> {
		// Token lookup by token.
		if (/FROM\s+mise_brigade_pending_tokens[\s\S]+WHERE\s+token\s*=\s*\?/i.test(this.sql)) {
			const token = String(this.bindings[0]);
			const row = this.db.tokens.get(token);
			return (row ? { ...row } : null) as T | null;
		}
		return null;
	}

	async all<T = unknown>(): Promise<{ results: T[] }> {
		// Events by cook_session_id ordered by emitted_at_ms ASC.
		if (/FROM\s+mise_brigade_events[\s\S]+WHERE\s+cook_session_id\s*=\s*\?/i.test(this.sql)) {
			const id = String(this.bindings[0]);
			const matched = this.db.events
				.filter(e => e.cook_session_id === id)
				.sort((a, b) => a.emitted_at_ms - b.emitted_at_ms);
			return { results: matched as unknown as T[] };
		}
		return { results: [] };
	}
}

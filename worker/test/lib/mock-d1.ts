// In-memory D1 shim for unit tests.
//
// Implements the slice of the D1Database / D1PreparedStatement API that the
// household-memory modules use: prepare/bind/run/first/all, plus a SQL
// engine that understands CREATE TABLE / CREATE INDEX (no-op), INSERT OR
// REPLACE, UPDATE … SET … WHERE …, and SELECT … FROM … WHERE … ORDER BY …
// LIMIT … with a small grammar of predicates (= ?, IS NULL, IS NOT NULL,
// >= ?, <= ?, AND chains, OR chains for tri-state booleans).
//
// This is NOT a general-purpose SQLite emulator. It's a deterministic
// in-memory store calibrated to the queries household-model.ts,
// conversation-threads.ts, and kitchen-inventory.ts actually issue.
// If a query hits a path the engine doesn't understand it throws so the
// test fails loudly rather than silently mis-routing.

export interface MockD1 {
	prepare(sql: string): MockD1Statement;
	__tables(): Map<string, MockTable>;
}

export interface MockD1Statement {
	bind(...values: unknown[]): MockD1Statement;
	first<T = unknown>(): Promise<T | null>;
	run(): Promise<{ success: boolean; meta: { changes: number } }>;
	all<T = unknown>(): Promise<{ results: T[] }>;
}

interface MockTable {
	name: string;
	columns: string[];
	primaryKey: string[];
	rows: Map<string, Record<string, unknown>>;  // pk-string → row
	insertion_order: string[];                   // pk-string in insertion order
}

export function createMockD1(): MockD1 {
	const tables = new Map<string, MockTable>();

	function statement(sql: string): MockD1Statement {
		const cleaned = sql.replace(/\s+/g, " ").trim();
		let bindings: unknown[] = [];
		const stmt: MockD1Statement = {
			bind(...values: unknown[]) {
				bindings = values;
				return stmt;
			},
			async first<T>(): Promise<T | null> {
				const rows = executeSelect(tables, cleaned, bindings, { limit: 1 });
				return (rows[0] as T) ?? null;
			},
			async run() {
				const changes = executeMutation(tables, cleaned, bindings);
				return { success: true, meta: { changes } };
			},
			async all<T>() {
				const rows = executeSelect(tables, cleaned, bindings);
				return { results: rows as T[] };
			},
		};
		return stmt;
	}

	return {
		prepare: statement,
		__tables: () => tables,
	};
}

// ---------- mutation paths (CREATE / INSERT OR REPLACE / UPDATE) ----------

function executeMutation(
	tables: Map<string, MockTable>,
	sql: string,
	bindings: unknown[],
): number {
	const lower = sql.toLowerCase();

	if (/^create\s+(unique\s+)?index/.test(lower)) {
		return 0;
	}

	// ALTER TABLE … ADD COLUMN — append a new column to the table. Throw
	// "duplicate column name" so callers using try/catch for idempotency
	// behave like real D1.
	if (/^alter\s+table\s+/i.test(sql)) {
		const m = /^alter\s+table\s+([a-z_][a-z0-9_]*)\s+add\s+(?:column\s+)?([a-z_][a-z0-9_]*)\b[\s\S]*$/i.exec(sql);
		if (!m) throw new Error(`mock-d1: cannot parse ALTER TABLE: ${sql}`);
		const tableName = m[1];
		const columnName = m[2];
		const table = tables.get(tableName);
		if (!table) throw new Error(`mock-d1: ALTER TABLE references unknown table ${tableName}`);
		if (table.columns.includes(columnName)) {
			throw new Error(`duplicate column name: ${columnName}`);
		}
		table.columns.push(columnName);
		// Existing rows pick up the new column lazily (undefined) — same as
		// SQLite's behavior with no DEFAULT clause.
		return 0;
	}

	if (/^create\s+table/.test(lower)) {
		const tableMatch = /create\s+table\s+(?:if\s+not\s+exists\s+)?([a-z_][a-z0-9_]*)\s*\(([\s\S]+)\)\s*$/i.exec(sql);
		if (!tableMatch) throw new Error(`mock-d1: cannot parse CREATE TABLE: ${sql}`);
		const tableName = tableMatch[1];
		if (tables.has(tableName)) return 0;
		const cols = parseCreateTableColumns(tableMatch[2]);
		tables.set(tableName, {
			name: tableName,
			columns: cols.columns,
			primaryKey: cols.primaryKey,
			rows: new Map(),
			insertion_order: [],
		});
		return 0;
	}

	if (/^insert\s+or\s+replace\s+into/i.test(sql)) {
		const m = /^insert\s+or\s+replace\s+into\s+([a-z_][a-z0-9_]*)\s*\(([^)]+)\)\s*values\s*\(([^)]+)\)\s*$/i.exec(sql);
		if (!m) throw new Error(`mock-d1: cannot parse INSERT OR REPLACE: ${sql}`);
		const tableName = m[1];
		const columns = m[2].split(",").map(c => c.trim());
		const placeholders = m[3].split(",").map(p => p.trim());
		if (placeholders.length !== bindings.length) {
			throw new Error(`mock-d1: binding count mismatch for ${tableName}: ${placeholders.length} vs ${bindings.length}`);
		}
		const table = tables.get(tableName);
		if (!table) throw new Error(`mock-d1: unknown table ${tableName}`);
		const row: Record<string, unknown> = {};
		for (let i = 0; i < columns.length; i++) row[columns[i]] = bindings[i];
		const pkKey = makePkKey(table, row);
		const existed = table.rows.has(pkKey);
		table.rows.set(pkKey, row);
		if (!existed) table.insertion_order.push(pkKey);
		return 1;
	}

	// INSERT INTO ... ON CONFLICT(...) DO UPDATE SET ... — D1 upsert form.
	// We support `datetime('now')` literals in the VALUES tuple and in the
	// SET assignments; placeholders bind against the bindings array. The
	// VALUES tuple supports nested parens (e.g. `datetime('now')`), so we
	// use depth-aware extraction rather than a flat `[^)]+` match.
	if (/^insert\s+into\s+[a-z_][a-z0-9_]*\b[\s\S]+\bon\s+conflict\b/i.test(sql)) {
		const upsert = parseInsertOnConflict(sql);
		if (!upsert) throw new Error(`mock-d1: cannot parse INSERT…ON CONFLICT: ${sql}`);
		const { tableName, columns, valueExprs, setClause } = upsert;
		const table = tables.get(tableName);
		if (!table) throw new Error(`mock-d1: unknown table ${tableName}`);

		// Resolve the incoming row (placeholders + datetime('now') literals).
		const incomingRow: Record<string, unknown> = {};
		const nowIso = new Date().toISOString().replace("T", " ").slice(0, 19);
		let bindCursor = 0;
		for (let i = 0; i < columns.length; i++) {
			const expr = valueExprs[i];
			if (expr === "?") {
				incomingRow[columns[i]] = bindings[bindCursor++];
			} else if (/^datetime\s*\(\s*'now'\s*\)$/i.test(expr)) {
				incomingRow[columns[i]] = nowIso;
			} else {
				throw new Error(`mock-d1: unsupported VALUE expression in INSERT…ON CONFLICT: ${expr}`);
			}
		}

		const pkKey = makePkKey(table, incomingRow);
		const existing = table.rows.get(pkKey);
		if (!existing) {
			table.rows.set(pkKey, incomingRow);
			table.insertion_order.push(pkKey);
			return 1;
		}

		// Apply DO UPDATE SET clause to the existing row.
		const assignments = splitTopLevelCommas(setClause);
		for (const raw of assignments) {
			const piece = raw.trim();
			const excludedMatch = /^([a-z_][a-z0-9_]*)\s*=\s*excluded\.([a-z_][a-z0-9_]*)$/i.exec(piece);
			if (excludedMatch) {
				existing[excludedMatch[1]] = incomingRow[excludedMatch[2]];
				continue;
			}
			const dtMatch = /^([a-z_][a-z0-9_]*)\s*=\s*datetime\s*\(\s*'now'\s*\)$/i.exec(piece);
			if (dtMatch) {
				existing[dtMatch[1]] = nowIso;
				continue;
			}
			const literalMatch = /^([a-z_][a-z0-9_]*)\s*=\s*'([^']*)'$/i.exec(piece);
			if (literalMatch) {
				existing[literalMatch[1]] = literalMatch[2];
				continue;
			}
			const bindMatch = /^([a-z_][a-z0-9_]*)\s*=\s*\?$/i.exec(piece);
			if (bindMatch) {
				existing[bindMatch[1]] = bindings[bindCursor++];
				continue;
			}
			throw new Error(`mock-d1: unsupported ON CONFLICT SET assignment: ${piece}`);
		}
		return 1;
	}

	if (/^delete\s+from\s+/i.test(sql)) {
		const m = /^delete\s+from\s+([a-z_][a-z0-9_]*)(?:\s+where\s+([\s\S]+))?\s*$/i.exec(sql);
		if (!m) throw new Error(`mock-d1: cannot parse DELETE: ${sql}`);
		const tableName = m[1];
		const whereClause = m[2];
		const table = tables.get(tableName);
		if (!table) return 0;
		const whereFn = whereClause ? compileWhere(whereClause, bindings) : (_: Record<string, unknown>) => true;
		let changes = 0;
		const survivors: string[] = [];
		for (const pk of table.insertion_order) {
			const row = table.rows.get(pk);
			if (!row) continue;
			if (whereFn(row)) {
				table.rows.delete(pk);
				changes++;
			} else {
				survivors.push(pk);
			}
		}
		table.insertion_order = survivors;
		return changes;
	}

	if (/^update\s+/i.test(sql)) {
		const m = /^update\s+([a-z_][a-z0-9_]*)\s+set\s+([\s\S]+?)\s+where\s+([\s\S]+)$/i.exec(sql);
		if (!m) throw new Error(`mock-d1: cannot parse UPDATE: ${sql}`);
		const tableName = m[1];
		const setClause = m[2];
		const whereClause = m[3];
		const table = tables.get(tableName);
		if (!table) throw new Error(`mock-d1: unknown table ${tableName}`);

		const setAssignments = parseSetClause(setClause);
		const setBindings = bindings.slice(0, setAssignments.placeholderCount);
		const whereBindings = bindings.slice(setAssignments.placeholderCount);
		const whereFn = compileWhere(whereClause, whereBindings);

		let changes = 0;
		for (const row of table.rows.values()) {
			if (!whereFn(row)) continue;
			let bindCursor = 0;
			for (const assign of setAssignments.assignments) {
				if (assign.kind === "bind") {
					row[assign.column] = setBindings[bindCursor++];
				} else if (assign.kind === "coalesce_bind") {
					const incoming = setBindings[bindCursor++];
					const current = row[assign.column];
					if (current === null || current === undefined) row[assign.column] = incoming;
				} else if (assign.kind === "coalesce_literal") {
					const current = row[assign.column];
					if (current === null || current === undefined) row[assign.column] = assign.literal;
				}
			}
			changes++;
		}
		return changes;
	}

	throw new Error(`mock-d1: unsupported mutation: ${sql}`);
}

interface ParsedAssignment {
	kind: "bind" | "coalesce_bind" | "coalesce_literal";
	column: string;
	literal?: unknown;
}

function parseSetClause(clause: string): {
	assignments: ParsedAssignment[];
	placeholderCount: number;
} {
	// Split on commas at top level (assignments don't have nested parens beyond COALESCE).
	const pieces = splitTopLevelCommas(clause);
	const assignments: ParsedAssignment[] = [];
	let placeholderCount = 0;
	for (const raw of pieces) {
		const piece = raw.trim();
		const coalesceLiteralMatch = /^([a-z_][a-z0-9_]*)\s*=\s*coalesce\s*\(\s*[a-z_][a-z0-9_]*\s*,\s*'([^']*)'\s*\)$/i.exec(piece);
		if (coalesceLiteralMatch) {
			assignments.push({
				kind: "coalesce_literal",
				column: coalesceLiteralMatch[1],
				literal: coalesceLiteralMatch[2],
			});
			continue;
		}
		const coalesceMatch = /^([a-z_][a-z0-9_]*)\s*=\s*coalesce\s*\(\s*[a-z_][a-z0-9_]*\s*,\s*\?\s*\)$/i.exec(piece);
		if (coalesceMatch) {
			assignments.push({ kind: "coalesce_bind", column: coalesceMatch[1] });
			placeholderCount++;
			continue;
		}
		const bindMatch = /^([a-z_][a-z0-9_]*)\s*=\s*\?$/i.exec(piece);
		if (bindMatch) {
			assignments.push({ kind: "bind", column: bindMatch[1] });
			placeholderCount++;
			continue;
		}
		throw new Error(`mock-d1: unsupported SET assignment: ${piece}`);
	}
	return { assignments, placeholderCount };
}

interface ParsedInsertOnConflict {
	tableName: string;
	columns: string[];
	valueExprs: string[];
	setClause: string;
}

function parseInsertOnConflict(sql: string): ParsedInsertOnConflict | null {
	// 1. Match `INSERT INTO <table> (`.
	const tableMatch = /^insert\s+into\s+([a-z_][a-z0-9_]*)\s*\(/i.exec(sql);
	if (!tableMatch) return null;
	const tableName = tableMatch[1];
	const colsStart = tableMatch[0].length;
	const colsEnd = matchClosingParen(sql, colsStart - 1);
	if (colsEnd < 0) return null;
	const columns = sql.slice(colsStart, colsEnd).split(",").map(c => c.trim());

	// 2. Skip whitespace, expect VALUES (
	const afterCols = sql.slice(colsEnd + 1);
	const valuesMatch = /^\s*values\s*\(/i.exec(afterCols);
	if (!valuesMatch) return null;
	const valuesStart = colsEnd + 1 + valuesMatch[0].length;
	const valuesEnd = matchClosingParen(sql, valuesStart - 1);
	if (valuesEnd < 0) return null;
	const valueExprs = splitTopLevelCommas(sql.slice(valuesStart, valuesEnd)).map(p => p.trim());

	// 3. Expect ON CONFLICT (...) DO UPDATE SET <clause>.
	const tail = sql.slice(valuesEnd + 1);
	const conflictMatch = /^\s*on\s+conflict\s*\(([^)]+)\)\s+do\s+update\s+set\s+([\s\S]+)$/i.exec(tail);
	if (!conflictMatch) return null;
	const setClause = conflictMatch[2].trim();
	return { tableName, columns, valueExprs, setClause };
}

function matchClosingParen(s: string, openIdx: number): number {
	if (s[openIdx] !== "(") return -1;
	let depth = 1;
	let inString = false;
	for (let i = openIdx + 1; i < s.length; i++) {
		const ch = s[i];
		if (inString) {
			if (ch === "'" && s[i + 1] === "'") { i++; continue; }
			if (ch === "'") inString = false;
			continue;
		}
		if (ch === "'") { inString = true; continue; }
		if (ch === "(") depth++;
		else if (ch === ")") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

function splitTopLevelCommas(input: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < input.length; i++) {
		const ch = input[i];
		if (ch === "(") depth++;
		else if (ch === ")") depth--;
		else if (ch === "," && depth === 0) {
			out.push(input.slice(start, i));
			start = i + 1;
		}
	}
	out.push(input.slice(start));
	return out;
}

// ---------- SELECT ----------

function executeSelect(
	tables: Map<string, MockTable>,
	sql: string,
	bindings: unknown[],
	opts: { limit?: number } = {},
): Record<string, unknown>[] {
	const m = /^select\s+([\s\S]+?)\s+from\s+([a-z_][a-z0-9_]*)(?:\s+where\s+([\s\S]+?))?(?:\s+order\s+by\s+([\s\S]+?))?(?:\s+limit\s+(\?|\d+))?\s*$/i.exec(sql);
	if (!m) throw new Error(`mock-d1: cannot parse SELECT: ${sql}`);
	const selectClause = m[1].trim();
	const tableName = m[2];
	const whereClause = m[3];
	const orderClause = m[4];
	const limitClause = m[5];

	const table = tables.get(tableName);
	if (!table) return [];

	let bindCursor = 0;
	const whereBindings: unknown[] = [];
	if (whereClause) {
		const placeholderCount = (whereClause.match(/\?/g) || []).length;
		for (let i = 0; i < placeholderCount; i++) whereBindings.push(bindings[bindCursor++]);
	}
	let limit = opts.limit;
	if (limitClause === "?") {
		limit = Number(bindings[bindCursor++]);
	} else if (limitClause) {
		limit = Number(limitClause);
	}
	const whereFn = whereClause ? compileWhere(whereClause, whereBindings) : (_: Record<string, unknown>) => true;

	let rows: Record<string, unknown>[] = [];
	for (const pk of table.insertion_order) {
		const row = table.rows.get(pk);
		if (!row) continue;
		if (whereFn(row)) rows.push(row);
	}

	if (orderClause) {
		rows = applyOrderBy(rows, orderClause);
	}
	if (typeof limit === "number" && Number.isFinite(limit) && limit >= 0) {
		rows = rows.slice(0, limit);
	}

	if (selectClause === "*") {
		return rows.map(r => ({ ...r }));
	}
	const cols = selectClause.split(",").map(c => c.trim());
	return rows.map(r => {
		const out: Record<string, unknown> = {};
		for (const c of cols) out[c] = r[c];
		return out;
	});
}

// ---------- WHERE compilation ----------

type WhereFn = (row: Record<string, unknown>) => boolean;

interface WhereCtx {
	bindings: unknown[];
	cursor: number;
}

function compileWhere(clause: string, bindings: unknown[]): WhereFn {
	const ctx: WhereCtx = { bindings, cursor: 0 };
	return compileExpr(clause.trim(), ctx);
}

function compileExpr(input: string, ctx: WhereCtx): WhereFn {
	// Top-level AND splitting (we don't handle OR at top level except in
	// parenthesized groups for tri-state booleans).
	const parts = splitTopLevelKeyword(input, "and");
	const fns = parts.map(part => compileTerm(part.trim(), ctx));
	return row => fns.every(fn => fn(row));
}

function compileTerm(input: string, ctx: WhereCtx): WhereFn {
	if (input.startsWith("(") && input.endsWith(")")) {
		const inner = input.slice(1, -1).trim();
		// Try OR-split inside parens.
		const orParts = splitTopLevelKeyword(inner, "or");
		if (orParts.length > 1) {
			const fns = orParts.map(p => compileTerm(p.trim(), ctx));
			return row => fns.some(fn => fn(row));
		}
		return compileExpr(inner, ctx);
	}

	// IS NULL / IS NOT NULL
	const isNullMatch = /^([a-z_][a-z0-9_]*)\s+is\s+(not\s+)?null$/i.exec(input);
	if (isNullMatch) {
		const col = isNullMatch[1];
		const negated = !!isNullMatch[2];
		return row => {
			const v = row[col];
			const isNull = v === null || v === undefined;
			return negated ? !isNull : isNull;
		};
	}

	// column OP ?  or column OP literal
	const opMatch = /^([a-z_][a-z0-9_]*)\s*(=|<>|!=|>=|<=|>|<)\s*(.+)$/i.exec(input);
	if (opMatch) {
		const col = opMatch[1];
		const op = opMatch[2];
		const rhs = opMatch[3].trim();
		const fetch = compileRhs(rhs, ctx);
		return row => {
			const a = row[col];
			const b = fetch();
			return compareOp(a, b, op);
		};
	}

	throw new Error(`mock-d1: unsupported WHERE term: ${input}`);
}

function compileRhs(rhs: string, ctx: WhereCtx): () => unknown {
	if (rhs === "?") {
		const idx = ctx.cursor++;
		return () => ctx.bindings[idx];
	}
	if (rhs.toLowerCase() === "true") return () => true;
	if (rhs.toLowerCase() === "false") return () => false;
	if (rhs.toLowerCase() === "null") return () => null;
	if (/^\d+$/.test(rhs)) {
		const n = Number(rhs);
		return () => n;
	}
	if (/^'.*'$/.test(rhs)) {
		const lit = rhs.slice(1, -1);
		return () => lit;
	}
	throw new Error(`mock-d1: unsupported RHS: ${rhs}`);
}

function compareOp(a: unknown, b: unknown, op: string): boolean {
	// SQL NULL handling: any comparison with NULL is FALSE.
	if (a === null || a === undefined || b === null || b === undefined) return false;
	if (typeof a === "boolean" || typeof b === "boolean") {
		const aN = a === true ? 1 : a === false ? 0 : Number(a);
		const bN = b === true ? 1 : b === false ? 0 : Number(b);
		return numericCompare(aN, bN, op);
	}
	if (typeof a === "number" && typeof b === "number") {
		return numericCompare(a, b, op);
	}
	const aS = String(a);
	const bS = String(b);
	switch (op) {
		case "=": return aS === bS;
		case "<>":
		case "!=": return aS !== bS;
		case ">": return aS > bS;
		case "<": return aS < bS;
		case ">=": return aS >= bS;
		case "<=": return aS <= bS;
	}
	return false;
}

function numericCompare(a: number, b: number, op: string): boolean {
	switch (op) {
		case "=": return a === b;
		case "<>":
		case "!=": return a !== b;
		case ">": return a > b;
		case "<": return a < b;
		case ">=": return a >= b;
		case "<=": return a <= b;
	}
	return false;
}

function splitTopLevelKeyword(input: string, keyword: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let start = 0;
	const lower = input.toLowerCase();
	const kw = keyword.toLowerCase();
	const len = kw.length;
	for (let i = 0; i < input.length; i++) {
		const ch = input[i];
		if (ch === "(") depth++;
		else if (ch === ")") depth--;
		if (depth === 0) {
			// Match word boundary on both sides.
			if (
				lower.slice(i, i + len) === kw &&
				(i === 0 || /\s/.test(input[i - 1])) &&
				(i + len === input.length || /\s/.test(input[i + len]))
			) {
				out.push(input.slice(start, i));
				start = i + len;
				i = start - 1;
			}
		}
	}
	out.push(input.slice(start));
	return out.filter(s => s.trim().length > 0);
}

// ---------- ORDER BY ----------

function applyOrderBy(rows: Record<string, unknown>[], clause: string): Record<string, unknown>[] {
	const specs = clause.split(",").map(s => parseOrderSpec(s.trim()));
	const copy = [...rows];
	copy.sort((a, b) => {
		for (const spec of specs) {
			const av = spec.eval(a);
			const bv = spec.eval(b);
			const cmp = compareForSort(av, bv);
			if (cmp !== 0) return spec.descending ? -cmp : cmp;
		}
		return 0;
	});
	return copy;
}

interface OrderSpec {
	eval: (row: Record<string, unknown>) => unknown;
	descending: boolean;
}

function parseOrderSpec(spec: string): OrderSpec {
	let descending = false;
	let body = spec;
	if (/\s+desc$/i.test(body)) { descending = true; body = body.replace(/\s+desc$/i, ""); }
	else if (/\s+asc$/i.test(body)) { body = body.replace(/\s+asc$/i, ""); }
	body = body.trim();

	// (column IS NULL) → 0 if not null, 1 if null (so NULLs sort last by default).
	const isNullMatch = /^\(\s*([a-z_][a-z0-9_]*)\s+is\s+null\s*\)$/i.exec(body);
	if (isNullMatch) {
		const col = isNullMatch[1];
		return {
			eval: row => (row[col] === null || row[col] === undefined ? 1 : 0),
			descending,
		};
	}
	if (/^[a-z_][a-z0-9_]*$/i.test(body)) {
		const col = body;
		return { eval: row => row[col], descending };
	}
	throw new Error(`mock-d1: unsupported ORDER BY spec: ${spec}`);
}

function compareForSort(a: unknown, b: unknown): number {
	if (a === b) return 0;
	if (a === null || a === undefined) return 1;
	if (b === null || b === undefined) return -1;
	if (typeof a === "number" && typeof b === "number") {
		return a < b ? -1 : a > b ? 1 : 0;
	}
	const aS = String(a);
	const bS = String(b);
	if (aS < bS) return -1;
	if (aS > bS) return 1;
	return 0;
}

// ---------- CREATE TABLE column parsing ----------

function parseCreateTableColumns(body: string): { columns: string[]; primaryKey: string[] } {
	const pieces = splitTopLevelCommas(body);
	const columns: string[] = [];
	let primaryKey: string[] = [];
	for (const raw of pieces) {
		const piece = raw.trim();
		const lower = piece.toLowerCase();
		if (lower.startsWith("primary key")) {
			const pkMatch = /\(([^)]+)\)/.exec(piece);
			if (pkMatch) {
				primaryKey = pkMatch[1].split(",").map(c => c.trim());
			}
			continue;
		}
		const colNameMatch = /^([a-z_][a-z0-9_]*)\b/i.exec(piece);
		if (colNameMatch) {
			const col = colNameMatch[1];
			columns.push(col);
			if (/primary\s+key/i.test(piece)) {
				primaryKey = [col];
			}
		}
	}
	if (primaryKey.length === 0 && columns.length > 0) {
		primaryKey = [columns[0]];
	}
	return { columns, primaryKey };
}

function makePkKey(table: MockTable, row: Record<string, unknown>): string {
	return table.primaryKey.map(c => `${c}=${stringifyKey(row[c])}`).join("|");
}

function stringifyKey(v: unknown): string {
	if (v === null || v === undefined) return "<null>";
	return String(v);
}

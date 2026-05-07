// Code Mode for the chef agent.
//
// Replaces the per-call [[TOOL_CALL]]/[[TOOL_RESULT]] envelope dance with
// Cloudflare's "Code Mode for MCP" pattern:
//   - mcp_search(query)  → look up tool name/description/schema by keyword
//   - mcp_execute(code)  → run JavaScript that calls our MCP tools via a
//                          builtin `mcp(name, args)` function
//
// Why: with 100+ tools in the catalog, listing every name+description+schema
// in the system prompt costs ~50K tokens. Cloudflare's own benchmark showed
// roughly a 1000× reduction by exposing JS+search+execute instead. The model
// is *already* fluent in JS, so the protocol is "just write code"; chains of
// calls happen in one isolate run instead of N round-trips.
//
// Sandbox: this is a SOFT sandbox (AsyncFunction constructor + closure-only
// access to the `mcp` builtin). The LLM can't see env, can't open sockets,
// can't reach D1 directly — those bindings are not exposed to the closure.
// It can in principle read globals (Date, JSON, crypto, fetch). For this
// route we trust Claude not to actively crash the worker, and we cap the
// blast radius with three controls:
//   1. timeout_ms (default 30s) wraps the whole run in Promise.race
//   2. max_tool_calls (default 12) caps how many mcp() invocations one
//      execute() can make
//   3. CHEF_ALLOWED_TOOLS stays the gate — Claude can't call anything that
//      isn't on the allow-list, even via Code Mode
//
// The dispatcher inside is `callPlanWorldTool` from plan-world-mcp.ts, the
// same in-process function the worker uses for direct chef tool calls and
// for the `/mcp/plan-world` HTTP endpoint. Code Mode is a different protocol
// front end onto the SAME tool surface — no behavior change downstream.

import {
	callPlanWorldTool,
	PLAN_WORLD_TOOLS,
} from "./plan-world-mcp";
import type { MiseGraphEnv } from "./types";

// ─── Types ────────────────────────────────────────────────────────────────

export interface CodeModeContext {
	household_id: string;
	/** Optional plan id to auto-inject if a tool requires it and none was passed. */
	plan_id?: string;
	/** Trace propagation — every tool call in the audit chain. */
	caller_kind: "agent";
	caller_id: string;
}

export interface ToolDescriptor {
	name: string;
	description: string;
	args_schema: Record<string, unknown>;
}

export interface SearchResult {
	matches: ToolDescriptor[];
}

export interface ToolCallTrace {
	name: string;
	args: Record<string, unknown>;
	result: unknown;
	duration_ms: number;
	error?: string;
}

export interface ExecuteResult {
	ok: boolean;
	/** Whatever the user code returned (if any). May be `undefined`. */
	return_value?: unknown;
	/** Each mcp() call made during the run + its result. */
	tool_calls: ToolCallTrace[];
	/** console.log output from inside the sandbox. */
	logs: string[];
	/** Set when the JS code throws or the sandbox aborts (timeout / cap). */
	error?: { message: string; stack?: string };
	/** Wall-clock time for the whole execute() call. */
	duration_ms: number;
}

export interface ExecuteOptions {
	timeout_ms?: number;
	max_tool_calls?: number;
	/** Test seam: replace callPlanWorldTool. */
	dispatcher?: typeof callPlanWorldTool;
	/** Subset of tools allowed; defaults to *all* PLAN_WORLD_TOOLS. */
	allowed_tools?: ReadonlySet<string>;
	/** Per-result truncation budget (chars). Mirrors stringifyToolResult. */
	result_truncation_chars?: number;
}

// ─── Defaults ─────────────────────────────────────────────────────────────

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_TOOL_CALLS = 12;
export const DEFAULT_RESULT_TRUNCATION = 3000;
export const DEFAULT_SEARCH_LIMIT = 20;
export const DEFAULT_DESCRIPTION_PREVIEW = 200;

// ─── Tool catalog adapter ─────────────────────────────────────────────────

interface CatalogEntry {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

function readCatalog(): CatalogEntry[] {
	const out: CatalogEntry[] = [];
	for (const raw of PLAN_WORLD_TOOLS as unknown as Array<Record<string, unknown>>) {
		const name = typeof raw.name === "string" ? raw.name : "";
		const description = typeof raw.description === "string" ? raw.description : "";
		const inputSchema =
			raw.inputSchema && typeof raw.inputSchema === "object"
				? (raw.inputSchema as Record<string, unknown>)
				: {};
		if (!name) continue;
		out.push({ name, description, inputSchema });
	}
	return out;
}

function findSchema(name: string): CatalogEntry | null {
	for (const entry of readCatalog()) {
		if (entry.name === name) return entry;
	}
	return null;
}

// ─── searchTools(query) ───────────────────────────────────────────────────

/**
 * Filter the full plan-world tool catalog by a keyword query. Matches
 * substrings on the tool name AND description (case-insensitive). Returns
 * up to `limit` matches with each description trimmed to a preview length so
 * the LLM sees enough to pick a tool but not the full schema verbosity.
 *
 * An empty/whitespace query returns the first `limit` tools — useful when
 * the model wants a quick "what's available" peek.
 */
export function searchTools(
	query: string,
	limit: number = DEFAULT_SEARCH_LIMIT,
): SearchResult {
	const q = (query ?? "").trim().toLowerCase();
	const catalog = readCatalog();
	const matches: ToolDescriptor[] = [];

	for (const entry of catalog) {
		const nameMatch = q.length === 0 || entry.name.toLowerCase().includes(q);
		const descMatch = q.length === 0 || entry.description.toLowerCase().includes(q);
		if (!nameMatch && !descMatch) continue;
		matches.push({
			name: entry.name,
			description:
				entry.description.length > DEFAULT_DESCRIPTION_PREVIEW
					? entry.description.slice(0, DEFAULT_DESCRIPTION_PREVIEW) + "…"
					: entry.description,
			args_schema: entry.inputSchema,
		});
		if (matches.length >= limit) break;
	}

	return { matches };
}

// ─── Auto-inject required args ────────────────────────────────────────────

/**
 * Walk a JSON-Schema-ish input schema's `required` array and fill in any
 * missing entries from CodeModeContext. Today that's `household_id` and
 * `plan_id`. The LLM can override either by passing them explicitly.
 */
export function ensureRequired(
	args: Record<string, unknown>,
	schema: CatalogEntry | null,
	ctx: CodeModeContext,
): Record<string, unknown> {
	const out: Record<string, unknown> = { ...args };
	const required = schema?.inputSchema?.required;
	const props = (schema?.inputSchema as { properties?: Record<string, unknown> } | undefined)
		?.properties;

	const wantsProp = (key: string): boolean =>
		(Array.isArray(required) && required.includes(key)) ||
		(!!props && Object.prototype.hasOwnProperty.call(props, key));

	if (wantsProp("household_id") && !("household_id" in out)) {
		out.household_id = ctx.household_id;
	}
	if (wantsProp("plan_id") && !("plan_id" in out) && ctx.plan_id) {
		out.plan_id = ctx.plan_id;
	}
	// Force-overwrite household_id even when the LLM passed one — prevents the
	// model from spec'ing a different household. Tools that don't take
	// household_id ignore the extra field.
	if (Object.prototype.hasOwnProperty.call(out, "household_id")) {
		out.household_id = ctx.household_id;
	}
	return out;
}

// ─── Result truncation ────────────────────────────────────────────────────

/**
 * Cap a tool result's JSON serialization to `limit` chars without breaking
 * validity. Same shape as stringifyToolResult in agent-chef-route.ts but
 * returns the parsed value (or a synthetic envelope) so the LLM sees JS
 * objects, not strings.
 */
export function truncateResult(
	result: unknown,
	limit: number = DEFAULT_RESULT_TRUNCATION,
): { value: unknown; truncated: boolean } {
	const full = JSON.stringify(result);
	if (typeof full !== "string" || full.length <= limit) {
		return { value: result, truncated: false };
	}
	if (result && typeof result === "object" && !Array.isArray(result)) {
		const cloned: Record<string, unknown> = { ...(result as Record<string, unknown>) };
		let mutated = false;
		for (const [k, v] of Object.entries(cloned)) {
			if (typeof v === "string" && v.length > 800) {
				cloned[k] = `${v.slice(0, 800)}…[truncated ${v.length - 800} chars]`;
				mutated = true;
			}
		}
		if (mutated) {
			const partial = JSON.stringify(cloned);
			if (partial.length <= limit) return { value: cloned, truncated: true };
		}
	}
	return {
		value: {
			__truncated: true,
			original_bytes: full.length,
			head_preview: full.slice(0, limit - 200),
			note: `Result exceeded ${limit} bytes. Call narrower tools or pass tighter args.`,
		},
		truncated: true,
	};
}

// ─── executeCode(env, ctx, code) ──────────────────────────────────────────

// AsyncFunction constructor — used to run user code as an async function
// without leaking `eval` into the closure. This is a SOFT sandbox: the user
// code can read global APIs (fetch/Date/crypto), but it cannot see `env` or
// any binding we don't pass as a parameter.
//
// IMPORTANT: Cloudflare Workers blocks `new Function` / `new AsyncFunction`
// at runtime ("Code generation from strings disallowed for this context").
// In tests (Node) this path works; in production we silently fall back to
// the JS-subset interpreter below. The proper Phase 1.5 fix is to migrate
// to Cloudflare's Worker Loader binding, which gives us a real V8 isolate.
const AsyncFunctionCtor = (async function () {}).constructor as new (
	...args: string[]
) => (...args: unknown[]) => Promise<unknown>;

function safeStringify(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value);
	} catch {
		try {
			return String(value);
		} catch {
			return "[unstringifiable]";
		}
	}
}

/**
 * Run user-provided JavaScript that calls our MCP tools.
 *
 * Inside the user code, three globals are bound:
 *   - mcp(name, args)   → await dispatch a chef tool, returns the structured result
 *   - mcp_search(query) → synchronous catalog search (returns SearchResult)
 *   - console           → console.log captured into ExecuteResult.logs
 *
 * The user code can `return` any value; it ends up in `return_value`. Tool
 * calls are recorded in `tool_calls` as a flat audit log. Errors are caught
 * and returned in `error` rather than thrown — the agent loop should treat
 * `ok:false` as the model needing to retry or apologize.
 */
export async function executeCode(
	env: MiseGraphEnv,
	ctx: CodeModeContext,
	code: string,
	opts: ExecuteOptions = {},
): Promise<ExecuteResult> {
	const timeoutMs = opts.timeout_ms ?? DEFAULT_TIMEOUT_MS;
	const maxToolCalls = opts.max_tool_calls ?? DEFAULT_MAX_TOOL_CALLS;
	const dispatcher = opts.dispatcher ?? callPlanWorldTool;
	const allowed = opts.allowed_tools ?? null;
	const truncationLimit = opts.result_truncation_chars ?? DEFAULT_RESULT_TRUNCATION;

	const toolCalls: ToolCallTrace[] = [];
	const logs: string[] = [];
	let aborted = false;

	const consoleSandbox = {
		log: (...args: unknown[]) => {
			if (logs.length >= 200) return;
			logs.push(args.map(a => safeStringify(a)).join(" "));
		},
		warn: (...args: unknown[]) => {
			if (logs.length >= 200) return;
			logs.push("[warn] " + args.map(a => safeStringify(a)).join(" "));
		},
		error: (...args: unknown[]) => {
			if (logs.length >= 200) return;
			logs.push("[error] " + args.map(a => safeStringify(a)).join(" "));
		},
	};

	const mcpFn = async (
		name: string,
		args: Record<string, unknown> = {},
	): Promise<unknown> => {
		if (aborted) throw new Error("execution aborted");
		if (toolCalls.length >= maxToolCalls) {
			throw new Error(
				`max_tool_calls exceeded (${maxToolCalls}); refactor to fewer calls or split into multiple execute() runs`,
			);
		}
		if (typeof name !== "string" || !name) {
			throw new Error("mcp(name, args): name must be a non-empty string");
		}
		if (allowed && !allowed.has(name)) {
			throw new Error(`tool not allowed: ${name}`);
		}
		const schema = findSchema(name);
		if (!schema) {
			throw new Error(`unknown tool: ${name}`);
		}
		const safeArgs =
			args && typeof args === "object" && !Array.isArray(args)
				? (args as Record<string, unknown>)
				: {};
		const finalArgs = ensureRequired(safeArgs, schema, ctx);

		const start = Date.now();
		try {
			const raw = await dispatcher(name, finalArgs, env, {
				caller_kind: ctx.caller_kind,
				caller_id: ctx.caller_id,
				parent_trace_id: null,
			});
			const { value } = truncateResult(raw, truncationLimit);
			const duration = Date.now() - start;
			toolCalls.push({ name, args: finalArgs, result: value, duration_ms: duration });
			return value;
		} catch (err) {
			const duration = Date.now() - start;
			const message = err instanceof Error ? err.message : String(err);
			toolCalls.push({
				name,
				args: finalArgs,
				result: null,
				duration_ms: duration,
				error: message,
			});
			throw err;
		}
	};

	const mcpSearchSandbox = (q: string, limit?: number) => searchTools(q, limit);

	const start = Date.now();
	let return_value: unknown;
	let error: { message: string; stack?: string } | undefined;

	// Try the AsyncFunction path first (works in Node/tests). If Cloudflare's
	// Workers runtime blocks it ("Code generation from strings disallowed"),
	// fall back to the JS-subset interpreter below — same protocol, narrower
	// language but covers what Claude actually emits.
	let userFn: ((...a: unknown[]) => Promise<unknown>) | null = null;
	let asyncFnCtorError: string | null = null;
	try {
		userFn = new AsyncFunctionCtor(
			"mcp",
			"mcp_search",
			"console",
			`return (async () => {\n${code}\n})();`,
		);
	} catch (err) {
		asyncFnCtorError = err instanceof Error ? err.message : String(err);
		userFn = null;
	}

	const timeoutPromise = new Promise<never>((_, reject) => {
		setTimeout(() => {
			aborted = true;
			reject(new Error(`execution timed out after ${timeoutMs}ms`));
		}, timeoutMs);
	});

	try {
		if (userFn) {
			return_value = await Promise.race([
				userFn(mcpFn, mcpSearchSandbox, consoleSandbox),
				timeoutPromise,
			]);
		} else {
			// Workers fallback: parse + interpret a JS subset.
			return_value = await Promise.race([
				interpretSubset(code, {
					mcp: mcpFn,
					mcp_search: (q: string, limit?: number) => searchTools(q, limit),
					console: consoleSandbox,
					isAborted: () => aborted,
				}),
				timeoutPromise,
			]);
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const stack = err instanceof Error ? err.stack : undefined;
		// If the subset interpreter rejected the code AND we never had
		// AsyncFunction, surface a "couldn't run" error that mentions both.
		if (!userFn && asyncFnCtorError) {
			error = {
				message: `code did not run in workers sandbox: ${message} (eval blocked: ${asyncFnCtorError})`,
				...(stack ? { stack } : {}),
			};
		} else {
			error = { message, ...(stack ? { stack } : {}) };
		}
	}

	const duration_ms = Date.now() - start;

	return {
		ok: !error,
		...(return_value !== undefined ? { return_value } : {}),
		tool_calls: toolCalls,
		logs,
		...(error ? { error } : {}),
		duration_ms,
	};
}

// ─── Code-block parsing ───────────────────────────────────────────────────

const CODE_BLOCK_RE = /\[\[CODE\]\]\s*([\s\S]*?)\s*\[\[\/CODE\]\]/g;

export interface ParsedCodeBlock {
	code: string;
	raw: string;
	start: number;
	end: number;
}

export interface CodeParseResult {
	blocks: ParsedCodeBlock[];
	leadingText: string;
}

/**
 * Parse all [[CODE]]…[[/CODE]] envelopes from a bridge response. Strips
 * optional ```js / ```javascript fences inside the body so Claude can wrap
 * the code in markdown without breaking the protocol.
 */
export function parseCodeBlocks(text: string): CodeParseResult {
	const blocks: ParsedCodeBlock[] = [];
	const matches: Array<{ start: number; end: number; body: string }> = [];

	CODE_BLOCK_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = CODE_BLOCK_RE.exec(text))) {
		matches.push({ start: m.index, end: m.index + m[0].length, body: m[1] });
	}

	for (const match of matches) {
		const stripped = match.body
			.replace(/^```(?:js|javascript|ts|typescript)?\s*\n?/, "")
			.replace(/\n?```\s*$/, "")
			.trim();
		if (!stripped) continue;
		blocks.push({
			code: stripped,
			raw: text.slice(match.start, match.end),
			start: match.start,
			end: match.end,
		});
	}

	let leadingText = text;
	if (matches.length > 0) {
		leadingText = "";
		let cursor = 0;
		for (const match of matches) {
			leadingText += text.slice(cursor, match.start);
			cursor = match.end;
		}
		leadingText += text.slice(cursor);
	}

	return { blocks, leadingText: leadingText.trim() };
}

// ─── JS-subset interpreter (Workers fallback) ─────────────────────────────
//
// Cloudflare Workers blocks `new Function`/`new AsyncFunction`, so when the
// AsyncFunction path errors we fall back to a tiny tree-walking interpreter
// for the subset of JavaScript Claude tends to write inside [[CODE]]. Goals:
//   - Faithful enough that the same code that ran in tests runs in Workers.
//   - Small enough to maintain (no parser dependency, no full ECMAScript).
//
// Supported:
//   - const / let identifier = <expr>;
//   - const [a, b, c] = await Promise.all([<expr>, <expr>, ...]);
//   - <expr> as: number / string literal / boolean / null / undefined,
//     identifier reference, member access (a.b.c), array/object literals,
//     await mcp("name", {…}), await mcp_search("q"), Date.now(),
//     new Date(...).toISOString().slice(...)
//   - if (cond) { … } else { … }  (cond = identifier / member / equality)
//   - for (const X of <expr>) { … }
//   - return <expr>;
//   - console.log/warn/error(<args>);
//   - basic equality (=== / !==), nullish-coalescing (??) on member access
//
// Anything outside the subset throws a parse/run error that the agent loop
// surfaces as ok:false. The system prompt steers Claude inside the subset.

interface InterpreterContext {
	mcp: (name: string, args?: Record<string, unknown>) => Promise<unknown>;
	mcp_search: (q: string, limit?: number) => SearchResult;
	console: { log: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
	isAborted: () => boolean;
}

class ReturnValue {
	constructor(public value: unknown) {}
}

interface Tokenizer {
	src: string;
	i: number;
}

function isIdentChar(c: string): boolean {
	return /[A-Za-z0-9_$]/.test(c);
}

function isIdentStart(c: string): boolean {
	return /[A-Za-z_$]/.test(c);
}

function skipWs(t: Tokenizer): void {
	while (t.i < t.src.length) {
		const c = t.src[t.i];
		if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === ";") {
			t.i++;
		} else if (c === "/" && t.src[t.i + 1] === "/") {
			while (t.i < t.src.length && t.src[t.i] !== "\n") t.i++;
		} else if (c === "/" && t.src[t.i + 1] === "*") {
			t.i += 2;
			while (t.i < t.src.length - 1 && !(t.src[t.i] === "*" && t.src[t.i + 1] === "/")) t.i++;
			t.i += 2;
		} else {
			break;
		}
	}
}

function peek(t: Tokenizer, s: string): boolean {
	return t.src.slice(t.i, t.i + s.length) === s;
}

function consume(t: Tokenizer, s: string): boolean {
	if (peek(t, s)) {
		t.i += s.length;
		return true;
	}
	return false;
}

function expect(t: Tokenizer, s: string): void {
	skipWs(t);
	if (!consume(t, s)) {
		throw new Error(`expected "${s}" at offset ${t.i}: ${t.src.slice(Math.max(0, t.i - 10), t.i + 30)}`);
	}
}

function readIdent(t: Tokenizer): string {
	skipWs(t);
	if (!isIdentStart(t.src[t.i])) {
		throw new Error(`expected identifier at offset ${t.i}`);
	}
	let s = "";
	while (t.i < t.src.length && isIdentChar(t.src[t.i])) {
		s += t.src[t.i++];
	}
	return s;
}

function readString(t: Tokenizer): string {
	skipWs(t);
	const quote = t.src[t.i];
	if (quote !== '"' && quote !== "'" && quote !== "`") {
		throw new Error(`expected string at offset ${t.i}`);
	}
	t.i++;
	let out = "";
	while (t.i < t.src.length && t.src[t.i] !== quote) {
		if (t.src[t.i] === "\\") {
			t.i++;
			const esc = t.src[t.i++];
			if (esc === "n") out += "\n";
			else if (esc === "t") out += "\t";
			else if (esc === "r") out += "\r";
			else out += esc;
		} else {
			out += t.src[t.i++];
		}
	}
	if (t.src[t.i] !== quote) throw new Error("unterminated string");
	t.i++;
	return out;
}

function readNumber(t: Tokenizer): number {
	skipWs(t);
	let s = "";
	if (t.src[t.i] === "-") s += t.src[t.i++];
	while (t.i < t.src.length && /[0-9.]/.test(t.src[t.i])) s += t.src[t.i++];
	return Number(s);
}

// Read an expression. Returns either a JS value (literals/object/array) OR
// a thunk { __defer: () => Promise<unknown> } when an await is involved.
async function readExpr(t: Tokenizer, env: Map<string, unknown>, ctx: InterpreterContext): Promise<unknown> {
	skipWs(t);
	const c = t.src[t.i];

	// String literal
	if (c === '"' || c === "'" || c === "`") {
		return readString(t);
	}
	// Number literal
	if (/[0-9-]/.test(c) && (c !== "-" || /[0-9]/.test(t.src[t.i + 1] ?? ""))) {
		return readNumber(t);
	}
	// Array literal
	if (c === "[") {
		t.i++;
		const out: unknown[] = [];
		skipWs(t);
		while (t.src[t.i] !== "]") {
			out.push(await readExpr(t, env, ctx));
			skipWs(t);
			if (t.src[t.i] === ",") t.i++;
			skipWs(t);
		}
		t.i++;
		return out;
	}
	// Object literal
	if (c === "{") {
		t.i++;
		const out: Record<string, unknown> = {};
		skipWs(t);
		while (t.src[t.i] !== "}") {
			skipWs(t);
			let key: string;
			if (t.src[t.i] === '"' || t.src[t.i] === "'") {
				key = readString(t);
			} else {
				key = readIdent(t);
			}
			skipWs(t);
			// Shorthand: { foo } means { foo: foo }
			if (t.src[t.i] === "," || t.src[t.i] === "}") {
				out[key] = env.has(key) ? env.get(key) : undefined;
			} else {
				expect(t, ":");
				out[key] = await readExpr(t, env, ctx);
			}
			skipWs(t);
			if (t.src[t.i] === ",") t.i++;
			skipWs(t);
		}
		t.i++;
		return out;
	}
	// await / new / identifier-leading expression
	skipWs(t);
	if (consume(t, "await ") || consume(t, "await\t") || consume(t, "await\n")) {
		const inner = await readExpr(t, env, ctx);
		return inner;
	}
	// Bareword keywords. Use isIdentChar lookahead so identifiers like
	// `nullable` or `undefined_var` aren't misparsed.
	if (peek(t, "true") && !isIdentChar(t.src[t.i + 4] ?? "")) { t.i += 4; return true; }
	if (peek(t, "false") && !isIdentChar(t.src[t.i + 5] ?? "")) { t.i += 5; return false; }
	if (peek(t, "null") && !isIdentChar(t.src[t.i + 4] ?? "")) { t.i += 4; return null; }
	if (peek(t, "undefined") && !isIdentChar(t.src[t.i + 9] ?? "")) { t.i += 9; return undefined; }
	if (peek(t, "new ")) {
		t.i += 4;
		// new Date(<args>)
		const ident = readIdent(t);
		if (ident !== "Date") throw new Error(`unsupported new: ${ident}`);
		expect(t, "(");
		const args: unknown[] = [];
		skipWs(t);
		while (t.src[t.i] !== ")") {
			args.push(await readExpr(t, env, ctx));
			skipWs(t);
			if (t.src[t.i] === ",") t.i++;
			skipWs(t);
		}
		t.i++;
		// eslint-disable-next-line prefer-spread
		const dateInstance = new (Date as unknown as new (...a: unknown[]) => Date)(...args as unknown[]);
		return readMemberChain(t, env, ctx, dateInstance);
	}

	// Identifier or function call
	const ident = readIdent(t);
	let value: unknown;

	skipWs(t);
	if (t.src[t.i] === "(") {
		// Function call. Supported builtins:
		//   mcp(name, args)
		//   mcp_search(q, limit?)
		//   Promise.all([...])
		t.i++;
		const args: unknown[] = [];
		skipWs(t);
		while (t.src[t.i] !== ")") {
			args.push(await readExpr(t, env, ctx));
			skipWs(t);
			if (t.src[t.i] === ",") t.i++;
			skipWs(t);
		}
		t.i++;
		if (ident === "mcp") {
			value = await ctx.mcp(args[0] as string, (args[1] as Record<string, unknown>) ?? {});
		} else if (ident === "mcp_search") {
			value = ctx.mcp_search(args[0] as string, args[1] as number | undefined);
		} else {
			throw new Error(`unsupported call: ${ident}(...)`);
		}
	} else if (ident === "Date" && peek(t, ".")) {
		t.i++;
		const sub = readIdent(t);
		if (sub === "now") {
			expect(t, "(");
			expect(t, ")");
			value = Date.now();
		} else {
			throw new Error(`unsupported Date.${sub}`);
		}
	} else if (ident === "Promise" && peek(t, ".")) {
		t.i++;
		const sub = readIdent(t);
		if (sub !== "all") throw new Error(`unsupported Promise.${sub}`);
		expect(t, "(");
		const arr: unknown[] = [];
		skipWs(t);
		expect(t, "[");
		skipWs(t);
		while (t.src[t.i] !== "]") {
			arr.push(await readExpr(t, env, ctx));
			skipWs(t);
			if (t.src[t.i] === ",") t.i++;
			skipWs(t);
		}
		t.i++;
		expect(t, ")");
		value = await Promise.all(arr.map(v => Promise.resolve(v)));
	} else if (ident === "console" && peek(t, ".")) {
		t.i++;
		const sub = readIdent(t);
		expect(t, "(");
		const args: unknown[] = [];
		skipWs(t);
		while (t.src[t.i] !== ")") {
			args.push(await readExpr(t, env, ctx));
			skipWs(t);
			if (t.src[t.i] === ",") t.i++;
			skipWs(t);
		}
		t.i++;
		if (sub === "log") ctx.console.log(...args);
		else if (sub === "warn") ctx.console.warn(...args);
		else if (sub === "error") ctx.console.error(...args);
		else throw new Error(`unsupported console.${sub}`);
		value = undefined;
	} else {
		if (!env.has(ident)) {
			throw new Error(`unknown identifier: ${ident}`);
		}
		value = env.get(ident);
	}

	return readMemberChain(t, env, ctx, value);
}

async function readMemberChain(
	t: Tokenizer,
	env: Map<string, unknown>,
	ctx: InterpreterContext,
	value: unknown,
): Promise<unknown> {
	for (;;) {
		skipWs(t);
		if (peek(t, "?.")) {
			t.i += 2;
			if (value == null) {
				// consume rest of chain harmlessly
				if (isIdentStart(t.src[t.i])) readIdent(t);
				continue;
			}
			const k = readIdent(t);
			value = (value as Record<string, unknown>)[k];
		} else if (peek(t, ".")) {
			t.i++;
			const k = readIdent(t);
			skipWs(t);
			if (t.src[t.i] === "(") {
				// Method call. Supported: .slice(a,b), .toISOString(), .toLocaleDateString(), .map (single arrow), .length is a property
				t.i++;
				const args: unknown[] = [];
				skipWs(t);
				while (t.src[t.i] !== ")") {
					args.push(await readExpr(t, env, ctx));
					skipWs(t);
					if (t.src[t.i] === ",") t.i++;
					skipWs(t);
				}
				t.i++;
				const recv = value as Record<string, unknown>;
				const fn = recv?.[k];
				if (typeof fn !== "function") throw new Error(`unsupported method: .${k}()`);
				value = (fn as (...a: unknown[]) => unknown).apply(recv, args);
			} else {
				value = value == null ? undefined : (value as Record<string, unknown>)[k];
			}
		} else if (peek(t, "[")) {
			t.i++;
			const idx = await readExpr(t, env, ctx);
			expect(t, "]");
			value = value == null ? undefined : (value as Record<string | number, unknown>)[idx as string | number];
		} else if (peek(t, "??")) {
			t.i += 2;
			const fallback = await readExpr(t, env, ctx);
			if (value == null) value = fallback;
		} else if (peek(t, "===") || peek(t, "!==")) {
			const op = t.src.slice(t.i, t.i + 3);
			t.i += 3;
			const rhs = await readExpr(t, env, ctx);
			value = op === "===" ? value === rhs : value !== rhs;
		} else if (peek(t, "==") || peek(t, "!=")) {
			const op = t.src.slice(t.i, t.i + 2);
			t.i += 2;
			const rhs = await readExpr(t, env, ctx);
			// eslint-disable-next-line eqeqeq
			value = op === "==" ? value == rhs : value != rhs;
		} else if (peek(t, "+") && !peek(t, "++")) {
			t.i++;
			const rhs = await readExpr(t, env, ctx);
			// String concat or number addition. Stringify on either side as a fallback.
			if (typeof value === "string" || typeof rhs === "string") {
				value = String(value) + String(rhs);
			} else {
				value = Number(value) + Number(rhs);
			}
		} else {
			break;
		}
	}
	return value;
}

async function execBlock(
	t: Tokenizer,
	env: Map<string, unknown>,
	ctx: InterpreterContext,
): Promise<void> {
	expect(t, "{");
	skipWs(t);
	while (t.src[t.i] !== "}") {
		await execStmt(t, env, ctx);
		skipWs(t);
	}
	t.i++;
}

async function execStmt(
	t: Tokenizer,
	env: Map<string, unknown>,
	ctx: InterpreterContext,
): Promise<void> {
	if (ctx.isAborted()) throw new Error("execution aborted");
	skipWs(t);
	if (t.i >= t.src.length) return;

	if (consume(t, "const ") || consume(t, "let ") || consume(t, "var ")) {
		skipWs(t);
		// Destructure: const [a, b] = ...
		if (t.src[t.i] === "[") {
			t.i++;
			const names: string[] = [];
			skipWs(t);
			while (t.src[t.i] !== "]") {
				names.push(readIdent(t));
				skipWs(t);
				if (t.src[t.i] === ",") t.i++;
				skipWs(t);
			}
			t.i++;
			expect(t, "=");
			const value = await readExpr(t, env, ctx);
			const arr = Array.isArray(value) ? value : [];
			names.forEach((n, i) => env.set(n, arr[i]));
			skipWs(t);
			if (t.src[t.i] === ";") t.i++;
			return;
		}
		// Destructure: const { a, b } = ...
		if (t.src[t.i] === "{") {
			t.i++;
			const names: string[] = [];
			skipWs(t);
			while (t.src[t.i] !== "}") {
				names.push(readIdent(t));
				skipWs(t);
				if (t.src[t.i] === ",") t.i++;
				skipWs(t);
			}
			t.i++;
			expect(t, "=");
			const value = (await readExpr(t, env, ctx)) as Record<string, unknown> | null;
			names.forEach(n => env.set(n, value ? value[n] : undefined));
			skipWs(t);
			if (t.src[t.i] === ";") t.i++;
			return;
		}
		const name = readIdent(t);
		expect(t, "=");
		const value = await readExpr(t, env, ctx);
		env.set(name, value);
		skipWs(t);
		if (t.src[t.i] === ";") t.i++;
		return;
	}

	if (consume(t, "return")) {
		skipWs(t);
		if (t.src[t.i] === ";" || t.src[t.i] === "}" || t.i >= t.src.length) {
			throw new ReturnValue(undefined);
		}
		const value = await readExpr(t, env, ctx);
		throw new ReturnValue(value);
	}

	if (consume(t, "if")) {
		expect(t, "(");
		const cond = await readExpr(t, env, ctx);
		expect(t, ")");
		skipWs(t);
		if (cond) {
			await execBlock(t, env, ctx);
			skipWs(t);
			if (consume(t, "else")) {
				skipWs(t);
				// Skip the else-block by parsing-and-discarding
				await skipBlock(t);
			}
		} else {
			await skipBlock(t);
			skipWs(t);
			if (consume(t, "else")) {
				skipWs(t);
				if (peek(t, "if")) {
					await execStmt(t, env, ctx);
				} else {
					await execBlock(t, env, ctx);
				}
			}
		}
		return;
	}

	if (consume(t, "for")) {
		expect(t, "(");
		// for (const X of EXPR) { ... }
		consume(t, "const ") || consume(t, "let ") || consume(t, "var ");
		const itName = readIdent(t);
		skipWs(t);
		if (!consume(t, "of")) throw new Error("only `for (… of …)` is supported");
		const iterable = await readExpr(t, env, ctx);
		expect(t, ")");
		skipWs(t);
		// We have to parse the body fresh per iteration. Capture it.
		const bodyStart = t.i;
		const arr = Array.isArray(iterable) ? iterable : [];
		for (const item of arr) {
			if (ctx.isAborted()) throw new Error("execution aborted");
			env.set(itName, item);
			t.i = bodyStart;
			await execBlock(t, env, ctx);
		}
		// Make sure t.i is past the body even if the array was empty.
		if (arr.length === 0) {
			t.i = bodyStart;
			await skipBlock(t);
		}
		return;
	}

	if (consume(t, "try")) {
		// Snapshot so we can advance past the try-block on error.
		skipWs(t);
		const tryBlockStart = t.i;
		let caught: unknown = null;
		try {
			await execBlock(t, env, ctx);
		} catch (err) {
			if (err instanceof ReturnValue) throw err;
			caught = err;
			// Reposition past the entire try-block, then attempt to bind catch.
			t.i = tryBlockStart;
			await skipBlock(t);
		}
		skipWs(t);
		if (consume(t, "catch")) {
			skipWs(t);
			let bindName: string | null = null;
			if (consume(t, "(")) {
				bindName = readIdent(t);
				expect(t, ")");
			}
			skipWs(t);
			if (caught) {
				if (bindName) {
					const errObj = caught instanceof Error
						? { message: caught.message, name: caught.name }
						: { message: String(caught), name: "Error" };
					env.set(bindName, errObj);
				}
				await execBlock(t, env, ctx);
			} else {
				// No error fired — skip the catch block.
				await skipBlock(t);
			}
		} else if (caught) {
			// try without catch + an error → re-throw
			throw caught;
		}
		return;
	}

	if (consume(t, "throw")) {
		skipWs(t);
		const value = await readExpr(t, env, ctx);
		const message = typeof value === "string"
			? value
			: (value && typeof value === "object" && "message" in (value as Record<string, unknown>)
				? String((value as Record<string, unknown>).message)
				: String(value));
		throw new Error(message);
	}

	// Plain assignment to an existing binding: `name = expr;`. We snapshot
	// the cursor so that, if this isn't actually an assignment (e.g. the
	// statement is `await mcp(...)`), we can rewind and let readExpr handle it.
	const savedI = t.i;
	if (isIdentStart(t.src[t.i])) {
		const ident = readIdent(t);
		skipWs(t);
		if (t.src[t.i] === "=" && t.src[t.i + 1] !== "=" && t.src[t.i + 1] !== ">") {
			t.i++;
			const value = await readExpr(t, env, ctx);
			env.set(ident, value);
			skipWs(t);
			if (t.src[t.i] === ";") t.i++;
			return;
		}
		// Not an assignment — rewind so readExpr can re-scan from the ident.
		t.i = savedI;
	}

	// Bare expression (e.g. `await mcp(...)` for side effects).
	await readExpr(t, env, ctx);
	skipWs(t);
	if (t.src[t.i] === ";") t.i++;
}

async function skipBlock(t: Tokenizer): Promise<void> {
	skipWs(t);
	if (t.src[t.i] !== "{") throw new Error("expected `{` for block to skip");
	let depth = 0;
	for (; t.i < t.src.length; t.i++) {
		const c = t.src[t.i];
		if (c === "{") depth++;
		else if (c === "}") {
			depth--;
			if (depth === 0) {
				t.i++;
				return;
			}
		} else if (c === '"' || c === "'" || c === "`") {
			const quote = c;
			t.i++;
			while (t.i < t.src.length && t.src[t.i] !== quote) {
				if (t.src[t.i] === "\\") t.i++;
				t.i++;
			}
		}
	}
}

/**
 * Tree-walking interpreter for a small JS subset. Used as the Workers
 * fallback when `new AsyncFunction()` is blocked by the runtime. See the
 * comment block above this section for the supported grammar.
 */
export async function interpretSubset(
	code: string,
	ctx: InterpreterContext,
): Promise<unknown> {
	const env = new Map<string, unknown>();
	const t: Tokenizer = { src: code, i: 0 };
	try {
		while (t.i < code.length) {
			skipWs(t);
			if (t.i >= code.length) break;
			await execStmt(t, env, ctx);
			skipWs(t);
		}
	} catch (err) {
		if (err instanceof ReturnValue) return err.value;
		throw err;
	}
	return undefined;
}

/**
 * Render an ExecuteResult as the `[[EXECUTE_RESULT]]` block we feed back
 * to the bridge. Mirrors the [[TOOL_RESULT]] envelope from agent-chef-route.
 * Truncates oversize payloads but preserves the tool_calls audit list.
 */
export function buildExecuteResultBlock(
	result: ExecuteResult,
	limit: number = DEFAULT_RESULT_TRUNCATION * 2,
): string {
	const summary: Record<string, unknown> = {
		ok: result.ok,
		duration_ms: result.duration_ms,
		tool_calls: result.tool_calls.map(tc => ({
			name: tc.name,
			args: tc.args,
			result: tc.result,
			duration_ms: tc.duration_ms,
			...(tc.error ? { error: tc.error } : {}),
		})),
	};
	if (result.return_value !== undefined) summary.return_value = result.return_value;
	if (result.logs.length > 0) summary.logs = result.logs;
	if (result.error) summary.error = result.error;

	let body = JSON.stringify(summary);
	let truncatedFlag = "";
	if (body.length > limit) {
		body = JSON.stringify({
			__truncated: true,
			original_bytes: body.length,
			ok: result.ok,
			duration_ms: result.duration_ms,
			tool_call_count: result.tool_calls.length,
			tool_call_names: result.tool_calls.map(tc => tc.name),
			...(result.error ? { error: result.error } : {}),
			note: `Execute result exceeded ${limit} bytes; only summary is shown.`,
		});
		truncatedFlag = " (truncated)";
	}

	return `[[EXECUTE_RESULT${truncatedFlag}]]\n${body}\n[[/EXECUTE_RESULT]]`;
}

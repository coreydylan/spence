// U112 — Code Mode runtime: searchTools + executeCode.
//
// Verifies the building blocks of the new chef tool-dispatch path:
//   1. searchTools() filters the catalog by name + description
//   2. searchTools() preview-trims long descriptions, caps to limit
//   3. executeCode() runs trivial JS, returns return_value
//   4. executeCode() can call mcp("plan_list", {}) via injected dispatcher
//   5. executeCode() chains multiple tool calls in one run
//   6. executeCode() rejects tools outside `allowed_tools`
//   7. executeCode() caps at max_tool_calls
//   8. executeCode() catches JS errors and returns ok:false + error.message
//   9. executeCode() times out via timeout_ms
//  10. ensureRequired() auto-injects household_id from CodeModeContext
//  11. parseCodeBlocks() finds [[CODE]]…[[/CODE]] envelopes (raw + fenced)
//  12. buildExecuteResultBlock() emits a [[EXECUTE_RESULT]] envelope

import type { Scenario } from "../lib/types";
import {
	buildExecuteResultBlock,
	ensureRequired,
	executeCode,
	parseCodeBlocks,
	searchTools,
	truncateResult,
	type CodeModeContext,
	type ExecuteResult,
} from "../../src/mise-graph/code-mode";
import { callPlanWorldTool } from "../../src/mise-graph/plan-world-mcp";
import type { MiseGraphEnv } from "../../src/mise-graph/types";

type Dispatcher = typeof callPlanWorldTool;

const u112: Scenario = {
	id: "u112",
	name: "code-mode: searchTools, executeCode sandbox, allow-list, caps, timeout, ensureRequired",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const env = {} as MiseGraphEnv;
		const codeCtx: CodeModeContext = {
			household_id: "hh_u112",
			caller_kind: "agent",
			caller_id: "u112-test",
		};

		// ── 1. searchTools — name match ───────────────────────────────────
		const planMatches = searchTools("plan_list");
		ctx.assert.gt(planMatches.matches.length, 0, "searchTools finds plan_list");
		const hasPlanList = planMatches.matches.some(m => m.name === "plan_list");
		ctx.assert.ok(hasPlanList, "plan_list in matches");

		// ── 2. searchTools — description match ─────────────────────────────
		const compose = searchTools("compose");
		ctx.assert.gt(compose.matches.length, 0, "description-substring match works");
		const composeNames = compose.matches.map(m => m.name);
		ctx.assert.contains(composeNames, "plan_compose_meal", "plan_compose_meal in compose matches");

		// ── 3. searchTools — case-insensitive ─────────────────────────────
		const upper = searchTools("PLAN_LIST");
		ctx.assert.gt(upper.matches.length, 0, "case-insensitive match");

		// ── 4. searchTools — empty query returns up to limit ──────────────
		const all = searchTools("", 5);
		ctx.assert.eq(all.matches.length, 5, "empty query honors limit");

		// ── 5. searchTools — limit clamps results ─────────────────────────
		const planAll = searchTools("plan", 3);
		ctx.assert.lte(planAll.matches.length, 3, "search limit respected");

		// ── 6. searchTools — descriptors include args_schema ──────────────
		const planMatch = planMatches.matches.find(m => m.name === "plan_list");
		ctx.assert.ok(!!planMatch, "plan_list descriptor exists");
		ctx.assert.ok(
			planMatch !== undefined && typeof planMatch.args_schema === "object",
			"args_schema is object",
		);

		// ── 7. executeCode — trivial return ───────────────────────────────
		const r1 = await executeCode(env, codeCtx, "return 42;");
		ctx.assert.eq(r1.ok, true, "trivial return ok");
		ctx.assert.eq(r1.return_value, 42, "return_value is 42");
		ctx.assert.eq(r1.tool_calls.length, 0, "no tool calls");

		// ── 8. executeCode — single mcp() call via fake dispatcher ────────
		let dispCalls = 0;
		const fakeDispatcher: Dispatcher = async (name, args) => {
			dispCalls++;
			if (name === "plan_list") return { plans: [{ id: "p1" }, { id: "p2" }] };
			return { ok: true, args };
		};

		const r2 = await executeCode(env, codeCtx, `
			const out = await mcp("plan_list", {});
			return out.plans.length;
		`, { dispatcher: fakeDispatcher });
		ctx.assert.eq(r2.ok, true, "single-call run ok");
		ctx.assert.eq(r2.return_value, 2, "return_value reflects tool result");
		ctx.assert.eq(dispCalls, 1, "dispatcher called once");
		ctx.assert.eq(r2.tool_calls.length, 1, "tool_calls audit length");
		ctx.assert.eq(r2.tool_calls[0].name, "plan_list", "tool name in audit");

		// ── 9. executeCode — chain multiple calls ─────────────────────────
		dispCalls = 0;
		const r3 = await executeCode(env, codeCtx, `
			const list = await mcp("plan_list", {});
			const names = [];
			for (const p of list.plans) {
				const sum = await mcp("plan_read_summary", { plan_id: p.id });
				names.push(sum.id);
			}
			return names;
		`, {
			dispatcher: async (name, args) => {
				dispCalls++;
				if (name === "plan_list") return { plans: [{ id: "p1" }, { id: "p2" }] };
				if (name === "plan_read_summary") return { id: args.plan_id };
				throw new Error("unexpected " + name);
			},
		});
		ctx.assert.eq(r3.ok, true, "chained run ok");
		ctx.assert.eq(dispCalls, 3, "three calls total (1 list + 2 summaries)");
		ctx.assert.eq(r3.tool_calls.length, 3, "audit captured all three");

		// ── 10. executeCode — allow_tools rejects unknown ─────────────────
		const allowed = new Set(["plan_list"]);
		const r4 = await executeCode(env, codeCtx, `await mcp("plan_lock_meal", { plan_id: "x", slot: { date: "2026-01-01", slot: "dinner" } });`, {
			dispatcher: fakeDispatcher,
			allowed_tools: allowed,
		});
		ctx.assert.eq(r4.ok, false, "disallowed tool fails the run");
		ctx.assert.ok(!!r4.error, "error populated");
		if (r4.error) {
			ctx.assert.contains(r4.error.message, "tool not allowed", "error message names rejection");
		}

		// ── 11. executeCode — max_tool_calls cap ──────────────────────────
		const r5 = await executeCode(env, codeCtx, `
			for (let i = 0; i < 50; i++) {
				await mcp("plan_list", {});
			}
			return "done";
		`, { dispatcher: fakeDispatcher, max_tool_calls: 3 });
		ctx.assert.eq(r5.ok, false, "cap exceeded fails the run");
		if (r5.error) {
			ctx.assert.contains(r5.error.message, "max_tool_calls", "error names the cap");
		}
		ctx.assert.lte(r5.tool_calls.length, 3, "tool_calls audit ≤ cap");

		// ── 12. executeCode — JS throw is caught ──────────────────────────
		const r6 = await executeCode(env, codeCtx, `throw new Error("boom");`);
		ctx.assert.eq(r6.ok, false, "throw fails the run");
		if (r6.error) {
			ctx.assert.contains(r6.error.message, "boom", "error.message echoes throw");
		}

		// ── 13. executeCode — syntax error returns ok:false ───────────────
		const r7 = await executeCode(env, codeCtx, `this is not valid javascript at all (((`);
		ctx.assert.eq(r7.ok, false, "syntax error fails the run");

		// ── 14. executeCode — timeout ─────────────────────────────────────
		const r8 = await executeCode(env, codeCtx, `
			await new Promise(r => setTimeout(r, 5000));
			return "should not get here";
		`, { timeout_ms: 50 });
		ctx.assert.eq(r8.ok, false, "timeout fails the run");
		if (r8.error) {
			ctx.assert.contains(r8.error.message, "timed out", "error.message names the timeout");
		}

		// ── 15. executeCode — console.log captured in logs ────────────────
		const r9 = await executeCode(env, codeCtx, `
			console.log("hello", { a: 1 });
			console.warn("careful");
			return "logged";
		`);
		ctx.assert.eq(r9.ok, true, "logged run ok");
		ctx.assert.gte(r9.logs.length, 2, "two log lines captured");
		ctx.assert.contains(r9.logs.join(" "), "hello", "log content captured");

		// ── 16. ensureRequired auto-injects household_id ──────────────────
		const schema = {
			name: "x",
			description: "x",
			inputSchema: {
				type: "object",
				required: ["household_id"],
				properties: { household_id: { type: "string" } },
			},
		};
		const filled = ensureRequired({}, schema, codeCtx);
		ctx.assert.eq(filled.household_id, "hh_u112", "household_id auto-injected");

		// ── 17. ensureRequired forces context.household_id over caller's ──
		const forced = ensureRequired({ household_id: "hh_other" }, schema, codeCtx);
		ctx.assert.eq(forced.household_id, "hh_u112", "context household_id wins");

		// ── 18. ensureRequired auto-injects plan_id when present in ctx ───
		const planSchema = {
			name: "x",
			description: "x",
			inputSchema: {
				type: "object",
				required: ["plan_id"],
				properties: { plan_id: { type: "string" } },
			},
		};
		const ctxWithPlan: CodeModeContext = { ...codeCtx, plan_id: "p_default" };
		const planFilled = ensureRequired({}, planSchema, ctxWithPlan);
		ctx.assert.eq(planFilled.plan_id, "p_default", "plan_id auto-injected when ctx has it");

		// ── 19. executeCode auto-injects household_id at dispatch time ────
		let receivedArgs: Record<string, unknown> = {};
		const recordingDispatcher: Dispatcher = async (name, args) => {
			receivedArgs = args;
			return { ok: true };
		};
		await executeCode(env, codeCtx, `
			// LLM forgot household_id — runtime should fill it in.
			await mcp("inspire_read_household_signals", {});
			return null;
		`, { dispatcher: recordingDispatcher });
		ctx.assert.eq(receivedArgs.household_id, "hh_u112", "dispatcher saw injected household_id");

		// ── 20. executeCode forces ctx.household_id over LLM-supplied ─────
		await executeCode(env, codeCtx, `
			await mcp("inspire_read_household_signals", { household_id: "hh_attacker" });
			return null;
		`, { dispatcher: recordingDispatcher });
		ctx.assert.eq(
			receivedArgs.household_id,
			"hh_u112",
			"LLM cannot override household_id (security)",
		);

		// ── 21. parseCodeBlocks finds raw [[CODE]] block ──────────────────
		const p1 = parseCodeBlocks("Reading now.\n[[CODE]]\nconst x = 1;\nreturn x;\n[[/CODE]]\nDone.");
		ctx.assert.eq(p1.blocks.length, 1, "one code block parsed");
		ctx.assert.contains(p1.blocks[0].code, "const x = 1", "code body extracted");
		ctx.assert.contains(p1.leadingText, "Reading now", "leading text preserved");
		ctx.assert.contains(p1.leadingText, "Done.", "trailing text preserved");

		// ── 22. parseCodeBlocks strips ```js fences ───────────────────────
		const p2 = parseCodeBlocks("[[CODE]]\n```js\nreturn 1;\n```\n[[/CODE]]");
		ctx.assert.eq(p2.blocks.length, 1, "fenced code block parsed");
		ctx.assert.eq(p2.blocks[0].code.trim(), "return 1;", "js fences stripped");

		// ── 23. parseCodeBlocks finds multiple blocks ─────────────────────
		const p3 = parseCodeBlocks("[[CODE]]\nreturn 1;\n[[/CODE]]\nthen\n[[CODE]]\nreturn 2;\n[[/CODE]]");
		ctx.assert.eq(p3.blocks.length, 2, "two blocks parsed");

		// ── 24. parseCodeBlocks ignores empty blocks ──────────────────────
		const p4 = parseCodeBlocks("[[CODE]]   [[/CODE]]");
		ctx.assert.eq(p4.blocks.length, 0, "empty block dropped");

		// ── 25. parseCodeBlocks: no blocks → leadingText is the whole text ─
		const p5 = parseCodeBlocks("Just plain prose, nothing fancy.");
		ctx.assert.eq(p5.blocks.length, 0, "no blocks");
		ctx.assert.contains(p5.leadingText, "plain prose", "all text preserved");

		// ── 26. buildExecuteResultBlock renders ok run ────────────────────
		const okResult: ExecuteResult = {
			ok: true,
			return_value: { plan_id: "p1" },
			tool_calls: [
				{ name: "plan_list", args: {}, result: { plans: [] }, duration_ms: 5 },
			],
			logs: [],
			duration_ms: 12,
		};
		const block1 = buildExecuteResultBlock(okResult);
		ctx.assert.contains(block1, "[[EXECUTE_RESULT", "envelope opener present");
		ctx.assert.contains(block1, "[[/EXECUTE_RESULT]]", "envelope closer present");
		ctx.assert.contains(block1, "plan_list", "tool name in body");
		ctx.assert.contains(block1, '"ok":true', "ok flag present");

		// ── 27. buildExecuteResultBlock renders error run ─────────────────
		const errResult: ExecuteResult = {
			ok: false,
			tool_calls: [],
			logs: [],
			error: { message: "boom" },
			duration_ms: 1,
		};
		const block2 = buildExecuteResultBlock(errResult);
		ctx.assert.contains(block2, '"ok":false', "ok:false serialized");
		ctx.assert.contains(block2, "boom", "error message present");

		// ── 28. truncateResult wraps oversize payloads ────────────────────
		const big = { huge: "x".repeat(10000) };
		const trunc = truncateResult(big, 1000);
		ctx.assert.eq(trunc.truncated, true, "oversize result flagged");
		// Result must still serialize to JSON.
		JSON.parse(JSON.stringify(trunc.value));

		// ── 29. truncateResult passes small payloads through ──────────────
		const small = truncateResult({ ok: true }, 1000);
		ctx.assert.eq(small.truncated, false, "small payload not flagged");

		// ── 30. searchTools handles unknown query gracefully ──────────────
		const empty = searchTools("xxxnotarealtoolnamexxx");
		ctx.assert.eq(empty.matches.length, 0, "no matches for nonsense query");

		// ── 31. executeCode: dispatcher error surfaces to user code ───────
		const r10 = await executeCode(env, codeCtx, `
			try {
				await mcp("plan_list", {});
				return "no error";
			} catch (e) {
				return "caught: " + e.message;
			}
		`, {
			dispatcher: async () => { throw new Error("d1 down"); },
		});
		ctx.assert.eq(r10.ok, true, "user code can catch dispatcher errors");
		const rv = String(r10.return_value);
		ctx.assert.contains(rv, "caught", "error caught in user code");
		ctx.assert.contains(rv, "d1 down", "underlying error message preserved");

		ctx.notes.push("u112 code-mode runtime + sandbox controls verified");
	},
};

export default u112;

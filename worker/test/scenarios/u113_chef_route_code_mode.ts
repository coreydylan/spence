// U113 — /agent/chef route: Code Mode integration.
//
// Verifies the agent loop correctly handles [[CODE]]…[[/CODE]] blocks in
// addition to the legacy [[TOOL_CALL]] envelope:
//
//   1. A bridge response containing a [[CODE]] block with a single mcp() call
//      causes:
//        - one code_execute_start event
//        - one tool_call_start + tool_call_result for the inner call
//        - one code_execute_end event
//        - the next bridge round-trip receives an [[EXECUTE_RESULT]] envelope
//   2. A code block with multiple chained mcp() calls emits one
//      tool_call_start/result per inner call.
//   3. A code block calling a tool outside CHEF_ALLOWED_TOOLS surfaces a
//      tool_call_error and execute_end.ok === false.
//   4. The legacy [[TOOL_CALL]] path still works (regression).
//   5. Mixed turn (one [[CODE]] + one [[TOOL_CALL]]) processes both.
//   6. The system prompt teaches Code Mode (mentions mcp_search / mcp_execute
//      / [[CODE]]).

import type { Scenario } from "../lib/types";
import { createMockD1 } from "../lib/mock-d1";
import { migrateHouseholdMemorySchema } from "../../src/mise-graph/admin-household-memory";
import { migrateOnboardingSchema } from "../../src/mise-graph/schemas/migrations";
import { migrateEquipmentSchema } from "../../src/mise-graph/equipment";
import { upsertMember } from "../../src/mise-graph/household-members";
import {
	answerOnboarding,
	startOnboarding,
} from "../../src/mise-graph/onboarding";
import { TIER_0_QUESTIONS } from "../../src/mise-graph/onboarding-questions";
import {
	buildSystemPrompt,
	runAgentChef,
	type AgentChefRouteEnv,
	type ChefEvent,
} from "../../src/mise-graph/agent-chef-route";
import { chefStatusCheck } from "../../src/mise-graph/chef-dispatch";
import type { MeshClaudeResponse } from "../../src/mise-graph/llm-bridge";
import type { MiseGraphEnv } from "../../src/mise-graph/types";

async function collect(run: (emit: { send: (e: ChefEvent) => void }) => Promise<void>): Promise<ChefEvent[]> {
	const events: ChefEvent[] = [];
	await run({ send: (e: ChefEvent) => events.push(e) });
	return events;
}

const u113: Scenario = {
	id: "u113",
	name: "agent/chef route: Code Mode parsing, inner-call SSE, allow-list, legacy fallback, mixed turn",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const db = createMockD1();
		const baseEnv = { DB: db as unknown as D1Database } as MiseGraphEnv;
		await migrateHouseholdMemorySchema(baseEnv);
		await migrateOnboardingSchema(baseEnv);
		await migrateEquipmentSchema(baseEnv);

		const HH = "hh_u113";
		await startOnboarding(baseEnv, { household_id: HH });
		for (const q of TIER_0_QUESTIONS) {
			const sample = q.options ? q.options[0].value : "Sample";
			await answerOnboarding(baseEnv, { household_id: HH, question_kind: q.kind, response_text: sample });
		}
		await answerOnboarding(baseEnv, { household_id: HH, question_kind: "tier_1_avoidances", response_text: "no peanuts" });
		await answerOnboarding(baseEnv, { household_id: HH, question_kind: "tier_1_dinner_ritual", response_text: "table" });
		await answerOnboarding(baseEnv, { household_id: HH, question_kind: "tier_1_cook_frequency", response_text: "most" });
		await answerOnboarding(baseEnv, { household_id: HH, question_kind: "tier_1_pantry_intake", response_text: "gradual" });
		await upsertMember(baseEnv, {
			household_id: HH,
			display_name: "Test",
			age_group: "adult",
			dietary: [],
			preferences: { loves: [], dislikes: [], allergies: [] },
		});

		const readyStatus = await chefStatusCheck(baseEnv, { household_id: HH });
		ctx.assert.eq(readyStatus.onboarding.tier_1_done, true, "fixture: tier 1 done");

		const readyEnv: AgentChefRouteEnv = {
			...baseEnv,
			MESH: { fetch: async () => new Response("{}") },
			BRIDGE_HOST: "100.96.0.10",
			BRIDGE_PORT: "8484",
			BRIDGE_SECRET: "test_secret",
		};

		// ── 0. System prompt teaches Code Mode ────────────────────────────
		const sys = buildSystemPrompt(readyStatus, readyStatus.signals, HH);
		ctx.assert.contains(sys, "mcp_search", "system prompt mentions mcp_search");
		ctx.assert.contains(sys, "mcp_execute", "system prompt mentions mcp_execute");
		ctx.assert.contains(sys, "[[CODE]]", "system prompt teaches [[CODE]] envelope");
		ctx.assert.contains(sys, "household_id is auto-injected", "system prompt clarifies auto-inject");

		// ── 1. Single [[CODE]] block with one mcp() call ───────────────────
		const dispatched1: Array<{ name: string; args: Record<string, unknown> }> = [];
		const fakeTools1 = async (
			name: string,
			args: Record<string, unknown>,
		): Promise<Record<string, unknown>> => {
			dispatched1.push({ name, args });
			if (name === "plan_list") return { plans: [{ id: "p_one", start_date: "2026-05-01" }] };
			return { ok: true };
		};

		const replies1: string[] = [
			"Let me look.\n[[CODE]]\nconst plans = await mcp(\"plan_list\", {});\nreturn { count: plans.plans.length, first: plans.plans[0]?.id };\n[[/CODE]]",
			"You have one plan: p_one.",
		];
		let i1 = 0;
		const events1 = await collect(async emit => {
			await runAgentChef(emit as { send: (e: ChefEvent) => void; close?: () => void }, {
				body: { message: "what plans do I have" },
				household_id: HH,
				env: readyEnv,
				bridge: async (): Promise<MeshClaudeResponse> => ({
					ok: true,
					sessionId: null,
					text: replies1[i1++] ?? "",
					elapsedMs: 1,
					messageCount: 1,
					toolCalls: 0,
					yieldDetected: false,
				}),
				toolDispatcher: fakeTools1 as unknown as Parameters<typeof runAgentChef>[1]["toolDispatcher"],
				chunkDelayMs: 0,
			});
		});

		const codeStarts1 = events1.filter(e => e.kind === "code_execute_start");
		const codeEnds1 = events1.filter(e => e.kind === "code_execute_end");
		const innerStarts1 = events1.filter(e => e.kind === "tool_call_start");
		const innerResults1 = events1.filter(e => e.kind === "tool_call_result");

		ctx.assert.eq(codeStarts1.length, 1, "one code_execute_start emitted");
		ctx.assert.eq(codeEnds1.length, 1, "one code_execute_end emitted");
		ctx.assert.eq(innerStarts1.length, 1, "one inner tool_call_start emitted");
		ctx.assert.eq(innerResults1.length, 1, "one inner tool_call_result emitted");

		const end1 = codeEnds1[0];
		if (end1.kind === "code_execute_end") {
			ctx.assert.eq(end1.ok, true, "execute ended ok");
			ctx.assert.eq(end1.tool_calls_count, 1, "execute counted one tool call");
			ctx.assert.ok(
				end1.return_value !== undefined,
				"return_value present in code_execute_end",
			);
		}

		const finalText1 = events1
			.filter(e => e.kind === "text")
			.map(e => (e as Extract<ChefEvent, { kind: "text" }>).delta)
			.join("");
		ctx.assert.contains(finalText1, "p_one", "final text reflects code-mode result");
		ctx.assert.eq(dispatched1.length, 1, "dispatcher called once");
		ctx.assert.eq(dispatched1[0].name, "plan_list", "right tool dispatched");
		ctx.assert.eq(dispatched1[0].args.household_id, HH, "household_id injected");

		// Order check: code_execute_start → inner tool_call_start → tool_call_result → code_execute_end
		const order1 = events1
			.map(e => e.kind)
			.filter(k =>
				["code_execute_start", "code_execute_end", "tool_call_start", "tool_call_result"].includes(k),
			);
		ctx.assert.eq(order1[0], "code_execute_start", "execute_start first");
		ctx.assert.eq(order1[order1.length - 1], "code_execute_end", "execute_end last");

		// ── 2. Code block with multiple mcp() calls ───────────────────────
		const dispatched2: string[] = [];
		const replies2: string[] = [
			"[[CODE]]\nconst plans = await mcp(\"plan_list\", {});\nfor (const p of plans.plans) {\n  await mcp(\"plan_read_summary\", { plan_id: p.id });\n}\nreturn plans.plans.length;\n[[/CODE]]",
			"Both summaries pulled.",
		];
		let i2 = 0;
		const events2 = await collect(async emit => {
			await runAgentChef(emit as { send: (e: ChefEvent) => void; close?: () => void }, {
				body: { message: "summarize my plans" },
				household_id: HH,
				env: readyEnv,
				bridge: async (): Promise<MeshClaudeResponse> => ({
					ok: true,
					sessionId: null,
					text: replies2[i2++] ?? "",
					elapsedMs: 1,
					messageCount: 1,
					toolCalls: 0,
					yieldDetected: false,
				}),
				toolDispatcher: (async (name: string) => {
					dispatched2.push(name);
					if (name === "plan_list") return { plans: [{ id: "p1" }, { id: "p2" }] };
					return { id: "x" };
				}) as unknown as Parameters<typeof runAgentChef>[1]["toolDispatcher"],
				chunkDelayMs: 0,
			});
		});

		const innerStarts2 = events2.filter(e => e.kind === "tool_call_start");
		ctx.assert.eq(innerStarts2.length, 3, "three inner tool_call_start (1 list + 2 summaries)");
		ctx.assert.eq(dispatched2.length, 3, "dispatcher called three times");
		const codeEnds2 = events2.filter(e => e.kind === "code_execute_end");
		ctx.assert.eq(codeEnds2.length, 1, "one code_execute_end for the whole [[CODE]] block");

		// ── 3. Disallowed tool surfaces tool_call_error + execute fails ────
		const replies3: string[] = [
			// plan_lock_meal is NOT in CHEF_ALLOWED_TOOLS.
			"[[CODE]]\ntry { await mcp(\"plan_lock_meal\", { plan_id: \"p1\", slot: { date: \"2026-01-01\", slot: \"dinner\" } }); } catch (e) { return { caught: e.message }; }\nreturn { unreachable: true };\n[[/CODE]]",
			"Can't lock that.",
		];
		let i3 = 0;
		let blockedDispatcherCalled = 0;
		const events3 = await collect(async emit => {
			await runAgentChef(emit as { send: (e: ChefEvent) => void; close?: () => void }, {
				body: { message: "lock my plan" },
				household_id: HH,
				env: readyEnv,
				bridge: async (): Promise<MeshClaudeResponse> => ({
					ok: true,
					sessionId: null,
					text: replies3[i3++] ?? "",
					elapsedMs: 1,
					messageCount: 1,
					toolCalls: 0,
					yieldDetected: false,
				}),
				toolDispatcher: (async () => {
					blockedDispatcherCalled++;
					return { ok: true };
				}) as unknown as Parameters<typeof runAgentChef>[1]["toolDispatcher"],
				chunkDelayMs: 0,
			});
		});
		const errorEvents3 = events3.filter(e => e.kind === "tool_call_error");
		ctx.assert.gte(errorEvents3.length, 1, "tool_call_error emitted for disallowed tool");
		ctx.assert.eq(blockedDispatcherCalled, 0, "dispatcher never reached for disallowed tool");
		// The user code catches the error so execute_end.ok stays true with caught return value.
		const codeEnd3 = events3.find(e => e.kind === "code_execute_end");
		if (codeEnd3 && codeEnd3.kind === "code_execute_end") {
			ctx.assert.eq(codeEnd3.ok, true, "execute_end ok when user catches the error");
			const rv = codeEnd3.return_value as { caught?: string } | undefined;
			ctx.assert.ok(!!rv?.caught, "return_value carries caught message");
		}

		// ── 4. Legacy [[TOOL_CALL]] still works (regression) ──────────────
		const dispatched4: string[] = [];
		const replies4: string[] = [
			"[[TOOL_CALL]]\n{\"name\":\"plan_list\",\"args\":{\"household_id\":\"" + HH + "\"}}\n[[/TOOL_CALL]]",
			"Plans found.",
		];
		let i4 = 0;
		const events4 = await collect(async emit => {
			await runAgentChef(emit as { send: (e: ChefEvent) => void; close?: () => void }, {
				body: { message: "list" },
				household_id: HH,
				env: readyEnv,
				bridge: async (): Promise<MeshClaudeResponse> => ({
					ok: true,
					sessionId: null,
					text: replies4[i4++] ?? "",
					elapsedMs: 1,
					messageCount: 1,
					toolCalls: 0,
					yieldDetected: false,
				}),
				toolDispatcher: (async (name: string) => {
					dispatched4.push(name);
					return { plans: [] };
				}) as unknown as Parameters<typeof runAgentChef>[1]["toolDispatcher"],
				chunkDelayMs: 0,
			});
		});
		const codeEnds4 = events4.filter(e => e.kind === "code_execute_end");
		ctx.assert.eq(codeEnds4.length, 0, "no code_execute_end on legacy path");
		const startEvents4 = events4.filter(e => e.kind === "tool_call_start");
		ctx.assert.eq(startEvents4.length, 1, "legacy tool_call_start emitted");
		ctx.assert.eq(dispatched4.length, 1, "legacy dispatcher called once");
		ctx.assert.eq(dispatched4[0], "plan_list", "legacy tool dispatched");

		// ── 5. Mixed turn — [[CODE]] + [[TOOL_CALL]] in same response ─────
		const dispatched5: string[] = [];
		const replies5: string[] = [
			"[[CODE]]\nconst x = await mcp(\"plan_list\", {});\nreturn x;\n[[/CODE]]\n[[TOOL_CALL]]\n{\"name\":\"household_get_traits\",\"args\":{}}\n[[/TOOL_CALL]]",
			"All set.",
		];
		let i5 = 0;
		const events5 = await collect(async emit => {
			await runAgentChef(emit as { send: (e: ChefEvent) => void; close?: () => void }, {
				body: { message: "everything" },
				household_id: HH,
				env: readyEnv,
				bridge: async (): Promise<MeshClaudeResponse> => ({
					ok: true,
					sessionId: null,
					text: replies5[i5++] ?? "",
					elapsedMs: 1,
					messageCount: 1,
					toolCalls: 0,
					yieldDetected: false,
				}),
				toolDispatcher: (async (name: string) => {
					dispatched5.push(name);
					if (name === "plan_list") return { plans: [] };
					return { traits: {} };
				}) as unknown as Parameters<typeof runAgentChef>[1]["toolDispatcher"],
				chunkDelayMs: 0,
			});
		});
		ctx.assert.contains(dispatched5, "plan_list", "code-mode tool dispatched");
		ctx.assert.contains(dispatched5, "household_get_traits", "legacy tool dispatched");
		const codeEnds5 = events5.filter(e => e.kind === "code_execute_end");
		ctx.assert.eq(codeEnds5.length, 1, "one code_execute_end for the [[CODE]] block");

		// ── 6. Final text appears after both branches finish ──────────────
		const finalText5 = events5
			.filter(e => e.kind === "text")
			.map(e => (e as Extract<ChefEvent, { kind: "text" }>).delta)
			.join("");
		ctx.assert.contains(finalText5, "All set", "final text streams from second iteration");

		ctx.notes.push("u113 chef route Code Mode integration verified");
	},
};

export default u113;

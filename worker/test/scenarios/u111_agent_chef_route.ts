// U111 — /agent/chef route: gating logic + SSE flow with mocked bridge.
//
// Verifies the worker-side chef-of-staff agent loop:
//   1. New household (tier 0 incomplete) → emits a status event followed by
//      a ui_component(onboarding_question), then done(blocked_on_onboarding).
//      The bridge is NEVER called.
//   2. Ready household (tier 1 done) → emits status, thinking_start, one or
//      more text deltas reconstructing the bridge response, then
//      done(stop). The bridge IS called with the persona system prompt
//      that includes personality + traditions + equipment.
//   3. Bridge error → emits an error event followed by
//      done(bridge_error).
//   4. Missing household_id (no body field, no CF Access header) →
//      handleAgentChefRoute returns 401.
//   5. OPTIONS preflight → 204 with permissive CORS.
//
// We don't call the real bridge here. The route module accepts an
// injectable `bridge` for runAgentChef so the scenario stays fast.

import type { Scenario } from "../lib/types";
import { createMockD1 } from "../lib/mock-d1";
import { migrateHouseholdMemorySchema } from "../../src/mise-graph/admin-household-memory";
import { migrateOnboardingSchema } from "../../src/mise-graph/schemas/migrations";
import { migrateEquipmentSchema, ensureEquipmentDefined } from "../../src/mise-graph/equipment";
import { upsertMember } from "../../src/mise-graph/household-members";
import { setTraditions } from "../../src/mise-graph/onboarding-bulk";
import {
	answerOnboarding,
	startOnboarding,
} from "../../src/mise-graph/onboarding";
import { TIER_0_QUESTIONS } from "../../src/mise-graph/onboarding-questions";
import {
	buildSystemPrompt,
	chunkText,
	handleAgentChefRoute,
	householdIdFromEmail,
	makeSseStream,
	parseToolCalls,
	resolveHouseholdId,
	runAgentChef,
	stringifyToolResult,
	CHEF_ALLOWED_TOOLS,
	TOOL_RESULT_TRUNCATION_LIMIT,
	type AgentChefRouteEnv,
	type ChefEvent,
} from "../../src/mise-graph/agent-chef-route";
import { chefStatusCheck } from "../../src/mise-graph/chef-dispatch";
import type { MeshClaudeResponse } from "../../src/mise-graph/llm-bridge";
import type { MiseGraphEnv } from "../../src/mise-graph/types";

async function collectSSE(stream: ReadableStream<Uint8Array>): Promise<ChefEvent[]> {
	const decoder = new TextDecoder();
	const reader = stream.getReader();
	let buf = "";
	const events: ChefEvent[] = [];
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		buf += decoder.decode(value, { stream: true });
		const parts = buf.split("\n\n");
		buf = parts.pop() ?? "";
		for (const part of parts) {
			const trimmed = part.trim();
			if (!trimmed.startsWith("data:")) continue;
			const json = trimmed.slice(5).trim();
			if (!json) continue;
			events.push(JSON.parse(json) as ChefEvent);
		}
	}
	if (buf.trim().startsWith("data:")) {
		const json = buf.trim().slice(5).trim();
		if (json) events.push(JSON.parse(json) as ChefEvent);
	}
	return events;
}

async function collectViaEmitter(run: (emit: { send: (e: ChefEvent) => void }) => Promise<void>): Promise<ChefEvent[]> {
	const events: ChefEvent[] = [];
	await run({ send: (e: ChefEvent) => { events.push(e); } });
	return events;
}

const u111: Scenario = {
	id: "u111",
	name: "agent/chef route: onboarding gate, ready→bridge, error path, auth, preflight",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		// ── chunkText sanity ──────────────────────────────────────────────
		const chunks = chunkText("Hey there friend, how are you today?", 10);
		ctx.assert.gt(chunks.length, 1, "chunkText splits long strings");
		ctx.assert.eq(chunks.join(""), "Hey there friend, how are you today?", "chunks rejoin to original");
		ctx.assert.eq(chunkText("", 50).length, 0, "empty input → empty chunks");

		// ── householdIdFromEmail matches web/lib/auth.ts ──────────────────
		ctx.assert.eq(
			householdIdFromEmail("Corey@experialstudio.com"),
			"hh_corey_experialstudio_com",
			"slug rule: lowercase + non-alnum → underscore",
		);

		// ── resolveHouseholdId prefers body, then CF Access header ────────
		const reqWithEmail = new Request("https://x/agent/chef", {
			method: "POST",
			headers: { "Cf-Access-Authenticated-User-Email": "user@example.com" },
		});
		ctx.assert.eq(
			resolveHouseholdId(reqWithEmail, { message: "" }),
			"hh_user_example_com",
			"resolveHouseholdId reads CF Access header when body lacks household_id",
		);
		ctx.assert.eq(
			resolveHouseholdId(reqWithEmail, { message: "", household_id: "hh_explicit" }),
			"hh_explicit",
			"resolveHouseholdId prefers explicit body household_id",
		);
		const reqNoEmail = new Request("https://x/agent/chef", { method: "POST" });
		ctx.assert.eq(
			resolveHouseholdId(reqNoEmail, { message: "" }),
			null,
			"resolveHouseholdId returns null when no body id and no CF Access header",
		);

		// ── DB setup for status checks ────────────────────────────────────
		const db = createMockD1();
		const baseEnv = { DB: db as unknown as D1Database } as MiseGraphEnv;
		await migrateHouseholdMemorySchema(baseEnv);
		await migrateOnboardingSchema(baseEnv);
		await migrateEquipmentSchema(baseEnv);

		// ── 1. Onboarding gate — bridge must NOT be called ────────────────
		const HH_NEW = "hh_u111_new";
		let bridgeCalls = 0;
		const events1 = await collectViaEmitter(emit =>
			runAgentChef(emit as { send: (e: ChefEvent) => void; close?: () => void }, {
				body: { message: "plan me dinners" },
				household_id: HH_NEW,
				env: baseEnv as AgentChefRouteEnv,
				bridge: async () => {
					bridgeCalls++;
					return { ok: true, sessionId: null, text: "should not run", elapsedMs: 0, messageCount: 0, toolCalls: 0, yieldDetected: false };
				},
				chunkDelayMs: 0,
			}),
		);
		ctx.assert.eq(bridgeCalls, 0, "onboarding-blocked household never reaches the bridge");
		ctx.assert.eq(events1[0]?.kind, "status", "first event is status");
		const ui1 = events1.find(e => e.kind === "ui_component");
		ctx.assert.ok(!!ui1, "ui_component event emitted");
		if (ui1 && ui1.kind === "ui_component") {
			ctx.assert.eq(ui1.component.component, "onboarding_question", "ui_component is onboarding_question");
		}
		const last1 = events1[events1.length - 1];
		ctx.assert.eq(last1.kind, "done", "terminal event is done");
		if (last1.kind === "done") {
			ctx.assert.eq(last1.reason, "blocked_on_onboarding", "done.reason flags the onboarding short-circuit");
		}

		// ── 2. Ready household — bridge runs, text streams ────────────────
		const HH_READY = "hh_u111_ready";
		await startOnboarding(baseEnv, { household_id: HH_READY });
		for (const q of TIER_0_QUESTIONS) {
			const sample = q.options ? q.options[0].value : "Sample answer";
			await answerOnboarding(baseEnv, { household_id: HH_READY, question_kind: q.kind, response_text: sample });
		}
		// Tier-1 answers so signals populate.
		await answerOnboarding(baseEnv, { household_id: HH_READY, question_kind: "tier_1_avoidances", response_text: "no peanuts" });
		await answerOnboarding(baseEnv, { household_id: HH_READY, question_kind: "tier_1_dinner_ritual", response_text: "table" });
		await answerOnboarding(baseEnv, { household_id: HH_READY, question_kind: "tier_1_cook_frequency", response_text: "most" });
		await answerOnboarding(baseEnv, { household_id: HH_READY, question_kind: "tier_1_pantry_intake", response_text: "gradual" });
		await upsertMember(baseEnv, {
			household_id: HH_READY,
			display_name: "Corey",
			age_group: "adult",
			dietary: [],
			preferences: { loves: [], dislikes: [], allergies: [] },
		});
		await setTraditions(baseEnv, {
			household_id: HH_READY,
			traditions: [{ name: "Friday Pizza Night", cadence: "weekly:friday", description: "homemade pies" }],
		});
		for (const slug of ["dutch_oven", "wok"]) {
			await ensureEquipmentDefined(baseEnv, HH_READY, slug);
		}

		const readyStatus = await chefStatusCheck(baseEnv, { household_id: HH_READY });
		ctx.assert.eq(readyStatus.onboarding.tier_1_done, true, "fixture: ready household is tier 1 done");

		// Mesh env needs to be present so runAgentChef doesn't bail early on
		// the "no_bridge" guard. The fake bridge replaces the real call.
		const readyEnv: AgentChefRouteEnv = {
			...baseEnv,
			MESH: { fetch: async () => new Response("{}") },
			BRIDGE_HOST: "100.96.0.10",
			BRIDGE_PORT: "8484",
			BRIDGE_SECRET: "test_secret",
		};

		let receivedSystem = "";
		let receivedPrompt = "";
		const fakeBridge = async (
			_env: unknown,
			req: { prompt: string; system?: string; model?: string },
		): Promise<MeshClaudeResponse> => {
			receivedSystem = req.system ?? "";
			receivedPrompt = req.prompt;
			return {
				ok: true,
				sessionId: "sess_fake",
				text: "Tonight you've got pasta on deck — keep it loose, garlic-forward.",
				elapsedMs: 12,
				messageCount: 1,
				toolCalls: 0,
				yieldDetected: false,
			};
		};

		const events2 = await collectViaEmitter(emit =>
			runAgentChef(emit as { send: (e: ChefEvent) => void; close?: () => void }, {
				body: {
					message: "what's tonight",
					history: [
						{ role: "user", content: "hi" },
						{ role: "assistant", content: "hey corey" },
					],
				},
				household_id: HH_READY,
				env: readyEnv,
				bridge: fakeBridge,
				chunkDelayMs: 0,
			}),
		);
		ctx.assert.eq(events2[0]?.kind, "status", "first event is status");
		const thinking = events2.find(e => e.kind === "thinking_start");
		ctx.assert.ok(!!thinking, "thinking_start emitted");
		const textEvents = events2.filter(e => e.kind === "text") as Array<Extract<ChefEvent, { kind: "text" }>>;
		ctx.assert.gt(textEvents.length, 0, "at least one text delta emitted");
		const reconstructed = textEvents.map(e => e.delta).join("");
		ctx.assert.eq(
			reconstructed,
			"Tonight you've got pasta on deck — keep it loose, garlic-forward.",
			"text deltas reconstruct to bridge response",
		);
		const last2 = events2[events2.length - 1];
		ctx.assert.eq(last2.kind, "done", "terminal event is done");
		if (last2.kind === "done") {
			ctx.assert.eq(last2.reason, "stop", "done.reason is stop on success");
		}
		ctx.assert.contains(receivedSystem, "Spence", "system prompt declares Spence persona");
		ctx.assert.contains(receivedSystem, "Friday Pizza Night", "system prompt includes household tradition");
		ctx.assert.contains(receivedSystem, "dutch_oven", "system prompt includes equipment");
		ctx.assert.contains(receivedPrompt, "what's tonight", "user prompt carries the message");
		ctx.assert.contains(receivedPrompt, "Recent conversation", "user prompt prepends history when present");

		// ── buildSystemPrompt unit ────────────────────────────────────────
		const sysWithSignals = buildSystemPrompt(readyStatus, readyStatus.signals, HH_READY);
		ctx.assert.contains(sysWithSignals, "Available tools", "system prompt lists tool catalog");
		ctx.assert.contains(sysWithSignals, "chef_status_check", "tool catalog mentions chef_status_check");
		ctx.assert.contains(sysWithSignals, "[[TOOL_CALL]]", "system prompt teaches the tool-call wire format");
		ctx.assert.contains(sysWithSignals, HH_READY, "system prompt embeds the resolved household_id");

		// ── 3. Bridge error path ──────────────────────────────────────────
		const events3 = await collectViaEmitter(emit =>
			runAgentChef(emit as { send: (e: ChefEvent) => void; close?: () => void }, {
				body: { message: "what's tonight" },
				household_id: HH_READY,
				env: readyEnv,
				bridge: async () => ({
					ok: false,
					sessionId: null,
					text: null,
					elapsedMs: 5,
					messageCount: 0,
					toolCalls: 0,
					yieldDetected: false,
					error: "bridge offline",
				}),
				chunkDelayMs: 0,
			}),
		);
		const err3 = events3.find(e => e.kind === "error");
		ctx.assert.ok(!!err3, "bridge error surfaces as an error event");
		if (err3 && err3.kind === "error") {
			ctx.assert.contains(err3.message, "bridge offline", "error message echoes bridge.error");
		}
		const last3 = events3[events3.length - 1];
		if (last3.kind === "done") {
			ctx.assert.eq(last3.reason, "bridge_error", "done.reason is bridge_error after error event");
		}

		// ── 3a. parseToolCalls + stringifyToolResult units ───────────────
		const parsedNone = parseToolCalls("Just a plain reply, nothing structured here.");
		ctx.assert.eq(parsedNone.calls.length, 0, "no tool calls when text is plain");
		ctx.assert.contains(parsedNone.leadingText, "plain reply", "leading text preserved when no calls");

		const parsedOne = parseToolCalls(
			"Reading your pantry now.\n[[TOOL_CALL]]\n{\"name\": \"inspire_read_household_signals\", \"args\": {\"household_id\": \"hh_x\"}}\n[[/TOOL_CALL]]\nDone.",
		);
		ctx.assert.eq(parsedOne.calls.length, 1, "single tool-call envelope parsed");
		ctx.assert.eq(parsedOne.calls[0].name, "inspire_read_household_signals", "tool name extracted");
		ctx.assert.eq(parsedOne.calls[0].args.household_id, "hh_x", "tool args extracted");
		ctx.assert.contains(parsedOne.leadingText, "Reading your pantry", "leading text strips the call block");
		ctx.assert.contains(parsedOne.leadingText, "Done.", "trailing text preserved");

		const parsedMulti = parseToolCalls(
			"[[TOOL_CALL]]\n{\"name\":\"plan_list\",\"args\":{}}\n[[/TOOL_CALL]]\n[[TOOL_CALL]]\n{\"name\":\"plan_read_summary\",\"args\":{\"plan_id\":\"p1\"}}\n[[/TOOL_CALL]]",
		);
		ctx.assert.eq(parsedMulti.calls.length, 2, "two tool-call envelopes parsed");
		ctx.assert.eq(parsedMulti.calls[1].name, "plan_read_summary", "second envelope's name");

		const parsedMalformed = parseToolCalls("[[TOOL_CALL]]\nnot json at all\n[[/TOOL_CALL]]");
		ctx.assert.eq(parsedMalformed.calls.length, 0, "malformed envelopes are dropped");

		const big = stringifyToolResult({
			ok: true,
			big_string: "x".repeat(5000),
		});
		ctx.assert.ok(big.text.length <= TOOL_RESULT_TRUNCATION_LIMIT + 200, "stringifyToolResult respects budget");
		ctx.assert.eq(big.truncated, true, "stringifyToolResult flags truncation");
		// Must remain JSON-valid after truncation.
		JSON.parse(big.text);

		const small = stringifyToolResult({ ok: true, x: 1 });
		ctx.assert.eq(small.truncated, false, "small payloads are not flagged");

		// ── 3b. Single tool call → dispatch → result feeds follow-up ─────
		const HH_TOOL = HH_READY;
		const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
		const fakeTools = async (
			name: string,
			args: Record<string, unknown>,
			_env: MiseGraphEnv,
		): Promise<Record<string, unknown>> => {
			toolCalls.push({ name, args });
			if (name === "inspire_read_household_signals") {
				return { ok: true, household_id: args.household_id, pantry_top: [{ category: "grains", items: ["rice", "oats"] }] };
			}
			return { ok: true };
		};

		const bridgeReplies: string[] = [
			"Let me check.\n[[TOOL_CALL]]\n{\"name\":\"inspire_read_household_signals\",\"args\":{\"household_id\":\"" + HH_TOOL + "\"}}\n[[/TOOL_CALL]]",
			"You've got rice and oats on hand.",
		];
		let bridgeIdx = 0;
		const fakeBridge2 = async (): Promise<MeshClaudeResponse> => ({
			ok: true,
			sessionId: null,
			text: bridgeReplies[bridgeIdx++] ?? "(no more)",
			elapsedMs: 1,
			messageCount: 1,
			toolCalls: 0,
			yieldDetected: false,
		});

		const events4 = await collectViaEmitter(emit =>
			runAgentChef(emit as { send: (e: ChefEvent) => void; close?: () => void }, {
				body: { message: "what's in my pantry" },
				household_id: HH_TOOL,
				env: readyEnv,
				bridge: fakeBridge2,
				toolDispatcher: fakeTools,
				chunkDelayMs: 0,
			}),
		);
		const startEvents = events4.filter(e => e.kind === "tool_call_start");
		const resultEvents = events4.filter(e => e.kind === "tool_call_result");
		ctx.assert.eq(startEvents.length, 1, "single tool_call_start emitted");
		ctx.assert.eq(resultEvents.length, 1, "single tool_call_result emitted");
		ctx.assert.eq(toolCalls.length, 1, "tool dispatcher called once");
		ctx.assert.eq(toolCalls[0].name, "inspire_read_household_signals", "right tool dispatched");
		ctx.assert.eq(toolCalls[0].args.household_id, HH_TOOL, "household_id forced into tool args");
		const iterEvents = events4.filter(e => e.kind === "iteration_start");
		ctx.assert.gte(iterEvents.length, 2, "at least two bridge iterations");
		const finalText4 = events4
			.filter(e => e.kind === "text")
			.map(e => (e as Extract<ChefEvent, { kind: "text" }>).delta)
			.join("");
		ctx.assert.contains(finalText4, "rice and oats", "final text reflects tool result");

		// ── 3c. Multiple tool calls in one bridge response ───────────────
		const multiCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
		const multiTools = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
			multiCalls.push({ name, args });
			return { ok: true, name };
		};
		const multiReplies = [
			"[[TOOL_CALL]]\n{\"name\":\"plan_list\",\"args\":{\"household_id\":\"" + HH_TOOL + "\"}}\n[[/TOOL_CALL]]\n[[TOOL_CALL]]\n{\"name\":\"household_get_traits\",\"args\":{\"household_id\":\"" + HH_TOOL + "\"}}\n[[/TOOL_CALL]]",
			"Got it — both reads done.",
		];
		let mIdx = 0;
		const events5 = await collectViaEmitter(emit =>
			runAgentChef(emit as { send: (e: ChefEvent) => void; close?: () => void }, {
				body: { message: "audit me" },
				household_id: HH_TOOL,
				env: readyEnv,
				bridge: async () => ({ ok: true, sessionId: null, text: multiReplies[mIdx++] ?? "", elapsedMs: 1, messageCount: 1, toolCalls: 0, yieldDetected: false }),
				toolDispatcher: multiTools as unknown as Parameters<typeof runAgentChef>[1]["toolDispatcher"],
				chunkDelayMs: 0,
			}),
		);
		const startsM = events5.filter(e => e.kind === "tool_call_start");
		ctx.assert.eq(startsM.length, 2, "two tool_call_start events from one bridge response");
		ctx.assert.eq(multiCalls.length, 2, "dispatcher called twice");

		// ── 3d. Disallowed tool name → tool_call_error ───────────────────
		const blockReplies = [
			"[[TOOL_CALL]]\n{\"name\":\"plan_lock_meal\",\"args\":{\"plan_id\":\"p1\"}}\n[[/TOOL_CALL]]",
			"Can't do that — different tool needed.",
		];
		let bIdx = 0;
		const blockedDispatched: string[] = [];
		const blockedTools = async (name: string): Promise<Record<string, unknown>> => {
			blockedDispatched.push(name);
			return { ok: true };
		};
		const events6 = await collectViaEmitter(emit =>
			runAgentChef(emit as { send: (e: ChefEvent) => void; close?: () => void }, {
				body: { message: "lock my meal" },
				household_id: HH_TOOL,
				env: readyEnv,
				bridge: async () => ({ ok: true, sessionId: null, text: blockReplies[bIdx++] ?? "", elapsedMs: 1, messageCount: 1, toolCalls: 0, yieldDetected: false }),
				toolDispatcher: blockedTools as unknown as Parameters<typeof runAgentChef>[1]["toolDispatcher"],
				chunkDelayMs: 0,
			}),
		);
		const errEvent = events6.find(e => e.kind === "tool_call_error");
		ctx.assert.ok(!!errEvent, "disallowed tool emits tool_call_error");
		if (errEvent && errEvent.kind === "tool_call_error") {
			ctx.assert.contains(errEvent.message, "tool not allowed", "error message labels the disallow");
			ctx.assert.eq(errEvent.tool, "plan_lock_meal", "error names the offending tool");
		}
		ctx.assert.eq(blockedDispatched.length, 0, "disallowed tool never reaches the dispatcher");
		ctx.assert.ok(!CHEF_ALLOWED_TOOLS.has("plan_lock_meal"), "fixture: plan_lock_meal is correctly off-list");

		// ── 3e. Bridge response without tool calls → final text path ────
		const noToolBridge = async (): Promise<MeshClaudeResponse> => ({
			ok: true,
			sessionId: null,
			text: "Just chatting — nothing to look up.",
			elapsedMs: 1,
			messageCount: 1,
			toolCalls: 0,
			yieldDetected: false,
		});
		const events7 = await collectViaEmitter(emit =>
			runAgentChef(emit as { send: (e: ChefEvent) => void; close?: () => void }, {
				body: { message: "hey" },
				household_id: HH_TOOL,
				env: readyEnv,
				bridge: noToolBridge,
				toolDispatcher: async () => ({}),
				chunkDelayMs: 0,
			}),
		);
		const tEvents7 = events7.filter(e => e.kind === "tool_call_start");
		ctx.assert.eq(tEvents7.length, 0, "no tool dispatch when bridge returns plain text");
		const final7 = events7
			.filter(e => e.kind === "text")
			.map(e => (e as Extract<ChefEvent, { kind: "text" }>).delta)
			.join("");
		ctx.assert.contains(final7, "Just chatting", "plain-text bridge response surfaces verbatim");

		// ── 3f. Iteration cap reached → fallback text + done ─────────────
		const loopReplies = [
			"[[TOOL_CALL]]\n{\"name\":\"plan_list\",\"args\":{\"household_id\":\"" + HH_TOOL + "\"}}\n[[/TOOL_CALL]]",
			"[[TOOL_CALL]]\n{\"name\":\"plan_list\",\"args\":{\"household_id\":\"" + HH_TOOL + "\"}}\n[[/TOOL_CALL]]",
		];
		let loopIdx = 0;
		const loopBridge = async (): Promise<MeshClaudeResponse> => ({
			ok: true,
			sessionId: null,
			text: loopReplies[Math.min(loopIdx++, loopReplies.length - 1)],
			elapsedMs: 1,
			messageCount: 1,
			toolCalls: 0,
			yieldDetected: false,
		});
		const events8 = await collectViaEmitter(emit =>
			runAgentChef(emit as { send: (e: ChefEvent) => void; close?: () => void }, {
				body: { message: "loop me" },
				household_id: HH_TOOL,
				env: readyEnv,
				bridge: loopBridge,
				toolDispatcher: async () => ({ ok: true }),
				chunkDelayMs: 0,
				maxIterations: 2,
			}),
		);
		const last8 = events8[events8.length - 1];
		ctx.assert.eq(last8.kind, "done", "iteration cap still terminates with done");
		const iterCount8 = events8.filter(e => e.kind === "iteration_start").length;
		ctx.assert.eq(iterCount8, 2, "iteration cap clamps bridge round-trips");

		// ── 4. handleAgentChefRoute: missing auth → 401 ───────────────────
		const route401 = await handleAgentChefRoute(
			new Request("https://w/agent/chef", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ message: "hi" }),
			}),
			baseEnv as AgentChefRouteEnv,
		);
		ctx.assert.eq(route401.status, 401, "missing household_id + no CF Access header → 401");

		// ── 5. OPTIONS preflight → 204 with CORS ──────────────────────────
		const preflight = await handleAgentChefRoute(
			new Request("https://w/agent/chef", {
				method: "OPTIONS",
				headers: { Origin: "http://localhost:3000" },
			}),
			baseEnv as AgentChefRouteEnv,
		);
		ctx.assert.eq(preflight.status, 204, "OPTIONS preflight returns 204");
		ctx.assert.eq(
			preflight.headers.get("Access-Control-Allow-Origin"),
			"http://localhost:3000",
			"preflight echoes localhost:3000 when origin matches",
		);
		ctx.assert.contains(
			preflight.headers.get("Access-Control-Allow-Methods") ?? "",
			"POST",
			"preflight allows POST",
		);

		// ── 6. SSE wire format: makeSseStream emits `data: <json>\n\n` ────
		const stream = makeSseStream(async emit => {
			emit.send({ kind: "thinking_start" });
			emit.send({ kind: "text", delta: "hello" });
			emit.send({ kind: "done", reason: "stop" });
		});
		const sseEvents = await collectSSE(stream);
		ctx.assert.eq(sseEvents.length, 3, "SSE stream parsed back to 3 events");
		ctx.assert.eq(sseEvents[0].kind, "thinking_start", "first SSE event is thinking_start");
		ctx.assert.eq(sseEvents[2].kind, "done", "last SSE event is done");

		ctx.notes.push("u111 chunkText/system/SSE/bridge/auth all wired");
	},
};

export default u111;

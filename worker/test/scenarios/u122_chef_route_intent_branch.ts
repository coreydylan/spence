// U122 — /agent/chef Phase 3 intent branching.
//
// Verifies that runAgentChef:
//   1. Emits an SSE `intent` event after the status check.
//   2. quick:save_preference → calls member_list + member_update_preferences
//      DIRECTLY (no bridge round-trip), streams a confirmation, done(stop).
//   3. quick:add_to_pantry → calls household_set_pantry_bulk DIRECTLY, streams
//      confirmation, done(stop). Bridge never invoked.
//   4. quick:add_equipment → calls household_set_equipment_bulk DIRECTLY.
//   5. quick:set_tradition → calls household_set_traditions DIRECTLY.
//   6. free_chat → falls through to the existing Code Mode + bridge loop.
//   7. workflow:onboard → falls through to bridge (Phase 2 will hook the
//      workflow trigger; for now we verify the fall-through path).
//   8. quick:save_preference with no adults → falls through (lets the bridge
//      handle context, e.g. members must be added first).
//
// We use intentOverride to inject the classification, plus a fake bridge +
// fake tool dispatcher to keep the test fast and deterministic.

import type { Scenario } from "../lib/types";
import { createMockD1 } from "../lib/mock-d1";
import { migrateHouseholdMemorySchema } from "../../src/mise-graph/admin-household-memory";
import { migrateOnboardingSchema } from "../../src/mise-graph/schemas/migrations";
import { migrateEquipmentSchema, ensureEquipmentDefined } from "../../src/mise-graph/equipment";
import { upsertMember } from "../../src/mise-graph/household-members";
import { setTraditions } from "../../src/mise-graph/onboarding-bulk";
import { answerOnboarding, startOnboarding } from "../../src/mise-graph/onboarding";
import { TIER_0_QUESTIONS } from "../../src/mise-graph/onboarding-questions";
import {
	runAgentChef,
	type AgentChefRouteEnv,
	type ChefEvent,
} from "../../src/mise-graph/agent-chef-route";
import type { MeshClaudeResponse } from "../../src/mise-graph/llm-bridge";
import type { ChefIntent } from "../../src/mise-graph/intent-router";
import type { MiseGraphEnv } from "../../src/mise-graph/types";

async function collect(
	run: (emit: { send: (e: ChefEvent) => void }) => Promise<void>,
): Promise<ChefEvent[]> {
	const events: ChefEvent[] = [];
	await run({ send: (e: ChefEvent) => events.push(e) });
	return events;
}

const u122: Scenario = {
	id: "u122",
	name: "agent/chef route: Phase 3 intent classification + direct MCP branches",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		// ── Fixture: a tier-1-ready household with one adult member ───────
		const db = createMockD1();
		const baseEnv = { DB: db as unknown as D1Database } as MiseGraphEnv;
		await migrateHouseholdMemorySchema(baseEnv);
		await migrateOnboardingSchema(baseEnv);
		await migrateEquipmentSchema(baseEnv);

		const HH = "hh_u122";
		await startOnboarding(baseEnv, { household_id: HH });
		for (const q of TIER_0_QUESTIONS) {
			const sample = q.options ? q.options[0].value : "Sample answer";
			await answerOnboarding(baseEnv, {
				household_id: HH,
				question_kind: q.kind,
				response_text: sample,
			});
		}
		await answerOnboarding(baseEnv, { household_id: HH, question_kind: "tier_1_avoidances", response_text: "no peanuts" });
		await answerOnboarding(baseEnv, { household_id: HH, question_kind: "tier_1_dinner_ritual", response_text: "table" });
		await answerOnboarding(baseEnv, { household_id: HH, question_kind: "tier_1_cook_frequency", response_text: "most" });
		await answerOnboarding(baseEnv, { household_id: HH, question_kind: "tier_1_pantry_intake", response_text: "gradual" });
		await upsertMember(baseEnv, {
			household_id: HH,
			display_name: "Corey",
			age_group: "adult",
			dietary: [],
			preferences: { loves: [], dislikes: [], allergies: [] },
		});
		await setTraditions(baseEnv, {
			household_id: HH,
			traditions: [{ name: "Friday Pizza Night", cadence: "weekly:friday" }],
		});
		await ensureEquipmentDefined(baseEnv, HH, "dutch_oven");

		const readyEnv: AgentChefRouteEnv = {
			...baseEnv,
			MESH: { fetch: async () => new Response("{}") },
			BRIDGE_HOST: "100.96.0.10",
			BRIDGE_PORT: "8484",
			BRIDGE_SECRET: "test_secret",
		};

		const ADULT_MEMBER_ID = "mem_adult_u122";
		const KID_MEMBER_ID = "mem_kid_u122";

		// Tool dispatcher that records every call and returns canned replies.
		// We DON'T touch the real plan-world MCP because the intent branch
		// only needs the dispatch surface.
		type Call = { name: string; args: Record<string, unknown> };
		function makeDispatcher(
			members: Array<{ member_id: string; age_group: string }> = [
				{ member_id: ADULT_MEMBER_ID, age_group: "adult" },
				{ member_id: KID_MEMBER_ID, age_group: "child" },
			],
		): { calls: Call[]; dispatch: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>> } {
			const calls: Call[] = [];
			const dispatch = async (
				name: string,
				args: Record<string, unknown>,
			): Promise<Record<string, unknown>> => {
				calls.push({ name, args });
				if (name === "member_list") return { members };
				return { ok: true };
			};
			return { calls, dispatch };
		}

		// Bridge counter — we want to assert it's NEVER invoked on quick:* paths.
		function makeBridge(): {
			bridgeCalls: number;
			bridge: (env: unknown, req: { prompt: string; system?: string; model?: string }) => Promise<MeshClaudeResponse>;
		} {
			const obj = {
				bridgeCalls: 0,
				bridge: async (): Promise<MeshClaudeResponse> => {
					obj.bridgeCalls++;
					return {
						ok: true,
						sessionId: "sess_fake",
						text: "I shouldn't be here.",
						elapsedMs: 1,
						messageCount: 1,
						toolCalls: 0,
						yieldDetected: false,
					};
				},
			};
			return obj;
		}

		// ── 1. quick:save_preference → direct MCP, no bridge ───────────────
		{
			const intent: ChefIntent = {
				kind: "quick:save_preference",
				confidence: 0.95,
				field: "dietary",
				values: ["vegetarian"],
			};
			const { calls, dispatch } = makeDispatcher();
			const bridge = makeBridge();
			const events = await collect(emit =>
				runAgentChef(emit as { send: (e: ChefEvent) => void; close?: () => void }, {
					body: { message: "we are vegetarian" },
					household_id: HH,
					env: readyEnv,
					bridge: bridge.bridge,
					toolDispatcher: dispatch as never,
					intentOverride: intent,
					chunkDelayMs: 0,
				}),
			);

			ctx.assert.eq(bridge.bridgeCalls, 0, "save_preference: bridge never invoked");

			const intentEvt = events.find(e => e.kind === "intent");
			ctx.assert.ok(!!intentEvt, "save_preference: intent event emitted");
			if (intentEvt && intentEvt.kind === "intent") {
				ctx.assert.eq(intentEvt.intent.kind, "quick:save_preference", "save_preference: intent.kind");
			}

			const memberList = calls.find(c => c.name === "member_list");
			ctx.assert.ok(!!memberList, "save_preference: member_list called");
			const updateCalls = calls.filter(c => c.name === "member_update_preferences");
			ctx.assert.eq(updateCalls.length, 1, "save_preference: 1 adult updated (kid skipped)");
			ctx.assert.eq(updateCalls[0].args.member_id, ADULT_MEMBER_ID, "save_preference: adult member_id used");
			ctx.assert.eq(
				(updateCalls[0].args.dietary as string[]).join(","),
				"vegetarian",
				"save_preference: dietary list passed through",
			);
			ctx.assert.eq(updateCalls[0].args.household_id, HH, "save_preference: household_id forced into args");

			const finalText = events
				.filter(e => e.kind === "text")
				.map(e => (e as Extract<ChefEvent, { kind: "text" }>).delta)
				.join("");
			ctx.assert.contains(finalText, "vegetarian", "save_preference: confirmation mentions value");

			const last = events[events.length - 1];
			ctx.assert.eq(last.kind, "done", "save_preference: terminates on done");
			if (last.kind === "done") ctx.assert.eq(last.reason, "stop", "save_preference: done.reason=stop");
		}

		// ── 1b. quick:save_preference with NO adults → fall through ───────
		{
			const intent: ChefIntent = {
				kind: "quick:save_preference",
				confidence: 0.9,
				field: "allergies",
				values: ["peanuts"],
			};
			const { calls, dispatch } = makeDispatcher([
				{ member_id: KID_MEMBER_ID, age_group: "child" },
			]);
			const bridge = makeBridge();
			await collect(emit =>
				runAgentChef(emit as { send: (e: ChefEvent) => void; close?: () => void }, {
					body: { message: "no peanuts" },
					household_id: HH,
					env: readyEnv,
					bridge: bridge.bridge,
					toolDispatcher: dispatch as never,
					intentOverride: intent,
					chunkDelayMs: 0,
				}),
			);
			ctx.assert.eq(bridge.bridgeCalls, 1, "save_preference w/o adults: falls through to bridge");
			const updateCalls = calls.filter(c => c.name === "member_update_preferences");
			ctx.assert.eq(updateCalls.length, 0, "save_preference w/o adults: no member updates");
		}

		// ── 2. quick:add_to_pantry → direct MCP, no bridge ─────────────────
		{
			const intent: ChefIntent = {
				kind: "quick:add_to_pantry",
				confidence: 0.9,
				items: ["olive oil", "chickpeas"],
			};
			const { calls, dispatch } = makeDispatcher();
			const bridge = makeBridge();
			const events = await collect(emit =>
				runAgentChef(emit as { send: (e: ChefEvent) => void; close?: () => void }, {
					body: { message: "I bought olive oil and chickpeas" },
					household_id: HH,
					env: readyEnv,
					bridge: bridge.bridge,
					toolDispatcher: dispatch as never,
					intentOverride: intent,
					chunkDelayMs: 0,
				}),
			);
			ctx.assert.eq(bridge.bridgeCalls, 0, "pantry: bridge never invoked");
			const pantryCall = calls.find(c => c.name === "household_set_pantry_bulk");
			ctx.assert.ok(!!pantryCall, "pantry: household_set_pantry_bulk called");
			if (pantryCall) {
				ctx.assert.eq(pantryCall.args.mode, "text", "pantry: mode=text");
				ctx.assert.contains(String(pantryCall.args.text), "olive oil", "pantry: text includes olive oil");
				ctx.assert.contains(String(pantryCall.args.text), "chickpeas", "pantry: text includes chickpeas");
				ctx.assert.eq(pantryCall.args.household_id, HH, "pantry: household_id forced");
			}
			const finalText = events
				.filter(e => e.kind === "text")
				.map(e => (e as Extract<ChefEvent, { kind: "text" }>).delta)
				.join("");
			ctx.assert.contains(finalText, "olive oil", "pantry: confirmation mentions item");
			const last = events[events.length - 1];
			if (last.kind === "done") ctx.assert.eq(last.reason, "stop", "pantry: done.reason=stop");
		}

		// ── 3. quick:add_equipment → direct MCP, no bridge ────────────────
		{
			const intent: ChefIntent = {
				kind: "quick:add_equipment",
				confidence: 0.9,
				slugs: ["dutch_oven", "instant_pot"],
			};
			const { calls, dispatch } = makeDispatcher();
			const bridge = makeBridge();
			const events = await collect(emit =>
				runAgentChef(emit as { send: (e: ChefEvent) => void; close?: () => void }, {
					body: { message: "I have a dutch oven and an instant pot" },
					household_id: HH,
					env: readyEnv,
					bridge: bridge.bridge,
					toolDispatcher: dispatch as never,
					intentOverride: intent,
					chunkDelayMs: 0,
				}),
			);
			ctx.assert.eq(bridge.bridgeCalls, 0, "equipment: bridge never invoked");
			const eqCall = calls.find(c => c.name === "household_set_equipment_bulk");
			ctx.assert.ok(!!eqCall, "equipment: household_set_equipment_bulk called");
			if (eqCall) {
				const slugs = eqCall.args.equipment_slugs as string[];
				ctx.assert.eq(slugs.length, 2, "equipment: 2 slugs");
				ctx.assert.contains(slugs, "dutch_oven", "equipment: dutch_oven");
				ctx.assert.contains(slugs, "instant_pot", "equipment: instant_pot");
				ctx.assert.eq(eqCall.args.household_id, HH, "equipment: household_id forced");
			}
			const finalText = events
				.filter(e => e.kind === "text")
				.map(e => (e as Extract<ChefEvent, { kind: "text" }>).delta)
				.join("");
			ctx.assert.contains(finalText, "dutch_oven", "equipment: confirmation lists slug");
		}

		// ── 4. quick:set_tradition → direct MCP, no bridge ────────────────
		{
			const intent: ChefIntent = {
				kind: "quick:set_tradition",
				confidence: 0.9,
				name: "taco tuesday",
				cadence: "weekly:tuesday",
			};
			const { calls, dispatch } = makeDispatcher();
			const bridge = makeBridge();
			const events = await collect(emit =>
				runAgentChef(emit as { send: (e: ChefEvent) => void; close?: () => void }, {
					body: { message: "every tuesday is taco tuesday" },
					household_id: HH,
					env: readyEnv,
					bridge: bridge.bridge,
					toolDispatcher: dispatch as never,
					intentOverride: intent,
					chunkDelayMs: 0,
				}),
			);
			ctx.assert.eq(bridge.bridgeCalls, 0, "tradition: bridge never invoked");
			const trCall = calls.find(c => c.name === "household_set_traditions");
			ctx.assert.ok(!!trCall, "tradition: household_set_traditions called");
			if (trCall) {
				const traditions = trCall.args.traditions as Array<{ name: string; cadence: string }>;
				ctx.assert.eq(traditions.length, 1, "tradition: 1 tradition");
				ctx.assert.eq(traditions[0].name, "taco tuesday", "tradition: name");
				ctx.assert.eq(traditions[0].cadence, "weekly:tuesday", "tradition: cadence");
				ctx.assert.eq(trCall.args.household_id, HH, "tradition: household_id forced");
			}
			const finalText = events
				.filter(e => e.kind === "text")
				.map(e => (e as Extract<ChefEvent, { kind: "text" }>).delta)
				.join("");
			ctx.assert.contains(finalText, "taco tuesday", "tradition: confirmation mentions name");
		}

		// ── 5. free_chat → falls through to bridge (existing behaviour) ───
		{
			const intent: ChefIntent = { kind: "free_chat", confidence: 0.95 };
			const { calls, dispatch } = makeDispatcher();
			const bridge = makeBridge();
			const events = await collect(emit =>
				runAgentChef(emit as { send: (e: ChefEvent) => void; close?: () => void }, {
					body: { message: "hi" },
					household_id: HH,
					env: readyEnv,
					bridge: bridge.bridge,
					toolDispatcher: dispatch as never,
					intentOverride: intent,
					chunkDelayMs: 0,
				}),
			);
			ctx.assert.eq(bridge.bridgeCalls, 1, "free_chat: bridge invoked exactly once");
			const intentEvt = events.find(e => e.kind === "intent");
			ctx.assert.ok(!!intentEvt, "free_chat: intent event still emitted");
			ctx.assert.ok(events.some(e => e.kind === "thinking_start"), "free_chat: thinking_start emitted");
			// No quick: tools called.
			const quickToolNames = ["household_set_pantry_bulk", "household_set_equipment_bulk", "household_set_traditions", "member_update_preferences"];
			for (const n of quickToolNames) {
				ctx.assert.eq(calls.find(c => c.name === n), undefined, `free_chat: ${n} not called`);
			}
		}

		// ── 6. workflow:onboard → falls through (Phase 2 wires the binding) ──
		{
			const intent: ChefIntent = { kind: "workflow:onboard", confidence: 0.9 };
			const bridge = makeBridge();
			const { dispatch } = makeDispatcher();
			const events = await collect(emit =>
				runAgentChef(emit as { send: (e: ChefEvent) => void; close?: () => void }, {
					body: { message: "let's continue onboarding" },
					household_id: HH,
					env: readyEnv,
					bridge: bridge.bridge,
					toolDispatcher: dispatch as never,
					intentOverride: intent,
					chunkDelayMs: 0,
				}),
			);
			ctx.assert.eq(bridge.bridgeCalls, 1, "workflow:onboard: falls through to bridge until Phase 2 hooks the binding");
			const intentEvt = events.find(e => e.kind === "intent");
			if (intentEvt && intentEvt.kind === "intent") {
				ctx.assert.eq(intentEvt.intent.kind, "workflow:onboard", "workflow:onboard: intent event recorded");
			}
		}

		// ── 7. workflow:plan → falls through ──────────────────────────────
		{
			const intent: ChefIntent = { kind: "workflow:plan", confidence: 0.9, nights: 1 };
			const bridge = makeBridge();
			const { dispatch } = makeDispatcher();
			await collect(emit =>
				runAgentChef(emit as { send: (e: ChefEvent) => void; close?: () => void }, {
					body: { message: "plan tonight" },
					household_id: HH,
					env: readyEnv,
					bridge: bridge.bridge,
					toolDispatcher: dispatch as never,
					intentOverride: intent,
					chunkDelayMs: 0,
				}),
			);
			ctx.assert.eq(bridge.bridgeCalls, 1, "workflow:plan: falls through to bridge until Phase 2 hooks the binding");
		}

		ctx.notes.push("u122 Phase 3 chef intent branching: 4 quick paths skip bridge; free_chat + workflow:* fall through");
	},
};

export default u122;

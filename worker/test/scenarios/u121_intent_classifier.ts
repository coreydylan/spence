// U121 — Phase 3 Workers AI intent classifier (intent-router.ts).
//
// Pure unit test of the classifier surface:
//   1. Each known intent kind round-trips when the (mocked) model returns
//      well-formed JSON.
//   2. JSON parse failures fall back to free_chat.
//   3. Confidence below INTENT_MIN_CONFIDENCE falls back to free_chat
//      (preserving the model's reported confidence on the fallback).
//   4. Responses with markdown ```json fences and preamble text still parse.
//   5. Missing AI binding → free_chat (router never throws).
//   6. Empty user message → free_chat with confidence 1 (skip the model).
//   7. Underlying model error → free_chat (graceful degradation).
//   8. Required details missing for a quick: intent → free_chat.
//
// We DON'T call Workers AI here. The router accepts a `classifier` injection
// (string-returning fn) so we can return canned outputs as if the model had.

import type { Scenario } from "../lib/types";
import {
	buildClassifierPrompt,
	classifyIntent,
	extractJsonObject,
	freeChatFallback,
	INTENT_CLASSIFIER_MODEL,
	INTENT_MIN_CONFIDENCE,
	invokeClassifier,
	normalizeIntent,
	type ChefIntent,
} from "../../src/mise-graph/intent-router";
import type { MiseGraphEnv, WorkersAiBinding } from "../../src/mise-graph/types";

const env = { DB: null as unknown as D1Database } as MiseGraphEnv;

const u121: Scenario = {
	id: "u121",
	name: "intent-router: classify each intent kind, fall back on parse / low-confidence / missing AI",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		// ── Prompt + constants ──────────────────────────────────────────────
		ctx.assert.eq(
			INTENT_CLASSIFIER_MODEL,
			"@cf/meta/llama-3.2-3b-instruct",
			"classifier model is llama-3.2-3b-instruct",
		);
		ctx.assert.gt(INTENT_MIN_CONFIDENCE, 0, "min confidence is positive");
		const prompt = buildClassifierPrompt(`what's tonight?`);
		ctx.assert.contains(prompt, "free_chat", "prompt enumerates free_chat");
		ctx.assert.contains(prompt, "workflow:plan", "prompt enumerates workflow:plan");
		ctx.assert.contains(prompt, "quick:save_preference", "prompt enumerates quick:save_preference");
		ctx.assert.contains(prompt, "quick:add_to_pantry", "prompt enumerates quick:add_to_pantry");
		ctx.assert.contains(prompt, "quick:add_equipment", "prompt enumerates quick:add_equipment");
		ctx.assert.contains(prompt, "quick:set_tradition", "prompt enumerates quick:set_tradition");
		ctx.assert.contains(prompt, "what's tonight?", "user message embedded in prompt");

		// Quote-injection guard — internal quotes get backslash-escaped so the
		// prompt template stays well-formed.
		const quoted = buildClassifierPrompt('he said "we are vegan"');
		ctx.assert.contains(quoted, '\\"we are vegan\\"', "internal quotes are escaped");

		// ── extractJsonObject — bare, fenced, with preamble ────────────────
		const bare = extractJsonObject('{"intent":"free_chat","confidence":0.95}');
		ctx.assert.ok(!!bare, "bare JSON parses");
		const fenced = extractJsonObject('```json\n{"intent":"free_chat","confidence":0.9}\n```');
		ctx.assert.ok(!!fenced, "fenced JSON parses");
		const preamble = extractJsonObject('Sure!  {"intent":"free_chat","confidence":0.8}  ok?');
		ctx.assert.ok(!!preamble, "JSON with preamble + trailing text parses");
		const nested = extractJsonObject(
			'{"intent":"workflow:plan","confidence":0.9,"constraints":["no peanuts","quick"]}',
		);
		ctx.assert.ok(!!nested, "nested arrays parse");
		const noJson = extractJsonObject("nope, just words.");
		ctx.assert.eq(noJson, null, "no JSON → null");
		const malformed = extractJsonObject('{"intent": "free_chat", "confidence": 0.5,}');
		ctx.assert.eq(malformed, null, "malformed JSON → null");
		const inString = extractJsonObject('{"intent":"free_chat","confidence":0.9,"note":"a } in string"}');
		ctx.assert.ok(!!inString, "braces inside strings don't fool the matcher");

		// ── normalizeIntent shape gates ────────────────────────────────────
		ctx.assert.eq(
			normalizeIntent({ intent: "made_up", confidence: 0.9 }),
			null,
			"unknown intent kind rejected",
		);
		ctx.assert.eq(
			normalizeIntent({ intent: "quick:save_preference", confidence: 0.95, field: "dietary" }),
			null,
			"save_preference without values rejected",
		);
		ctx.assert.eq(
			normalizeIntent({ intent: "quick:save_preference", confidence: 0.95, field: "made_up", values: ["x"] }),
			null,
			"save_preference with unknown field rejected",
		);
		ctx.assert.eq(
			normalizeIntent({ intent: "quick:add_to_pantry", confidence: 0.95, items: [] }),
			null,
			"add_to_pantry with empty items rejected",
		);
		ctx.assert.eq(
			normalizeIntent({ intent: "quick:add_equipment", confidence: 0.95, slugs: [] }),
			null,
			"add_equipment with empty slugs rejected",
		);
		ctx.assert.eq(
			normalizeIntent({ intent: "quick:set_tradition", confidence: 0.95, name: "pizza night" }),
			null,
			"set_tradition without cadence rejected",
		);

		// Confidence is clamped into [0,1].
		const clamped = normalizeIntent({ intent: "free_chat", confidence: 5 });
		ctx.assert.ok(!!clamped, "out-of-range confidence still parses");
		if (clamped) ctx.assert.eq(clamped.confidence, 1, "confidence clamped to 1");
		const negClamped = normalizeIntent({ intent: "free_chat", confidence: -1 });
		if (negClamped) ctx.assert.eq(negClamped.confidence, 0, "negative confidence clamped to 0");

		// ── classifyIntent: each known intent round-trips ──────────────────
		const cases: Array<{
			label: string;
			user: string;
			model: string;
			expect: (i: ChefIntent) => void;
		}> = [
			{
				label: "free_chat",
				user: "hi",
				model: '{"intent":"free_chat","confidence":0.95}',
				expect: i => {
					ctx.assert.eq(i.kind, "free_chat", "free_chat: kind");
					ctx.assert.gte(i.confidence, 0.9, "free_chat: confidence preserved");
				},
			},
			{
				label: "workflow:onboard",
				user: "let's continue onboarding",
				model: '{"intent":"workflow:onboard","confidence":0.92}',
				expect: i => ctx.assert.eq(i.kind, "workflow:onboard", "workflow:onboard: kind"),
			},
			{
				label: "workflow:plan",
				user: "plan tonight",
				model: '{"intent":"workflow:plan","confidence":0.9,"nights":1}',
				expect: i => {
					ctx.assert.eq(i.kind, "workflow:plan", "workflow:plan: kind");
					if (i.kind === "workflow:plan") ctx.assert.eq(i.nights, 1, "workflow:plan: nights=1");
				},
			},
			{
				label: "workflow:debrief_meal",
				user: "I want to debrief last night's dinner",
				model: '{"intent":"workflow:debrief_meal","confidence":0.85,"meal_id":"meal_abc"}',
				expect: i => {
					ctx.assert.eq(i.kind, "workflow:debrief_meal", "debrief: kind");
					if (i.kind === "workflow:debrief_meal")
						ctx.assert.eq(i.meal_id, "meal_abc", "debrief: meal_id parsed");
				},
			},
			{
				label: "quick:save_preference",
				user: "we're vegetarian",
				model: '{"intent":"quick:save_preference","confidence":0.95,"field":"dietary","values":["vegetarian"]}',
				expect: i => {
					ctx.assert.eq(i.kind, "quick:save_preference", "save_preference: kind");
					if (i.kind === "quick:save_preference") {
						ctx.assert.eq(i.field, "dietary", "save_preference: field");
						ctx.assert.eq(i.values.length, 1, "save_preference: 1 value");
						ctx.assert.eq(i.values[0], "vegetarian", "save_preference: vegetarian");
					}
				},
			},
			{
				label: "quick:add_to_pantry",
				user: "I just bought olive oil and chickpeas",
				model:
					'{"intent":"quick:add_to_pantry","confidence":0.9,"items":["olive oil","chickpeas"]}',
				expect: i => {
					ctx.assert.eq(i.kind, "quick:add_to_pantry", "pantry: kind");
					if (i.kind === "quick:add_to_pantry") {
						ctx.assert.eq(i.items.length, 2, "pantry: 2 items");
						ctx.assert.contains(i.items, "olive oil", "pantry: olive oil");
						ctx.assert.contains(i.items, "chickpeas", "pantry: chickpeas");
					}
				},
			},
			{
				label: "quick:add_equipment",
				user: "I have a dutch oven and an instant pot",
				model:
					'{"intent":"quick:add_equipment","confidence":0.9,"slugs":["dutch_oven","instant_pot"]}',
				expect: i => {
					ctx.assert.eq(i.kind, "quick:add_equipment", "equipment: kind");
					if (i.kind === "quick:add_equipment") {
						ctx.assert.eq(i.slugs.length, 2, "equipment: 2 slugs");
						ctx.assert.contains(i.slugs, "dutch_oven", "equipment: dutch_oven");
					}
				},
			},
			{
				label: "quick:set_tradition",
				user: "every Friday is pizza night",
				model:
					'{"intent":"quick:set_tradition","confidence":0.9,"name":"pizza night","cadence":"weekly:friday"}',
				expect: i => {
					ctx.assert.eq(i.kind, "quick:set_tradition", "tradition: kind");
					if (i.kind === "quick:set_tradition") {
						ctx.assert.eq(i.name, "pizza night", "tradition: name");
						ctx.assert.eq(i.cadence, "weekly:friday", "tradition: cadence");
					}
				},
			},
		];

		for (const c of cases) {
			const intent = await classifyIntent(env, c.user, {
				classifier: async () => c.model,
			});
			c.expect(intent);
		}

		// ── Whitespace / preamble / fences ─────────────────────────────────
		const preambleIntent = await classifyIntent(env, "what's tonight", {
			classifier: async () =>
				`Sure thing!\n\`\`\`json\n   {"intent":"workflow:plan","confidence":0.9,"nights":1}\n\`\`\`\n`,
		});
		ctx.assert.eq(preambleIntent.kind, "workflow:plan", "preamble + fences still classify");

		// ── JSON parse failure → free_chat ─────────────────────────────────
		const malformedIntent = await classifyIntent(env, "some message", {
			classifier: async () => "not json at all",
		});
		ctx.assert.eq(malformedIntent.kind, "free_chat", "malformed → free_chat");
		ctx.assert.eq(malformedIntent.confidence, 0, "malformed → confidence 0");

		// ── Low confidence → free_chat (carrying the reported number) ─────
		const lowConfIntent = await classifyIntent(env, "plan tonight maybe", {
			classifier: async () =>
				'{"intent":"workflow:plan","confidence":0.3,"nights":1}',
		});
		ctx.assert.eq(lowConfIntent.kind, "free_chat", "low-confidence → free_chat");
		ctx.assert.eq(lowConfIntent.confidence, 0.3, "low-confidence: number preserved on fallback");

		// free_chat at low confidence is still free_chat (no fallback churn).
		const lowFree = await classifyIntent(env, "hi", {
			classifier: async () => '{"intent":"free_chat","confidence":0.2}',
		});
		ctx.assert.eq(lowFree.kind, "free_chat", "low-conf free_chat passes through");

		// ── Missing required details → free_chat ───────────────────────────
		const missingValues = await classifyIntent(env, "we're vegetarian", {
			classifier: async () =>
				'{"intent":"quick:save_preference","confidence":0.9,"field":"dietary"}',
		});
		ctx.assert.eq(missingValues.kind, "free_chat", "save_pref w/o values → free_chat");

		// ── Empty message — short-circuits without invoking model ──────────
		let invoked = 0;
		const emptyIntent = await classifyIntent(env, "   ", {
			classifier: async () => {
				invoked++;
				return '{"intent":"free_chat","confidence":0.99}';
			},
		});
		ctx.assert.eq(emptyIntent.kind, "free_chat", "empty msg → free_chat");
		ctx.assert.eq(emptyIntent.confidence, 1, "empty msg → confidence 1");
		ctx.assert.eq(invoked, 0, "empty msg short-circuits the classifier");

		// ── Classifier throws → free_chat ──────────────────────────────────
		const throwIntent = await classifyIntent(env, "anything", {
			classifier: async () => {
				throw new Error("model offline");
			},
		});
		ctx.assert.eq(throwIntent.kind, "free_chat", "classifier throw → free_chat");

		// ── No AI binding + no classifier override → free_chat ────────────
		const envNoAi = { DB: null as unknown as D1Database } as MiseGraphEnv;
		const noBinding = await classifyIntent(envNoAi, "we're vegetarian");
		ctx.assert.eq(noBinding.kind, "free_chat", "no AI binding → free_chat");

		// ── invokeClassifier shape: pulls .response off the AI run result ──
		const seenInput: Array<{ model: string; opts: Record<string, unknown> }> = [];
		const fakeAi: WorkersAiBinding = {
			async run(model, opts) {
				seenInput.push({ model, opts: opts as Record<string, unknown> });
				return { response: '{"intent":"free_chat","confidence":0.9}' };
			},
		};
		const raw = await invokeClassifier(fakeAi, "hi");
		ctx.assert.contains(raw, "free_chat", "invokeClassifier returns model text");
		ctx.assert.eq(seenInput.length, 1, "AI.run invoked once");
		ctx.assert.eq(seenInput[0].model, INTENT_CLASSIFIER_MODEL, "model id passed through");
		ctx.assert.eq(seenInput[0].opts.temperature, 0, "temperature=0 for deterministic JSON");
		ctx.assert.eq(seenInput[0].opts.max_tokens, 64, "max_tokens=64");
		const messages = seenInput[0].opts.messages as Array<{ role: string; content: string }>;
		ctx.assert.eq(messages.length, 2, "2 messages: system + user");
		ctx.assert.eq(messages[0].role, "system", "first message is system");

		// invokeClassifier also tolerates a raw-string return.
		const fakeAiString: WorkersAiBinding = {
			async run() {
				return '{"intent":"free_chat","confidence":0.9}' as unknown;
			},
		};
		const rawStr = await invokeClassifier(fakeAiString, "hi");
		ctx.assert.contains(rawStr, "free_chat", "invokeClassifier handles string return");

		// ── End-to-end via env.AI binding (no classifier override) ─────────
		const envWithAi = {
			DB: null as unknown as D1Database,
			AI: {
				async run() {
					return {
						response:
							'{"intent":"quick:add_to_pantry","confidence":0.92,"items":["olive oil"]}',
					};
				},
			},
		} as MiseGraphEnv;
		const e2e = await classifyIntent(envWithAi, "I just bought olive oil");
		ctx.assert.eq(e2e.kind, "quick:add_to_pantry", "e2e through env.AI: pantry");

		// ── Sanity: freeChatFallback shape ─────────────────────────────────
		const fb = freeChatFallback(0.42);
		ctx.assert.eq(fb.kind, "free_chat", "fallback kind");
		ctx.assert.eq(fb.confidence, 0.42, "fallback confidence");

		ctx.notes.push("u121 intent classifier: 8 intent kinds + parse/conf/error fallbacks");
	},
};

export default u121;

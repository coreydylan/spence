// Phase 3 — Workers AI intent router for /agent/chef.
//
// A cheap fast classifier (@cf/meta/llama-3.2-3b-instruct, ~50ms typical)
// decides whether the user's message is free chat, an onboarding-flow
// trigger, a planning trigger, a quick-save trigger, etc. Based on the
// returned intent the chef route can:
//
//   - free_chat              → fall through to the existing Code Mode +
//                              mesh-claude bridge loop
//   - workflow:onboard       → kick off the OnboardingWorkflow (Phase 2)
//   - workflow:plan          → kick off the PlanningWorkflow (Phase 2)
//   - workflow:debrief_meal  → kick off CookSessionDebriefWorkflow (Phase 2)
//   - quick:save_preference  → direct member_update_preferences MCP call
//   - quick:add_to_pantry    → direct household_set_pantry_bulk MCP call
//   - quick:add_equipment    → direct household_set_equipment_bulk MCP call
//   - quick:set_tradition    → direct household_set_traditions MCP call
//
// The classifier returns ONE-SHOT JSON; we parse it defensively. On any
// error (binding missing, model error, malformed JSON, low confidence) we
// default to free_chat so the user is never blocked by the router.

import type { MiseGraphEnv, WorkersAiBinding } from "./types";

// ─── Intent shape ─────────────────────────────────────────────────────────

export type ChefIntent =
	| { kind: "free_chat"; confidence: number }
	| { kind: "workflow:onboard"; confidence: number }
	| {
			kind: "workflow:plan";
			confidence: number;
			nights?: number;
			constraints?: string[];
	  }
	| {
			kind: "workflow:debrief_meal";
			confidence: number;
			meal_id?: string;
	  }
	| {
			kind: "quick:save_preference";
			confidence: number;
			field: "dietary" | "allergies" | "dislikes";
			values: string[];
	  }
	| {
			kind: "quick:add_to_pantry";
			confidence: number;
			items: string[];
	  }
	| {
			kind: "quick:add_equipment";
			confidence: number;
			slugs: string[];
	  }
	| {
			kind: "quick:set_tradition";
			confidence: number;
			name: string;
			cadence: string;
	  };

export type ChefIntentKind = ChefIntent["kind"];

/** Confidence below this rolls back to free_chat. */
export const INTENT_MIN_CONFIDENCE = 0.6;

/** Cloudflare Workers AI model for the classifier. */
export const INTENT_CLASSIFIER_MODEL = "@cf/meta/llama-3.2-3b-instruct";

/** Generation budget for the classifier — JSON is short. */
export const INTENT_MAX_TOKENS = 64;

/** Default fallback intent when anything goes wrong. */
export function freeChatFallback(confidence = 0.0): ChefIntent {
	return { kind: "free_chat", confidence };
}

// ─── Prompt ───────────────────────────────────────────────────────────────

/** One-shot classifier prompt. Returns JSON only. */
export function buildClassifierPrompt(userMessage: string): string {
	const safeMessage = userMessage.replace(/"/g, '\\"').slice(0, 500);
	return [
		"Classify the user's message into ONE of these intents and return JSON only.",
		"",
		"Intents:",
		'- "free_chat" — casual conversation, questions, banter, requests for info',
		'- "workflow:onboard" — user wants to start or continue onboarding',
		'- "workflow:plan" — user wants to plan one or more meals (e.g. "plan tonight", "plan next week")',
		'- "workflow:debrief_meal" — user wants to debrief / log how a recent meal went',
		'- "quick:save_preference" — user states a dietary preference / allergy / dislike',
		'- "quick:add_to_pantry" — user mentions buying or having food items to log',
		'- "quick:add_equipment" — user mentions kitchen equipment they own',
		'- "quick:set_tradition" — user describes a recurring meal pattern',
		"",
		'Return JSON: {"intent": "...", "confidence": 0..1, ...details}',
		"",
		"Examples:",
		'User: "what can I make tonight?"',
		'{"intent": "workflow:plan", "confidence": 0.9, "nights": 1}',
		"",
		'User: "we\'re vegetarian"',
		'{"intent": "quick:save_preference", "confidence": 0.95, "field": "dietary", "values": ["vegetarian"]}',
		"",
		'User: "I just bought olive oil and chickpeas"',
		'{"intent": "quick:add_to_pantry", "confidence": 0.9, "items": ["olive oil", "chickpeas"]}',
		"",
		'User: "I have a dutch oven and an instant pot"',
		'{"intent": "quick:add_equipment", "confidence": 0.9, "slugs": ["dutch_oven", "instant_pot"]}',
		"",
		'User: "every Friday is pizza night"',
		'{"intent": "quick:set_tradition", "confidence": 0.9, "name": "pizza night", "cadence": "weekly:friday"}',
		"",
		'User: "let\'s pick up onboarding"',
		'{"intent": "workflow:onboard", "confidence": 0.9}',
		"",
		'User: "hi"',
		'{"intent": "free_chat", "confidence": 0.95}',
		"",
		`User message: "${safeMessage}"`,
		"JSON:",
	].join("\n");
}

// ─── Workers AI invocation ────────────────────────────────────────────────

/** Internal: call env.AI.run with the standardized options. Exported so tests
 *  can verify the invocation shape. */
export async function invokeClassifier(
	ai: WorkersAiBinding,
	userMessage: string,
): Promise<string> {
	const prompt = buildClassifierPrompt(userMessage);
	const result = (await ai.run(INTENT_CLASSIFIER_MODEL, {
		messages: [
			{
				role: "system",
				content:
					"You are an intent classifier. Respond with ONE JSON object on a single line. No markdown, no preamble, no explanation.",
			},
			{ role: "user", content: prompt },
		],
		max_tokens: INTENT_MAX_TOKENS,
		temperature: 0,
	})) as unknown;

	// Workers AI commonly returns `{ response: "<text>" }` for text-generation
	// models. Some versions return a raw string. Be liberal in what we accept.
	if (typeof result === "string") return result;
	if (result && typeof result === "object") {
		const r = result as Record<string, unknown>;
		if (typeof r.response === "string") return r.response;
		if (typeof r.output === "string") return r.output;
		if (typeof r.result === "string") return r.result;
	}
	return "";
}

// ─── JSON parsing ─────────────────────────────────────────────────────────

/** Best-effort extraction of the first JSON object from a model's reply. The
 *  llama family will sometimes wrap output in ```json fences or write a brief
 *  preamble before the JSON; we tolerate both. */
export function extractJsonObject(text: string): unknown | null {
	if (!text) return null;
	const trimmed = text.trim();
	// Strip ```json fences if present.
	const fenceStripped = trimmed
		.replace(/^```(?:json|JSON)?\s*\n?/, "")
		.replace(/\n?```\s*$/, "")
		.trim();

	// Locate the first '{' and the matching closing '}'.
	const start = fenceStripped.indexOf("{");
	if (start < 0) return null;

	let depth = 0;
	let inString = false;
	let escape = false;
	for (let i = start; i < fenceStripped.length; i++) {
		const ch = fenceStripped[i];
		if (escape) {
			escape = false;
			continue;
		}
		if (ch === "\\") {
			escape = true;
			continue;
		}
		if (ch === '"') {
			inString = !inString;
			continue;
		}
		if (inString) continue;
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) {
				const slice = fenceStripped.slice(start, i + 1);
				try {
					return JSON.parse(slice);
				} catch {
					return null;
				}
			}
		}
	}
	return null;
}

// ─── Intent normalisation ─────────────────────────────────────────────────

const KNOWN_INTENT_KINDS: ReadonlySet<ChefIntentKind> = new Set([
	"free_chat",
	"workflow:onboard",
	"workflow:plan",
	"workflow:debrief_meal",
	"quick:save_preference",
	"quick:add_to_pantry",
	"quick:add_equipment",
	"quick:set_tradition",
]);

const PREFERENCE_FIELDS: ReadonlySet<"dietary" | "allergies" | "dislikes"> =
	new Set(["dietary", "allergies", "dislikes"] as const);

function asString(v: unknown): string | undefined {
	if (typeof v !== "string") return undefined;
	const t = v.trim();
	return t.length > 0 ? t : undefined;
}

function asStringArray(v: unknown): string[] {
	if (!Array.isArray(v)) return [];
	const out: string[] = [];
	for (const item of v) {
		const s = asString(item);
		if (s) out.push(s);
	}
	return out;
}

function asNumber(v: unknown): number | undefined {
	if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
	return v;
}

/** Map a parsed JSON object to a ChefIntent. Returns null when the shape
 *  doesn't match a known intent or required details are missing. */
export function normalizeIntent(parsed: unknown): ChefIntent | null {
	if (!parsed || typeof parsed !== "object") return null;
	const obj = parsed as Record<string, unknown>;

	const rawKind = asString(obj.intent) ?? asString(obj.kind);
	if (!rawKind) return null;
	const kind = rawKind as ChefIntentKind;
	if (!KNOWN_INTENT_KINDS.has(kind)) return null;

	const confidence = clamp01(asNumber(obj.confidence) ?? 0.5);

	switch (kind) {
		case "free_chat":
			return { kind: "free_chat", confidence };
		case "workflow:onboard":
			return { kind: "workflow:onboard", confidence };
		case "workflow:plan": {
			const nights = asNumber(obj.nights);
			const constraints = asStringArray(obj.constraints);
			const out: Extract<ChefIntent, { kind: "workflow:plan" }> = {
				kind: "workflow:plan",
				confidence,
			};
			if (nights !== undefined) out.nights = Math.max(1, Math.round(nights));
			if (constraints.length > 0) out.constraints = constraints;
			return out;
		}
		case "workflow:debrief_meal": {
			const meal_id = asString(obj.meal_id);
			const out: Extract<ChefIntent, { kind: "workflow:debrief_meal" }> = {
				kind: "workflow:debrief_meal",
				confidence,
			};
			if (meal_id) out.meal_id = meal_id;
			return out;
		}
		case "quick:save_preference": {
			const field = asString(obj.field) as
				| "dietary"
				| "allergies"
				| "dislikes"
				| undefined;
			const values = asStringArray(obj.values);
			if (!field || !PREFERENCE_FIELDS.has(field)) return null;
			if (values.length === 0) return null;
			return {
				kind: "quick:save_preference",
				confidence,
				field,
				values,
			};
		}
		case "quick:add_to_pantry": {
			const items = asStringArray(obj.items);
			if (items.length === 0) return null;
			return { kind: "quick:add_to_pantry", confidence, items };
		}
		case "quick:add_equipment": {
			const slugs = asStringArray(obj.slugs);
			if (slugs.length === 0) return null;
			return { kind: "quick:add_equipment", confidence, slugs };
		}
		case "quick:set_tradition": {
			const name = asString(obj.name);
			const cadence = asString(obj.cadence);
			if (!name || !cadence) return null;
			return { kind: "quick:set_tradition", confidence, name, cadence };
		}
	}
}

function clamp01(n: number): number {
	if (!Number.isFinite(n)) return 0;
	if (n < 0) return 0;
	if (n > 1) return 1;
	return n;
}

// ─── Public API ───────────────────────────────────────────────────────────

export interface ClassifyIntentOpts {
	/** Test injection: replaces invokeClassifier. Receives the raw user
	 *  message and should return what the model would have written. */
	classifier?: (userMessage: string) => Promise<string>;
	/** Override the minimum confidence below which we fall back. */
	minConfidence?: number;
}

/** Classify a user message into a ChefIntent. Always resolves — never
 *  rejects — so callers can inline this without try/catch. On any failure
 *  (no AI binding, parse error, low confidence, unknown intent) we return
 *  free_chat with confidence 0. */
export async function classifyIntent(
	env: MiseGraphEnv,
	userMessage: string,
	opts: ClassifyIntentOpts = {},
): Promise<ChefIntent> {
	const message = (userMessage ?? "").trim();
	if (!message) return freeChatFallback(1.0);

	const minConf = opts.minConfidence ?? INTENT_MIN_CONFIDENCE;

	let raw = "";
	try {
		if (opts.classifier) {
			raw = await opts.classifier(message);
		} else if (env.AI) {
			raw = await invokeClassifier(env.AI, message);
		} else {
			// No binding wired — silently fall back. Production wrangler.mise.toml
			// declares the binding; this keeps tests + older configs working.
			return freeChatFallback();
		}
	} catch {
		return freeChatFallback();
	}

	const parsed = extractJsonObject(raw);
	const intent = normalizeIntent(parsed);
	if (!intent) return freeChatFallback();
	if (intent.kind !== "free_chat" && intent.confidence < minConf) {
		return freeChatFallback(intent.confidence);
	}
	return intent;
}

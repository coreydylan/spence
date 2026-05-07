// Chef-of-staff agent loop, hosted on the worker.
//
// The web app's /api/chef route is a thin proxy that streams this route's
// Server-Sent Events (SSE) back to the browser. We host the loop here so we
// can route through the mesh-claude bridge (Corey's CC subscription) instead
// of the Anthropic API — the worker already has the MESH vpc binding wired
// for menu composition.
//
// Wire format (SSE):
//   data: {"kind":"status","status":{...}}
//   data: {"kind":"ui_component","component":{"component":"onboarding_question","props":{...}}}
//   data: {"kind":"thinking_start"}
//   data: {"kind":"iteration_start","iteration_n":1}
//   data: {"kind":"tool_call_start","tool":"...","args":{...},"call_id":"..."}
//   data: {"kind":"tool_call_result","call_id":"...","result":{...}}
//   data: {"kind":"tool_call_error","call_id":"...","tool":"...","message":"..."}
//   data: {"kind":"text","delta":"Hey..."}
//   data: {"kind":"error","message":"..."}
//   data: {"kind":"done","reason":"stop"}
//
// Phase 2 (this file): the bridge's text response is parsed for explicit
// `[[TOOL_CALL]]...[[/TOOL_CALL]]` envelopes. When present, the worker
// executes them via callPlanWorldTool, feeds the results back to the bridge
// in a follow-up prompt, and continues until the bridge returns text without
// any tool calls (or we hit MAX_ITERATIONS).

import { callMeshClaude, type MeshClaudeEnv } from "./llm-bridge";
import { chefStatusCheck, type ChefStatusResult } from "./chef-dispatch";
import { callPlanWorldTool } from "./plan-world-mcp";
import {
	buildExecuteResultBlock,
	executeCode,
	parseCodeBlocks,
	searchTools,
	type CodeModeContext,
	type ExecuteResult,
} from "./code-mode";
import type { HouseholdSignals } from "./household-signals";
import type { MiseGraphEnv } from "./types";
import {
	classifyIntent,
	type ChefIntent,
	type ClassifyIntentOpts,
} from "./intent-router";

// ─── Auth + body parsing ──────────────────────────────────────────────────

const ACCESS_HEADER = "cf-access-authenticated-user-email";

/** Slug an email into a deterministic household_id (matches web/lib/auth.ts). */
export function householdIdFromEmail(email: string): string {
	const safe = email.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
	return `hh_${safe}`;
}

export interface AgentChefBody {
	household_id?: string;
	message: string;
	history?: Array<{ role: "user" | "assistant"; content: string }>;
	/** Optional dev override for unit tests. */
	model?: string;
}

export function resolveHouseholdId(req: Request, body: AgentChefBody): string | null {
	const explicit = body.household_id?.trim();
	if (explicit) return explicit;
	// CF Access fronts the worker in prod and injects the email header.
	const email =
		req.headers.get(ACCESS_HEADER) ??
		req.headers.get(ACCESS_HEADER.toLowerCase()) ??
		req.headers.get("Cf-Access-Authenticated-User-Email");
	if (email && email.trim().length > 0) return householdIdFromEmail(email);
	return null;
}

// ─── Event types ──────────────────────────────────────────────────────────

export type ChefEvent =
	| { kind: "status"; status: ChefStatusResult }
	| { kind: "ui_component"; component: { component: string; props: Record<string, unknown> } }
	// Phase 3 — fast Workers AI classification of the user's message. The
	// client doesn't need to render this for MVP; logging it lets us later
	// surface a "Spence is interpreting…" hint and gives us SSE-replayable
	// evidence of which branch the route took (free_chat vs quick:* vs
	// workflow:*).
	| { kind: "intent"; intent: ChefIntent }
	| { kind: "thinking_start" }
	| { kind: "iteration_start"; iteration_n: number }
	| { kind: "tool_call_start"; tool: string; args: Record<string, unknown>; call_id: string }
	| { kind: "tool_call_result"; call_id: string; tool: string; result: Record<string, unknown>; truncated?: boolean }
	| { kind: "tool_call_error"; call_id: string; tool: string; message: string }
	// Code Mode: emitted around an [[CODE]]…[[/CODE]] block. The
	// tool_call_start/result events for the inner mcp() calls are interleaved
	// between code_execute_start and code_execute_end so clients can render
	// progress while a single execute() runs.
	| { kind: "code_execute_start"; call_id: string; code_preview: string }
	| {
			kind: "code_execute_end";
			call_id: string;
			ok: boolean;
			tool_calls_count: number;
			duration_ms: number;
			return_value?: unknown;
			logs?: string[];
			error?: { message: string };
	  }
	| { kind: "text"; delta: string }
	| { kind: "error"; message: string }
	| { kind: "done"; reason?: string };

// ─── Tool allow-list ──────────────────────────────────────────────────────
//
// Curated set Claude is allowed to call from the chef-of-staff loop. We
// deliberately keep this tight: ~30 tools instead of the 100+ in the MCP
// catalog. Rationale:
//   * Reads cover the bread-and-butter — household signals, current plan,
//     seasonality, weather, calendar, recent menu, format/flavor libraries,
//     and recipe steps.
//   * Plan writes are limited to the safe verbs (create / compose / replace /
//     cancel + audit). No locking, splitting, sliding, or manual ledger ops
//     yet — those are too easy to misuse without a spec.
//   * Member tools cover the common "save my preference" cases (vegetarian,
//     allergies, safety) without exposing presence/skill-tracking.
//   * Household setters cover the common "log my pantry/equipment/tradition"
//     cases without exposing the deeper observation pipeline.
//   * agent_list_plan_traces lets Claude self-introspect ("did I already
//     compose this slot?") without giving it the full trace machinery.
//
// If Claude tries to call something outside this list, we emit a
// tool_call_error and let it adapt — same shape as a tool failure, so the
// follow-up prompt loop handles it naturally.
export const CHEF_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
	"chef_status_check",
	"inspire_read_household_signals",
	"inspire_read_household_context",
	"inspire_read_weather",
	"inspire_read_seasonality",
	"inspire_read_recent_menu",
	"inspire_read_canonical_dishes",
	"inspire_read_recipe_steps",
	"inspire_read_format_library",
	"inspire_read_flavor_vibes",
	"inspire_read_calendar",
	"plan_list",
	"plan_read_map",
	"plan_read_meal",
	"plan_read_grievances",
	"plan_read_summary",
	"plan_read_shopping_list",
	"plan_read_shop_runs",
	"plan_read_recent_meals",
	"plan_create",
	"plan_compose_meal",
	"plan_replace_meal",
	"plan_cancel_meal",
	"plan_audit",
	"plan_score_coherence",
	"member_create",
	"member_update_preferences",
	"member_update_safety",
	"household_set_pantry_bulk",
	"household_set_equipment_bulk",
	"household_set_traditions",
	"household_get_traits",
	"household_read_brief",
	"agent_list_plan_traces",
]);

/** One-line description for each allow-listed tool — feeds the system prompt. */
const TOOL_DESCRIPTIONS: Record<string, string> = {
	chef_status_check: "Onboarding state + household signals. Needs {household_id}.",
	inspire_read_household_signals: "Personality, traditions, equipment, pantry, avoidances.",
	inspire_read_household_context: "Read the canonical household_context (cooks, kids, etc).",
	inspire_read_weather: "Weekly forecast for the household zip. {household_id}.",
	inspire_read_seasonality: "What's seasonal where the household lives. {household_id}.",
	inspire_read_recent_menu: "What the household ate the last few weeks. {household_id, weeks?}.",
	inspire_read_canonical_dishes: "Library of dish archetypes (e.g. risotto, taco). {household_id?}.",
	inspire_read_recipe_steps: "Pull saved step-by-step instructions for a dish.",
	inspire_read_format_library: "Format slot specs (bowl, plate, sandwich…).",
	inspire_read_flavor_vibes: "Flavor-vibe library (light/bright, deep/savoury…).",
	inspire_read_calendar: "Read Google/Outlook calendar windows. {household_id, days?}.",
	plan_list: "List active plans for the household. {household_id}.",
	plan_read_map: "Markdown wall-map of a plan. {plan_id}.",
	plan_read_meal: "Read a single meal slot. {plan_id, slot:{date,slot}}.",
	plan_read_grievances: "Unresolved grievances on a plan. {plan_id}.",
	plan_read_summary: "Plan summary block. {plan_id}.",
	plan_read_shopping_list: "Shopping list for the plan. {plan_id}.",
	plan_read_shop_runs: "Scheduled shop runs for the plan. {plan_id}.",
	plan_read_recent_meals: "Last 14 days of composed meals. {plan_id}.",
	plan_create: "Create a new empty plan. {household_id, start_date, end_date}.",
	plan_compose_meal: "Compose (or replace) a meal at a slot. {plan_id, slot:{date,slot}, ...}.",
	plan_replace_meal: "Replace a composed meal in place. {plan_id, slot:{date,slot}, ...}.",
	plan_cancel_meal: "Cancel a meal slot. {plan_id, slot:{date,slot}}.",
	plan_audit: "Re-run critics for a plan. {plan_id}.",
	plan_score_coherence: "Coherence + grievance counts. {plan_id}.",
	member_create: "Add a household member. {household_id, display_name, age_group, ...}.",
	member_update_preferences: "Update a member's loves/dislikes/dietary. {household_id, member_id, ...}.",
	member_update_safety: "Update a member's allergies/safety. {household_id, member_id, ...}.",
	household_set_pantry_bulk: "Replace the household pantry. {household_id, pantry:[...]}.",
	household_set_equipment_bulk: "Replace the household equipment list. {household_id, equipment:[...]}.",
	household_set_traditions: "Replace the household traditions. {household_id, traditions:[...]}.",
	household_get_traits: "Read derived traits (skill, time-of-day, complexity).",
	household_read_brief: "Today's morning brief. {household_id}.",
	agent_list_plan_traces: "List recent agent tool-call traces for a plan.",
};

// ─── Persona prompt builder ───────────────────────────────────────────────

export function buildSystemPrompt(
	status: ChefStatusResult | null,
	signals: HouseholdSignals | null,
	householdId?: string,
): string {
	const personality =
		signals?.personality?.summary ?? "Still calibrating; no personality signal yet.";

	// Personality dimensions — only the ones with non-trivial confidence.
	// Helps Claude *use* the dimensions rather than just see a summary string.
	const dimensions = (signals?.personality?.dimensions ?? [])
		.filter(d => d.confidence >= 0.15 && (d.value <= 0.3 || d.value >= 0.7))
		.map(d => `- ${d.trait_name}: ${d.label} (value ${d.value.toFixed(2)}, confidence ${d.confidence.toFixed(2)})`)
		.join("\n");

	const traditions =
		signals?.traditions && signals.traditions.length > 0
			? signals.traditions
				.slice(0, 8)
				.map(t => `- ${t.name} (${t.cadence})${t.description ? ": " + t.description : ""}`)
				.join("\n")
			: "(none recorded yet)";

	const avoidances = signals?.avoidances
		? [
			...(signals.avoidances.dietary ?? []),
			...(signals.avoidances.allergies ?? []),
			...(signals.avoidances.dislikes ?? []),
		].join(", ") || "(none)"
		: "(unknown — onboarding incomplete)";

	const equipment =
		signals?.equipment_available && signals.equipment_available.length > 0
			? signals.equipment_available.slice(0, 24).join(", ")
			: "(none recorded yet)";

	const pantry =
		signals?.pantry_top && signals.pantry_top.length > 0
			? signals.pantry_top
				.map(g => `- ${g.category}: ${g.items.join(", ")}`)
				.join("\n")
			: "(no pantry items recorded yet)";

	const spread = signals?.member_spread_guidance
		? `\nMulti-member trait spread: ${signals.member_spread_guidance}`
		: "";

	const onboardingNote =
		status?.onboarding && !status.onboarding.tier_0_done
			? "\n\nIMPORTANT: tier 0 onboarding is incomplete. Don't propose new meals yet — gently steer the user toward answering the next onboarding question."
			: "";

	const toolList = Array.from(CHEF_ALLOWED_TOOLS)
		.map(name => `  ${name} — ${TOOL_DESCRIPTIONS[name] ?? ""}`)
		.join("\n");

	const householdNote = householdId
		? `\n\nThe household_id for this conversation is "${householdId}". The runtime forces it into every tool call regardless of what you specify, so just include it correctly.`
		: "";

	return [
		"You are Spence, a chef-of-staff agent embedded in a household's life.",
		"You speak warmly, briefly, in second person — like a friend who happens to know what's in the fridge.",
		"Default to one or two short sentences. The user is at the stove or on their phone.",
		"Ground every recommendation in the household's signals below — never invent equipment, ingredients, or traditions. If a section says \"(none recorded yet)\" then it's truly empty — say so plainly, don't make up an excuse.",
		"",
		"# Household signals (use these — never claim you don't have them)",
		"",
		`## Personality`,
		personality,
		dimensions ? `\nDecisive dimensions:\n${dimensions}` : "",
		"",
		`## Traditions`,
		traditions,
		"",
		`## Pantry on hand`,
		pantry,
		"",
		`## Equipment in this kitchen`,
		equipment,
		"",
		`## Avoidances`,
		avoidances,
		spread,
		"",
		"# How to answer",
		"- If asked about pantry, equipment, or traditions, READ from the sections above. Do not say \"I don't have that on file\" if the section has data.",
		"- When proposing meals, prefer items already in the pantry over shopping spikes.",
		"- Honor traditions when the date/cadence matches.",
		"- Match the household's personality (quick vs project, comfort vs adventure, etc.) when picking complexity.",
		"",
		"# Calling tools — Code Mode (primary)",
		"",
		"You have access to tools that read AND WRITE the household's real data.",
		"You MUST call them — text claims without a tool call are hallucinations.",
		"",
		"You have two meta-tools that give you the FULL chef-of-staff API (100+ tools):",
		"",
		"  mcp_search(query)  — find matching tools by keyword. Returns name + 1-line",
		"                       description + JSON-Schema args.",
		"",
		"  mcp_execute(code)  — run JavaScript. Inside the code:",
		"                         await mcp(\"tool_name\", { args })  → call a tool, get the result",
		"                         await mcp_search(\"keyword\")        → search inline if you forgot a name",
		"                         console.log(...)                    → captured for debugging",
		"                         return any value                    → surfaced as return_value",
		"",
		"To run code, emit EXACTLY this format on its own lines:",
		"",
		"[[CODE]]",
		"const plans = await mcp(\"plan_list\", {});",
		"const today = new Date().toISOString().slice(0, 10);",
		"if (plans.plans?.length) {",
		"  const meal = await mcp(\"plan_read_meal\", { plan_id: plans.plans[0].id, slot: { date: today, slot: \"dinner\" } });",
		"  return meal;",
		"}",
		"return { reason: \"no plan\" };",
		"[[/CODE]]",
		"",
		"NEVER wrap a [[CODE]] block in a markdown code fence — it must be raw lines.",
		"household_id is auto-injected; you do not need to pass it.",
		"plan_id is NOT auto-injected — read it from plan_list first.",
		"",
		"## Why Code Mode is better than one-tool-at-a-time",
		"",
		"Compose multiple calls in ONE [[CODE]] block. The runtime executes them",
		"all and returns ONE [[EXECUTE_RESULT]] back to you — that's much faster",
		"and lets you branch on intermediate values without round-trips:",
		"",
		"[[CODE]]",
		"const members = await mcp(\"member_list\", {});",
		"let count = 0;",
		"for (const m of members.members ?? []) {",
		"  if (m.age_group === \"adult\") {",
		"    await mcp(\"member_update_preferences\", { member_id: m.member_id, dietary: [\"vegetarian\"] });",
		"    count += 1;",
		"  }",
		"}",
		"return { saved: true, adults_updated: count };",
		"[[/CODE]]",
		"",
		"## Fallback — single-tool envelopes (still supported)",
		"",
		"If you only need one tool and Code Mode feels heavy, you may emit:",
		"",
		"[[TOOL_CALL]]",
		'{"name": "tool_name", "args": {"key": "value"}}',
		"[[/TOOL_CALL]]",
		"",
		"Both forms work. Prefer [[CODE]] when chaining ≥2 calls or branching on",
		"intermediate values. After [[EXECUTE_RESULT]] / [[TOOL_RESULT]] blocks",
		"appear, integrate the data — don't echo them.",
		"",
		"## When you MUST call a tool (no exceptions)",
		"",
		"User says/asks                       → REQUIRED tool call",
		"────────────────────────────────────────────────────────────────────",
		"\"plan a/the [dinner|week|menu]\"      → plan_create + plan_compose_meal × N",
		"\"swap/replace tonight's [meal]\"      → plan_replace_meal",
		"\"cancel [meal]\"                       → plan_cancel_meal",
		"\"what's in season\" / \"seasonal\"     → inspire_read_seasonality",
		"\"weather\" / \"this week\"              → inspire_read_weather",
		"\"what's on my calendar\"               → inspire_read_calendar",
		"\"recent meals\" / \"what have we eaten\"→ inspire_read_recent_menu",
		"\"we're [vegetarian|vegan|...]\"       → member_update_preferences (every adult)",
		"\"i'm allergic to X\"                   → member_update_preferences",
		"\"i bought X\" / \"add X to pantry\"     → household_set_pantry_bulk",
		"\"i have a [grill|instant pot|...]\"   → household_set_equipment_bulk",
		"\"every Friday is X night\"            → household_set_traditions",
		"\"what does my plan look like\"        → plan_read_map (after plan_list)",
		"\"shopping list\"                       → plan_read_shopping_list",
		"\"how am i doing\" / \"any issues\"     → plan_read_grievances + plan_score_coherence",
		"",
		"## Anti-pattern (do NOT do this)",
		"",
		"User: \"plan tonight's dinner\"",
		"Bad:  \"How about asparagus pasta? 20 minutes, easy.\" (no tool call — hallucination)",
		"Good (Code Mode):",
		"  [[CODE]]",
		"  const seasonality = await mcp(\"inspire_read_seasonality\", {});",
		"  const today = new Date().toISOString().slice(0, 10);",
		"  const plan = await mcp(\"plan_create\", { start_date: today, end_date: today });",
		"  const meal = await mcp(\"plan_compose_meal\", {",
		"    plan_id: plan.plan_id,",
		"    slot: { date: today, slot: \"dinner\" },",
		"    meal: { /* …assembled from seasonality… */ }",
		"  });",
		"  return { plan_id: plan.plan_id, dish: meal.meal?.title };",
		"  [[/CODE]]",
		"Then narrate the saved plan in 1–2 sentences.",
		"",
		"## When NOT to call tools",
		"",
		"- The household signals already include pantry/equipment/traditions/avoidances/personality.",
		"  If the user asks about those, READ from the signal sections above.",
		"- Casual conversation (\"hi\", \"thanks\", \"how are you\") — no tool calls needed.",
		"- Clarifying questions back to the user — no tool calls needed.",
		"",
		"## Saving vs proposing",
		"",
		"If the user says \"plan it\" / \"do it\" / \"book it\" / \"go ahead\" — actually CALL the write tools.",
		"If the user says \"what should I do\" / \"any ideas\" — you can suggest in text first.",
		"If you are uncertain, ASK the user one short clarifying question (no tool call).",
		"",
		"## Today's date",
		"",
		`Today's date is ${new Date().toISOString().slice(0, 10)} (${new Date().toLocaleDateString("en-US", { weekday: "long" })}).`,
		"Use this when the user says \"tonight\", \"tomorrow\", \"this week\", etc.",
		householdNote,
		"",
		"Available tools (allow-listed for the chef-of-staff):",
		toolList,
		onboardingNote,
	].join("\n");
}

export function buildUserPrompt(
	message: string,
	history?: Array<{ role: "user" | "assistant"; content: string }>,
): string {
	const recent = (history ?? []).slice(-6); // last 6 turns max
	if (recent.length === 0) return message;
	const transcript = recent
		.map(m => `${m.role === "user" ? "User" : "Spence"}: ${m.content}`)
		.join("\n");
	return `Recent conversation:\n${transcript}\n\nUser (new message): ${message}`;
}

// ─── SSE helpers ──────────────────────────────────────────────────────────

export interface SseEmitter {
	send(event: ChefEvent): void;
	close(): void;
}

export function makeSseStream(
	run: (emit: SseEmitter) => Promise<void>,
): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		async start(controller) {
			let closed = false;
			const emit: SseEmitter = {
				send(event) {
					if (closed) return;
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
				},
				close() {
					if (closed) return;
					closed = true;
					controller.close();
				},
			};
			try {
				await run(emit);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				emit.send({ kind: "error", message: msg });
				emit.send({ kind: "done", reason: "agent_error" });
			} finally {
				emit.close();
			}
		},
	});
}

// ─── Text chunking for typing cadence ─────────────────────────────────────

/** Split text into ~targetChars chunks, preferring to break on whitespace. */
export function chunkText(text: string, targetChars = 50): string[] {
	if (!text) return [];
	const out: string[] = [];
	let i = 0;
	while (i < text.length) {
		let end = Math.min(i + targetChars, text.length);
		if (end < text.length) {
			// Look ahead for the next whitespace within +20 chars.
			const slack = Math.min(end + 20, text.length);
			let candidate = -1;
			for (let j = end; j < slack; j++) {
				if (/\s/.test(text[j])) {
					candidate = j + 1;
					break;
				}
			}
			if (candidate > end) end = candidate;
		}
		out.push(text.slice(i, end));
		i = end;
	}
	return out;
}

// ─── Tool-call parser ─────────────────────────────────────────────────────

export interface ParsedToolCall {
	name: string;
	args: Record<string, unknown>;
	/** The raw block text (including markers) so we can strip it from the
	 *  final assistant text if there's no further iteration. */
	raw: string;
}

export interface ToolParseResult {
	calls: ParsedToolCall[];
	/** Free-form text Claude wrote OUTSIDE the [[TOOL_CALL]] blocks. */
	leadingText: string;
}

const TOOL_CALL_RE = /\[\[TOOL_CALL\]\]\s*([\s\S]*?)\s*\[\[\/TOOL_CALL\]\]/g;

/** Parse all [[TOOL_CALL]]…[[/TOOL_CALL]] envelopes from a bridge response. */
export function parseToolCalls(text: string): ToolParseResult {
	const calls: ParsedToolCall[] = [];
	let leadingText = text;
	const matches: Array<{ start: number; end: number; body: string }> = [];

	TOOL_CALL_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = TOOL_CALL_RE.exec(text))) {
		matches.push({ start: m.index, end: m.index + m[0].length, body: m[1] });
	}

	for (const match of matches) {
		const body = match.body.trim();
		// Strip optional ```json fences in case the model wrapped the body.
		const stripped = body
			.replace(/^```(?:json|JSON)?\s*\n?/, "")
			.replace(/\n?```\s*$/, "")
			.trim();
		try {
			const parsed = JSON.parse(stripped) as Record<string, unknown>;
			const name = typeof parsed.name === "string" ? parsed.name : "";
			const args = parsed.args && typeof parsed.args === "object"
				? (parsed.args as Record<string, unknown>)
				: {};
			if (!name) continue;
			calls.push({ name, args, raw: text.slice(match.start, match.end) });
		} catch {
			// Malformed envelope — skip it. Claude will see the missing result
			// and either retry or move on.
		}
	}

	// Rebuild leadingText by removing every successfully-parsed block.
	if (matches.length > 0) {
		leadingText = "";
		let cursor = 0;
		for (const match of matches) {
			leadingText += text.slice(cursor, match.start);
			cursor = match.end;
		}
		leadingText += text.slice(cursor);
	}

	return { calls, leadingText: leadingText.trim() };
}

// ─── Tool-result truncation ───────────────────────────────────────────────

export const TOOL_RESULT_TRUNCATION_LIMIT = 3000;

/** Stringify a tool result, truncating to ~3KB without breaking JSON validity.
 *  When over budget, returns a JSON-valid object that wraps the truncated
 *  payload with a __truncated marker so Claude knows what happened. */
export function stringifyToolResult(
	result: Record<string, unknown>,
	limit = TOOL_RESULT_TRUNCATION_LIMIT,
): { text: string; truncated: boolean } {
	const full = JSON.stringify(result);
	if (full.length <= limit) {
		return { text: full, truncated: false };
	}

	// First try: if there's a top-level "map" or large string field we can
	// preserve the rest by truncating just that field.
	const cloned: Record<string, unknown> = { ...result };
	let mutated = false;
	for (const [k, v] of Object.entries(cloned)) {
		if (typeof v === "string" && v.length > 800) {
			const head = v.slice(0, 800);
			cloned[k] = `${head}…[truncated ${v.length - 800} chars]`;
			mutated = true;
		}
	}
	if (mutated) {
		const partial = JSON.stringify(cloned);
		if (partial.length <= limit) {
			return { text: partial, truncated: true };
		}
	}

	// Fall back: produce a synthetic envelope that's always JSON-valid.
	const headSlice = full.slice(0, limit - 200);
	return {
		text: JSON.stringify({
			__truncated: true,
			original_bytes: full.length,
			head_preview: headSlice,
			note: `Result exceeded ${limit} byte budget. Showing first ${headSlice.length} chars of the JSON. Call narrower tools or provide more specific args to get the data you need.`,
		}),
		truncated: true,
	};
}

// ─── Agent loop ───────────────────────────────────────────────────────────

export interface AgentChefRunOpts {
	body: AgentChefBody;
	household_id: string;
	env: MiseGraphEnv & Partial<MeshClaudeEnv>;
	/** Test injection: replaces the mesh-claude bridge call. */
	bridge?: typeof callMeshClaude;
	/** Test injection: replaces chef_status_check. */
	statusCheck?: (env: MiseGraphEnv, input: { household_id: string }) => Promise<ChefStatusResult>;
	/** Test injection: replaces callPlanWorldTool. */
	toolDispatcher?: typeof callPlanWorldTool;
	/** Override per-chunk delay. Defaults to 30ms; tests pass 0. */
	chunkDelayMs?: number;
	/** Override iteration cap. Defaults to MAX_ITERATIONS; tests can shrink. */
	maxIterations?: number;
	/** Phase 3 — test injection: replaces the Workers AI intent classifier.
	 *  Provide either a full ChefIntent (skip the model entirely) or the
	 *  raw classifier-string-output the model would have returned. */
	intentOverride?: ChefIntent;
	classifierOverride?: ClassifyIntentOpts["classifier"];
}

const DEFAULT_MODEL = "claude-sonnet-4-6";
const MAX_ITERATIONS = 4;

interface BridgeInvocation {
	prompt: string;
	system: string;
	model: string;
}

export async function runAgentChef(
	emit: SseEmitter,
	opts: AgentChefRunOpts,
): Promise<void> {
	const statusCheck = opts.statusCheck ?? chefStatusCheck;
	const bridge = opts.bridge ?? callMeshClaude;
	const tools = opts.toolDispatcher ?? callPlanWorldTool;
	const chunkDelayMs = opts.chunkDelayMs ?? 30;
	const maxIterations = Math.max(1, opts.maxIterations ?? MAX_ITERATIONS);

	// 1. Status check.
	let status: ChefStatusResult;
	try {
		status = await statusCheck(opts.env, { household_id: opts.household_id });
		emit.send({ kind: "status", status });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		emit.send({ kind: "error", message: `chef_status_check failed: ${msg}` });
		emit.send({ kind: "done", reason: "status_failed" });
		return;
	}

	// 2. If onboarding blocks, surface the next question and stop.
	if (
		status.recommendation.primary_action === "answer_onboarding_question" &&
		status.onboarding.blocked_actions.length > 0
	) {
		const q = status.recommendation.next_question ?? status.onboarding.next_question;
		if (q) {
			emit.send({
				kind: "ui_component",
				component: {
					component: "onboarding_question",
					props: { question: q as unknown as Record<string, unknown> },
				},
			});
			emit.send({ kind: "done", reason: "blocked_on_onboarding" });
			return;
		}
	}

	// 3. Phase 3 — Workers AI intent classifier (~50ms typical).
	//
	// Run BEFORE the bridge so we can route quick saves and workflows
	// directly without burning a mesh-claude round-trip. classifyIntent
	// always resolves; on any failure (binding missing, parse error, low
	// confidence) it returns free_chat and we fall through to the
	// existing Code Mode + bridge loop unchanged.
	const intent: ChefIntent = opts.intentOverride
		? opts.intentOverride
		: await classifyIntent(opts.env, opts.body.message, {
				classifier: opts.classifierOverride,
		  });
	emit.send({ kind: "intent", intent });

	const handled = await runIntentBranch(emit, intent, {
		env: opts.env,
		household_id: opts.household_id,
		toolDispatcher: tools,
	});
	if (handled) return;

	// 4. Build prompt + dispatch to the bridge.
	const system = buildSystemPrompt(status, status.signals, opts.household_id);
	const initialPrompt = buildUserPrompt(opts.body.message, opts.body.history);
	const model = opts.body.model ?? DEFAULT_MODEL;

	emit.send({ kind: "thinking_start" });

	if (!opts.env.MESH || !opts.env.BRIDGE_HOST || !opts.env.BRIDGE_PORT || !opts.env.BRIDGE_SECRET) {
		emit.send({
			kind: "error",
			message: "mesh-claude bridge not configured — missing MESH binding or BRIDGE_* vars",
		});
		emit.send({ kind: "done", reason: "no_bridge" });
		return;
	}

	const meshEnv: MeshClaudeEnv = {
		MESH: opts.env.MESH as MeshClaudeEnv["MESH"],
		BRIDGE_HOST: opts.env.BRIDGE_HOST,
		BRIDGE_PORT: opts.env.BRIDGE_PORT,
		BRIDGE_SECRET: opts.env.BRIDGE_SECRET,
	};

	// Multi-turn tool-dispatch loop.
	//
	// Each iteration: call the bridge → parse [[TOOL_CALL]] envelopes →
	// dispatch each via callPlanWorldTool → emit SSE events → if no calls,
	// stream the bridge's text and we're done. If calls, build a follow-up
	// prompt that includes Claude's previous response + [[TOOL_RESULT]] blocks
	// and re-call the bridge. Hard cap at maxIterations.
	let invocation: BridgeInvocation = { prompt: initialPrompt, system, model };
	let finalText = "";
	let callCounter = 0;

	for (let iteration = 1; iteration <= maxIterations; iteration++) {
		emit.send({ kind: "iteration_start", iteration_n: iteration });

		let response;
		try {
			response = await bridge(meshEnv, {
				prompt: invocation.prompt,
				system: invocation.system,
				model: invocation.model,
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			emit.send({ kind: "error", message: `bridge call failed: ${msg}` });
			emit.send({ kind: "done", reason: "bridge_error" });
			return;
		}

		if (!response.ok || !response.text) {
			const reason = response.error ?? response.reason ?? "empty bridge response";
			emit.send({ kind: "error", message: reason });
			emit.send({ kind: "done", reason: "bridge_error" });
			return;
		}

		// Parse BOTH Code Mode blocks AND legacy [[TOOL_CALL]] envelopes. Code
		// Mode is the encouraged path; the [[TOOL_CALL]] fallback stays so
		// Claude can still use it for trivial single-tool cases. We strip
		// [[CODE]] first, then parse [[TOOL_CALL]] from the remainder.
		const codeParsed = parseCodeBlocks(response.text);
		const parsed = parseToolCalls(codeParsed.leadingText);

		// Nothing to dispatch → this is the final reply. Stream the (cleaned) text.
		if (parsed.calls.length === 0 && codeParsed.blocks.length === 0) {
			finalText = parsed.leadingText.length > 0 ? parsed.leadingText : response.text.trim();
			break;
		}

		// Process Code Mode blocks first. We run them sequentially so
		// observation order is stable and tool-call IDs increment cleanly.
		const followupBlocks: string[] = [];

		for (const block of codeParsed.blocks) {
			callCounter += 1;
			const codeCallId = `code_${iteration}_${callCounter}`;
			const codePreview =
				block.code.length > 200 ? block.code.slice(0, 200) + "…" : block.code;
			emit.send({ kind: "code_execute_start", call_id: codeCallId, code_preview: codePreview });

			const codeCtx: CodeModeContext = {
				household_id: opts.household_id,
				caller_kind: "agent",
				caller_id: "chef-route",
			};

			// Build a wrapper dispatcher that also emits per-inner-call SSE
			// events, gates on CHEF_ALLOWED_TOOLS, and forces household_id.
			let innerCallCounter = 0;
			const codeDispatcher: typeof callPlanWorldTool = async (
				name,
				args,
				dispatcherEnv,
				caller,
			) => {
				innerCallCounter += 1;
				const innerId = `${codeCallId}_${innerCallCounter}`;
				if (!CHEF_ALLOWED_TOOLS.has(name)) {
					emit.send({
						kind: "tool_call_error",
						call_id: innerId,
						tool: name,
						message: `tool not allowed: ${name}`,
					});
					throw new Error(`tool not allowed: ${name}`);
				}
				const safeArgs: Record<string, unknown> = { ...args };
				if (Object.prototype.hasOwnProperty.call(safeArgs, "household_id") || callRequiresHousehold(name)) {
					safeArgs.household_id = opts.household_id;
				}
				emit.send({
					kind: "tool_call_start",
					tool: name,
					args: safeArgs,
					call_id: innerId,
				});
				try {
					const result = await tools(name, safeArgs, dispatcherEnv, caller);
					const { truncated } = stringifyToolResult(result);
					emit.send({
						kind: "tool_call_result",
						call_id: innerId,
						tool: name,
						result,
						...(truncated ? { truncated: true } : {}),
					});
					return result;
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					emit.send({
						kind: "tool_call_error",
						call_id: innerId,
						tool: name,
						message,
					});
					throw err;
				}
			};

			let executeResult: ExecuteResult;
			try {
				// We rely on `codeDispatcher` (above) for the allow-list gate so
				// it can emit a tool_call_error SSE event before throwing into
				// the sandbox. Don't pass allowed_tools here — that would gate
				// inside executeCode BEFORE our SSE wrapper runs.
				executeResult = await executeCode(opts.env, codeCtx, block.code, {
					dispatcher: codeDispatcher,
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				executeResult = {
					ok: false,
					tool_calls: [],
					logs: [],
					error: { message },
					duration_ms: 0,
				};
			}

			emit.send({
				kind: "code_execute_end",
				call_id: codeCallId,
				ok: executeResult.ok,
				tool_calls_count: executeResult.tool_calls.length,
				duration_ms: executeResult.duration_ms,
				...(executeResult.return_value !== undefined ? { return_value: executeResult.return_value } : {}),
				...(executeResult.logs.length > 0 ? { logs: executeResult.logs } : {}),
				...(executeResult.error ? { error: { message: executeResult.error.message } } : {}),
			});

			followupBlocks.push(buildExecuteResultBlock(executeResult));
		}

		// Execute each legacy tool call.
		const toolResultBlocks: string[] = followupBlocks;
		for (const call of parsed.calls) {
			callCounter += 1;
			const callId = `tc_${iteration}_${callCounter}`;

			// Force the route's resolved household_id into args (security).
			// Claude could otherwise specify a different household.
			const safeArgs: Record<string, unknown> = { ...call.args };
			if (Object.prototype.hasOwnProperty.call(safeArgs, "household_id")) {
				safeArgs.household_id = opts.household_id;
			} else if (callRequiresHousehold(call.name)) {
				safeArgs.household_id = opts.household_id;
			}

			// Allow-list check.
			if (!CHEF_ALLOWED_TOOLS.has(call.name)) {
				const message = `tool not allowed: ${call.name}`;
				emit.send({
					kind: "tool_call_error",
					call_id: callId,
					tool: call.name,
					message,
				});
				toolResultBlocks.push(buildToolErrorBlock(call.name, message));
				continue;
			}

			emit.send({
				kind: "tool_call_start",
				tool: call.name,
				args: safeArgs,
				call_id: callId,
			});

			try {
				const result = await tools(call.name, safeArgs, opts.env, {
					caller_kind: "agent",
					caller_id: "chef-route",
					parent_trace_id: null,
				});
				const { text: serialized, truncated } = stringifyToolResult(result);
				emit.send({
					kind: "tool_call_result",
					call_id: callId,
					tool: call.name,
					result,
					...(truncated ? { truncated: true } : {}),
				});
				toolResultBlocks.push(
					buildToolResultBlock(call.name, serialized, truncated),
				);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				emit.send({
					kind: "tool_call_error",
					call_id: callId,
					tool: call.name,
					message,
				});
				toolResultBlocks.push(buildToolErrorBlock(call.name, message));
			}
		}

		// If we've hit the cap, fall through with whatever leading text Claude
		// wrote. We don't fire another bridge round-trip.
		if (iteration === maxIterations) {
			finalText = (parsed.leadingText.length > 0
				? parsed.leadingText
				: "I ran into the tool-call iteration cap. Let me summarize what I have so far and you can ask me to continue.");
			break;
		}

		// Build the follow-up prompt with the previous assistant turn + tool
		// results. We concatenate tool-result blocks so a single bridge round
		// observes all of them together.
		invocation = {
			prompt: buildFollowupPrompt(invocation.prompt, response.text, toolResultBlocks),
			system,
			model,
		};
	}

	// Stream the final text in ~50-char fragments.
	const chunks = chunkText(finalText, 50);
	for (const chunk of chunks) {
		emit.send({ kind: "text", delta: chunk });
		if (chunkDelayMs > 0) {
			await new Promise(r => setTimeout(r, chunkDelayMs));
		}
	}

	emit.send({ kind: "done", reason: "stop" });
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Most chef tools take household_id; a handful take only plan_id. We default
 *  to injecting household_id when the tool accepts it; the dispatcher
 *  ignores extra args, so this is safe even for plan-scoped tools. */
function callRequiresHousehold(name: string): boolean {
	const planScoped = new Set([
		"plan_read_map",
		"plan_read_meal",
		"plan_read_grievances",
		"plan_read_summary",
		"plan_read_shopping_list",
		"plan_read_shop_runs",
		"plan_read_recent_meals",
		"plan_compose_meal",
		"plan_replace_meal",
		"plan_cancel_meal",
		"plan_audit",
		"plan_score_coherence",
		"agent_list_plan_traces",
		"inspire_read_recipe_steps",
		"inspire_read_format_library",
		"inspire_read_flavor_vibes",
	]);
	return !planScoped.has(name);
}

function buildToolResultBlock(name: string, body: string, truncated: boolean): string {
	const flag = truncated ? " (truncated to fit budget)" : "";
	return `[[TOOL_RESULT name=${name}${flag}]]\n${body}\n[[/TOOL_RESULT]]`;
}

function buildToolErrorBlock(name: string, message: string): string {
	return `[[TOOL_RESULT name=${name} error=true]]\n${JSON.stringify({ error: message })}\n[[/TOOL_RESULT]]`;
}

function buildFollowupPrompt(
	previousPrompt: string,
	previousAssistantText: string,
	toolResultBlocks: string[],
): string {
	return [
		previousPrompt,
		"",
		"# Previous assistant turn",
		previousAssistantText.trim(),
		"",
		"# Tool results",
		toolResultBlocks.join("\n\n"),
		"",
		"Continue: integrate these results into your reply. If you need more tools, emit another [[CODE]]…[[/CODE]] block (preferred) or [[TOOL_CALL]] envelope. If you have everything you need, just answer the user.",
	].join("\n");
}

// ─── Phase 3 — intent branch handlers ────────────────────────────────────

interface IntentBranchOpts {
	env: MiseGraphEnv;
	household_id: string;
	toolDispatcher: typeof callPlanWorldTool;
}

/** Handle the intent's branch. Returns true if the route should terminate
 *  (we already streamed the reply + emitted `done`); false if the route
 *  should fall through to the Code Mode + bridge loop. */
export async function runIntentBranch(
	emit: SseEmitter,
	intent: ChefIntent,
	opts: IntentBranchOpts,
): Promise<boolean> {
	const caller = {
		caller_kind: "agent" as const,
		caller_id: "chef-route-intent",
		parent_trace_id: null,
	};

	const callTool = (
		name: string,
		args: Record<string, unknown>,
		callId: string,
	): Promise<Record<string, unknown>> => {
		const safeArgs: Record<string, unknown> = { ...args, household_id: opts.household_id };
		emit.send({ kind: "tool_call_start", tool: name, args: safeArgs, call_id: callId });
		return opts.toolDispatcher(name, safeArgs, opts.env, caller).then(
			result => {
				emit.send({ kind: "tool_call_result", call_id: callId, tool: name, result });
				return result;
			},
			err => {
				const message = err instanceof Error ? err.message : String(err);
				emit.send({ kind: "tool_call_error", call_id: callId, tool: name, message });
				throw err;
			},
		);
	};

	switch (intent.kind) {
		case "free_chat":
			return false;

		case "quick:save_preference": {
			// Apply the preference to every adult in the household. We list
			// members first; if member_list isn't available we fall back to
			// free_chat so the bridge can do the right thing with full
			// context.
			let listResult: Record<string, unknown>;
			try {
				listResult = await callTool("member_list", {}, "intent_member_list");
			} catch {
				return false;
			}
			const members = Array.isArray(listResult.members)
				? (listResult.members as Array<Record<string, unknown>>)
				: [];
			const adults = members.filter(m => m.age_group === "adult");
			if (adults.length === 0) {
				// No adult members yet — let the bridge gently steer the user.
				return false;
			}
			let updated = 0;
			let lastError: string | null = null;
			for (let i = 0; i < adults.length; i++) {
				const member_id = (adults[i] as { member_id?: string }).member_id;
				if (!member_id) continue;
				try {
					await callTool(
						"member_update_preferences",
						{ member_id, [intent.field]: intent.values },
						`intent_member_update_${i}`,
					);
					updated += 1;
				} catch (err) {
					lastError = err instanceof Error ? err.message : String(err);
				}
			}
			if (updated === 0) {
				emit.send({
					kind: "error",
					message: `Couldn't save ${intent.field}: ${lastError ?? "unknown error"}`,
				});
				emit.send({ kind: "done", reason: "intent_error" });
				return true;
			}
			const friendly = friendlyPreferenceField(intent.field);
			const list = intent.values.join(", ");
			const noun = updated === 1 ? "adult" : "adults";
			emit.send({
				kind: "text",
				delta: `Saved — ${list} set as ${friendly} for ${updated} ${noun}.`,
			});
			emit.send({ kind: "done", reason: "stop" });
			return true;
		}

		case "quick:add_to_pantry": {
			try {
				await callTool(
					"household_set_pantry_bulk",
					{ mode: "text", text: intent.items.join("\n") },
					"intent_pantry_bulk",
				);
			} catch (err) {
				emit.send({
					kind: "error",
					message: err instanceof Error ? err.message : String(err),
				});
				emit.send({ kind: "done", reason: "intent_error" });
				return true;
			}
			emit.send({
				kind: "text",
				delta: `Added to your pantry: ${intent.items.join(", ")}.`,
			});
			emit.send({ kind: "done", reason: "stop" });
			return true;
		}

		case "quick:add_equipment": {
			try {
				await callTool(
					"household_set_equipment_bulk",
					{ equipment_slugs: intent.slugs },
					"intent_equipment_bulk",
				);
			} catch (err) {
				emit.send({
					kind: "error",
					message: err instanceof Error ? err.message : String(err),
				});
				emit.send({ kind: "done", reason: "intent_error" });
				return true;
			}
			emit.send({
				kind: "text",
				delta: `Added to your kitchen: ${intent.slugs.join(", ")}.`,
			});
			emit.send({ kind: "done", reason: "stop" });
			return true;
		}

		case "quick:set_tradition": {
			try {
				await callTool(
					"household_set_traditions",
					{
						traditions: [
							{ name: intent.name, cadence: intent.cadence },
						],
					},
					"intent_set_tradition",
				);
			} catch (err) {
				emit.send({
					kind: "error",
					message: err instanceof Error ? err.message : String(err),
				});
				emit.send({ kind: "done", reason: "intent_error" });
				return true;
			}
			emit.send({
				kind: "text",
				delta: `Got it — ${intent.name} (${intent.cadence}) is on the books.`,
			});
			emit.send({ kind: "done", reason: "stop" });
			return true;
		}

		case "workflow:onboard":
		case "workflow:plan":
		case "workflow:debrief_meal": {
			// Phase 2 ships the workflow bindings (env.ONBOARDING_WORKFLOW,
			// env.PLANNING_WORKFLOW, env.COOK_DEBRIEF_WORKFLOW). Until the
			// bindings are available on env, fall through to the bridge so
			// users still get a useful answer. Once Phase 2 lands we'll fire
			// the workflow here.
			//
			// TODO(phase-2): when workflow bindings are wired, replace this
			// fall-through with `await env.<WORKFLOW>.create({ ... })` and
			// stream a friendly confirmation via the bridge.
			return false;
		}
	}
	// Should be unreachable, but stay safe.
	return false;
}

function friendlyPreferenceField(
	field: "dietary" | "allergies" | "dislikes",
): string {
	switch (field) {
		case "dietary":
			return "dietary preference";
		case "allergies":
			return "allergies";
		case "dislikes":
			return "dislikes";
	}
}

// ─── HTTP route handler ───────────────────────────────────────────────────

export interface AgentChefRouteEnv extends MiseGraphEnv, Partial<MeshClaudeEnv> {}

const ALLOWED_ORIGINS = [
	"http://localhost:3000",
	"http://127.0.0.1:3000",
];

function corsHeaders(origin: string | null): Record<string, string> {
	// Allow any *.workers.dev origin (deployed web app) + localhost (dev).
	let allow: string;
	if (origin && (ALLOWED_ORIGINS.includes(origin) || /^https:\/\/[^/]+\.workers\.dev$/.test(origin))) {
		allow = origin;
	} else {
		// Permissive fallback: both the web worker and mise-graph sit behind
		// CF Access in prod, so wildcard is acceptable for MVP.
		allow = "*";
	}
	return {
		"Access-Control-Allow-Origin": allow,
		"Access-Control-Allow-Methods": "POST, OPTIONS",
		"Access-Control-Allow-Headers": "Content-Type, Cf-Access-Authenticated-User-Email",
		"Access-Control-Max-Age": "86400",
		Vary: "Origin",
	};
}

export async function handleAgentChefRoute(
	request: Request,
	env: AgentChefRouteEnv,
): Promise<Response> {
	const origin = request.headers.get("Origin");
	const cors = corsHeaders(origin);

	if (request.method === "OPTIONS") {
		return new Response(null, { status: 204, headers: cors });
	}

	if (request.method !== "POST") {
		return new Response(JSON.stringify({ error: "method_not_allowed" }), {
			status: 405,
			headers: { "Content-Type": "application/json", ...cors },
		});
	}

	let body: AgentChefBody;
	try {
		body = (await request.json()) as AgentChefBody;
	} catch {
		return new Response(JSON.stringify({ error: "invalid_json" }), {
			status: 400,
			headers: { "Content-Type": "application/json", ...cors },
		});
	}

	const message = (body.message ?? "").trim();
	if (!message) {
		return new Response(JSON.stringify({ error: "empty_message" }), {
			status: 400,
			headers: { "Content-Type": "application/json", ...cors },
		});
	}

	const household_id = resolveHouseholdId(request, body);
	if (!household_id) {
		return new Response(JSON.stringify({ error: "no_household_id" }), {
			status: 401,
			headers: { "Content-Type": "application/json", ...cors },
		});
	}

	const stream = makeSseStream(emit =>
		runAgentChef(emit, {
			body: { ...body, message },
			household_id,
			env,
		}),
	);

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			"X-Accel-Buffering": "no",
			Connection: "keep-alive",
			...cors,
		},
	});
}

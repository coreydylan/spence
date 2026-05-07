// Chef-of-staff agent loop, hosted on the worker.
//
// The web app's /api/chef route is now a thin proxy that streams this route's
// Server-Sent Events (SSE) back to the browser. We moved the loop here so we
// can route through the mesh-claude bridge (Corey's CC subscription) instead
// of the Anthropic API — the worker already has the MESH vpc binding wired
// for menu composition.
//
// Wire format (SSE):
//   data: {"kind":"status","status":{...}}
//   data: {"kind":"ui_component","component":{"component":"onboarding_question","props":{...}}}
//   data: {"kind":"thinking_start"}
//   data: {"kind":"text","delta":"Hey..."}
//   data: {"kind":"error","message":"..."}
//   data: {"kind":"done","reason":"stop"}
//
// Phase 1 streams the bridge's plain text response only — no in-loop tool
// dispatch. The bridge's reply is chunked client-side into ~50-char fragments
// emitted with a small gap so the chat surface gets a typing cadence.
//
// TODO Phase 2: parse the bridge's text for explicit tool-call hints (e.g.
// `[[tool: plan_read_meal {plan_id, slot}]]`) and execute them via
// `callPlanWorldTool`, then re-prompt the bridge with the result. The
// SSE event shape (`tool_call_start`, `tool_call_result`) is already
// defined on the web client — we just don't emit those events yet.

import { callMeshClaude, type MeshClaudeEnv } from "./llm-bridge";
import { chefStatusCheck, type ChefStatusResult } from "./chef-dispatch";
import type { HouseholdSignals } from "./household-signals";
import type { MiseGraphEnv } from "./types";

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
	| { kind: "thinking_start" }
	| { kind: "text"; delta: string }
	| { kind: "error"; message: string }
	| { kind: "done"; reason?: string };

// ─── Persona prompt builder ───────────────────────────────────────────────

/** Curated tool catalog — names + 1-line descriptions. The bridge does NOT
 *  call these; the list shapes its responses (so it knows what's possible
 *  even though we'll execute the tool calls in a future iteration). */
const TOOL_CATALOG: Array<{ name: string; desc: string }> = [
	{ name: "chef_status_check", desc: "Always called first by the worker. Returns onboarding state + signals." },
	{ name: "inspire_read_household_signals", desc: "Personality summary, traditions, equipment, avoidances." },
	{ name: "plan_read_meal", desc: "Read a meal at {plan_id, slot_date, slot_label}." },
	{ name: "plan_compose_meal", desc: "Add or replace a meal at a plan slot." },
	{ name: "plan_create", desc: "Create an empty plan for a date range." },
	{ name: "plan_read_shopping_list", desc: "Read the shopping list for a plan." },
	{ name: "plan_read_grievances", desc: "List unresolved grievances for a plan." },
	{ name: "household_onboarding_start", desc: "Begin tier-0 onboarding." },
	{ name: "household_onboarding_answer", desc: "Record an answer to an onboarding question." },
	{ name: "household_read_brief", desc: "Read today's morning brief." },
];

export function buildSystemPrompt(
	status: ChefStatusResult | null,
	signals: HouseholdSignals | null,
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

	// Equipment: render every slug the household has so the chef knows what
	// they can cook with. Empty state is "(none recorded)" not "(unknown)" —
	// don't invite hallucinations about a stocked kitchen.
	const equipment =
		signals?.equipment_available && signals.equipment_available.length > 0
			? signals.equipment_available.slice(0, 24).join(", ")
			: "(none recorded yet)";

	// Pantry: this was the missing piece — Claude was hallucinating "I don't
	// have a pantry inventory" because the system prompt didn't include it.
	// Render every category with its items so the chef can plan from what's
	// actually on hand.
	const pantry =
		signals?.pantry_top && signals.pantry_top.length > 0
			? signals.pantry_top
				.map(g => `- ${g.category}: ${g.items.join(", ")}`)
				.join("\n")
			: "(no pantry items recorded yet)";

	// Member-spread guidance: if traits diverge across members, surface the
	// description so Claude can reason about it ("alternate dishes").
	const spread = signals?.member_spread_guidance
		? `\nMulti-member trait spread: ${signals.member_spread_guidance}`
		: "";

	const onboardingNote =
		status?.onboarding && !status.onboarding.tier_0_done
			? "\n\nIMPORTANT: tier 0 onboarding is incomplete. Don't propose new meals yet — gently steer the user toward answering the next onboarding question."
			: "";

	const toolList = TOOL_CATALOG.map(t => `  ${t.name} — ${t.desc}`).join("\n");

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
		"Tools available to the agent runtime (you don't call these directly — the runtime does):",
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

// ─── Agent loop ───────────────────────────────────────────────────────────

export interface AgentChefRunOpts {
	body: AgentChefBody;
	household_id: string;
	env: MiseGraphEnv & Partial<MeshClaudeEnv>;
	/** Test injection: replaces the mesh-claude bridge call. */
	bridge?: typeof callMeshClaude;
	/** Test injection: replaces chef_status_check. */
	statusCheck?: (env: MiseGraphEnv, input: { household_id: string }) => Promise<ChefStatusResult>;
	/** Override per-chunk delay. Defaults to 30ms; tests pass 0. */
	chunkDelayMs?: number;
}

const DEFAULT_MODEL = "claude-sonnet-4-6";

export async function runAgentChef(
	emit: SseEmitter,
	opts: AgentChefRunOpts,
): Promise<void> {
	const statusCheck = opts.statusCheck ?? chefStatusCheck;
	const bridge = opts.bridge ?? callMeshClaude;
	const chunkDelayMs = opts.chunkDelayMs ?? 30;

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

	// 3. Build prompt + dispatch to the bridge.
	const system = buildSystemPrompt(status, status.signals);
	const prompt = buildUserPrompt(opts.body.message, opts.body.history);
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

	let response;
	try {
		response = await bridge(meshEnv, { prompt, system, model });
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

	// 4. Chunk the response for a typing cadence.
	const chunks = chunkText(response.text.trim(), 50);
	for (const chunk of chunks) {
		emit.send({ kind: "text", delta: chunk });
		if (chunkDelayMs > 0) {
			await new Promise(r => setTimeout(r, chunkDelayMs));
		}
	}

	emit.send({ kind: "done", reason: "stop" });
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

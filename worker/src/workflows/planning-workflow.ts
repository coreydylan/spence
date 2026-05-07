// Phase 2 — PlanningWorkflow.
//
// Long-running, durable plan-generation pipeline:
//
//   1. Parallel data gather: seasonality + weather + calendar + signals
//      (each step retries independently; failed steps replay without
//      re-running the others).
//   2. LLM proposes dishes via the mesh-claude bridge.
//   3. Per-dish approval loop — `step.waitForEvent` pauses up to 1 hour
//      per dish so the user can swap / approve from chat.
//   4. Mandatory persistence: plan_create + plan_compose_meal × N.
//   5. Audit (plan_audit, run_critics: "all").
//   6. Finalize hand-off — plan_finalize spawns the MealAgents.
//
// Trigger: `POST /agent/workflow/planning/start` with body
//   { household_id, start_date, end_date, constraints? }
// → worker calls `env.PLANNING_WORKFLOW.create({ id: <plan_id>, params })`.
// The workflow owns plan_create so callers don't need to mint a plan_id;
// the workflow's instance id is the household_id + start_date for
// idempotency.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { callMeshClaude, type MeshClaudeEnv } from "../mise-graph/llm-bridge";
import { bindMcp, relaxStep, workflowCallerId } from "./runner-helpers";

// ─── Public params + result types ──────────────────────────────────────────

export interface PlanningWorkflowParams {
	household_id: string;
	start_date: string;
	end_date: string;
	constraints?: string[];
	// Optional — defaults to 1 hour per dish; tests can shorten.
	approval_timeout?: string;
	// Optional plan_id seed — when omitted the workflow mints one off the
	// instance id + start_date.
	plan_id?: string;
}

export interface ProposedDish {
	id: string;                           // stable composer-side id
	slot: { date: string; slot: string };
	title: string;
	format: string;
	cuisine: string[];
	people?: number;
	notes?: string;
	// Anything else the composer wants to round-trip — passed to
	// plan_compose_meal verbatim.
	[k: string]: unknown;
}

export interface DishDecisionEvent {
	approved: boolean;
	swap_to?: ProposedDish;
}

export interface PlanningWorkflowResult {
	plan_id: string;
	approved_count: number;
	skipped_count: number;
	audit: Record<string, unknown> | null;
	finalize: Record<string, unknown> | null;
}

// ─── Workflow class ────────────────────────────────────────────────────────

export class PlanningWorkflow extends WorkflowEntrypoint<Cloudflare.Env, PlanningWorkflowParams> {
	async run(event: WorkflowEvent<PlanningWorkflowParams>, step: WorkflowStep): Promise<PlanningWorkflowResult> {
		const params = event.payload;
		const { household_id, start_date, end_date } = params;
		const constraints = params.constraints ?? [];
		const approvalTimeout = params.approval_timeout ?? "1 hour";
		const plan_id = params.plan_id ?? defaultPlanId(household_id, start_date);

		const mcp = bindMcp(this.env, {
			caller_kind: "system",
			caller_id: workflowCallerId("planning", event.instanceId || plan_id),
		});
		const s = relaxStep(step);

		// ── Step 1: parallel data gather ────────────────────────────────
		// step.do handles retry + checkpointing per call. Promise.all
		// runs them concurrently; if one fails, only that step retries on
		// resume.
		const [seasonality, weather, calendar, signals] = await Promise.all([
			s.do("read_seasonality", () =>
				mcp("inspire_read_seasonality", { household_id, start_date, end_date }),
			),
			s.do("read_weather", () =>
				mcp("inspire_read_weather", { household_id, start_date, end_date }),
			),
			s.do("read_calendar", () =>
				mcp("inspire_read_calendar", { household_id, start_date, end_date }),
			),
			s.do("read_signals", () =>
				mcp("inspire_read_household_signals", { household_id }),
			),
		]);

		// ── Step 2: LLM proposes dishes ─────────────────────────────────
		const proposed = await s.do("propose_dishes", async () => {
			const prompt = buildProposePrompt({
				household_id,
				start_date,
				end_date,
				constraints,
				seasonality: seasonality as Record<string, unknown>,
				weather: weather as Record<string, unknown>,
				calendar: calendar as Record<string, unknown>,
				signals: signals as Record<string, unknown>,
			});
			// Cast: this.env's MESH is optional (so older deployments
			// without the binding still typecheck), but callMeshClaude
			// surfaces a clean error message if it's missing at runtime.
			const reply = await callMeshClaude(this.env as unknown as MeshClaudeEnv, {
				prompt,
				system: PROPOSE_SYSTEM,
			});
			return { dishes: parseProposedDishes(reply.text) };
		});

		const dishes: ProposedDish[] = Array.isArray(proposed.dishes)
			? (proposed.dishes as ProposedDish[])
			: [];

		// ── Step 3: per-dish approval ───────────────────────────────────
		const approved: ProposedDish[] = [];
		let skipped_count = 0;
		for (const dish of dishes) {
			let decision: DishDecisionEvent | null = null;
			try {
				const evt = await s.waitForEvent<DishDecisionEvent>(`approve_${dish.id}`, {
					type: "dish_decision",
					timeout: approvalTimeout,
				});
				decision = evt.payload;
			} catch {
				// Timeout — treat as auto-approve so the flow doesn't stall
				// for days. The user can still cancel/swap after the plan
				// finalizes via the meal-level tools.
				decision = { approved: true };
			}
			if (decision?.swap_to) {
				approved.push(decision.swap_to);
			} else if (decision?.approved) {
				approved.push(dish);
			} else {
				skipped_count++;
			}
		}

		// ── Step 4: mandatory persistence ───────────────────────────────
		await s.do("create_plan", () =>
			mcp("plan_create", {
				plan: {
					id: plan_id,
					household_id,
					start_date,
					end_date,
					title: `Plan ${start_date} → ${end_date}`,
				},
			}),
		);

		for (const dish of approved) {
			const slotKey = `${dish.slot.date}_${dish.slot.slot}`;
			await s.do(`compose_${slotKey}`, () =>
				mcp("plan_compose_meal", {
					plan_id,
					slot: dish.slot,
					meal: dish,
				}),
			);
		}

		// ── Step 5: audit ───────────────────────────────────────────────
		const audit = await s.do("audit", () =>
			mcp("plan_audit", { plan_id, run_critics: "all" }),
		);

		// ── Step 6: finalize hand-off ───────────────────────────────────
		// PlanAgent.routeFinalize spawns the MealAgents. Wave 4 wired this
		// through a fiber so the spawn is checkpointable; the workflow
		// just needs the call to succeed.
		const finalize = await s.do("finalize", () =>
			mcp("plan_finalize", { plan_id }),
		);

		return {
			plan_id,
			approved_count: approved.length,
			skipped_count,
			audit: audit as Record<string, unknown>,
			finalize: finalize as Record<string, unknown>,
		};
	}
}

// ─── Prompt construction ───────────────────────────────────────────────────

const PROPOSE_SYSTEM = `You are Spence, a household chef-of-staff. You build week-long meal plans that respect the household's actual constraints, calendar, and stated personality. Output STRICT JSON only — no prose, no markdown — with shape:

{
  "dishes": [
    {
      "id": "<short stable id>",
      "slot": { "date": "YYYY-MM-DD", "slot": "breakfast"|"lunch"|"dinner" },
      "title": "<dish name>",
      "format": "<canonical format slug>",
      "cuisine": ["<canonical cuisine>"],
      "notes": "<one short sentence>"
    }
  ]
}

Use seasonal produce when in season. Avoid recipes that conflict with calendar busy_blocks. Respect avoidances + dietary signals.`;

interface ProposeContext {
	household_id: string;
	start_date: string;
	end_date: string;
	constraints: string[];
	seasonality: Record<string, unknown>;
	weather: Record<string, unknown>;
	calendar: Record<string, unknown>;
	signals: Record<string, unknown>;
}

function buildProposePrompt(ctx: ProposeContext): string {
	const lines = [
		`Household: ${ctx.household_id}`,
		`Plan window: ${ctx.start_date} → ${ctx.end_date}`,
		ctx.constraints.length > 0 ? `Constraints: ${ctx.constraints.join("; ")}` : null,
		``,
		`SEASONALITY:\n${jsonClip(ctx.seasonality, 1500)}`,
		`WEATHER:\n${jsonClip(ctx.weather, 1500)}`,
		`CALENDAR:\n${jsonClip(ctx.calendar, 1500)}`,
		`HOUSEHOLD SIGNALS:\n${jsonClip(ctx.signals, 2500)}`,
		``,
		`Propose dinner dishes only for each day in the window. Output STRICT JSON per the system spec.`,
	];
	return lines.filter(Boolean).join("\n");
}

function jsonClip(value: unknown, limit: number): string {
	let text: string;
	try {
		text = JSON.stringify(value, null, 2);
	} catch {
		text = String(value);
	}
	if (text.length <= limit) return text;
	return text.slice(0, limit) + `\n…[truncated ${text.length - limit} chars]`;
}

// ─── Output parsing ────────────────────────────────────────────────────────

function parseProposedDishes(text: string | null): ProposedDish[] {
	if (!text) return [];
	const json = extractJsonObject(text);
	if (!json) return [];
	const dishes = (json as Record<string, unknown>).dishes;
	if (!Array.isArray(dishes)) return [];
	const out: ProposedDish[] = [];
	for (const raw of dishes) {
		if (!raw || typeof raw !== "object") continue;
		const r = raw as Record<string, unknown>;
		const slot = r.slot as { date?: unknown; slot?: unknown } | undefined;
		if (!slot || typeof slot.date !== "string" || typeof slot.slot !== "string") continue;
		const id = typeof r.id === "string" && r.id.length > 0
			? r.id
			: `dish_${slot.date}_${slot.slot}`;
		out.push({
			...r,
			id,
			slot: { date: slot.date, slot: slot.slot },
			title: typeof r.title === "string" ? r.title : "Untitled",
			format: typeof r.format === "string" ? r.format : "bowl",
			cuisine: Array.isArray(r.cuisine) ? r.cuisine.filter(c => typeof c === "string") as string[] : [],
		});
	}
	return out;
}

function extractJsonObject(text: string): unknown {
	// Tolerate mesh-claude responses that include leading prose by finding
	// the first balanced JSON object.
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end < 0 || end <= start) return null;
	const slice = text.slice(start, end + 1);
	try {
		return JSON.parse(slice);
	} catch {
		return null;
	}
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function defaultPlanId(household_id: string, start_date: string): string {
	return `plan_${household_id}_${start_date}`.replace(/[^a-zA-Z0-9_-]/g, "_");
}

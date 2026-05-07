import { handleMiseGraphRequest } from "./mise-graph";
import { handlePlanWorldMcpRequest } from "./mise-graph/plan-world-mcp";
import { handleAgentChefRoute } from "./mise-graph/agent-chef-route";
import { handleReplanRequest, handleReplanLogRequest } from "./mise-graph/replan-webhook";
import { migrateHouseholdMemorySchema } from "./mise-graph/admin-household-memory";
import { migrateCalendarSchema } from "./mise-graph/calendar-tools";
import { runDailyCheckinForToday, handleDailyCheckin } from "./mise-graph/cron-daily-checkin";
import { runDailyMorningBriefSweep } from "./mise-graph/cron-runner";
import type { MeshClaudeEnv } from "./mise-graph/llm-bridge";
import type { MiseGraphEnv } from "./mise-graph/types";
import { householdAgentName, planAgentName } from "./mise-graph/agents/base";
import {
	migrateBrigadeSchema,
	migrateDailyBriefsSchema,
	migrateOnboardingSchema,
	migratePlanHealthSchema,
	migrateShopRemindersSchema,
} from "./mise-graph/schemas/migrations";
import { migrateMealAgentSchemas } from "./mise-graph/agents/d1-schemas";
import { migrateTaskGraphSchema } from "./mise-graph/task-graph";
import { migrateEquipmentSchema, migrateEquipmentSchemaWithRebuild } from "./mise-graph/equipment";
import {
	cookAgentName as cookName,
	householdAgentName as householdName,
	mealAgentName as mealName,
	memberAgentName as memberName,
	planAgentName as planName,
	probeDO,
	shopAgentName as shopName,
} from "./mise-graph/agents/router";
import { cookingLeadAgentName } from "./mise-graph/agents/base";

// Wave 7 entity DOs — exported so the wrangler `new_sqlite_classes` migration
// can find the classes. They are NOT yet wired into the MCP handlers; Wave 7B
// migrates handler reads/writes to route through the DO stubs.
export { HouseholdAgent } from "./mise-graph/agents/household-agent";
export { PlanAgent } from "./mise-graph/agents/plan-agent";
export { MealAgent } from "./mise-graph/agents/meal-agent";
export { ShopAgent } from "./mise-graph/agents/shop-agent";
export { CookAgent } from "./mise-graph/agents/cook-agent";
export { MemberAgent } from "./mise-graph/agents/member-agent";

// Wave 8 foundation — ephemeral brigade lead per cook session. The wrangler
// `[[migrations]] tag = "v2"` block claims this class as a new SQLite DO.
export { CookingLeadAgent } from "./mise-graph/agents/cooking-lead-agent";

// PlannerWorkflow is built (src/mise-graph/workflow-runner.ts) but currently
// not bound — the synchronous /mise-graph/plan route runs the full pipeline.
// Re-enable the [[workflows]] block in wrangler.mise.toml when we want
// durability + cross-restart resume.
// export { PlannerWorkflow } from "./mise-graph/workflow-runner";

const CORS_HEADERS: Record<string, string> = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type",
};

export interface Env extends MiseGraphEnv {
	// Wave 7 entity-DO bindings. Defined as plain DurableObjectNamespace here
	// (without the Agent class generic) so legacy handlers don't pull in the
	// agents SDK types. The agents/base.ts module augments Cloudflare.Env with
	// the same fields, which is what the Agent subclasses see.
	HOUSEHOLD_AGENT: DurableObjectNamespace;
	PLAN_AGENT: DurableObjectNamespace;
	MEAL_AGENT: DurableObjectNamespace;
	SHOP_AGENT: DurableObjectNamespace;
	COOK_AGENT: DurableObjectNamespace;
	MEMBER_AGENT: DurableObjectNamespace;
	// Wave 8 foundation — ephemeral brigade lead. Optional: when running
	// against a Wave 7-only deployment the binding is absent and the
	// MealAgent active_cook hand-off short-circuits to the legacy stub.
	COOKING_LEAD_AGENT?: DurableObjectNamespace;
	// Wave 8B Track B — brigade photo storage (R2). Optional so the worker
	// type compiles before the bucket has been provisioned. The photo
	// upload route returns 503 when the binding is missing.
	BRIGADE_PHOTOS?: R2Bucket;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname === "/" ? "/mise-graph" : url.pathname;

		// Chef-of-staff agent route — runs the agent loop on the worker and
		// streams SSE back. Handles its own OPTIONS preflight (per-route CORS
		// because the web app is on a different origin and we need fine-
		// grained allow-origin/headers for credentialed reqs).
		if (path === "/agent/chef") {
			return await handleAgentChefRoute(request, env);
		}

		if (request.method === "OPTIONS") {
			return new Response(null, { status: 204, headers: CORS_HEADERS });
		}

		// MCP plan-world tool server (Wave 5A)
		const mcpResponse = await handlePlanWorldMcpRequest(path, request, env);
		if (mcpResponse) return mcpResponse;

		// Replan webhook (Wave 5E) — POST /mise-graph/replan, GET /mise-graph/replan/log
		if (path === "/mise-graph/replan" && request.method === "POST") {
			const r = await handleReplanRequest(request, env);
			return withCors(r);
		}
		if (path === "/mise-graph/replan/log" && request.method === "GET") {
			const r = await handleReplanLogRequest(request, env);
			return withCors(r);
		}

		// Admin: schema migrations
		if (path === "/mise-graph/admin/migrate-household-memory" && request.method === "POST") {
			try {
				const result = await migrateHouseholdMemorySchema(env);
				return jsonResponse(result);
			} catch (e) {
				return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 500);
			}
		}

		// Admin: calendar schema (Wave 6)
		if (path === "/mise-graph/admin/migrate-calendar" && request.method === "POST") {
			try {
				const result = await migrateCalendarSchema(env);
				return jsonResponse(result);
			} catch (e) {
				return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 500);
			}
		}

		// Admin: Wave 8 brigade schema migration. Adds:
		//   * mise_brigade_events
		//   * mise_brigade_pending_tokens
		// Idempotent CREATE TABLE IF NOT EXISTS. Gated on X-Spence-Admin.
		if (path === "/mise-graph/admin/migrate-brigade" && request.method === "POST") {
			if (!request.headers.get("X-Spence-Admin")) {
				return jsonResponse({ error: "X-Spence-Admin header required" }, 401);
			}
			try {
				const result = await migrateBrigadeSchema(env);
				return jsonResponse({ ok: true, ...result });
			} catch (e) {
				return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 500);
			}
		}

		// Admin: Onboarding Phase A schema migration. Adds:
		//   * mise_onboarding_state, mise_onboarding_responses,
		//     mise_household_traits, mise_household_traditions
		//   * ALTER TABLE mise_household_profiles ADD COLUMN
		//     dinner_ritual / cook_frequency / pantry_intake_mode
		// Idempotent — re-running is a no-op (CREATE IF NOT EXISTS + ALTERs
		// are wrapped in try/catch for "duplicate column"). Gated on
		// X-Spence-Admin.
		if (path === "/mise-graph/admin/migrate-onboarding" && request.method === "POST") {
			if (!request.headers.get("X-Spence-Admin")) {
				return jsonResponse({ error: "X-Spence-Admin header required" }, 401);
			}
			try {
				const result = await migrateOnboardingSchema(env);
				return jsonResponse({ ok: true, ...result });
			} catch (e) {
				return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 500);
			}
		}

		// Wave 8 foundation — CookingLeadAgent WS upgrade endpoint.
		// Pattern: /mise-graph/agents/cooking-lead/<cook_session_id>/ws?token=...
		// We forward the original request (Upgrade header intact) to the DO
		// so partyserver's fetch() handles the WS upgrade + auth via
		// getConnectionTags. NOT admin-gated — the token IS the auth.
		if (path.startsWith("/mise-graph/agents/cooking-lead/") && path.endsWith("/ws")) {
			const ns = env.COOKING_LEAD_AGENT;
			if (!ns) return jsonResponse({ error: "COOKING_LEAD_AGENT not bound" }, 503);
			const idPart = path.slice("/mise-graph/agents/cooking-lead/".length, -"/ws".length);
			if (!idPart) return jsonResponse({ error: "cook_session_id required" }, 400);
			try {
				const stub = ns.get(ns.idFromName(cookingLeadAgentName(idPart)));
				return await stub.fetch(request);
			} catch (e) {
				return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 500);
			}
		}

		// Wave 8B Track B — phone-facing photo routes. Pattern:
		//   POST /mise-graph/agents/cooking-lead/<cook_session_id>/upload-photo?member_id=&task_id=&token=
		//   GET  /mise-graph/agents/cooking-lead/<cook_session_id>/photo?photo_id=&token=
		//   GET  /mise-graph/agents/cooking-lead/<cook_session_id>/photo-analysis?photo_id=&token=
		// NOT admin-gated — the token IS the auth (verified inside the DO).
		// Forward the request body intact so the DO can read the multipart /
		// raw image bytes.
		if (
			path.startsWith("/mise-graph/agents/cooking-lead/") &&
			(path.endsWith("/upload-photo") ||
				path.endsWith("/photo") ||
				path.endsWith("/photo-analysis"))
		) {
			const ns = env.COOKING_LEAD_AGENT;
			if (!ns) return jsonResponse({ error: "COOKING_LEAD_AGENT not bound" }, 503);
			const tail = path.slice("/mise-graph/agents/cooking-lead/".length);
			const slash = tail.indexOf("/");
			if (slash <= 0) return jsonResponse({ error: "cook_session_id required" }, 400);
			const idPart = tail.slice(0, slash);
			const action = tail.slice(slash + 1); // upload-photo | photo | photo-analysis
			try {
				const stub = ns.get(ns.idFromName(cookingLeadAgentName(idPart)));
				// Forward the request to the DO under its internal URL, preserving
				// the search params + body. The DO's onRequest dispatches by
				// the trailing route segment.
				const internalUrl = `https://agent/internal/${action}${url.search}`;
				const fwdInit: RequestInit = {
					method: request.method,
					headers: request.headers,
					body: request.method === "POST" ? request.body : undefined,
				};
				return await stub.fetch(new Request(internalUrl, fwdInit));
			} catch (e) {
				return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 500);
			}
		}

		// Wave 8 foundation — CookingLeadAgent admin routes (init, grant-token,
		// status, events, complete). Pattern:
		//   POST /mise-graph/agents/cooking-lead/<cook_session_id>/{init,grant-token,complete}
		//   GET  /mise-graph/agents/cooking-lead/<cook_session_id>/{state,status,events}
		// Admin-gated.
		if (path.startsWith("/mise-graph/agents/cooking-lead/")) {
			if (!request.headers.get("X-Spence-Admin")) {
				return jsonResponse({ error: "X-Spence-Admin header required" }, 401);
			}
			const ns = env.COOKING_LEAD_AGENT;
			if (!ns) return jsonResponse({ error: "COOKING_LEAD_AGENT not bound" }, 503);
			const tail = path.slice("/mise-graph/agents/cooking-lead/".length);
			const slash = tail.indexOf("/");
			if (slash <= 0) return jsonResponse({ error: "expected /<cook_session_id>/<action>" }, 400);
			const idPart = tail.slice(0, slash);
			const action = tail.slice(slash + 1);
			if (!idPart || !action) {
				return jsonResponse({ error: "cook_session_id and action required" }, 400);
			}
			try {
				const stub = ns.get(ns.idFromName(cookingLeadAgentName(idPart)));
				const m = request.method.toUpperCase();
				const init: RequestInit = { method: m, headers: { "content-type": "application/json" } };
				if (m === "POST") {
					const text = await request.text();
					init.body = text || "{}";
				}
				const resp = await stub.fetch(new Request(`https://agent/internal/${action}`, init));
				const respText = await resp.text();
				return new Response(respText, {
					status: resp.status,
					headers: { "Content-Type": "application/json", ...CORS_HEADERS },
				});
			} catch (e) {
				return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 500);
			}
		}

		// Admin: Wave 7 schema migrations. Single consolidated route runs all
		// 8 migrations in sequence and reports per-step status. Idempotent.
		// Gated by X-Spence-Admin (any non-empty value).
		if (path === "/mise-graph/admin/migrate-wave-7" && request.method === "POST") {
			if (!request.headers.get("X-Spence-Admin")) {
				return jsonResponse({ error: "X-Spence-Admin header required" }, 401);
			}
			const migrated: Array<{ step: string; tables?: string[] }> = [];
			const errors: Array<{ step: string; error: string }> = [];
			const steps: Array<{ name: string; fn: () => Promise<unknown> }> = [
				{ name: "household_memory", fn: () => migrateHouseholdMemorySchema(env) },
				{ name: "calendar", fn: () => migrateCalendarSchema(env) },
				{ name: "daily_briefs", fn: () => migrateDailyBriefsSchema(env) },
				{ name: "plan_health", fn: () => migratePlanHealthSchema(env) },
				{ name: "shop_reminders", fn: () => migrateShopRemindersSchema(env) },
				{ name: "meal_agent", fn: () => migrateMealAgentSchemas(env) },
				{ name: "task_graphs", fn: () => migrateTaskGraphSchema(env).then(() => ({ migrated: ["mise_task_graphs"] })) },
				{ name: "equipment", fn: async () => {
					// Run the rebuild path on existing deployments — converts the
					// legacy `slug TEXT PRIMARY KEY` definitions table to the
					// per-household composite PK, and adds household_id to the
					// claims table. Idempotent on fresh installs.
					const rebuilt = await migrateEquipmentSchemaWithRebuild(env);
					await migrateEquipmentSchema(env);
					return {
						migrated: ["mise_equipment_definitions", "mise_equipment_claims"],
						rebuilt,
					};
				} },
			];
			for (const step of steps) {
				try {
					const r = (await step.fn()) as { migrated?: string[] } | undefined;
					migrated.push({ step: step.name, tables: r?.migrated });
				} catch (e) {
					errors.push({ step: step.name, error: e instanceof Error ? e.message : String(e) });
				}
			}
			return jsonResponse({ migrated, errors });
		}

		// Admin: DO bridge routes. Each route computes the DO id from the URL
		// path, forwards request to the DO, and returns its response unchanged.
		// All gated on X-Spence-Admin.
		const bridgeMatch = matchBridgeRoute(path, request.method);
		if (bridgeMatch) {
			if (!request.headers.get("X-Spence-Admin")) {
				return jsonResponse({ error: "X-Spence-Admin header required" }, 401);
			}
			try {
				const body = request.method === "POST"
					? (await request.json().catch(() => ({})) as Record<string, unknown>)
					: undefined;
				const resp = await probeDO(env, {
					kind: bridgeMatch.kind,
					id: bridgeMatch.id,
					action: bridgeMatch.action,
					method: bridgeMatch.method,
					body,
				});
				const respText = await resp.text();
				return new Response(respText, {
					status: resp.status,
					headers: { "Content-Type": "application/json", ...CORS_HEADERS },
				});
			} catch (e) {
				return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 500);
			}
		}

		// Admin: Wave 7 DO smoke test. Spawns a HouseholdAgent + PlanAgent for
		// the given household_id/plan_id and pings each one. Gated by the same
		// X-Spence-Admin header used by the migrate-* routes (any non-empty
		// value passes — admin routes here are dev-only and the worker isn't
		// publicly routed).
		if (path === "/mise-graph/agents/spawn" && request.method === "POST") {
			if (!request.headers.get("X-Spence-Admin")) {
				return jsonResponse({ error: "X-Spence-Admin header required" }, 401);
			}
			try {
				const body = (await request.json().catch(() => ({}))) as {
					household_id?: string;
					plan_id?: string;
				};
				const household_id = body.household_id;
				const plan_id = body.plan_id;
				if (!household_id || !plan_id) {
					return jsonResponse({ error: "household_id and plan_id required" }, 400);
				}

				const householdNs = env.HOUSEHOLD_AGENT;
				const householdStub = householdNs.get(
					householdNs.idFromName(householdAgentName(household_id)),
				);

				// Init the household.
				await householdStub.fetch(
					new Request("https://agent/internal/init", {
						method: "POST",
						body: JSON.stringify({ household_id }),
						headers: { "content-type": "application/json" },
					}),
				);

				// Ask the household to spawn a plan agent.
				const spawnResp = await householdStub.fetch(
					new Request("https://agent/internal/spawn-plan", {
						method: "POST",
						body: JSON.stringify({ plan_id }),
						headers: { "content-type": "application/json" },
					}),
				);
				const spawn = await spawnResp.json().catch(() => ({}));

				// Read back state from both DOs to confirm they're alive.
				const householdState = await (await householdStub.fetch(
					new Request("https://agent/internal/state", { method: "GET" }),
				)).json();
				const planNs = env.PLAN_AGENT;
				const planStub = planNs.get(planNs.idFromName(planAgentName(plan_id)));
				const planState = await (await planStub.fetch(
					new Request("https://agent/internal/state", { method: "GET" }),
				)).json();

				return jsonResponse({
					ok: true,
					spawn,
					household_state: householdState,
					plan_state: planState,
				});
			} catch (e) {
				return jsonResponse(
					{ error: e instanceof Error ? e.message : String(e) },
					500,
				);
			}
		}

		// Admin: trigger daily check-in manually (testing)
		if (path === "/mise-graph/admin/run-checkin" && request.method === "POST") {
			try {
				const body = await request.json().catch(() => ({})) as { household_id?: string };
				const result = await runDailyCheckinForToday(env as Env & Partial<MeshClaudeEnv>, body.household_id);
				return jsonResponse(result);
			} catch (e) {
				return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 500);
			}
		}

		const response = await handleMiseGraphRequest(path, request, env);
		if (response) return response;

		return new Response(JSON.stringify({ error: "Not found", service: "mise-graph" }, null, 2), {
			status: 404,
			headers: { "Content-Type": "application/json", ...CORS_HEADERS },
		});
	},

	// Scheduled handler invoked by Cloudflare Cron Trigger.
	//
	// Wave 7F runs TWO sweeps per fire:
	//   1. runDailyMorningBriefSweep — fans out to every active household's
	//      HouseholdAgent /daily-brief route. This is the primary brief in
	//      the entity-DO architecture.
	//   2. handleDailyCheckin — legacy per-plan brief (kept until consumers
	//      migrate to mise_household_agent_briefs).
	//
	// Both run via ctx.waitUntil so the cron returns immediately. Errors are
	// per-household / per-plan and never abort the other sweep.
	async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
		const fireMs = controller.scheduledTime || Date.now();
		ctx.waitUntil(
			runDailyMorningBriefSweep(env, fireMs)
				.then(result => {
					console.log("[cron] morning-brief sweep:", JSON.stringify(result));
				})
				.catch(err => {
					console.error("[cron] morning-brief sweep failed:", err);
				}),
		);
		ctx.waitUntil(
			handleDailyCheckin(env as Env & Partial<MeshClaudeEnv>)
				.then(result => {
					console.log("[cron] daily check-in (legacy):", JSON.stringify(result));
				})
				.catch(err => {
					console.error("[cron] daily check-in (legacy) failed:", err);
				}),
		);
	},
};

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body, null, 2), {
		status,
		headers: { "Content-Type": "application/json", ...CORS_HEADERS },
	});
}

interface BridgeRoute {
	kind: "household" | "plan" | "meal" | "shop" | "cook" | "member";
	id: string;
	action: string;
	method: "GET" | "POST";
}

/**
 * Match a path like:
 *   GET  /mise-graph/agents/household/:hh/state
 *   POST /mise-graph/agents/meal/:plan/:date/:slot/start-cook
 *   POST /mise-graph/agents/shop/:plan/:run/mark-completed
 * to a bridge route. Returns null when the path doesn't match a known shape.
 *
 * The DO id format is documented in agents/base.ts (e.g. mealAgentName), and
 * `router.ts` re-exports the helpers we use here.
 */
function matchBridgeRoute(path: string, method: string): BridgeRoute | null {
	const prefix = "/mise-graph/agents/";
	if (!path.startsWith(prefix)) return null;
	const segments = path.slice(prefix.length).split("/").filter(Boolean);
	if (segments.length < 2) return null;
	const [kind, ...rest] = segments;
	const m = method.toUpperCase() as "GET" | "POST";

	switch (kind) {
		case "household": {
			// /household/:hh/<action>
			if (rest.length !== 2) return null;
			const [hh, action] = rest;
			return { kind: "household", id: householdName(hh), action, method: m };
		}
		case "plan": {
			// /plan/:plan/<action>
			if (rest.length !== 2) return null;
			const [plan, action] = rest;
			return { kind: "plan", id: planName(plan), action, method: m };
		}
		case "meal": {
			// /meal/:plan/:date/:slot/<action>
			if (rest.length !== 4) return null;
			const [plan, date, slot, action] = rest;
			return { kind: "meal", id: mealName(plan, date, slot), action, method: m };
		}
		case "shop": {
			// /shop/:plan/:run/<action>
			if (rest.length !== 3) return null;
			const [plan, run, action] = rest;
			return { kind: "shop", id: shopName(plan, run), action, method: m };
		}
		case "cook": {
			// /cook/:meal/:cook_id/<action>
			if (rest.length !== 3) return null;
			const [meal, cookId, action] = rest;
			return { kind: "cook", id: cookName(meal, cookId), action, method: m };
		}
		case "member": {
			// /member/:hh/:member/<action>
			if (rest.length !== 3) return null;
			const [hh, mem, action] = rest;
			return { kind: "member", id: memberName(hh, mem), action, method: m };
		}
		default:
			return null;
	}
}

function withCors(r: Response): Response {
	const headers = new Headers(r.headers);
	for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
	return new Response(r.body, { status: r.status, headers });
}

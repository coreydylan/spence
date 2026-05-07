// PlanWorld MCP-over-HTTP server.
//
// Exposes the world model (ledger, ripple preview, critics, locks, recipe
// import, coherence score) as an MCP tool catalog so an LLM agent can drive
// plan composition turn-by-turn instead of via single-shot LLM calls.
// JSON-RPC 2.0 over POST /mcp/plan-world. Supports `initialize`, `tools/list`,
// `tools/call`, and `ping`.
//
// Each tool wraps an existing world-model API. ALL stateful tools take
// `plan_id` as their first argument; the handler loads the persisted plan
// from D1 (`mise_active_plans`, falling back to legacy `mise_week_plans`),
// applies the change in memory, and saves the result back. Because the
// in-memory RipplePreview proposal cache is dropped between MCP requests,
// write tools fuse preview + commit in the same handler call.

import type { MiseGraphEnv } from "./types";
import {
	deleteActivePlan,
	listActivePlans,
	loadActivePlan,
	markActivePlanFinal,
	saveActivePlan,
} from "./active-plans";
import { saveMiseWeeklyPlan, type MiseWeeklyPlanDraft, type MisePlanMeal, type MisePlanDay, type MiseMealSlot } from "./planner";
import {
	createPlanWorld,
	planCommitPreview,
	planFinalize,
	planPreviewMutation,
	planReadCoherence,
	planReadEmptySlots,
	planReadGrievances,
	planReadMap,
	planReadMeal,
	planReadSummary,
	type PlanWorld,
	type PlanWorldMutationInput,
	type PlanWorldSlotRef,
} from "./plan-world-tools";
import {
	clearProposalCache,
	commit,
	previewCancelMeal,
	previewMoveMeal,
	previewMoveShop,
	previewReplaceMeal,
	previewSlidePrepDate,
	previewSplitBatch,
	previewSwapIngredient,
	rebuildShoppingList,
	type RipplePreview,
} from "./ripple-preview";
import { runHardCritics, runWarningCritics, type Grievance, type GrievanceSeverity } from "./critics";
import { ledgerFromPlan } from "./resource-ledger";
import { deriveDependencyEdges, edgesViolated, type DependencyEdge } from "./dependency-edges";
import { isMealLocked, lockMeal, unlockMeal } from "./locks";
import { assignRecipeToSlot, importRecipe, type AssignOptions, type ImportedRecipe, type ImportInput } from "./recipe-importer";
import { fillComponents } from "./composer-postpass";
import type { ComposedMeal, ComposerRawIngredient } from "./menu-composer";
import { FORMAT_ALIASES, FORMAT_SLOT_SPECS } from "./meal-component";
import {
	inspireReadAffinityPairs,
	inspireReadAnchorPressure,
	inspireReadCanonicalComponents,
	inspireReadCanonicalDishes,
	inspireReadCuisineFusions,
	inspireReadFlavorCompounds,
	inspireReadFlavorVibes,
	inspireReadFormatLibrary,
	inspireReadHouseholdContext,
	inspireReadRecentMenu,
	inspireReadRecipeLibrary,
	inspireReadSeasonality,
	inspireReadTasteFeedback,
} from "./inspire-tools";
import { inspireReadRecipeSteps } from "./recipe-lookup";
import { fetchWeatherForecast } from "./weather-tools";
import {
	addCalendarBlock,
	cancelStagedEvent,
	listStagedEvents,
	readCalendarWindows,
	stageCalendarEvent,
	type CalendarEventInput,
} from "./calendar-tools";
import {
	coerceCallerKind,
	getMutationTrace,
	getTrace,
	linkMutationToTrace,
	listMutationsForPlan,
	listPlanTraces,
	traced,
	type CallerKind,
	type TraceContext,
	type TriggeredMutation,
} from "./agent-trace";
import {
	getMember,
	listMembers,
	recordSkillOutcome,
	upsertMember,
	type AgeGroup,
	type MemberPreferences,
	type MemberSafety,
	type SkillOutcome,
} from "./household-members";
import {
	answerOnboarding,
	skipOnboarding,
	startOnboarding,
	statusOnboarding,
} from "./onboarding";
import {
	getPresence,
	listAvailableMembers,
	pingPresence,
	type PresenceState,
} from "./member-presence";
import {
	autoTetrisFit,
	bookmarkConcept,
	getConcept,
	getMovement,
	listConcepts,
	scoreTetris,
	setMovement,
	shortlistTopConcepts,
	updateConceptStatus,
	type ConceptCard,
	type ConceptCardRawIngredient,
	type ConceptSourceKind,
	type ConceptStatus,
} from "./concept-board";
import {
	routeCookingLead,
	routeMealCancelled,
	routeMealComposed,
	routeMemberInit,
	routeMemberPingPresence,
	routeMemberSkillOutcome,
	routePlanArchived,
	routePlanCreated,
	routePlanFinalized,
} from "./agents/router";

const CORS_HEADERS: Record<string, string> = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type",
};

const MCP_ROUTE = "/mcp/plan-world";
const VALID_SLOTS: ReadonlyArray<MiseMealSlot> = ["breakfast", "lunch", "dinner", "snack"];

interface JsonRpcRequest {
	jsonrpc?: "2.0";
	id?: string | number | null;
	method?: string;
	params?: unknown;
}

interface ToolCallParams {
	name?: unknown;
	arguments?: unknown;
}

// ─── HTTP entry ─────────────────────────────────────────────────────────────

// Trace-context HTTP headers. `x-spence-trace-caller-kind` flags the caller
// (agent/human/cron/replan/subagent), `x-spence-trace-caller-id` carries an
// opaque session/agent id, `x-spence-trace-parent` lets a subagent thread its
// call under a parent trace. Default caller_kind is `system` so internal cron
// jobs and direct fetches still produce traces (just unlabeled).
const TRACE_HEADER_CALLER_KIND = "x-spence-trace-caller-kind";
const TRACE_HEADER_CALLER_ID = "x-spence-trace-caller-id";
const TRACE_HEADER_PARENT = "x-spence-trace-parent";

export interface CallerTraceContext {
	caller_kind: CallerKind;
	caller_id: string | null;
	parent_trace_id: string | null;
}

export async function handlePlanWorldMcpRequest(
	path: string,
	request: Request,
	env: MiseGraphEnv,
): Promise<Response | null> {
	if (path !== MCP_ROUTE) return null;

	if (request.method === "OPTIONS") {
		return new Response(null, { status: 204, headers: CORS_HEADERS });
	}

	if (request.method === "GET") {
		return json({
			service: "plan-world-mcp",
			route: MCP_ROUTE,
			methods: ["initialize", "tools/list", "tools/call", "ping"],
			tools: PLAN_WORLD_TOOLS.map(tool => tool.name),
		});
	}

	if (request.method !== "POST") {
		return json({ error: "Method not allowed" }, 405);
	}

	const body = await request.json().catch(() => null);
	const callerCtx = readCallerContext(request);
	const result = await handlePlanWorldJsonRpc(body, env, callerCtx);
	return json(result);
}

export async function handlePlanWorldJsonRpc(
	input: unknown,
	env: MiseGraphEnv,
	caller?: CallerTraceContext,
): Promise<unknown> {
	if (Array.isArray(input)) {
		return Promise.all(input.map(item => handleOneJsonRpc(item, env, caller)));
	}
	return handleOneJsonRpc(input, env, caller);
}

async function handleOneJsonRpc(
	input: unknown,
	env: MiseGraphEnv,
	caller?: CallerTraceContext,
): Promise<Record<string, unknown>> {
	const request = isRecord(input) ? input as JsonRpcRequest : {};
	const id = request.id ?? null;
	if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
		return rpcError(id, -32600, "Invalid JSON-RPC request");
	}

	try {
		switch (request.method) {
			case "initialize":
				return rpcResult(id, {
					protocolVersion: "2024-11-05",
					capabilities: { tools: {} },
					serverInfo: { name: "spence-plan-world", version: "0.2.0" },
				});
			case "ping":
				return rpcResult(id, { ok: true });
			case "tools/list":
				return rpcResult(id, { tools: PLAN_WORLD_TOOLS });
			case "tools/call":
				return rpcResult(id, await handleToolCall(request.params, env, caller));
			default:
				return rpcError(id, -32601, `Method not found: ${request.method}`);
		}
	} catch (error) {
		return rpcError(id, -32000, error instanceof Error ? error.message : String(error));
	}
}

async function handleToolCall(
	params: unknown,
	env: MiseGraphEnv,
	caller?: CallerTraceContext,
): Promise<Record<string, unknown>> {
	const call = isRecord(params) ? params as ToolCallParams : {};
	const name = typeof call.name === "string" ? call.name : "";
	const args = isRecord(call.arguments) ? call.arguments : {};
	try {
		const structuredContent = await callPlanWorldTool(name, args, env, caller);
		const text = typeof structuredContent.map === "string"
			? structuredContent.map
			: JSON.stringify(structuredContent, null, 2);
		return {
			content: [{ type: "text", text }],
			structuredContent,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			isError: true,
			content: [{ type: "text", text: `Tool '${name || "?"}' failed: ${message}` }],
		};
	}
}

function readCallerContext(request: Request): CallerTraceContext {
	const kindRaw = request.headers.get(TRACE_HEADER_CALLER_KIND);
	const idRaw = request.headers.get(TRACE_HEADER_CALLER_ID);
	const parentRaw = request.headers.get(TRACE_HEADER_PARENT);
	return {
		caller_kind: coerceCallerKind(kindRaw),
		caller_id: idRaw && idRaw.trim().length > 0 ? idRaw.trim() : null,
		parent_trace_id: parentRaw && parentRaw.trim().length > 0 ? parentRaw.trim() : null,
	};
}

// ─── Tool dispatch ──────────────────────────────────────────────────────────

export async function callPlanWorldTool(
	name: string,
	args: Record<string, unknown>,
	env: MiseGraphEnv,
	caller?: CallerTraceContext,
): Promise<Record<string, unknown>> {
	switch (name) {
		// ── Plan lifecycle ───────────────────────────────────────────────
		case "plan_create":
			return await withTrace(env, name, args, caller, ctx => toolPlanCreateTraced(args, env, ctx));
		case "plan_get_summary":
		case "plan_read_summary": return await toolReadSummary(args, env);
		case "plan_finalize":
			return await withTrace(env, name, args, caller, () => toolFinalize(args, env));
		case "plan_archive":
			return await withTrace(env, name, args, caller, () => toolArchive(args, env));
		case "plan_list": return await toolList(args, env);

		// ── Read tools ───────────────────────────────────────────────────
		case "plan_read_map": return await toolReadMap(args, env);
		case "plan_read_empty_slots": return await toolReadEmptySlots(args, env);
		case "plan_read_meal": return await toolReadMeal(args, env);
		case "plan_read_ledger_at": return await toolReadLedgerAt(args, env);
		case "plan_read_expiring_by": return await toolReadExpiringBy(args, env);
		case "plan_read_grievances": return await toolReadGrievances(args, env);
		case "plan_read_recent_meals": return await toolReadRecentMeals(args, env);
		case "plan_read_cuisine_balance": return await toolReadCuisineBalance(args, env);
		case "plan_read_format_balance": return await toolReadFormatBalance(args, env);
		case "plan_read_batches": return await toolReadBatches(args, env);
		case "plan_read_shopping_list": return await toolReadShoppingList(args, env);
		case "plan_read_shop_runs": return await toolReadShopRuns(args, env);
		case "plan_read_dependency_edges": return await toolReadDependencyEdges(args, env);
		case "plan_read_coherence": return await toolReadCoherence(args, env);

		// ── Write tools (preview+commit fused) — wrapped in withTrace so
		//     every commit gets a trace_id and mutation_traces row.
		case "plan_compose_meal":
			return await withTrace(env, name, args, caller, ctx => toolComposeMealTraced(args, env, ctx));
		case "plan_cancel_meal":
			return await withTrace(env, name, args, caller, ctx => toolCancelMealTraced(args, env, ctx));
		case "plan_swap_ingredient":
			return await withTrace(env, name, args, caller, ctx => toolSwapIngredientTraced(args, env, ctx));
		case "plan_move_meal":
			return await withTrace(env, name, args, caller, ctx => toolMoveMealTraced(args, env, ctx));
		case "plan_replace_meal":
			return await withTrace(env, name, args, caller, ctx => toolReplaceMealTraced(args, env, ctx));
		case "plan_split_batch":
			return await withTrace(env, name, args, caller, ctx => toolSplitBatchTraced(args, env, ctx));
		case "plan_move_shop":
			return await withTrace(env, name, args, caller, ctx => toolMoveShopTraced(args, env, ctx));
		case "plan_slide_prep_date":
			return await withTrace(env, name, args, caller, ctx => toolSlidePrepDateTraced(args, env, ctx));
		case "plan_lock_meal":
			return await withTrace(env, name, args, caller, ctx => toolLockMealTraced(args, env, ctx));
		case "plan_unlock_meal":
			return await withTrace(env, name, args, caller, ctx => toolUnlockMealTraced(args, env, ctx));
		case "plan_import_recipe": return await toolImportRecipe(args);
		case "plan_assign_recipe":
			return await withTrace(env, name, args, caller, ctx => toolAssignRecipeTraced(args, env, ctx));

		// ── Audit ────────────────────────────────────────────────────────
		case "plan_audit": return await toolAudit(args, env);
		case "plan_score_coherence": return await toolReadCoherence(args, env);

		// ── Legacy preview/commit (kept for back-compat) ─────────────────
		case "plan_preview_mutation": return await toolPreviewMutation(args, env);
		case "plan_commit_preview":
			return await withTrace(env, name, args, caller, ctx => toolCommitPreviewTraced(args, env, ctx));
		case "plan_apply_mutation":
			return await withTrace(env, name, args, caller, ctx => toolApplyMutationTraced(args, env, ctx));

		// ── Agent trace + replay debug (Wave 6) ──────────────────────────
		case "agent_get_trace": return await toolAgentGetTrace(args, env);
		case "agent_get_mutation_trace": return await toolAgentGetMutationTrace(args, env);
		case "agent_list_plan_traces": return await toolAgentListPlanTraces(args, env);
		case "agent_list_plan_mutations": return await toolAgentListPlanMutations(args, env);

		// ── Inspiration reads (Wave 6) ───────────────────────────────────
		case "inspire_read_seasonality":
			return await inspireReadSeasonality(env, args as Parameters<typeof inspireReadSeasonality>[1]) as unknown as Record<string, unknown>;
		case "inspire_read_anchor_pressure":
			return await inspireReadAnchorPressure(env, args as Parameters<typeof inspireReadAnchorPressure>[1]) as unknown as Record<string, unknown>;
		case "inspire_read_recent_menu":
			return await inspireReadRecentMenu(env, args as Parameters<typeof inspireReadRecentMenu>[1]) as unknown as Record<string, unknown>;
		case "inspire_read_taste_feedback":
			return await inspireReadTasteFeedback(env, args as Parameters<typeof inspireReadTasteFeedback>[1]) as unknown as Record<string, unknown>;
		case "inspire_read_recipe_library":
			return await inspireReadRecipeLibrary(env, args as Parameters<typeof inspireReadRecipeLibrary>[1]) as unknown as Record<string, unknown>;
		case "inspire_read_canonical_dishes":
			return await inspireReadCanonicalDishes(env, args as Parameters<typeof inspireReadCanonicalDishes>[1]) as unknown as Record<string, unknown>;
		case "inspire_read_canonical_components":
			return await inspireReadCanonicalComponents(env, args as Parameters<typeof inspireReadCanonicalComponents>[1]) as unknown as Record<string, unknown>;
		case "inspire_read_recipe_steps":
			return await inspireReadRecipeSteps(env, args as Parameters<typeof inspireReadRecipeSteps>[1]) as unknown as Record<string, unknown>;
		case "inspire_read_flavor_compounds":
			return await inspireReadFlavorCompounds(env, args as Parameters<typeof inspireReadFlavorCompounds>[1]) as unknown as Record<string, unknown>;
		case "inspire_read_affinity_pairs":
			return await inspireReadAffinityPairs(env, args as Parameters<typeof inspireReadAffinityPairs>[1]) as unknown as Record<string, unknown>;
		case "inspire_read_cuisine_fusions":
			return await inspireReadCuisineFusions(env, args as Parameters<typeof inspireReadCuisineFusions>[1]) as unknown as Record<string, unknown>;
		case "inspire_read_flavor_vibes":
			return await inspireReadFlavorVibes(env, args as Parameters<typeof inspireReadFlavorVibes>[1]) as unknown as Record<string, unknown>;
		case "inspire_read_format_library":
			return await inspireReadFormatLibrary(env, args as Parameters<typeof inspireReadFormatLibrary>[1]) as unknown as Record<string, unknown>;
		case "inspire_read_household_context":
			return await inspireReadHouseholdContext(env, args as Parameters<typeof inspireReadHouseholdContext>[1]) as unknown as Record<string, unknown>;

		// ── Weather + calendar (Wave 6) ───────────────────────────────────
		case "inspire_read_weather": return await toolReadWeather(args, env);
		case "inspire_read_calendar": return await toolReadCalendar(args, env);
		case "inspire_add_calendar_block": return await toolAddCalendarBlock(args, env);
		case "plan_stage_calendar_event": return await toolStageCalendarEvent(args, env);
		case "plan_list_staged_events": return await toolListStagedEvents(args, env);
		case "plan_cancel_staged_event": return await toolCancelStagedEvent(args, env);

		// ── Per-person household members (Wave 6) ────────────────────────
		case "member_create": return await toolMemberCreate(args, env);
		case "member_get": return await toolMemberGet(args, env);
		case "member_list": return await toolMemberList(args, env);
		case "member_update_preferences": return await toolMemberUpdatePreferences(args, env);
		case "member_update_safety": return await toolMemberUpdateSafety(args, env);
		case "member_record_skill_outcome": return await toolMemberRecordSkillOutcome(args, env);
		case "member_ping_presence": return await toolMemberPingPresence(args, env);
		case "member_get_presence": return await toolMemberGetPresence(args, env);
		case "member_list_available": return await toolMemberListAvailable(args, env);
		case "meal_set_attendance": return await toolMealSetAttendance(args, env);
		case "meal_read_attendance": return await toolMealReadAttendance(args, env);

		// ── Onboarding (Phase A) — tier-based progressive Q/A ─────────────
		case "household_onboarding_start": return await toolOnboardingStart(args, env);
		case "household_onboarding_answer": return await toolOnboardingAnswer(args, env);
		case "household_onboarding_skip": return await toolOnboardingSkip(args, env);
		case "household_onboarding_status": return await toolOnboardingStatus(args, env);

		// ── Concept board (Wave 6) — Phase-1 inspiration sticky-notes ────
		case "inspire_set_movement": return await toolInspireSetMovement(args, env);
		case "inspire_get_movement": return await toolInspireGetMovement(args, env);
		case "inspire_bookmark_concept": return await toolInspireBookmarkConcept(args, env);
		case "inspire_list_concepts": return await toolInspireListConcepts(args, env);
		case "inspire_score_tetris": return await toolInspireScoreTetris(args, env);
		case "inspire_auto_tetris": return await toolInspireAutoTetris(args, env);
		case "inspire_shortlist_top": return await toolInspireShortlistTop(args, env);
		case "inspire_commit_concept": return await toolInspireCommitConcept(args, env, caller);

		// ── Brigade (Wave 8B Track C) — manual control + observation ──────
		case "brigade_start":
			return await withTrace(env, name, args, caller, () => toolBrigadeStart(args, env));
		case "brigade_grant_token":
			return await withTrace(env, name, args, caller, () => toolBrigadeGrantToken(args, env));
		case "brigade_get_state":
			return await toolBrigadeGetState(args, env);
		case "brigade_get_event_log":
			return await toolBrigadeGetEventLog(args, env);
		case "brigade_assign_task_manually":
			return await withTrace(env, name, args, caller, () => toolBrigadeAssignManually(args, env));
		case "brigade_unassign_task":
			return await withTrace(env, name, args, caller, () => toolBrigadeUnassign(args, env));
		case "brigade_mark_task_complete":
			return await withTrace(env, name, args, caller, () => toolBrigadeMarkComplete(args, env));
		case "brigade_send_message":
			return await withTrace(env, name, args, caller, () => toolBrigadeSendMessage(args, env));
		case "brigade_pause":
			return await withTrace(env, name, args, caller, () => toolBrigadePause(args, env));
		case "brigade_resume":
			return await withTrace(env, name, args, caller, () => toolBrigadeResume(args, env));
		case "brigade_end":
			return await withTrace(env, name, args, caller, () => toolBrigadeEnd(args, env));

		default:
			throw new Error(`Unknown PlanWorld tool: ${name}`);
	}
}

// ─── Plan lifecycle handlers ────────────────────────────────────────────────

async function toolPlanCreate(args: Record<string, unknown>, env: MiseGraphEnv): Promise<Record<string, unknown>> {
	// Two intents are supported:
	//   1. Legacy: { plan: MiseWeeklyPlanDraft } — caller pre-built it.
	//   2. Spec:   { household_id, start_date, end_date, ... } — we shape an
	//      empty draft with empty slots ready for plan_compose_meal.
	if (isRecord(args.plan)) {
		const plan = requirePlan(args.plan);
		await saveActivePlan(env, plan);
		try {
			await saveMiseWeeklyPlan(env, plan);
		} catch {
			// Legacy save is best-effort — only matters when the integrator
			// has wired the archival schema. Active plans table is sufficient.
		}
		// Wave 7B Phase 2: side-effect — wake the household + plan DOs.
		await routePlanCreated(env, {
			plan_id: plan.id,
			household_id: plan.household_id ?? null,
		});
		const world = createPlanWorld(plan);
		return {
			plan_id: plan.id,
			summary: planReadSummary(world),
			coherence: planReadCoherence(world),
		};
	}

	const householdId = optionalString(args.household_id) ?? null;
	const startDate = requireString(args.start_date, "start_date");
	const endDate = optionalString(args.end_date) ?? startDate;
	const peopleDefault = numberValue(args.people_default, 2);
	const planId = optionalString(args.plan_id) ?? slugPlanId(householdId, startDate, endDate);
	const dietary = stringArray(args.dietary) ?? [];
	const ingredients = stringArray(args.ingredients) ?? [];
	const equipment = stringArray(args.equipment) ?? [];
	const pantry = stringArray(args.pantry) ?? [];
	const cuisineDirection = stringArray(args.cuisine_direction) ?? [];
	const promptText = optionalString(args.prompt) ?? null;

	const plan = buildEmptyPlan({
		plan_id: planId,
		household_id: householdId,
		start_date: startDate,
		end_date: endDate,
		people: peopleDefault,
		dietary,
		ingredients,
		equipment,
		pantry,
		cuisine_direction: cuisineDirection,
		prompt: promptText,
	});

	await saveActivePlan(env, plan);
	// Wave 7B Phase 2: side-effect — wake the household + plan DOs.
	await routePlanCreated(env, { plan_id: plan.id, household_id: householdId });
	const world = createPlanWorld(plan);
	return {
		plan_id: plan.id,
		summary: planReadSummary(world),
		empty_slot_count: planReadEmptySlots(world).length,
	};
}

async function toolReadSummary(args: Record<string, unknown>, env: MiseGraphEnv): Promise<Record<string, unknown>> {
	const world = await loadWorld(env, requireString(args.plan_id, "plan_id"));
	return { summary: planReadSummary(world) };
}

async function toolFinalize(args: Record<string, unknown>, env: MiseGraphEnv): Promise<Record<string, unknown>> {
	const planId = requireString(args.plan_id, "plan_id");
	const world = await loadWorld(env, planId);
	// Safety net: if shop_runs is empty (e.g. plan was composed via earlier
	// tool versions that didn't rebuild on insert), regenerate before finalize.
	if (!world.plan.shop_runs || world.plan.shop_runs.length === 0) {
		rebuildShoppingList(world.plan);
	}
	const result = planFinalize(world);
	await markActivePlanFinal(env, planId, world.plan);
	// Wave 7B Phase 2: drive the PlanAgent to spawn child meal/shop agents.
	const finalizeResult = await routePlanFinalized(env, {
		plan_id: planId,
		household_id: world.plan.household_id ?? null,
	});
	return {
		plan_id: planId,
		ok: result.ok,
		summary: result.summary,
		grievances: result.grievances,
		coherence: result.coherence,
		agents: finalizeResult ?? undefined,
	};
}

async function toolArchive(args: Record<string, unknown>, env: MiseGraphEnv): Promise<Record<string, unknown>> {
	const planId = requireString(args.plan_id, "plan_id");
	await deleteActivePlan(env, planId);
	// Wave 7B Phase 2: signal the PlanAgent to flip status + signal children.
	const archiveResult = await routePlanArchived(env, { plan_id: planId });
	return { plan_id: planId, archived: true, agents: archiveResult ?? undefined };
}

async function toolList(args: Record<string, unknown>, env: MiseGraphEnv): Promise<Record<string, unknown>> {
	const householdId = optionalString(args.household_id);
	const plans = await listActivePlans(env, householdId);
	return { plans };
}

// ─── Read tool handlers ─────────────────────────────────────────────────────

async function toolReadMap(args: Record<string, unknown>, env: MiseGraphEnv): Promise<Record<string, unknown>> {
	const world = await loadWorld(env, requireString(args.plan_id, "plan_id"));
	const detail = optionalString(args.detail) ?? optionalString(args.mode);
	const mode = detail === "full" ? "full" : "compact";
	const map = planReadMap(world, { mode });
	return { plan_id: world.plan.id, mode, map };
}

async function toolReadEmptySlots(args: Record<string, unknown>, env: MiseGraphEnv): Promise<Record<string, unknown>> {
	const world = await loadWorld(env, requireString(args.plan_id, "plan_id"));
	return {
		plan_id: world.plan.id,
		empty_slots: planReadEmptySlots(world, coerceSlots(args.requested_slots)),
	};
}

async function toolReadMeal(args: Record<string, unknown>, env: MiseGraphEnv): Promise<Record<string, unknown>> {
	const world = await loadWorld(env, requireString(args.plan_id, "plan_id"));
	const slot = requireSlotFromArgs(args);
	return planReadMeal(world, slot) as unknown as Record<string, unknown>;
}

async function toolReadLedgerAt(args: Record<string, unknown>, env: MiseGraphEnv): Promise<Record<string, unknown>> {
	const world = await loadWorld(env, requireString(args.plan_id, "plan_id"));
	const date = requireString(args.date, "date");
	const ledger = ledgerFromPlan(world.plan);
	const items = ledger.at(date);
	return {
		plan_id: world.plan.id,
		date,
		item_count: items.length,
		items,
	};
}

async function toolReadExpiringBy(args: Record<string, unknown>, env: MiseGraphEnv): Promise<Record<string, unknown>> {
	const world = await loadWorld(env, requireString(args.plan_id, "plan_id"));
	const date = requireString(args.date, "date");
	const threshold = numberValue(args.threshold_days, 0);
	const ledger = ledgerFromPlan(world.plan);
	const items = ledger.expiring_by(date, threshold);
	return {
		plan_id: world.plan.id,
		date,
		threshold_days: threshold,
		item_count: items.length,
		items,
	};
}

async function toolReadGrievances(args: Record<string, unknown>, env: MiseGraphEnv): Promise<Record<string, unknown>> {
	const world = await loadWorld(env, requireString(args.plan_id, "plan_id"));
	const severity = optionalString(args.severity);
	const read = planReadGrievances(world);
	const filtered = severity
		? read.grievances.filter(g => g.severity === severity)
		: read.grievances;
	return {
		plan_id: world.plan.id,
		severity: severity ?? "all",
		grievances: filtered,
		counts: read.counts,
	};
}

async function toolReadRecentMeals(args: Record<string, unknown>, env: MiseGraphEnv): Promise<Record<string, unknown>> {
	const world = await loadWorld(env, requireString(args.plan_id, "plan_id"));
	const n = Math.max(1, Math.min(50, numberValue(args.n, 7)));
	const meals = collectAllMeals(world.plan).sort((a, b) => {
		if (a.date !== b.date) return a.date.localeCompare(b.date);
		return slotOrder(a.slot) - slotOrder(b.slot);
	});
	const recent = meals.slice(-n).map(meal => ({
		id: meal.id,
		date: meal.date,
		slot: meal.slot,
		title: meal.title,
		format: meal.format,
		cuisine: meal.cuisine || [],
	}));
	return { plan_id: world.plan.id, meals: recent };
}

async function toolReadCuisineBalance(args: Record<string, unknown>, env: MiseGraphEnv): Promise<Record<string, unknown>> {
	const world = await loadWorld(env, requireString(args.plan_id, "plan_id"));
	const distribution: Record<string, number> = {};
	for (const meal of collectAllMeals(world.plan)) {
		const tags = (meal.cuisine || []);
		if (tags.length === 0) {
			distribution.unspecified = (distribution.unspecified || 0) + 1;
			continue;
		}
		for (const tag of tags) {
			const key = tag.toLowerCase();
			distribution[key] = (distribution[key] || 0) + 1;
		}
	}
	return { plan_id: world.plan.id, cuisine_distribution: distribution };
}

async function toolReadFormatBalance(args: Record<string, unknown>, env: MiseGraphEnv): Promise<Record<string, unknown>> {
	const world = await loadWorld(env, requireString(args.plan_id, "plan_id"));
	const distribution: Record<string, number> = {};
	for (const meal of collectAllMeals(world.plan)) {
		const format = (meal.format || "").toLowerCase().trim() || "unspecified";
		distribution[format] = (distribution[format] || 0) + 1;
	}
	return { plan_id: world.plan.id, format_distribution: distribution };
}

async function toolReadBatches(args: Record<string, unknown>, env: MiseGraphEnv): Promise<Record<string, unknown>> {
	const world = await loadWorld(env, requireString(args.plan_id, "plan_id"));
	return {
		plan_id: world.plan.id,
		batches: (world.plan.component_batches || []).map(batch => ({
			id: batch.id,
			label: batch.label,
			quantity: batch.quantity,
			unit: batch.unit,
			storage: batch.storage,
			quality_window_hours: batch.quality_window_hours,
			planned_uses: batch.planned_uses,
			meta: batch.meta,
		})),
	};
}

async function toolReadShoppingList(args: Record<string, unknown>, env: MiseGraphEnv): Promise<Record<string, unknown>> {
	const world = await loadWorld(env, requireString(args.plan_id, "plan_id"));
	const grouped = optionalString(args.grouped_by) ?? "category";
	return {
		plan_id: world.plan.id,
		grouped_by: grouped,
		sections: world.plan.shopping_list || [],
	};
}

async function toolReadShopRuns(args: Record<string, unknown>, env: MiseGraphEnv): Promise<Record<string, unknown>> {
	const world = await loadWorld(env, requireString(args.plan_id, "plan_id"));
	return { plan_id: world.plan.id, shop_runs: world.plan.shop_runs || [] };
}

async function toolReadDependencyEdges(args: Record<string, unknown>, env: MiseGraphEnv): Promise<Record<string, unknown>> {
	const world = await loadWorld(env, requireString(args.plan_id, "plan_id"));
	const status = optionalString(args.status);
	const allEdges = deriveDependencyEdges(world.plan);
	let edges: DependencyEdge[];
	if (status === "violated") edges = edgesViolated(allEdges);
	else if (status === "critical") edges = allEdges.filter(e => e.critical);
	else if (status && status !== "all") edges = allEdges.filter(e => e.status === status);
	else edges = allEdges;
	return {
		plan_id: world.plan.id,
		status: status ?? "all",
		edge_count: edges.length,
		edges,
	};
}

async function toolReadCoherence(args: Record<string, unknown>, env: MiseGraphEnv): Promise<Record<string, unknown>> {
	const world = await loadWorld(env, requireString(args.plan_id, "plan_id"));
	return planReadCoherence(world) as unknown as Record<string, unknown>;
}

// ─── Write tool handlers (preview+commit fused) ─────────────────────────────

async function toolComposeMeal(args: Record<string, unknown>, env: MiseGraphEnv): Promise<Record<string, unknown>> {
	const planId = requireString(args.plan_id, "plan_id");
	const slot = requireSlotFromArgs({ slot: args.slot });
	const mealInput = isRecord(args.meal) ? args.meal : null;
	if (!mealInput) throw new Error("plan_compose_meal requires a meal object");

	const plan = await loadPlan(env, planId);
	if (slotIsOccupied(plan, slot.date, slot.slot)) {
		return {
			plan_id: planId,
			ok: false,
			error: "slot_occupied",
			message: `Slot ${slot.date}/${slot.slot} already has a meal. Use plan_replace_meal instead.`,
		};
	}

	const beforeGrievances = safeRunCritics(plan);
	const beforeIds = new Set(beforeGrievances.map(grievanceKey));

	const updated = insertMealAtSlot(plan, slot, mealInput);
	// Rebuild shopping_list + shop_runs after the insert. Otherwise compose-only
	// flows (which never go through ripple-preview's apply path) leave the plan
	// with empty shop_runs and a stale shopping list.
	rebuildShoppingList(updated);
	const afterGrievances = safeRunCritics(updated);
	const afterIds = new Set(afterGrievances.map(grievanceKey));

	const newGrievances = afterGrievances.filter(g => !beforeIds.has(grievanceKey(g)));
	const resolvedGrievances = beforeGrievances.filter(g => !afterIds.has(grievanceKey(g)));

	await saveActivePlan(env, updated);
	const world = createPlanWorld(updated);
	const meal_id = findMealId(updated, slot.date, slot.slot);
	// Wave 7B Phase 2: wake the MealAgent so its state machine kicks in.
	if (meal_id) {
		await routeMealComposed(env, {
			plan_id: planId,
			date: slot.date,
			slot: slot.slot,
			meal_id,
			household_id: updated.household_id ?? null,
		});
	}
	return {
		plan_id: planId,
		ok: true,
		meal_id,
		new_grievances: newGrievances,
		resolved_grievances: resolvedGrievances,
		summary: planReadSummary(world),
	};
}

async function toolCancelMeal(args: Record<string, unknown>, env: MiseGraphEnv): Promise<Record<string, unknown>> {
	const planId = requireString(args.plan_id, "plan_id");
	const slot = requireSlotFromArgs(args);
	const reason = optionalString(args.reason) ?? "manual_cancel";
	const result = await applyMutation(env, args, plan => previewCancelMeal(plan, slot));
	// Wave 7B Phase 2: signal the MealAgent so it can release equipment claims
	// and write a phase_transition row. Best-effort; D1 is authoritative.
	if (result.ok !== false) {
		await routeMealCancelled(env, {
			plan_id: planId,
			date: slot.date,
			slot: slot.slot,
			reason,
		});
	}
	return result;
}

async function toolSwapIngredient(args: Record<string, unknown>, env: MiseGraphEnv): Promise<Record<string, unknown>> {
	const slot = requireSlotFromArgs(args);
	const fromName = requireString(args.from_name, "from_name");
	const toName = requireString(args.to_name, "to_name");
	return await applyMutation(env, args, plan => previewSwapIngredient(plan, slot, fromName, toName));
}

async function toolMoveMeal(args: Record<string, unknown>, env: MiseGraphEnv): Promise<Record<string, unknown>> {
	const from = requireSlotFromArgs({ slot: args.from_slot });
	const to = requireSlotFromArgs({ slot: args.to_slot });
	const mode = args.mode === "swap" ? "swap" : "replace";
	return await applyMutation(env, args, plan => previewMoveMeal(plan, from, to, mode));
}

async function toolReplaceMeal(args: Record<string, unknown>, env: MiseGraphEnv): Promise<Record<string, unknown>> {
	const slot = requireSlotFromArgs(args);
	// Accept both `new_meal` and `meal` — agents naturally reach for `meal`
	// since plan_compose_meal uses that name. Silently picking the wrong key
	// caused a hard-to-debug walkthrough failure (replace silently no-op'd).
	const mealRecord = isRecord(args.new_meal) ? args.new_meal : (isRecord(args.meal) ? args.meal : null);
	const newMeal = mealRecord ? coerceReplaceMeal(mealRecord) : undefined;
	if (!newMeal) {
		throw new Error("plan_replace_meal requires either `new_meal` or `meal` (a meal object). Got neither.");
	}
	return await applyMutation(env, args, plan => previewReplaceMeal(plan, slot, newMeal, {
		must_consume: stringArray(args.must_consume),
		must_avoid: stringArray(args.must_avoid),
	}));
}

async function toolSplitBatch(args: Record<string, unknown>, env: MiseGraphEnv): Promise<Record<string, unknown>> {
	const batchId = requireString(args.batch_id, "batch_id");
	const atDate = requireString(args.at_date, "at_date");
	return await applyMutation(env, args, plan => previewSplitBatch(plan, batchId, atDate));
}

async function toolMoveShop(args: Record<string, unknown>, env: MiseGraphEnv): Promise<Record<string, unknown>> {
	const runId = requireString(args.run_id, "run_id");
	const newDate = requireString(args.new_date, "new_date");
	return await applyMutation(env, args, plan => previewMoveShop(plan, runId, newDate));
}

async function toolSlidePrepDate(args: Record<string, unknown>, env: MiseGraphEnv): Promise<Record<string, unknown>> {
	const batchId = requireString(args.batch_id, "batch_id");
	const newPrepDate = requireString(args.new_prep_date, "new_prep_date");
	return await applyMutation(env, args, plan => previewSlidePrepDate(plan, batchId, newPrepDate));
}

async function toolLockMeal(args: Record<string, unknown>, env: MiseGraphEnv): Promise<Record<string, unknown>> {
	const planId = requireString(args.plan_id, "plan_id");
	const slot = requireSlotFromArgs(args);
	const reason = optionalString(args.reason) ?? "agent lock";
	const plan = await loadPlan(env, planId);
	const updated = lockMeal(plan, { date: slot.date, slot: slot.slot }, { reason, by: "agent", scope: "hard" });
	await saveActivePlan(env, updated);
	return { plan_id: planId, locked: true, slot };
}

async function toolUnlockMeal(args: Record<string, unknown>, env: MiseGraphEnv): Promise<Record<string, unknown>> {
	const planId = requireString(args.plan_id, "plan_id");
	const slot = requireSlotFromArgs(args);
	const plan = await loadPlan(env, planId);
	const updated = unlockMeal(plan, { date: slot.date, slot: slot.slot });
	await saveActivePlan(env, updated);
	return { plan_id: planId, locked: false, slot };
}

async function toolImportRecipe(args: Record<string, unknown>): Promise<Record<string, unknown>> {
	const url = optionalString(args.url);
	const plainText = optionalString(args.plain_text);
	const schemaJson = optionalString(args.schema_org_json);
	const dietary = stringArray(args.household_dietary);
	let input: ImportInput;
	if (url) input = { kind: "url", payload: url, options: { household_dietary: dietary } };
	else if (plainText) input = { kind: "plain_text", payload: plainText, options: { household_dietary: dietary } };
	else if (schemaJson) input = { kind: "schema_org_json", payload: schemaJson, options: { household_dietary: dietary } };
	else throw new Error("plan_import_recipe requires url, plain_text, or schema_org_json");

	const recipe = await importRecipe(input);
	return {
		recipe_id: recipe.id,
		title: recipe.title,
		ingredient_count: recipe.ingredients_canonicalized.length,
		warnings: recipe.warnings,
		recipe,
	};
}

async function toolAssignRecipe(args: Record<string, unknown>, env: MiseGraphEnv): Promise<Record<string, unknown>> {
	const planId = requireString(args.plan_id, "plan_id");
	const slot = requireSlotFromArgs(args);
	const recipeRaw = args.recipe;
	if (!isRecord(recipeRaw)) throw new Error("plan_assign_recipe requires a recipe object (use plan_import_recipe first)");
	const recipe = recipeRaw as unknown as ImportedRecipe;
	const opts: AssignOptions = {};
	if (args.lock === true) opts.lock = true;
	const lockReason = optionalString(args.lock_reason);
	if (lockReason) opts.lock_reason = lockReason;
	const scaleTo = optionalNumber(args.scale_to);
	if (scaleTo !== undefined) opts.scale_to = scaleTo;

	const plan = await loadPlan(env, planId);
	const updated = assignRecipeToSlot(plan, recipe, { date: slot.date, slot: slot.slot }, opts);
	await saveActivePlan(env, updated);
	const world = createPlanWorld(updated);
	return {
		plan_id: planId,
		recipe_id: recipe.id,
		slot,
		summary: planReadSummary(world),
	};
}

// ─── Trace wrapping for WRITE tools ────────────────────────────────────────

// Run `fn` under a trace. The returned value is the original handler result
// (the caller never sees the trace_id by default — it's persisted to D1 and
// surfaced via getMutationTrace()). On thrown errors the trace is recorded
// with ok=false and the error rethrows. On success we extract a result_summary
// + triggered_mutations from the result (best-effort) so the trace row carries
// readable provenance instead of a blob of JSON.
async function withTrace(
	env: MiseGraphEnv,
	tool_name: string,
	args: Record<string, unknown>,
	caller: CallerTraceContext | undefined,
	fn: (ctx: TraceContext) => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
	const callerKind = caller?.caller_kind ?? "system";
	const callerId = caller?.caller_id ?? undefined;
	const parentTraceId = caller?.parent_trace_id ?? undefined;
	const planId = optionalString(args.plan_id);
	const householdId = optionalString(args.household_id);

	return await traced(env, {
		tool_name,
		tool_args: args,
		caller_kind: callerKind,
		caller_id: callerId,
		parent_trace_id: parentTraceId,
		household_id: householdId,
		plan_id: planId,
	}, async ctx => {
		const result = await fn(ctx);
		return {
			result,
			result_summary: summarizeWriteResult(tool_name, result),
			triggered_mutations: extractMutationsFromResult(tool_name, result),
		};
	});
}

// Pull a short human-readable summary from a write tool's result. Most tools
// return { ok, plan_id, summary, ... }, so we read grievance counts when
// present and otherwise fall back to a one-liner with the tool name.
function summarizeWriteResult(tool_name: string, result: Record<string, unknown>): string {
	const ok = result.ok;
	if (ok === false) {
		const error = result.error || "failed";
		const message = result.message || "";
		return `${tool_name}: ${String(error)}${message ? ` (${String(message).slice(0, 80)})` : ""}`;
	}
	const summary = isRecord(result.summary) ? result.summary : null;
	const grievCounts = summary && isRecord(summary.grievance_counts) ? summary.grievance_counts : null;
	if (grievCounts) {
		const hard = Number(grievCounts.hard || 0);
		const warning = Number(grievCounts.warning || 0);
		return `${tool_name}: ok hard=${hard} warning=${warning}`;
	}
	if (typeof result.meal_id === "string") return `${tool_name}: meal=${result.meal_id}`;
	if (typeof result.proposal_id === "string") return `${tool_name}: proposal=${result.proposal_id}`;
	return `${tool_name}: ok`;
}

// Map a write-tool result to (kind, mutation_id) tuples the trace links.
// Most tools commit exactly one row; lock/unlock derive a synthetic id from
// (plan_id, date, slot) since they don't return a unique row id.
function extractMutationsFromResult(tool_name: string, result: Record<string, unknown>): TriggeredMutation[] {
	if (result.ok === false) return [];
	const out: TriggeredMutation[] = [];
	const planId = typeof result.plan_id === "string" ? result.plan_id : "";

	switch (tool_name) {
		case "plan_compose_meal": {
			const mealId = typeof result.meal_id === "string" ? result.meal_id : null;
			if (mealId) out.push({ kind: tool_name, mutation_id: mealId });
			break;
		}
		case "plan_split_batch":
		case "plan_slide_prep_date": {
			const batchId = typeof result.batch_id === "string"
				? result.batch_id
				: optionalString((result as Record<string, unknown>).proposal_id) ?? null;
			if (batchId) out.push({ kind: tool_name, mutation_id: batchId });
			break;
		}
		case "plan_move_shop": {
			const runId = typeof result.run_id === "string"
				? result.run_id
				: optionalString((result as Record<string, unknown>).proposal_id) ?? null;
			if (runId) out.push({ kind: tool_name, mutation_id: runId });
			break;
		}
		case "plan_assign_recipe": {
			const recipeId = typeof result.recipe_id === "string" ? result.recipe_id : null;
			const slot = isRecord(result.slot) ? result.slot : null;
			const id = recipeId ? `${recipeId}@${slot?.date || "?"}/${slot?.slot || "?"}` : null;
			if (id) out.push({ kind: tool_name, mutation_id: id });
			break;
		}
		case "plan_lock_meal":
		case "plan_unlock_meal": {
			const slot = isRecord(result.slot) ? result.slot : null;
			if (slot && typeof slot.date === "string" && typeof slot.slot === "string" && planId) {
				out.push({ kind: tool_name, mutation_id: `${planId}:${slot.date}:${slot.slot}` });
			}
			break;
		}
		case "plan_create": {
			if (typeof result.plan_id === "string") {
				out.push({ kind: tool_name, mutation_id: result.plan_id });
			}
			break;
		}
		case "plan_finalize":
		case "plan_archive": {
			if (planId) out.push({ kind: tool_name, mutation_id: planId });
			break;
		}
		case "plan_commit_preview":
		case "plan_apply_mutation": {
			const proposalId = typeof result.proposal_id === "string" ? result.proposal_id : null;
			if (proposalId) out.push({ kind: tool_name, mutation_id: proposalId });
			break;
		}
		default: {
			const proposalId = typeof result.proposal_id === "string" ? result.proposal_id : null;
			if (proposalId) out.push({ kind: tool_name, mutation_id: proposalId });
		}
	}
	return out;
}

// Each *Traced helper below wraps the underlying tool handler, captures a
// mutation_id from the result, and links it to the trace via
// linkMutationToTrace. The handler's return value is forwarded unchanged so
// existing callers (and tests) keep working.

async function toolPlanCreateTraced(args: Record<string, unknown>, env: MiseGraphEnv, ctx: TraceContext): Promise<Record<string, unknown>> {
	const result = await toolPlanCreate(args, env);
	await linkMutationsFromResult(env, "plan_create", result, ctx.trace_id);
	return result;
}

async function toolComposeMealTraced(args: Record<string, unknown>, env: MiseGraphEnv, ctx: TraceContext): Promise<Record<string, unknown>> {
	const result = await toolComposeMeal(args, env);
	await linkMutationsFromResult(env, "plan_compose_meal", result, ctx.trace_id);
	return result;
}

async function toolCancelMealTraced(args: Record<string, unknown>, env: MiseGraphEnv, ctx: TraceContext): Promise<Record<string, unknown>> {
	const result = await toolCancelMeal(args, env);
	await linkMutationsFromResult(env, "plan_cancel_meal", result, ctx.trace_id);
	return result;
}

async function toolSwapIngredientTraced(args: Record<string, unknown>, env: MiseGraphEnv, ctx: TraceContext): Promise<Record<string, unknown>> {
	const result = await toolSwapIngredient(args, env);
	await linkMutationsFromResult(env, "plan_swap_ingredient", result, ctx.trace_id);
	return result;
}

async function toolMoveMealTraced(args: Record<string, unknown>, env: MiseGraphEnv, ctx: TraceContext): Promise<Record<string, unknown>> {
	const result = await toolMoveMeal(args, env);
	await linkMutationsFromResult(env, "plan_move_meal", result, ctx.trace_id);
	return result;
}

async function toolReplaceMealTraced(args: Record<string, unknown>, env: MiseGraphEnv, ctx: TraceContext): Promise<Record<string, unknown>> {
	const result = await toolReplaceMeal(args, env);
	await linkMutationsFromResult(env, "plan_replace_meal", result, ctx.trace_id);
	return result;
}

async function toolSplitBatchTraced(args: Record<string, unknown>, env: MiseGraphEnv, ctx: TraceContext): Promise<Record<string, unknown>> {
	const result = await toolSplitBatch(args, env);
	await linkMutationsFromResult(env, "plan_split_batch", result, ctx.trace_id);
	return result;
}

async function toolMoveShopTraced(args: Record<string, unknown>, env: MiseGraphEnv, ctx: TraceContext): Promise<Record<string, unknown>> {
	const result = await toolMoveShop(args, env);
	await linkMutationsFromResult(env, "plan_move_shop", result, ctx.trace_id);
	return result;
}

async function toolSlidePrepDateTraced(args: Record<string, unknown>, env: MiseGraphEnv, ctx: TraceContext): Promise<Record<string, unknown>> {
	const result = await toolSlidePrepDate(args, env);
	await linkMutationsFromResult(env, "plan_slide_prep_date", result, ctx.trace_id);
	return result;
}

async function toolLockMealTraced(args: Record<string, unknown>, env: MiseGraphEnv, ctx: TraceContext): Promise<Record<string, unknown>> {
	const result = await toolLockMeal(args, env);
	await linkMutationsFromResult(env, "plan_lock_meal", result, ctx.trace_id);
	return result;
}

async function toolUnlockMealTraced(args: Record<string, unknown>, env: MiseGraphEnv, ctx: TraceContext): Promise<Record<string, unknown>> {
	const result = await toolUnlockMeal(args, env);
	await linkMutationsFromResult(env, "plan_unlock_meal", result, ctx.trace_id);
	return result;
}

async function toolAssignRecipeTraced(args: Record<string, unknown>, env: MiseGraphEnv, ctx: TraceContext): Promise<Record<string, unknown>> {
	const result = await toolAssignRecipe(args, env);
	await linkMutationsFromResult(env, "plan_assign_recipe", result, ctx.trace_id);
	return result;
}

async function toolCommitPreviewTraced(args: Record<string, unknown>, env: MiseGraphEnv, ctx: TraceContext): Promise<Record<string, unknown>> {
	const result = await toolCommitPreview(args, env);
	await linkMutationsFromResult(env, "plan_commit_preview", result, ctx.trace_id);
	return result;
}

async function toolApplyMutationTraced(args: Record<string, unknown>, env: MiseGraphEnv, ctx: TraceContext): Promise<Record<string, unknown>> {
	const result = await toolApplyMutation(args, env);
	await linkMutationsFromResult(env, "plan_apply_mutation", result, ctx.trace_id);
	return result;
}

// Pull mutation_ids out of a write-tool's result and persist links to the
// produced trace_id. Best-effort — if the result has no recognizable id we
// skip linkage rather than synthesize one.
async function linkMutationsFromResult(
	env: MiseGraphEnv,
	tool_name: string,
	result: Record<string, unknown>,
	trace_id: string,
): Promise<void> {
	if (result.ok === false) return;
	const planId = typeof result.plan_id === "string" ? result.plan_id : "";
	if (!planId) return;
	const mutations = extractMutationsFromResult(tool_name, result);
	for (const m of mutations) {
		if (!m.mutation_id) continue;
		await linkMutationToTrace(env, {
			mutation_id: m.mutation_id,
			mutation_kind: m.kind,
			plan_id: planId,
			trace_id,
		});
	}
}

// ─── Agent trace + replay (Wave 6) ─────────────────────────────────────────

async function toolAgentGetTrace(args: Record<string, unknown>, env: MiseGraphEnv): Promise<Record<string, unknown>> {
	const traceId = requireString(args.trace_id, "trace_id");
	const trace = await getTrace(env, traceId);
	if (!trace) return { trace_id: traceId, found: false };
	return { trace_id: traceId, found: true, trace };
}

async function toolAgentGetMutationTrace(args: Record<string, unknown>, env: MiseGraphEnv): Promise<Record<string, unknown>> {
	const mutationId = requireString(args.mutation_id, "mutation_id");
	const result = await getMutationTrace(env, mutationId);
	if (!result) return { mutation_id: mutationId, found: false };
	return {
		mutation_id: mutationId,
		found: true,
		trace: result.trace,
		ancestors: result.ancestors,
		chain_length: 1 + result.ancestors.length,
	};
}

async function toolAgentListPlanTraces(args: Record<string, unknown>, env: MiseGraphEnv): Promise<Record<string, unknown>> {
	const planId = requireString(args.plan_id, "plan_id");
	const limit = optionalNumber(args.limit) ?? 50;
	const traces = await listPlanTraces(env, planId, limit);
	return { plan_id: planId, count: traces.length, traces };
}

async function toolAgentListPlanMutations(args: Record<string, unknown>, env: MiseGraphEnv): Promise<Record<string, unknown>> {
	const planId = requireString(args.plan_id, "plan_id");
	const limit = optionalNumber(args.limit) ?? 100;
	const mutations = await listMutationsForPlan(env, planId, limit);
	return { plan_id: planId, count: mutations.length, mutations };
}

// ─── Audit ─────────────────────────────────────────────────────────────────

async function toolAudit(args: Record<string, unknown>, env: MiseGraphEnv): Promise<Record<string, unknown>> {
	const world = await loadWorld(env, requireString(args.plan_id, "plan_id"));
	const which = optionalString(args.run_critics) ?? "all";
	const grievances: Grievance[] = [];
	if (which === "hard" || which === "all") grievances.push(...safeRunHard(world.plan));
	if (which === "warning" || which === "all") grievances.push(...safeRunWarning(world.plan));
	const counts = countBySeverity(grievances);
	return { plan_id: world.plan.id, run_critics: which, counts, grievances };
}

// ─── Weather + calendar (Wave 6) ───────────────────────────────────────────

async function toolReadWeather(args: Record<string, unknown>, env: MiseGraphEnv): Promise<Record<string, unknown>> {
	const daysAhead = optionalNumber(args.days_ahead);
	const explicitStart = optionalString(args.start_date);
	const explicitEnd = optionalString(args.end_date);

	let startDate: string;
	let endDate: string;
	if (explicitStart) {
		startDate = explicitStart;
		endDate = explicitEnd ?? explicitStart;
	} else if (daysAhead !== undefined && daysAhead >= 0) {
		const today = new Date();
		startDate = isoDateUTC(today);
		const end = new Date(today.getTime() + Math.max(0, Math.floor(daysAhead)) * 86400000);
		endDate = isoDateUTC(end);
	} else {
		throw new Error("inspire_read_weather requires either start_date (with optional end_date) or days_ahead (non-negative integer)");
	}

	let lat: number | undefined;
	let lng: number | undefined;
	let tz: string | undefined;
	let city: string | undefined;
	if (isRecord(args.location)) {
		const locArg = args.location;
		if (typeof locArg.lat === "number") lat = locArg.lat;
		if (typeof locArg.lng === "number") lng = locArg.lng;
		if (typeof locArg.tz === "string") tz = locArg.tz;
		if (typeof locArg.city === "string") city = locArg.city;
	}

	// Household lookup is best-effort: if location not given, the household
	// profile may store one in shop_preferences or notes in a future wave.
	// For Wave 6 we require explicit location and surface a helpful error.
	if ((lat === undefined || lng === undefined) && optionalString(args.household_id)) {
		// Placeholder: read lat/lng from household profile shop_preferences if/
		// when that field lands. For now we just throw the missing-location
		// message so the agent retries with a {lat, lng} pair.
		void env;
	}
	if (lat === undefined || lng === undefined) {
		throw new Error("inspire_read_weather requires location.{lat, lng} (household-lookup not yet wired)");
	}

	const summary = await fetchWeatherForecast(
		{ lat, lng },
		startDate,
		endDate,
		{ timezone: tz, city },
	);
	return summary as unknown as Record<string, unknown>;
}

async function toolReadCalendar(args: Record<string, unknown>, env: MiseGraphEnv): Promise<Record<string, unknown>> {
	const householdId = requireString(args.household_id, "household_id");
	const startDate = requireString(args.start_date, "start_date");
	const endDate = optionalString(args.end_date) ?? startDate;
	const windows = await readCalendarWindows(env, householdId, startDate, endDate);
	return { household_id: householdId, start_date: startDate, end_date: endDate, windows };
}

async function toolAddCalendarBlock(args: Record<string, unknown>, env: MiseGraphEnv): Promise<Record<string, unknown>> {
	const householdId = requireString(args.household_id, "household_id");
	const block = isRecord(args.block) ? args.block : null;
	if (!block) throw new Error("inspire_add_calendar_block requires a block object");
	const start = requireString(block.start, "block.start");
	const end = requireString(block.end, "block.end");
	const title = requireString(block.title, "block.title");
	const result = await addCalendarBlock(env, householdId, {
		start,
		end,
		title,
		busy: block.busy === false ? false : true,
		source: optionalString(block.source) ?? "manual",
		location: optionalString(block.location),
		description: optionalString(block.description),
		metadata: isRecord(block.metadata) ? block.metadata as Record<string, unknown> : undefined,
	});
	return { household_id: householdId, block_id: result.block_id };
}

async function toolStageCalendarEvent(args: Record<string, unknown>, env: MiseGraphEnv): Promise<Record<string, unknown>> {
	const householdId = requireString(args.household_id, "household_id");
	const planId = requireString(args.plan_id, "plan_id");
	const entityType = requireString(args.entity_type, "entity_type");
	const entityId = requireString(args.entity_id, "entity_id");
	if (entityType !== "shop" && entityType !== "cook" && entityType !== "meal") {
		throw new Error(`entity_type must be shop|cook|meal (got ${entityType})`);
	}
	const start = requireString(args.start, "start");
	const end = requireString(args.end, "end");
	const title = requireString(args.title, "title");
	const event: CalendarEventInput = {
		start,
		end,
		title,
		metadata: { plan_id: planId, entity_id: entityId, entity_type: entityType },
	};
	const description = optionalString(args.description);
	if (description) event.description = description;
	const location = optionalString(args.location);
	if (location) event.location = location;

	const result = await stageCalendarEvent(env, householdId, event);
	return {
		household_id: householdId,
		event_id: result.event_id,
		status: "staged",
		event,
	};
}

async function toolListStagedEvents(args: Record<string, unknown>, env: MiseGraphEnv): Promise<Record<string, unknown>> {
	const householdId = requireString(args.household_id, "household_id");
	const planId = optionalString(args.plan_id);
	const events = await listStagedEvents(env, householdId, planId);
	return { household_id: householdId, plan_id: planId ?? null, count: events.length, events };
}

async function toolCancelStagedEvent(args: Record<string, unknown>, env: MiseGraphEnv): Promise<Record<string, unknown>> {
	const eventId = requireString(args.event_id, "event_id");
	await cancelStagedEvent(env, eventId);
	return { event_id: eventId, status: "canceled" };
}

// ─── Legacy preview/commit (kept so u18 + t17 still pass) ──────────────────

async function toolPreviewMutation(args: Record<string, unknown>, env: MiseGraphEnv): Promise<Record<string, unknown>> {
	const world = await loadWorld(env, requireString(args.plan_id, "plan_id"));
	const preview = planPreviewMutation(world, requireMutation(args.mutation));
	await savePreviewDraft(env, world.plan, preview);
	return {
		plan_id: world.plan.id,
		preview: sanitizePreview(preview),
		summary: planReadSummary(world),
	};
}

async function toolCommitPreview(args: Record<string, unknown>, env: MiseGraphEnv): Promise<Record<string, unknown>> {
	const planId = requireString(args.plan_id, "plan_id");
	const proposalId = requireString(args.proposal_id, "proposal_id");
	const world = await loadWorld(env, planId);
	const committed = await commitPreviewWithFallback(env, world, proposalId);
	await markPreviewApplied(env, planId, proposalId);
	return committed;
}

async function toolApplyMutation(args: Record<string, unknown>, env: MiseGraphEnv): Promise<Record<string, unknown>> {
	const planId = requireString(args.plan_id, "plan_id");
	const world = await loadWorld(env, planId);
	const preview = planPreviewMutation(world, requireMutation(args.mutation));
	await savePreviewDraft(env, world.plan, preview);
	const committed = await commitPreviewWithFallback(env, world, preview.proposal_id);
	await markPreviewApplied(env, planId, preview.proposal_id);
	return { ...committed, preview: sanitizePreview(preview) };
}

// ─── Mutation helpers ──────────────────────────────────────────────────────

async function applyMutation(
	env: MiseGraphEnv,
	args: Record<string, unknown>,
	preview: (plan: MiseWeeklyPlanDraft) => RipplePreview,
): Promise<Record<string, unknown>> {
	const planId = requireString(args.plan_id, "plan_id");
	const plan = await loadPlan(env, planId);
	let ripple: RipplePreview;
	try {
		ripple = preview(plan);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (/locked/i.test(message)) {
			return {
				plan_id: planId,
				ok: false,
				error: "locked",
				message,
			};
		}
		throw error;
	}

	// Locks land in the preview's `warnings` rather than thrown errors. Surface
	// them as a tool-level locked failure so the agent can re-plan.
	const lockWarning = (ripple.warnings || []).find(w => /lock/i.test(w));
	if (lockWarning) {
		return {
			plan_id: planId,
			ok: false,
			error: "locked",
			message: lockWarning,
			warnings: ripple.warnings,
		};
	}

	let committedPlan: MiseWeeklyPlanDraft;
	try {
		committedPlan = commit(plan, ripple.proposal_id);
	} catch {
		// Cache may have been cleared between preview and commit; fall back
		// to the preview's own preview_state.plan when available.
		committedPlan = (ripple.preview_state?.plan as MiseWeeklyPlanDraft | undefined) || plan;
	}
	await saveActivePlan(env, committedPlan);
	const world = createPlanWorld(committedPlan);
	return {
		plan_id: planId,
		ok: true,
		proposal_id: ripple.proposal_id,
		ripple_summary: {
			affected_meals: ripple.affected_meals.length,
			affected_batches: ripple.affected_batches.length,
			affected_prep_tasks: ripple.affected_prep_tasks.length,
			affected_shopping: {
				added: ripple.affected_shopping.added.length,
				removed: ripple.affected_shopping.removed.length,
				qty_changed: ripple.affected_shopping.qty_changed.length,
				runs_changed: ripple.affected_shopping.runs_changed.length,
			},
			affected_edges: {
				added: ripple.affected_edges.added.length,
				removed: ripple.affected_edges.removed.length,
				status_changed: ripple.affected_edges.status_changed.length,
			},
		},
		new_grievances: ripple.new_grievances,
		resolved_grievances: ripple.resolved_grievances,
		warnings: ripple.warnings,
		summary: planReadSummary(world),
	};
}

async function commitPreviewWithFallback(
	env: MiseGraphEnv,
	world: PlanWorld,
	proposalId: string,
): Promise<Record<string, unknown>> {
	try {
		const committed = planCommitPreview(world, proposalId);
		await saveActivePlan(env, committed.world.plan);
		try { await saveMiseWeeklyPlan(env, committed.world.plan); } catch { /* legacy save best-effort */ }
		return {
			plan_id: committed.world.plan.id,
			proposal_id: proposalId,
			committed_from: "proposal_cache",
			summary: committed.summary,
			grievances: committed.grievances,
			coherence: planReadCoherence(committed.world),
		};
	} catch (error) {
		const previewPlan = await loadPreviewPlan(env, world.plan.id, proposalId);
		if (!previewPlan) throw error;
		await saveActivePlan(env, previewPlan);
		try { await saveMiseWeeklyPlan(env, previewPlan); } catch { /* legacy save best-effort */ }
		const nextWorld = createPlanWorld(previewPlan);
		return {
			plan_id: previewPlan.id,
			proposal_id: proposalId,
			committed_from: "stored_preview",
			summary: planReadSummary(nextWorld),
			grievances: planReadGrievances(nextWorld),
			coherence: planReadCoherence(nextWorld),
		};
	}
}

// ─── Plan persistence helpers ──────────────────────────────────────────────

async function loadWorld(env: MiseGraphEnv, planId: string): Promise<PlanWorld> {
	return createPlanWorld(await loadPlan(env, planId));
}

async function loadPlan(env: MiseGraphEnv, planId: string): Promise<MiseWeeklyPlanDraft> {
	const active = await loadActivePlan(env, planId);
	if (active) return active;

	// Legacy fallback so u18/t17 contracts keep working when callers persist
	// directly to mise_week_plans.
	const row = await env.DB.prepare("SELECT plan_json FROM mise_week_plans WHERE id = ? LIMIT 1")
		.bind(planId)
		.first<{ plan_json: string }>();
	if (!row?.plan_json) throw new Error(`Plan not found: ${planId}`);
	const plan = parseJson(row.plan_json, null) as MiseWeeklyPlanDraft | null;
	if (!plan) throw new Error(`Plan JSON not parseable: ${planId}`);
	return plan;
}

async function savePreviewDraft(env: MiseGraphEnv, plan: MiseWeeklyPlanDraft, preview: RipplePreview): Promise<void> {
	const previewPlan = preview.preview_state?.plan;
	if (!previewPlan) return;
	await env.DB.prepare(`
		INSERT OR REPLACE INTO mise_plan_proposals
		(id, plan_id, household_id, kind, intent, status,
		 proposed_changes_json, ripple_up_json, ripple_down_json,
		 conflict_log_json, meta_json)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).bind(
		preview.proposal_id,
		plan.id,
		plan.household_id,
		`preview:${preview.proposed_change.kind}`,
		JSON.stringify(preview.proposed_change),
		"draft",
		JSON.stringify(sanitizePreview(preview)),
		"{}",
		"{}",
		"[]",
		JSON.stringify({
			created_by: "plan_world_mcp",
			preview_plan_json: JSON.stringify(previewPlan),
		}),
	).run();
}

async function loadPreviewPlan(env: MiseGraphEnv, planId: string, proposalId: string): Promise<MiseWeeklyPlanDraft | null> {
	const row = await env.DB.prepare(`
		SELECT meta_json FROM mise_plan_proposals
		WHERE id = ? AND plan_id = ? LIMIT 1
	`).bind(proposalId, planId).first<{ meta_json: string }>();
	const meta = parseJson(row?.meta_json || "{}", {}) as Record<string, unknown>;
	const raw = meta.preview_plan_json;
	if (typeof raw === "string") return parseJson(raw, null) as MiseWeeklyPlanDraft | null;
	if (isRecord(raw)) return raw as unknown as MiseWeeklyPlanDraft;
	return null;
}

async function markPreviewApplied(env: MiseGraphEnv, planId: string, proposalId: string): Promise<void> {
	await env.DB.prepare(`
		UPDATE mise_plan_proposals SET status = 'applied', applied_at = datetime('now')
		WHERE id = ? AND plan_id = ?
	`).bind(proposalId, planId).run();
}

// ─── Empty plan + meal insertion ───────────────────────────────────────────

interface EmptyPlanInput {
	plan_id: string;
	household_id: string | null;
	start_date: string;
	end_date: string;
	people: number;
	dietary: string[];
	ingredients: string[];
	equipment: string[];
	pantry: string[];
	cuisine_direction: string[];
	prompt: string | null;
}

function buildEmptyPlan(input: EmptyPlanInput): MiseWeeklyPlanDraft {
	const dates = enumerateDates(input.start_date, input.end_date);
	const meals_by_day: MisePlanDay[] = dates.map((date, day_index) => ({
		date,
		day_index,
		meals: [],
	}));
	const constraints: Record<string, unknown> = {};
	if (input.dietary.length) constraints.dietary = input.dietary;
	if (input.equipment.length) constraints.equipment = input.equipment;
	if (input.pantry.length) constraints.pantry = input.pantry;
	if (input.cuisine_direction.length) constraints.cuisine_direction = input.cuisine_direction;
	if (input.prompt) constraints.prompt = input.prompt;
	return {
		id: input.plan_id,
		household_id: input.household_id,
		title: input.prompt || `Plan ${input.start_date} → ${input.end_date}`,
		start_date: input.start_date,
		end_date: input.end_date,
		timezone: null,
		people: input.people,
		status: "draft",
		constraints,
		selected_ingredients: input.ingredients,
		source_recipe_ids: [],
		meals_by_day,
		component_batches: [],
		prep_tasks: [],
		breakfasts: [],
		snack_boxes: [],
		shopping_list: [],
		shop_runs: [],
		storage_labels: [],
		meta: { generated_by: "mise_graph_planner", deterministic: true },
	};
}

function insertMealAtSlot(plan: MiseWeeklyPlanDraft, slot: PlanWorldSlotRef, mealInput: Record<string, unknown>): MiseWeeklyPlanDraft {
	const cloned: MiseWeeklyPlanDraft = JSON.parse(JSON.stringify(plan));
	const id = optionalString(mealInput.id) ?? `meal:${slot.date}_${slot.slot}`;
	const title = optionalString(mealInput.title) ?? "untitled meal";
	const formatRaw = optionalString(mealInput.format) ?? "";
	const format = canonicalFormat(formatRaw);
	const cuisine = stringArray(mealInput.cuisine) ?? [];
	const formulaIds = stringArray(mealInput.formula_ids) ?? [];
	const leftoversTo = stringArray(mealInput.leftovers_to) ?? [];
	const methodSummary = optionalString(mealInput.method_summary) ?? null;
	const rawIngredients = coerceRawIngredients(mealInput.raw_ingredients);
	const people = numberValue(mealInput.people, plan.people || 2);

	if (slot.slot === "snack") {
		const snack = {
			id,
			date: slot.date,
			title,
			items: rawIngredients.map(r => r.name),
			component_ids: [],
			people,
			locked: false,
			raw_ingredients: rawIngredients,
			meta: {},
		};
		cloned.snack_boxes = [...(cloned.snack_boxes || []).filter(s => s.date !== slot.date), snack];
		return cloned;
	}

	const meal: MisePlanMeal = {
		id,
		date: slot.date,
		slot: slot.slot,
		title,
		format,
		component_ids: [],
		ingredient_names: rawIngredients.map(r => r.name),
		source: "agent_compose",
		notes: [],
		people,
		cuisine,
		locked: false,
		raw_ingredients: rawIngredients,
		method_summary: methodSummary || undefined,
		leftovers_to: leftoversTo,
	};
	if (formulaIds.length) (meal as MisePlanMeal & { formula_ids?: string[] }).formula_ids = formulaIds;
	// Carry forward meta when the caller supplies it. Track D's equipment-
	// claim path reads meal.meta.equipment from the snapshot, so dropping
	// meta here means equipment never reaches the MealAgent.
	if (isRecord(mealInput.meta)) {
		(meal as MisePlanMeal & { meta?: Record<string, unknown> }).meta = mealInput.meta;
	}

	// Run the deterministic component fill so format slot specs get exercised
	// even when the caller hands us only raw ingredients.
	try {
		const composed: ComposedMeal = {
			date: slot.date,
			slot: slot.slot,
			title,
			format,
			people,
			cuisine,
			formula_ids: formulaIds,
			raw_ingredients: rawIngredients,
			notes: [],
			method_summary: methodSummary || "",
			leftovers_to: leftoversTo,
			lineage: [],
		};
		fillComponents(composed, cloned.component_batches || []);
		const composedComponents = (composed as ComposedMeal & { components?: unknown }).components;
		if (Array.isArray(composedComponents) && composedComponents.length > 0) {
			meal.components = composedComponents as MisePlanMeal["components"];
		}
	} catch {
		// fillComponents is best-effort; missing format specs aren't fatal.
	}

	if (slot.slot === "breakfast") {
		cloned.breakfasts = [...(cloned.breakfasts || []).filter(b => b.date !== slot.date), meal];
	} else {
		const dayIndex = (cloned.meals_by_day || []).findIndex(d => d.date === slot.date);
		if (dayIndex < 0) {
			cloned.meals_by_day = [
				...(cloned.meals_by_day || []),
				{ date: slot.date, day_index: cloned.meals_by_day?.length || 0, meals: [meal] },
			];
		} else {
			cloned.meals_by_day[dayIndex] = {
				...cloned.meals_by_day[dayIndex],
				meals: [...cloned.meals_by_day[dayIndex].meals.filter(m => m.slot !== slot.slot), meal],
			};
		}
	}
	return cloned;
}

function slotIsOccupied(plan: MiseWeeklyPlanDraft, date: string, slotName: MiseMealSlot): boolean {
	if (slotName === "snack") return !!(plan.snack_boxes || []).find(s => s.date === date);
	if (slotName === "breakfast") {
		if ((plan.breakfasts || []).some(b => b.date === date)) return true;
	}
	for (const day of plan.meals_by_day || []) {
		if (day.date !== date) continue;
		if (day.meals.some(m => normalizeSlot(m.slot) === slotName)) return true;
	}
	return false;
}

function findMealId(plan: MiseWeeklyPlanDraft, date: string, slotName: MiseMealSlot): string | null {
	if (slotName === "snack") return (plan.snack_boxes || []).find(s => s.date === date)?.id || null;
	if (slotName === "breakfast") {
		const b = (plan.breakfasts || []).find(b => b.date === date);
		if (b) return b.id;
	}
	for (const day of plan.meals_by_day || []) {
		if (day.date !== date) continue;
		const meal = day.meals.find(m => normalizeSlot(m.slot) === slotName);
		if (meal) return meal.id;
	}
	return null;
}

function collectAllMeals(plan: MiseWeeklyPlanDraft): MisePlanMeal[] {
	const out: MisePlanMeal[] = [];
	for (const day of plan.meals_by_day || []) for (const meal of day.meals) out.push(meal);
	for (const breakfast of plan.breakfasts || []) out.push(breakfast);
	return out;
}

function safeRunCritics(plan: MiseWeeklyPlanDraft): Grievance[] {
	return [...safeRunHard(plan), ...safeRunWarning(plan)];
}

function safeRunHard(plan: MiseWeeklyPlanDraft): Grievance[] {
	try { return runHardCritics(plan); } catch { return []; }
}

function safeRunWarning(plan: MiseWeeklyPlanDraft): Grievance[] {
	try { return runWarningCritics(plan); } catch { return []; }
}

function grievanceKey(g: Grievance): string {
	return `${g.critic}::${g.slot_ref?.date || "-"}/${g.slot_ref?.slot || "-"}::${g.batch_id || "-"}::${g.component_id || "-"}::${g.message.slice(0, 80)}`;
}

function countBySeverity(grievances: Grievance[]): Record<GrievanceSeverity | "total", number> {
	const counts = { total: grievances.length, hard: 0, warning: 0, preference: 0 };
	for (const g of grievances) {
		if (g.severity === "hard") counts.hard += 1;
		else if (g.severity === "warning") counts.warning += 1;
		else if (g.severity === "preference") counts.preference += 1;
	}
	return counts;
}

// ─── Per-person household member handlers (Wave 6) ─────────────────────────

const VALID_AGE_GROUPS_TOOL: ReadonlyArray<AgeGroup> = ["adult", "teen", "kid", "toddler"];
const VALID_PRESENCE_STATES: ReadonlyArray<PresenceState> = ["absent", "in_kitchen_idle", "busy_assigned", "stepped_away"];
const VALID_SKILL_OUTCOMES: ReadonlyArray<SkillOutcome> = ["success", "partial", "failure", "retry"];

async function toolMemberCreate(args: Record<string, unknown>, env: MiseGraphEnv): Promise<Record<string, unknown>> {
	const household_id = requireString(args.household_id, "household_id");
	const display_name = requireString(args.display_name, "display_name");
	const age_group = coerceAgeGroup(args.age_group);
	const dietary = stringArray(args.dietary);
	const preferences = isRecord(args.preferences) ? coerceMemberPreferences(args.preferences) : undefined;
	const safety_overrides = isRecord(args.safety_overrides) ? coerceMemberSafety(args.safety_overrides) : undefined;
	const member_id = optionalString(args.member_id);
	const member = await upsertMember(env, {
		member_id,
		household_id,
		display_name,
		age_group,
		dietary,
		preferences,
		safety: safety_overrides,
	});
	// Wave 7B Phase 2: spawn the MemberAgent so it sees its profile.
	await routeMemberInit(env, { household_id, member_id: member.member_id });
	return { member };
}

async function toolMemberGet(args: Record<string, unknown>, env: MiseGraphEnv): Promise<Record<string, unknown>> {
	const member_id = requireString(args.member_id, "member_id");
	const member = await getMember(env, member_id);
	return { member };
}

async function toolMemberList(args: Record<string, unknown>, env: MiseGraphEnv): Promise<Record<string, unknown>> {
	const household_id = requireString(args.household_id, "household_id");
	const members = await listMembers(env, household_id);
	return { household_id, count: members.length, members };
}

async function toolMemberUpdatePreferences(args: Record<string, unknown>, env: MiseGraphEnv): Promise<Record<string, unknown>> {
	const member_id = requireString(args.member_id, "member_id");
	const existing = await getMember(env, member_id);
	if (!existing) throw new Error(`member_update_preferences: member ${member_id} not found`);
	const patch = isRecord(args.preferences) ? coerceMemberPreferences(args.preferences) : {};
	const member = await upsertMember(env, {
		member_id: existing.member_id,
		household_id: existing.household_id,
		display_name: existing.display_name,
		age_group: existing.age_group,
		preferences: patch,
	});
	// Wave 7B Phase 2: refresh MemberAgent so cached profile is up to date.
	await routeMemberInit(env, { household_id: existing.household_id, member_id });
	return { member };
}

async function toolMemberUpdateSafety(args: Record<string, unknown>, env: MiseGraphEnv): Promise<Record<string, unknown>> {
	const member_id = requireString(args.member_id, "member_id");
	const existing = await getMember(env, member_id);
	if (!existing) throw new Error(`member_update_safety: member ${member_id} not found`);
	const patch = isRecord(args.safety) ? coerceMemberSafety(args.safety) : {};
	const member = await upsertMember(env, {
		member_id: existing.member_id,
		household_id: existing.household_id,
		display_name: existing.display_name,
		age_group: existing.age_group,
		safety: patch,
	});
	// Wave 7B Phase 2: refresh MemberAgent so cached profile is up to date.
	await routeMemberInit(env, { household_id: existing.household_id, member_id });
	return { member };
}

async function toolMemberRecordSkillOutcome(args: Record<string, unknown>, env: MiseGraphEnv): Promise<Record<string, unknown>> {
	const member_id = requireString(args.member_id, "member_id");
	const skill_name = requireString(args.skill_name, "skill_name");
	const outcomeRaw = requireString(args.outcome, "outcome").toLowerCase().trim() as SkillOutcome;
	if (!VALID_SKILL_OUTCOMES.includes(outcomeRaw)) {
		throw new Error(`outcome must be one of ${VALID_SKILL_OUTCOMES.join(", ")}`);
	}
	const result = await recordSkillOutcome(env, {
		member_id,
		skill_name,
		outcome: outcomeRaw,
		duration_actual_min: optionalNumber(args.duration_actual_min),
		duration_expected_min: optionalNumber(args.duration_expected_min),
		user_rating: optionalNumber(args.user_rating),
		task_id: optionalString(args.task_id),
		meal_id: optionalString(args.meal_id),
		notes: optionalString(args.notes),
	});
	// Wave 7B Phase 2: mirror the outcome through the MemberAgent so it
	// keeps a per-member skill log + emits a trace.
	const member = await getMember(env, member_id);
	if (member) {
		await routeMemberSkillOutcome(env, {
			household_id: member.household_id,
			member_id,
			skill_name,
			outcome: outcomeRaw,
			duration_actual_min: optionalNumber(args.duration_actual_min),
			duration_expected_min: optionalNumber(args.duration_expected_min),
			user_rating: optionalNumber(args.user_rating),
			task_id: optionalString(args.task_id),
			meal_id: optionalString(args.meal_id),
			notes: optionalString(args.notes),
		});
	}
	return { member_id, skill_name, ...result };
}

async function toolMemberPingPresence(args: Record<string, unknown>, env: MiseGraphEnv): Promise<Record<string, unknown>> {
	const member_id = requireString(args.member_id, "member_id");
	const stateRaw = requireString(args.state, "state").toLowerCase().trim() as PresenceState;
	if (!VALID_PRESENCE_STATES.includes(stateRaw)) {
		throw new Error(`state must be one of ${VALID_PRESENCE_STATES.join(", ")}`);
	}
	await pingPresence(env, {
		member_id,
		state: stateRaw,
		current_task_id: optionalString(args.current_task_id),
		current_session_id: optionalString(args.current_session_id),
	});
	// Wave 7B Phase 2: also notify the MemberAgent so its DO state caches the
	// presence + we get a trace row.
	const member = await getMember(env, member_id);
	if (member) {
		await routeMemberPingPresence(env, {
			household_id: member.household_id,
			member_id,
			state: stateRaw,
			current_task_id: optionalString(args.current_task_id),
			current_session_id: optionalString(args.current_session_id),
		});
	}
	return { member_id, state: stateRaw, ok: true };
}

async function toolMemberGetPresence(args: Record<string, unknown>, env: MiseGraphEnv): Promise<Record<string, unknown>> {
	const member_id = requireString(args.member_id, "member_id");
	const snapshot = await getPresence(env, member_id);
	return { member_id, presence: snapshot };
}

async function toolMemberListAvailable(args: Record<string, unknown>, env: MiseGraphEnv): Promise<Record<string, unknown>> {
	const household_id = requireString(args.household_id, "household_id");
	const available = await listAvailableMembers(env, household_id);
	return { household_id, count: available.length, available };
}

async function toolMealSetAttendance(args: Record<string, unknown>, env: MiseGraphEnv): Promise<Record<string, unknown>> {
	const planId = requireString(args.plan_id, "plan_id");
	const slot = requireSlotFromArgs(args);
	const ids = stringArray(args.member_ids) ?? [];

	const plan = await loadPlan(env, planId);
	const cloned: MiseWeeklyPlanDraft = JSON.parse(JSON.stringify(plan));
	let updated = false;

	if (slot.slot === "snack") {
		for (const snack of cloned.snack_boxes || []) {
			if (snack.date !== slot.date) continue;
			const meta = (snack.meta as Record<string, unknown> | undefined) || {};
			meta.attendance_member_ids = [...ids];
			snack.meta = meta as typeof snack.meta;
			updated = true;
		}
	} else if (slot.slot === "breakfast") {
		for (const breakfast of cloned.breakfasts || []) {
			if (breakfast.date !== slot.date) continue;
			const meta = breakfast.meta || {};
			meta.attendance_member_ids = [...ids];
			breakfast.meta = meta;
			updated = true;
		}
	} else {
		for (const day of cloned.meals_by_day || []) {
			if (day.date !== slot.date) continue;
			for (const meal of day.meals) {
				if (normalizeSlot(meal.slot) !== slot.slot) continue;
				const meta = meal.meta || {};
				meta.attendance_member_ids = [...ids];
				meal.meta = meta;
				updated = true;
			}
		}
	}

	if (!updated) {
		return { plan_id: planId, slot, ok: false, error: "meal_not_found" };
	}

	await saveActivePlan(env, cloned);
	return { plan_id: planId, slot, member_ids: ids, ok: true };
}

async function toolMealReadAttendance(args: Record<string, unknown>, env: MiseGraphEnv): Promise<Record<string, unknown>> {
	const planId = requireString(args.plan_id, "plan_id");
	const slot = requireSlotFromArgs(args);
	const plan = await loadPlan(env, planId);
	const ids = readAttendanceFromPlan(plan, slot);
	return {
		plan_id: planId,
		slot,
		// `null` means "use household default" — caller should attribute the
		// meal to all members in the household when ids === null.
		member_ids: ids,
		uses_default: ids === null,
	};
}

function readAttendanceFromPlan(plan: MiseWeeklyPlanDraft, slot: PlanWorldSlotRef): string[] | null {
	if (slot.slot === "snack") {
		const snack = (plan.snack_boxes || []).find(s => s.date === slot.date);
		const meta = (snack?.meta as Record<string, unknown> | undefined) || {};
		const ids = meta.attendance_member_ids;
		return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : null;
	}
	if (slot.slot === "breakfast") {
		const b = (plan.breakfasts || []).find(b => b.date === slot.date);
		const meta = b?.meta || {};
		const ids = meta.attendance_member_ids;
		return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : null;
	}
	for (const day of plan.meals_by_day || []) {
		if (day.date !== slot.date) continue;
		for (const meal of day.meals) {
			if (normalizeSlot(meal.slot) !== slot.slot) continue;
			const meta = meal.meta || {};
			const ids = meta.attendance_member_ids;
			return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : null;
		}
	}
	return null;
}

function coerceAgeGroup(value: unknown): AgeGroup {
	if (typeof value !== "string") return "adult";
	const v = value.trim().toLowerCase();
	if (VALID_AGE_GROUPS_TOOL.includes(v as AgeGroup)) return v as AgeGroup;
	return "adult";
}

function coerceMemberPreferences(value: Record<string, unknown>): Partial<MemberPreferences> {
	const out: Partial<MemberPreferences> = {};
	const loves = stringArray(value.loves); if (loves) out.loves = loves;
	const dislikes = stringArray(value.dislikes); if (dislikes) out.dislikes = dislikes;
	const allergies = stringArray(value.allergies); if (allergies) out.allergies = allergies;
	return out;
}

function coerceMemberSafety(value: Record<string, unknown>): Partial<MemberSafety> {
	const out: Partial<MemberSafety> = {};
	if (typeof value.stove_authorized === "boolean") out.stove_authorized = value.stove_authorized;
	if (typeof value.oven_authorized === "boolean") out.oven_authorized = value.oven_authorized;
	if (typeof value.knife_authorized === "boolean") {
		out.knife_authorized = value.knife_authorized;
	} else if (value.knife_authorized === "supervised") {
		out.knife_authorized = "supervised";
	}
	if (typeof value.heavy_lift_authorized === "boolean") out.heavy_lift_authorized = value.heavy_lift_authorized;
	if (typeof value.sharp_oils_authorized === "boolean") out.sharp_oils_authorized = value.sharp_oils_authorized;
	if (typeof value.minimum_supervision === "string") {
		const ms = value.minimum_supervision.trim().toLowerCase();
		if (ms === "none" || ms === "adult" || ms === "designated") {
			out.minimum_supervision = ms;
		}
	}
	return out;
}

// ─── Onboarding (Phase A) ──────────────────────────────────────────────────

async function toolOnboardingStart(args: Record<string, unknown>, env: MiseGraphEnv): Promise<Record<string, unknown>> {
	const household_id = requireString(args.household_id, "household_id");
	const household_name = optionalString(args.household_name);
	const result = await startOnboarding(env, { household_id, household_name });
	return result as unknown as Record<string, unknown>;
}

async function toolOnboardingAnswer(args: Record<string, unknown>, env: MiseGraphEnv): Promise<Record<string, unknown>> {
	const household_id = requireString(args.household_id, "household_id");
	const question_kind = requireString(args.question_kind, "question_kind");
	const response_text = requireString(args.response_text, "response_text");
	const member_id = optionalString(args.member_id);
	const result = await answerOnboarding(env, { household_id, question_kind, response_text, member_id });
	return result as unknown as Record<string, unknown>;
}

async function toolOnboardingSkip(args: Record<string, unknown>, env: MiseGraphEnv): Promise<Record<string, unknown>> {
	const household_id = requireString(args.household_id, "household_id");
	const question_kind = requireString(args.question_kind, "question_kind");
	const member_id = optionalString(args.member_id);
	const result = await skipOnboarding(env, { household_id, question_kind, member_id });
	return result as unknown as Record<string, unknown>;
}

async function toolOnboardingStatus(args: Record<string, unknown>, env: MiseGraphEnv): Promise<Record<string, unknown>> {
	const household_id = requireString(args.household_id, "household_id");
	const result = await statusOnboarding(env, { household_id });
	return result as unknown as Record<string, unknown>;
}

// ─── Conversion + validation helpers ───────────────────────────────────────

function sanitizePreview(preview: RipplePreview): Record<string, unknown> {
	return {
		proposal_id: preview.proposal_id,
		proposed_change: preview.proposed_change,
		affected_meals: preview.affected_meals,
		affected_batches: preview.affected_batches,
		affected_prep_tasks: preview.affected_prep_tasks,
		affected_shopping: preview.affected_shopping,
		affected_edges: preview.affected_edges,
		new_grievances: preview.new_grievances,
		resolved_grievances: preview.resolved_grievances,
		scores: preview.scores,
		cascade_proposals: preview.cascade_proposals,
		reversible: preview.reversible,
		warnings: preview.warnings,
	};
}

function rpcResult(id: string | number | null, result: unknown): Record<string, unknown> {
	return { jsonrpc: "2.0", id, result };
}

function rpcError(id: string | number | null, code: number, message: string): Record<string, unknown> {
	return { jsonrpc: "2.0", id, error: { code, message } };
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data, null, 2), {
		status,
		headers: { "Content-Type": "application/json", ...CORS_HEADERS },
	});
}

function requirePlan(value: unknown): MiseWeeklyPlanDraft {
	if (!isRecord(value) || typeof value.id !== "string") {
		throw new Error("plan_create requires a plan object with id");
	}
	return value as unknown as MiseWeeklyPlanDraft;
}

function requireMutation(value: unknown): PlanWorldMutationInput {
	if (!isRecord(value) || typeof value.kind !== "string") {
		throw new Error("mutation must be an object with kind");
	}
	return value as PlanWorldMutationInput;
}

function requireSlotFromArgs(args: { slot?: unknown; date?: unknown }): PlanWorldSlotRef {
	if (isRecord(args.slot)) return parseSlotRecord(args.slot, "slot");
	const date = optionalString(args.date);
	const slotName = optionalString((args as Record<string, unknown>).slot_name);
	if (date && slotName) return parseSlotRecord({ date, slot: slotName }, "slot");
	throw new Error("slot is required");
}

function parseSlotRecord(value: Record<string, unknown>, label: string): PlanWorldSlotRef {
	const date = requireString(value.date, `${label}.date`);
	const slotName = requireString(value.slot, `${label}.slot`).toLowerCase().trim();
	if (!VALID_SLOTS.includes(slotName as MiseMealSlot)) {
		throw new Error(`${label}.slot must be one of ${VALID_SLOTS.join(", ")}`);
	}
	return { date, slot: slotName as MiseMealSlot };
}

function coerceSlots(value: unknown): PlanWorldSlotRef[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const out: PlanWorldSlotRef[] = [];
	for (const item of value) {
		if (!isRecord(item)) continue;
		try { out.push(parseSlotRecord(item, "requested_slots[]")); } catch { /* ignore */ }
	}
	return out.length ? out : undefined;
}

function coerceRawIngredients(value: unknown): ComposerRawIngredient[] {
	if (!Array.isArray(value)) return [];
	const out: ComposerRawIngredient[] = [];
	for (const item of value) {
		if (typeof item === "string") {
			out.push({ name: item, qty: null, unit: null, grams: null, category: null });
			continue;
		}
		if (!isRecord(item)) continue;
		const name = optionalString(item.name);
		if (!name) continue;
		out.push({
			name,
			qty: typeof item.qty === "number" ? item.qty : null,
			unit: optionalString(item.unit) ?? null,
			grams: typeof item.grams === "number" ? item.grams : null,
			category: optionalString(item.category) ?? null,
		});
	}
	return out;
}

function coerceReplaceMeal(value: Record<string, unknown>): {
	title?: string;
	format?: string;
	method_summary?: string;
	cuisine?: string[];
	formula_ids?: string[];
	leftovers_to?: string[];
	raw_ingredients?: Array<{ name: string; qty?: number; unit?: string; grams?: number }>;
} {
	const out: ReturnType<typeof coerceReplaceMeal> = {};
	const title = optionalString(value.title); if (title) out.title = title;
	const format = optionalString(value.format); if (format) out.format = format;
	const method = optionalString(value.method_summary); if (method) out.method_summary = method;
	const cuisine = stringArray(value.cuisine); if (cuisine) out.cuisine = cuisine;
	const formulas = stringArray(value.formula_ids); if (formulas) out.formula_ids = formulas;
	const leftovers = stringArray(value.leftovers_to); if (leftovers) out.leftovers_to = leftovers;
	if (Array.isArray(value.raw_ingredients)) {
		out.raw_ingredients = value.raw_ingredients
			.filter(isRecord)
			.map(r => ({
				name: typeof r.name === "string" ? r.name : "",
				qty: typeof r.qty === "number" ? r.qty : undefined,
				unit: typeof r.unit === "string" ? r.unit : undefined,
				grams: typeof r.grams === "number" ? r.grams : undefined,
			}))
			.filter(r => r.name.length > 0);
	}
	return out;
}

function canonicalFormat(format: string): string {
	const lower = format.toLowerCase().trim();
	if (!lower) return "bowl";
	if (FORMAT_SLOT_SPECS[lower]) return lower;
	if (FORMAT_ALIASES[lower]) return FORMAT_ALIASES[lower];
	return lower;
}

function normalizeSlot(slot: string): MiseMealSlot {
	const lower = (slot || "").toLowerCase().trim();
	return (VALID_SLOTS.includes(lower as MiseMealSlot) ? lower : "dinner") as MiseMealSlot;
}

function slotOrder(slot: string): number {
	const lower = slot.toLowerCase();
	if (lower === "breakfast") return 1;
	if (lower === "lunch") return 2;
	if (lower === "snack") return 3;
	return 4;
}

function enumerateDates(start: string, end: string): string[] {
	if (!isIsoDate(start) || !isIsoDate(end)) return [];
	const startMs = Date.parse(`${start}T00:00:00Z`);
	const endMs = Date.parse(`${end}T00:00:00Z`);
	if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return [];
	const out: string[] = [];
	const cursor = new Date(startMs);
	while (cursor.getTime() <= endMs && out.length < 60) {
		out.push(cursor.toISOString().slice(0, 10));
		cursor.setUTCDate(cursor.getUTCDate() + 1);
	}
	return out;
}

function isIsoDate(value: string): boolean {
	return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function slugPlanId(householdId: string | null, start: string, end: string): string {
	const hh = (householdId || "household").replace(/[^a-z0-9]+/gi, "_").toLowerCase();
	const days = enumerateDates(start, end).length || 1;
	const stamp = Date.now().toString(36).slice(-6);
	return `mise_plan:${hh}:${start}:${days}d:${stamp}`;
}

function requireString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`${label} is required`);
	}
	return value;
}

function optionalString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function optionalNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	return undefined;
}

function numberValue(value: unknown, fallback: number): number {
	const n = optionalNumber(value);
	return n === undefined ? fallback : n;
}

function stringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const out: string[] = [];
	for (const item of value) if (typeof item === "string" && item.trim().length > 0) out.push(item);
	return out.length > 0 ? out : undefined;
}

function parseJson(value: string, fallback: unknown): unknown {
	try { return JSON.parse(value); } catch { return fallback; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isoDateUTC(d: Date): string {
	const y = d.getUTCFullYear();
	const m = String(d.getUTCMonth() + 1).padStart(2, "0");
	const day = String(d.getUTCDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

// ─── Concept board handlers (Wave 6) ───────────────────────────────────────

async function toolInspireSetMovement(args: Record<string, unknown>, env: MiseGraphEnv): Promise<Record<string, unknown>> {
	const movement = await setMovement(env, {
		plan_id: requireString(args.plan_id, "plan_id"),
		household_id: optionalString(args.household_id),
		theme_text: requireString(args.theme_text, "theme_text"),
		rationale: optionalString(args.rationale),
	});
	return { ok: true, movement };
}

async function toolInspireGetMovement(args: Record<string, unknown>, env: MiseGraphEnv): Promise<Record<string, unknown>> {
	const movement = await getMovement(env, requireString(args.plan_id, "plan_id"));
	return { found: !!movement, movement };
}

async function toolInspireBookmarkConcept(args: Record<string, unknown>, env: MiseGraphEnv): Promise<Record<string, unknown>> {
	const sourceKindRaw = requireString(args.source_kind, "source_kind").toLowerCase();
	const validSources: ConceptSourceKind[] = ["corpus", "personal_recipe", "user_prompt", "subagent_ideation", "manual"];
	if (!validSources.includes(sourceKindRaw as ConceptSourceKind)) {
		throw new Error(`source_kind must be one of: ${validSources.join(", ")}`);
	}
	const card = await bookmarkConcept(env, {
		plan_id: requireString(args.plan_id, "plan_id"),
		movement_id: optionalString(args.movement_id) ?? null,
		title: requireString(args.title, "title"),
		format: optionalString(args.format) ?? null,
		cuisine: stringArray(args.cuisine) ?? [],
		source_kind: sourceKindRaw as ConceptSourceKind,
		source_ref: optionalString(args.source_ref) ?? null,
		raw_ingredients: coerceConceptIngredients(args.raw_ingredients),
		formula_ids: stringArray(args.formula_ids) ?? [],
		est_active_min: optionalNumber(args.est_active_min) ?? null,
		est_idle_min: optionalNumber(args.est_idle_min) ?? null,
		rationale: optionalString(args.rationale) ?? null,
		vibe_tags: stringArray(args.vibe_tags) ?? [],
	});
	return { ok: true, concept: card };
}

async function toolInspireListConcepts(args: Record<string, unknown>, env: MiseGraphEnv): Promise<Record<string, unknown>> {
	const planId = requireString(args.plan_id, "plan_id");
	const status = optionalString(args.status) as ConceptStatus | undefined;
	const cards = await listConcepts(env, planId, { status });
	return { plan_id: planId, count: cards.length, concepts: cards };
}

async function toolInspireScoreTetris(args: Record<string, unknown>, env: MiseGraphEnv): Promise<Record<string, unknown>> {
	const planId = requireString(args.plan_id, "plan_id");
	const conceptId = requireString(args.concept_id, "concept_id");
	const slotInput = isRecord(args.candidate_slot) ? args.candidate_slot : null;
	if (!slotInput) throw new Error("candidate_slot is required");
	const slot = parseSlotRecord(slotInput, "candidate_slot");
	const result = await scoreTetris(env, {
		plan_id: planId,
		concept_id: conceptId,
		candidate_slot: slot,
	});
	return result as unknown as Record<string, unknown>;
}

async function toolInspireAutoTetris(args: Record<string, unknown>, env: MiseGraphEnv): Promise<Record<string, unknown>> {
	const planId = requireString(args.plan_id, "plan_id");
	const result = await autoTetrisFit(env, planId);
	return { plan_id: planId, ...result };
}

async function toolInspireShortlistTop(args: Record<string, unknown>, env: MiseGraphEnv): Promise<Record<string, unknown>> {
	const planId = requireString(args.plan_id, "plan_id");
	const topN = optionalNumber(args.top_n) ?? 7;
	const winners = await shortlistTopConcepts(env, planId, topN);
	return { plan_id: planId, top_n: topN, shortlisted: winners };
}

async function toolInspireCommitConcept(
	args: Record<string, unknown>,
	env: MiseGraphEnv,
	caller?: CallerTraceContext,
): Promise<Record<string, unknown>> {
	const planId = requireString(args.plan_id, "plan_id");
	const conceptId = requireString(args.concept_id, "concept_id");
	const slotInput = isRecord(args.slot) ? args.slot : null;
	if (!slotInput) throw new Error("slot is required");
	const slot = parseSlotRecord(slotInput, "slot");

	const concept = await getConcept(env, conceptId);
	if (!concept) throw new Error(`concept ${conceptId} not found`);

	// Compose the meal from the concept's content using the same path the agent
	// would call directly. We bypass the trace wrapper here because the
	// concept commit is an inspiration-phase operation; the underlying
	// plan_compose_meal handler still saves the plan and runs critics.
	const composeResult = await callPlanWorldTool(
		"plan_compose_meal",
		{
			plan_id: planId,
			slot: { date: slot.date, slot: slot.slot },
			meal: {
				title: concept.title,
				format: concept.format || "bowl",
				cuisine: concept.cuisine,
				formula_ids: concept.formula_ids,
				raw_ingredients: concept.raw_ingredients,
				method_summary: concept.rationale ?? undefined,
			},
		},
		env,
		caller,
	);

	const slotKey = `${slot.date}_${slot.slot}`;
	const updated = await updateConceptStatus(env, conceptId, "committed", slotKey);

	return {
		ok: true,
		concept_id: conceptId,
		committed_to_slot: slotKey,
		concept: updated,
		compose: composeResult,
	};
}

function coerceConceptIngredients(value: unknown): ConceptCardRawIngredient[] {
	if (!Array.isArray(value)) return [];
	const out: ConceptCardRawIngredient[] = [];
	for (const item of value) {
		if (typeof item === "string") {
			const name = item.trim();
			if (name) out.push({ name });
			continue;
		}
		if (!isRecord(item)) continue;
		const name = optionalString(item.name);
		if (!name) continue;
		const cleaned: ConceptCardRawIngredient = { name };
		if (typeof item.qty === "number" && Number.isFinite(item.qty)) cleaned.qty = item.qty;
		const unit = optionalString(item.unit); if (unit) cleaned.unit = unit;
		if (typeof item.grams === "number" && Number.isFinite(item.grams)) cleaned.grams = item.grams;
		out.push(cleaned);
	}
	return out;
}

// ─── Brigade tools (Wave 8B Track C) ────────────────────────────────────────
//
// Each tool is a thin wrapper over a CookingLeadAgent DO route via
// `routeCookingLead`. Errors from the DO surface as { ok: false, error }.

async function toolBrigadeStart(
	args: Record<string, unknown>,
	env: MiseGraphEnv,
): Promise<Record<string, unknown>> {
	const cook_session_id = requireString(args.cook_session_id, "cook_session_id");
	const meal_id = requireString(args.meal_id, "meal_id");
	const plan_id = optionalString(args.plan_id);
	const household_id = optionalString(args.household_id);
	const result = await routeCookingLead(env, cook_session_id, "init", {
		cook_session_id,
		meal_id,
		plan_id,
		household_id,
	});
	if (!result) return { ok: false, error: "COOKING_LEAD_AGENT not bound" };
	return { ok: true, cook_session_id, ...result };
}

async function toolBrigadeGrantToken(
	args: Record<string, unknown>,
	env: MiseGraphEnv,
): Promise<Record<string, unknown>> {
	const cook_session_id = requireString(args.cook_session_id, "cook_session_id");
	const member_id = requireString(args.member_id, "member_id");
	const result = await routeCookingLead(env, cook_session_id, "grant-token", {
		cook_session_id,
		member_id,
	});
	if (!result) return { ok: false, error: "COOKING_LEAD_AGENT not bound" };
	const ws_url = `/mise-graph/agents/cooking-lead/${cook_session_id}/ws?token=${result.token ?? ""}&member_id=${member_id}`;
	return { ok: true, cook_session_id, member_id, ws_url, ...result };
}

async function toolBrigadeGetState(
	args: Record<string, unknown>,
	env: MiseGraphEnv,
): Promise<Record<string, unknown>> {
	const cook_session_id = requireString(args.cook_session_id, "cook_session_id");
	const result = await routeCookingLead(env, cook_session_id, "get-state", undefined, "GET");
	if (!result) return { ok: false, error: "COOKING_LEAD_AGENT not bound" };
	return { ok: true, cook_session_id, ...result };
}

async function toolBrigadeGetEventLog(
	args: Record<string, unknown>,
	env: MiseGraphEnv,
): Promise<Record<string, unknown>> {
	const cook_session_id = requireString(args.cook_session_id, "cook_session_id");
	const since_ms = numberValue(args.since_ms, 0);
	const limit = Math.min(Math.max(1, numberValue(args.limit, 200)), 1000);
	// Read directly from D1.mise_brigade_events so we get the durable record
	// (DOs hibernate; D1 is the post-mortem store).
	try {
		const rows = await env.DB.prepare(`
			SELECT id, kind, member_id, payload_json, emitted_at_ms
			FROM mise_brigade_events
			WHERE cook_session_id = ? AND emitted_at_ms >= ?
			ORDER BY emitted_at_ms ASC
			LIMIT ?
		`).bind(cook_session_id, since_ms, limit)
			.all<{ id: string; kind: string; member_id: string | null; payload_json: string | null; emitted_at_ms: number }>();
		return {
			ok: true,
			cook_session_id,
			since_ms,
			events: (rows.results ?? []).map(r => ({
				id: r.id,
				kind: r.kind,
				member_id: r.member_id,
				payload: r.payload_json ? safeJsonParse(r.payload_json) : {},
				emitted_at_ms: r.emitted_at_ms,
			})),
		};
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

async function toolBrigadeAssignManually(
	args: Record<string, unknown>,
	env: MiseGraphEnv,
): Promise<Record<string, unknown>> {
	const cook_session_id = requireString(args.cook_session_id, "cook_session_id");
	const task_id = requireString(args.task_id, "task_id");
	const member_id = requireString(args.member_id, "member_id");
	const reason = optionalString(args.reason);
	const result = await routeCookingLead(env, cook_session_id, "manual-assign", {
		task_id,
		member_id,
		reason,
	});
	if (!result) return { ok: false, error: "COOKING_LEAD_AGENT not bound" };
	return { ok: true, cook_session_id, ...result };
}

async function toolBrigadeUnassign(
	args: Record<string, unknown>,
	env: MiseGraphEnv,
): Promise<Record<string, unknown>> {
	const cook_session_id = requireString(args.cook_session_id, "cook_session_id");
	const task_id = requireString(args.task_id, "task_id");
	const reason = optionalString(args.reason);
	const result = await routeCookingLead(env, cook_session_id, "manual-unassign", {
		task_id,
		reason,
	});
	if (!result) return { ok: false, error: "COOKING_LEAD_AGENT not bound" };
	return { ok: true, cook_session_id, ...result };
}

async function toolBrigadeMarkComplete(
	args: Record<string, unknown>,
	env: MiseGraphEnv,
): Promise<Record<string, unknown>> {
	const cook_session_id = requireString(args.cook_session_id, "cook_session_id");
	const task_id = requireString(args.task_id, "task_id");
	const member_id = optionalString(args.member_id);
	const outcome = optionalString(args.outcome);
	const notes = optionalString(args.notes);
	const result = await routeCookingLead(env, cook_session_id, "manual-complete-task", {
		task_id,
		member_id,
		outcome,
		notes,
	});
	if (!result) return { ok: false, error: "COOKING_LEAD_AGENT not bound" };
	return { ok: true, cook_session_id, ...result };
}

async function toolBrigadeSendMessage(
	args: Record<string, unknown>,
	env: MiseGraphEnv,
): Promise<Record<string, unknown>> {
	const cook_session_id = requireString(args.cook_session_id, "cook_session_id");
	const message = requireString(args.message, "message");
	const member_id = optionalString(args.member_id);
	const correlation_id = optionalString(args.correlation_id);
	const result = await routeCookingLead(env, cook_session_id, "send-message", {
		member_id,
		message,
		correlation_id,
	});
	if (!result) return { ok: false, error: "COOKING_LEAD_AGENT not bound" };
	return { ok: true, cook_session_id, ...result };
}

async function toolBrigadePause(
	args: Record<string, unknown>,
	env: MiseGraphEnv,
): Promise<Record<string, unknown>> {
	const cook_session_id = requireString(args.cook_session_id, "cook_session_id");
	const result = await routeCookingLead(env, cook_session_id, "pause", {});
	if (!result) return { ok: false, error: "COOKING_LEAD_AGENT not bound" };
	return { ok: true, cook_session_id, ...result };
}

async function toolBrigadeResume(
	args: Record<string, unknown>,
	env: MiseGraphEnv,
): Promise<Record<string, unknown>> {
	const cook_session_id = requireString(args.cook_session_id, "cook_session_id");
	const result = await routeCookingLead(env, cook_session_id, "resume", {});
	if (!result) return { ok: false, error: "COOKING_LEAD_AGENT not bound" };
	return { ok: true, cook_session_id, ...result };
}

async function toolBrigadeEnd(
	args: Record<string, unknown>,
	env: MiseGraphEnv,
): Promise<Record<string, unknown>> {
	const cook_session_id = requireString(args.cook_session_id, "cook_session_id");
	const outcomeRaw = optionalString(args.outcome);
	const outcome = outcomeRaw === "abandoned" ? "abandoned" : "completed";
	const notes = optionalString(args.notes);
	const result = await routeCookingLead(env, cook_session_id, "end", {
		outcome,
		notes,
	});
	if (!result) return { ok: false, error: "COOKING_LEAD_AGENT not bound" };
	return { ok: true, cook_session_id, ...result };
}

function safeJsonParse(s: string): Record<string, unknown> {
	try {
		const v = JSON.parse(s);
		return typeof v === "object" && v !== null ? v as Record<string, unknown> : {};
	} catch {
		return {};
	}
}

// Surface a referenced helper so adversarial tests can simulate locked slots
// without reaching into the locks module directly.
export const _mcpInternals = {
	clearProposalCache,
	isMealLocked,
	handleToolCall,
};

// ─── Tool catalog ──────────────────────────────────────────────────────────

const SLOT_SCHEMA = {
	type: "object",
	required: ["date", "slot"],
	properties: {
		date: { type: "string", description: "ISO YYYY-MM-DD" },
		slot: { type: "string", enum: ["breakfast", "lunch", "dinner", "snack"] },
	},
};

const PLAN_WORLD_TOOLS = [
	// Plan lifecycle
	tool("plan_create", "Create or persist a plan. Pass {plan} for a pre-built MiseWeeklyPlanDraft, or {household_id, start_date, end_date, ...} to shape an empty draft.", {
		type: "object",
		properties: {
			plan: { type: "object" },
			plan_id: { type: "string" },
			household_id: { type: "string" },
			start_date: { type: "string" },
			end_date: { type: "string" },
			people_default: { type: "number" },
			ingredients: { type: "array", items: { type: "string" } },
			cuisine_direction: { type: "array", items: { type: "string" } },
			dietary: { type: "array", items: { type: "string" } },
			equipment: { type: "array", items: { type: "string" } },
			pantry: { type: "array", items: { type: "string" } },
			prompt: { type: "string" },
		},
	}),
	tool("plan_get_summary", "Read compact plan summary with grievance + coherence counts.", planIdSchema()),
	tool("plan_finalize", "Mark plan final and return final hard-grievance + coherence acceptance status.", planIdSchema()),
	tool("plan_archive", "Remove plan from the active plans set.", planIdSchema()),
	tool("plan_list", "List active plans, optionally scoped to a household.", {
		type: "object",
		properties: { household_id: { type: "string" } },
	}),

	// Read tools
	tool("plan_read_map", "Read the markdown plan map (compact or full).", {
		type: "object",
		required: ["plan_id"],
		properties: {
			plan_id: { type: "string" },
			detail: { enum: ["compact", "full"] },
			mode: { enum: ["compact", "full"] },
		},
	}),
	tool("plan_read_empty_slots", "List unfilled slot specs.", {
		type: "object",
		required: ["plan_id"],
		properties: { plan_id: { type: "string" }, requested_slots: { type: "array" } },
	}),
	tool("plan_read_meal", "Read one meal/snack at a slot.", {
		type: "object",
		required: ["plan_id", "slot"],
		properties: { plan_id: { type: "string" }, slot: SLOT_SCHEMA },
	}),
	tool("plan_read_ledger_at", "Read projected resource ledger state on a date.", {
		type: "object",
		required: ["plan_id", "date"],
		properties: { plan_id: { type: "string" }, date: { type: "string" } },
	}),
	tool("plan_read_expiring_by", "List items expiring on/by a date.", {
		type: "object",
		required: ["plan_id", "date"],
		properties: {
			plan_id: { type: "string" },
			date: { type: "string" },
			threshold_days: { type: "number" },
		},
	}),
	tool("plan_read_grievances", "Read grievances; optionally filter by severity.", {
		type: "object",
		required: ["plan_id"],
		properties: {
			plan_id: { type: "string" },
			severity: { enum: ["hard", "warning", "preference"] },
		},
	}),
	tool("plan_read_recent_meals", "Read the last N composed meals (chronological).", {
		type: "object",
		required: ["plan_id"],
		properties: { plan_id: { type: "string" }, n: { type: "number" } },
	}),
	tool("plan_read_cuisine_balance", "Read cuisine distribution across composed meals.", planIdSchema()),
	tool("plan_read_format_balance", "Read format distribution across composed meals.", planIdSchema()),
	tool("plan_read_batches", "Read component batches with planned uses.", planIdSchema()),
	tool("plan_read_shopping_list", "Read shopping list sections.", {
		type: "object",
		required: ["plan_id"],
		properties: { plan_id: { type: "string" }, grouped_by: { type: "string" } },
	}),
	tool("plan_read_shop_runs", "Read planned shop runs.", planIdSchema()),
	tool("plan_read_dependency_edges", "Read derived dependency edges; status filter accepts violated/critical/marginal/ok.", {
		type: "object",
		required: ["plan_id"],
		properties: {
			plan_id: { type: "string" },
			status: { type: "string" },
		},
	}),
	tool("plan_read_coherence", "Read structured plan coherence score.", planIdSchema()),

	// Write tools
	tool("plan_compose_meal", "Add a meal at the slot. Auto-fills components from format slot specs and runs critics.", {
		type: "object",
		required: ["plan_id", "slot", "meal"],
		properties: {
			plan_id: { type: "string" },
			slot: SLOT_SCHEMA,
			meal: { type: "object" },
		},
	}),
	tool("plan_cancel_meal", "Cancel the meal at slot; ripple downstream.", {
		type: "object",
		required: ["plan_id", "slot"],
		properties: { plan_id: { type: "string" }, slot: SLOT_SCHEMA },
	}),
	tool("plan_swap_ingredient", "Swap one raw ingredient for another in a meal slot.", {
		type: "object",
		required: ["plan_id", "slot", "from_name", "to_name"],
		properties: {
			plan_id: { type: "string" },
			slot: SLOT_SCHEMA,
			from_name: { type: "string" },
			to_name: { type: "string" },
		},
	}),
	tool("plan_move_meal", "Move a meal from one slot to another (mode=replace|swap).", {
		type: "object",
		required: ["plan_id", "from_slot", "to_slot"],
		properties: {
			plan_id: { type: "string" },
			from_slot: SLOT_SCHEMA,
			to_slot: SLOT_SCHEMA,
			mode: { enum: ["replace", "swap"] },
		},
	}),
	tool("plan_replace_meal", "Replace a meal with a new one (must_consume / must_avoid optional). Pass the new meal as either `new_meal` or `meal`.", {
		type: "object",
		required: ["plan_id", "slot"],
		properties: {
			plan_id: { type: "string" },
			slot: SLOT_SCHEMA,
			new_meal: { type: "object", description: "The new meal object. Accepts the same shape as plan_compose_meal's `meal` arg." },
			meal: { type: "object", description: "Alias for new_meal." },
			must_consume: { type: "array" },
			must_avoid: { type: "array" },
		},
	}),
	tool("plan_split_batch", "Split a batch on the given date.", {
		type: "object",
		required: ["plan_id", "batch_id", "at_date"],
		properties: {
			plan_id: { type: "string" },
			batch_id: { type: "string" },
			at_date: { type: "string" },
		},
	}),
	tool("plan_move_shop", "Move a shop run to a new date.", {
		type: "object",
		required: ["plan_id", "run_id", "new_date"],
		properties: {
			plan_id: { type: "string" },
			run_id: { type: "string" },
			new_date: { type: "string" },
		},
	}),
	tool("plan_slide_prep_date", "Move a batch's prep date.", {
		type: "object",
		required: ["plan_id", "batch_id", "new_prep_date"],
		properties: {
			plan_id: { type: "string" },
			batch_id: { type: "string" },
			new_prep_date: { type: "string" },
		},
	}),
	tool("plan_lock_meal", "Lock a meal so subsequent mutations refuse to touch it.", {
		type: "object",
		required: ["plan_id", "slot"],
		properties: {
			plan_id: { type: "string" },
			slot: SLOT_SCHEMA,
			reason: { type: "string" },
		},
	}),
	tool("plan_unlock_meal", "Unlock a meal.", {
		type: "object",
		required: ["plan_id", "slot"],
		properties: { plan_id: { type: "string" }, slot: SLOT_SCHEMA },
	}),
	tool("plan_import_recipe", "Import a recipe from URL / plain text / schema.org JSON.", {
		type: "object",
		properties: {
			url: { type: "string" },
			plain_text: { type: "string" },
			schema_org_json: { type: "string" },
			household_dietary: { type: "array", items: { type: "string" } },
		},
	}),
	tool("plan_assign_recipe", "Assign an imported recipe to a slot.", {
		type: "object",
		required: ["plan_id", "slot", "recipe"],
		properties: {
			plan_id: { type: "string" },
			slot: SLOT_SCHEMA,
			recipe: { type: "object" },
			lock: { type: "boolean" },
			lock_reason: { type: "string" },
			scale_to: { type: "number" },
		},
	}),

	// Audit
	tool("plan_audit", "Run hard / warning / all critics fresh and return grievances.", {
		type: "object",
		required: ["plan_id"],
		properties: {
			plan_id: { type: "string" },
			run_critics: { enum: ["hard", "warning", "all"] },
		},
	}),
	tool("plan_score_coherence", "Run the deterministic plan coherence scorer.", planIdSchema()),

	// Legacy preview/commit
	tool("plan_read_summary", "[legacy alias for plan_get_summary]", planIdSchema()),
	tool("plan_preview_mutation", "Preview a mutation without persisting; returns proposal_id.", {
		type: "object",
		required: ["plan_id", "mutation"],
		properties: { plan_id: { type: "string" }, mutation: { type: "object" } },
	}),
	tool("plan_commit_preview", "Commit a previously previewed mutation by proposal_id.", {
		type: "object",
		required: ["plan_id", "proposal_id"],
		properties: { plan_id: { type: "string" }, proposal_id: { type: "string" } },
	}),
	tool("plan_apply_mutation", "Preview, commit, and persist a mutation in one call.", {
		type: "object",
		required: ["plan_id", "mutation"],
		properties: { plan_id: { type: "string" }, mutation: { type: "object" } },
	}),

	// ── Inspiration reads (Wave 6) ──────────────────────────────────────
	// These let the chef-of-staff agent gather signal BEFORE composing.
	// Phase 1 of every planning turn should call inspire_read_household_context
	// once, then drill into specific signals as the conversation unfolds.
	tool("inspire_read_seasonality", "Read peak / coming / departing produce for the given dates and region. Returns canonical names with notes; useful for grounding meals in what's actually in season locally.", {
		type: "object",
		properties: {
			region: { type: "string", description: "Optional region code (e.g. 'us-southwest', 'pacific-nw'). When set, regional rows are preferred over global." },
			dates: { type: "array", items: { type: "string" }, description: "ISO YYYY-MM-DD dates the plan covers. Defaults to today + 6 days." },
			limit: { type: "number" },
		},
	}),
	tool("inspire_read_anchor_pressure", "Read recent-menu anchor pressure for a household. Returns saturated (>=0.6, avoid this week), trending (0.3-0.6, fine to use), cooled (0.15-0.3, fading). Drives anti-monotony in the next compose.", {
		type: "object",
		required: ["household_id"],
		properties: {
			household_id: { type: "string" },
			lookback_days: { type: "number", description: "Default 28." },
		},
	}),
	tool("inspire_read_recent_menu", "Read recent dinner titles, format counts, and cuisine counts for a household. Use to avoid repeating last week's dinners and to spot format/cuisine ruts.", {
		type: "object",
		required: ["household_id"],
		properties: {
			household_id: { type: "string" },
			lookback_days: { type: "number", description: "Default 28." },
		},
	}),
	tool("inspire_read_taste_feedback", "Read post-meal ratings for a household. Returns loved/rejected titles, recency-weighted loved anchors / cuisines / formats, and would-repeat / unfinished signals. Use to lean toward what they liked and away from what they didn't.", {
		type: "object",
		required: ["household_id"],
		properties: {
			household_id: { type: "string" },
			lookback_days: { type: "number", description: "Default 60." },
		},
	}),
	tool("inspire_read_recipe_library", "Read the household's saved personal recipes. Optional anchor / cuisine / format filters, plus loved_only flag. Use to prefer dishes the household already knows + loves.", {
		type: "object",
		required: ["household_id"],
		properties: {
			household_id: { type: "string" },
			anchor_filter: { type: "array", items: { type: "string" }, description: "Filter to recipes that include any of these ingredient names." },
			cuisine_filter: { type: "array", items: { type: "string" } },
			format_filter: { type: "string", description: "Single canonical format (bowl, pasta, taco, ...)." },
			loved_only: { type: "boolean", description: "Default false." },
			limit: { type: "number" },
		},
	}),
	tool("inspire_read_canonical_dishes", "Read corpus dishes (1100+ canonical recipes) that match the given INGREDIENT anchors. Returns canonical_title, composition, core/expected ingredients, methods, equipment, recipe_count. Use to ground meal titles + components in real shipped recipes rather than hallucinated names. NOTE: anchors are INGREDIENTS (e.g. ['chickpea', 'tomato']), not cuisines. Pass empty array (or omit) to get top-N by recipe_count as a starting point.", {
		type: "object",
		properties: {
			anchors: { type: "array", items: { type: "string" }, description: "Canonical INGREDIENT names (e.g. ['chickpea','tomato'])—NOT cuisine names. Empty array → top-N by recipe_count." },
			limit: { type: "number", description: "Default 12." },
		},
	}),
	tool("inspire_read_canonical_components", "Read reusable corpus components (sauces, dips, fillings) that match the given INGREDIENT anchors. Use to source batched component templates that work across many meals. anchors are ingredients (e.g. ['tahini', 'lemon']), not cuisines. Empty array → top-N.", {
		type: "object",
		properties: {
			anchors: { type: "array", items: { type: "string" }, description: "Canonical INGREDIENT names. Empty array → top-N by recipe_count." },
			limit: { type: "number", description: "Default 12." },
		},
	}),
	tool("inspire_read_recipe_steps", "Read the real method steps + structured ingredient list for a single recipe from canonical_recipes_v2. Identify by recipe_id (e.g. 'banana_bread'), canonical_dish_id (joins through canonical_dishes), or canonical_dish_title (LIKE match). Returns {ok, recipe_id, title, ingredients, steps[].prose, total_time_min, servings, source_url}. Use this when briefing the cook or rendering a real walkthrough rather than a synthesized timeline. Returns {ok:false, message} when nothing matches.", {
		type: "object",
		properties: {
			recipe_id: { type: "string", description: "Exact id of a row in canonical_recipes_v2 (e.g. 'banana_bread')." },
			canonical_dish_id: { type: ["string", "number"], description: "ID of a canonical_dishes row — title is looked up and matched into canonical_recipes_v2." },
			canonical_dish_title: { type: "string", description: "Free-text title (e.g. 'banana bread') — case-insensitive LIKE match." },
			limit: { type: "number", description: "Reserved for future expansion. Currently returns at most 1 recipe per call." },
		},
	}),
	tool("inspire_read_flavor_compounds", "Read FoodDB-style aromatic-compound pairings for a single ingredient. Returns ingredients that share volatile compounds (the foodpairing.com signal). Useful when the agent wants a non-obvious but molecularly-grounded match.", {
		type: "object",
		required: ["anchor"],
		properties: {
			anchor: { type: "string", description: "Canonical ingredient name (e.g. 'tomato')." },
			limit: { type: "number" },
		},
	}),
	tool("inspire_read_affinity_pairs", "Read PMI-weighted ingredient pairings from the corpus for the given anchors. Returns pairs that statistically co-occur in shipped recipes. Use to ground ingredient combinations in real cooking patterns.", {
		type: "object",
		required: ["anchors"],
		properties: {
			anchors: { type: "array", items: { type: "string" } },
			limit: { type: "number" },
		},
	}),
	tool("inspire_read_cuisine_fusions", "Read chef-validated cuisine fusion patterns (Korean-Mexican, Indo-Chinese, Nikkei, Tex-Mex, etc.) plus divergences (combinations to avoid). Returns structured rows + ready-to-prompt strings.", {
		type: "object",
		properties: {
			cuisines: { type: "array", items: { type: "string" }, description: "Restrict to fusions involving any of these cuisines." },
			min_affinity: { type: "number", description: "Drop divergences (set 0.5 to keep canonical fusions only)." },
			limit: { type: "number" },
		},
	}),
	tool("inspire_read_flavor_vibes", "Read cross-cuisine flavor 'moods' (gochujang-aioli, miso-butter, harissa-honey, chili-crisp, herby-creamy-acid, etc.). Use to push a menu in a flavor direction without locking it to one cuisine label.", {
		type: "object",
		properties: {
			vibe_kind: { type: "string", enum: ["sauce", "spice", "method", "produce", "umami", "general"] },
			max: { type: "number" },
		},
	}),
	tool("inspire_read_format_library", "Read format slot specs + cuisine variants (bowl, taco, pasta, etc.). Each format includes required slots and the most-common ingredients per slot per cuisine, with frequencies. Use when the agent wants to riff on 'an italian bowl looks like X, Y, Z'.", {
		type: "object",
		properties: {
			formats: { type: "array", items: { type: "string" }, description: "Restrict to a subset of formats." },
			max_cuisines_per_format: { type: "number" },
			max_ingredients_per_slot: { type: "number" },
		},
	}),
	tool("inspire_read_household_context", "Master inspiration read: gathers seasonality, anchor pressure, recent menu, taste feedback, recipe library, canonical dishes/components, affinity pairs, flavor compounds, cuisine fusions, flavor vibes, and format library in one call. Phase 1 of every planning turn — call this first, then drill in. Use compact=true (~6KB) for the structural overview; full mode (~40KB) when you need the example dishes / fusion notes / vibe descriptions.", {
		type: "object",
		required: ["household_id"],
		properties: {
			household_id: { type: "string" },
			plan_id: { type: "string", description: "Optional — link to an active plan." },
			lookback_days: { type: "number", description: "Default 28." },
			location_region: { type: "string" },
			dates: { type: "array", items: { type: "string" }, description: "Plan window. Defaults to today + 6 days." },
			anchors: { type: "array", items: { type: "string" }, description: "Optional anchors to seed canonical lookups. If omitted, derived from loved + trending anchors." },
			compact: { type: "boolean", description: "Tighten per-section limits and strip bulky example arrays from vibes / fusions / format library. Default false. Cuts payload ~6–8×." },
			per_section_limit: { type: "integer", minimum: 1, description: "Override per-section item count. Default 12 (full mode) or 4 (compact)." },
		},
	}),

	// Weather + calendar (Wave 6)
	tool("inspire_read_weather", "Read a daily weather forecast (Open-Meteo) for a location and date range. Returns highs/lows/conditions/precip plus a 1-sentence pattern_summary and cooking_hints (grill weather, braise weather, no-oven days, first hot day). location.{lat,lng} required. Pass either start_date (with optional end_date) OR days_ahead (auto-derives from today). Use to ground meals in actual conditions.", {
		type: "object",
		properties: {
			location: {
				type: "object",
				properties: {
					lat: { type: "number" },
					lng: { type: "number" },
					tz: { type: "string", description: "IANA timezone, e.g. America/Los_Angeles. Defaults to 'auto'." },
					city: { type: "string" },
				},
			},
			household_id: { type: "string", description: "Optional — used to look up location in future waves." },
			start_date: { type: "string", description: "ISO YYYY-MM-DD. Mutually exclusive with days_ahead." },
			end_date: { type: "string", description: "ISO YYYY-MM-DD; defaults to start_date." },
			days_ahead: { type: "integer", minimum: 0, description: "Convenience: forecast from today through today+days_ahead. Use this if you don't already know today's date in ISO." },
		},
	}),
	tool("inspire_read_calendar", "Read household calendar windows (busy_blocks + derived cook/eat/shop windows) for a date range. Backed by mise_calendar_blocks (synthetic for demo; future Google/iCloud sync). Use to avoid scheduling cooks during practices, date nights, etc.", {
		type: "object",
		required: ["household_id", "start_date"],
		properties: {
			household_id: { type: "string" },
			start_date: { type: "string", description: "ISO YYYY-MM-DD." },
			end_date: { type: "string", description: "ISO YYYY-MM-DD; defaults to start_date." },
		},
	}),
	tool("inspire_add_calendar_block", "Admin tool: add a synthetic calendar block (busy time) for a household. Used to populate the demo calendar; ignored once Google/iCloud sync is wired.", {
		type: "object",
		required: ["household_id", "block"],
		properties: {
			household_id: { type: "string" },
			block: {
				type: "object",
				required: ["start", "end", "title"],
				properties: {
					start: { type: "string", description: "ISO timestamp (YYYY-MM-DDTHH:MM)." },
					end: { type: "string", description: "ISO timestamp (YYYY-MM-DDTHH:MM)." },
					title: { type: "string" },
					busy: { type: "boolean", description: "Default true." },
					source: { type: "string", description: "google|icloud|manual; default manual." },
					location: { type: "string" },
					description: { type: "string" },
					metadata: { type: "object" },
				},
			},
		},
	}),
	tool("plan_stage_calendar_event", "Stage a Spence-created calendar event (cook / shop / meal) tied to a plan + entity. Lives in mise_staged_calendar_events with status='staged' until pushed to a real calendar. Replans can update or cancel by event_id.", {
		type: "object",
		required: ["household_id", "plan_id", "entity_type", "entity_id", "start", "end", "title"],
		properties: {
			household_id: { type: "string" },
			plan_id: { type: "string" },
			entity_type: { type: "string", enum: ["shop", "cook", "meal"] },
			entity_id: { type: "string" },
			start: { type: "string", description: "ISO timestamp." },
			end: { type: "string", description: "ISO timestamp." },
			title: { type: "string" },
			description: { type: "string" },
			location: { type: "string" },
		},
	}),
	tool("plan_list_staged_events", "List staged calendar events for a household, optionally scoped to a plan. Returns event_id, status (staged|pushed|canceled), and full event payload.", {
		type: "object",
		required: ["household_id"],
		properties: {
			household_id: { type: "string" },
			plan_id: { type: "string" },
		},
	}),
	tool("plan_cancel_staged_event", "Mark a staged calendar event as canceled. Used when a plan revision drops the underlying meal/cook/shop.", {
		type: "object",
		required: ["event_id"],
		properties: { event_id: { type: "string" } },
	}),

	// Concept board (Wave 6) — Phase 1 inspiration sticky-notes
	tool("inspire_set_movement", "Articulate the week's theme/movement (e.g. 'cool weather + chickpea anchor + Sat Ooni opportunity'). One per plan. Used to anchor concept-board candidates.", {
		type: "object",
		required: ["plan_id", "theme_text"],
		properties: {
			plan_id: { type: "string" },
			household_id: { type: "string" },
			theme_text: { type: "string", description: "1-2 sentence statement of the week's direction." },
			rationale: { type: "string", description: "Why this theme — driven by which signals." },
		},
	}),
	tool("inspire_get_movement", "Read the most recent movement statement for a plan, if any.", planIdSchema()),
	tool("inspire_bookmark_concept", "Add a candidate dish concept to the concept board for a plan. Like a sticky note: title, format, cuisine, source, raw ingredients, vibe tags. Status starts as 'candidate'.", {
		type: "object",
		required: ["plan_id", "title", "source_kind"],
		properties: {
			plan_id: { type: "string" },
			movement_id: { type: "string", description: "Optional — link to the plan's movement_id." },
			title: { type: "string", description: "e.g. 'Gochujang Aioli Smashburger w/ Kimchi Slaw'." },
			format: { type: "string", description: "e.g. 'burger', 'bowl', 'flatbread'." },
			cuisine: { type: "array", items: { type: "string" } },
			source_kind: { type: "string", enum: ["corpus", "personal_recipe", "user_prompt", "subagent_ideation", "manual"] },
			source_ref: { type: "string", description: "canonical_dish id or personal_recipe id or sub-agent run id." },
			raw_ingredients: { type: "array", items: { type: "object" } },
			formula_ids: { type: "array", items: { type: "string" } },
			est_active_min: { type: "number" },
			est_idle_min: { type: "number" },
			rationale: { type: "string", description: "Why this candidate fits the movement." },
			vibe_tags: { type: "array", items: { type: "string" } },
		},
	}),
	tool("inspire_list_concepts", "List concept-board cards for a plan, optionally filtered by status (candidate|shortlisted|committed|discarded).", {
		type: "object",
		required: ["plan_id"],
		properties: {
			plan_id: { type: "string" },
			status: { type: "string", enum: ["candidate", "shortlisted", "committed", "discarded"] },
		},
	}),
	tool("inspire_score_tetris", "Score a single concept against a candidate slot. Returns a deterministic 0..100 total plus a per-dimension breakdown (cuisine_fit, format_diversity, leftover_continuity, prep_budget, shop_efficiency, cross_meal_reuse, calendar_fit, weather_fit, ...).", {
		type: "object",
		required: ["plan_id", "concept_id", "candidate_slot"],
		properties: {
			plan_id: { type: "string" },
			concept_id: { type: "string" },
			candidate_slot: SLOT_SCHEMA,
		},
	}),
	tool("inspire_auto_tetris", "Score every unscored candidate against every empty slot in the plan, persist the best score per concept, and return the suggested per-concept slot assignments.", planIdSchema()),
	tool("inspire_shortlist_top", "Mark the top N candidates by tetris_score as 'shortlisted'; the rest stay 'candidate'. Default N=7.", {
		type: "object",
		required: ["plan_id"],
		properties: {
			plan_id: { type: "string" },
			top_n: { type: "number", description: "Default 7." },
		},
	}),
	tool("inspire_commit_concept", "Commit a concept to a slot — marks it 'committed' AND calls plan_compose_meal under the hood with the concept's content (title/format/cuisine/raw_ingredients).", {
		type: "object",
		required: ["plan_id", "concept_id", "slot"],
		properties: {
			plan_id: { type: "string" },
			concept_id: { type: "string" },
			slot: SLOT_SCHEMA,
		},
	}),

	// ── Per-person household members (Wave 6) ──────────────────────────────
	tool("member_create", "Create or upsert a household member with default skills/safety derived from age_group. Pass safety_overrides to specialize.", {
		type: "object",
		required: ["household_id", "display_name"],
		properties: {
			member_id: { type: "string" },
			household_id: { type: "string" },
			display_name: { type: "string" },
			age_group: { enum: ["adult", "teen", "kid", "toddler"] },
			dietary: { type: "array", items: { type: "string" } },
			preferences: {
				type: "object",
				properties: {
					loves: { type: "array", items: { type: "string" } },
					dislikes: { type: "array", items: { type: "string" } },
					allergies: { type: "array", items: { type: "string" } },
				},
			},
			safety_overrides: { type: "object" },
		},
	}),
	tool("member_get", "Fetch a single household member with skills + safety + preferences.", {
		type: "object",
		required: ["member_id"],
		properties: { member_id: { type: "string" } },
	}),
	tool("member_list", "List all members in a household.", {
		type: "object",
		required: ["household_id"],
		properties: { household_id: { type: "string" } },
	}),
	tool("member_update_preferences", "Update a member's preferences (loves / dislikes / allergies).", {
		type: "object",
		required: ["member_id", "preferences"],
		properties: {
			member_id: { type: "string" },
			preferences: { type: "object" },
		},
	}),
	tool("member_update_safety", "Update a member's safety authorizations (stove, knife, oven, etc.).", {
		type: "object",
		required: ["member_id", "safety"],
		properties: {
			member_id: { type: "string" },
			safety: { type: "object" },
		},
	}),
	tool("member_record_skill_outcome", "Record a brigade-task outcome for a member; updates confidence + speed_multiplier and appends to history.", {
		type: "object",
		required: ["member_id", "skill_name", "outcome"],
		properties: {
			member_id: { type: "string" },
			skill_name: { type: "string" },
			outcome: { enum: ["success", "partial", "failure", "retry"] },
			duration_actual_min: { type: "number" },
			duration_expected_min: { type: "number" },
			user_rating: { type: "number" },
			task_id: { type: "string" },
			meal_id: { type: "string" },
			notes: { type: "string" },
		},
	}),
	tool("member_ping_presence", "Update a member's kitchen presence state (in_kitchen_idle / busy_assigned / stepped_away / absent).", {
		type: "object",
		required: ["member_id", "state"],
		properties: {
			member_id: { type: "string" },
			state: { enum: ["absent", "in_kitchen_idle", "busy_assigned", "stepped_away"] },
			current_task_id: { type: "string" },
			current_session_id: { type: "string" },
		},
	}),
	tool("member_get_presence", "Read a member's current presence snapshot.", {
		type: "object",
		required: ["member_id"],
		properties: { member_id: { type: "string" } },
	}),
	tool("member_list_available", "List members in a household currently in_kitchen_idle or busy_assigned (idle preferred for next task pickup).", {
		type: "object",
		required: ["household_id"],
		properties: { household_id: { type: "string" } },
	}),
	tool("meal_set_attendance", "Override default 'all members' attendance for a specific meal slot. member_ids = []  marks the meal as 'no one'.", {
		type: "object",
		required: ["plan_id", "slot", "member_ids"],
		properties: {
			plan_id: { type: "string" },
			slot: SLOT_SCHEMA,
			member_ids: { type: "array", items: { type: "string" } },
		},
	}),
	tool("meal_read_attendance", "Read the override attendance for a slot. Returns uses_default=true when no override is set (caller falls back to listing all household members).", {
		type: "object",
		required: ["plan_id", "slot"],
		properties: {
			plan_id: { type: "string" },
			slot: SLOT_SCHEMA,
		},
	}),

	// ── Onboarding (Phase A) — progressive Q/A across depth tiers ──────────
	tool("household_onboarding_start", "Begin tier-0 onboarding for a household. Idempotent — calling on a household that has already started returns the current state + next question without resetting. Returns {state, next_question, tier_progress}.", {
		type: "object",
		required: ["household_id"],
		properties: {
			household_id: { type: "string" },
			household_name: { type: "string", description: "Optional display name for the household; mirrors to mise_household_profiles.display_name." },
		},
	}),
	tool("household_onboarding_answer", "Record an answer to a tier question. The agent extracts inferred trait deltas from the answer per the question's mapping, advances the tier when all required questions in the tier are answered or skipped, and returns the next question (or null if the session quota is satisfied).", {
		type: "object",
		required: ["household_id", "question_kind", "response_text"],
		properties: {
			household_id: { type: "string" },
			question_kind: { type: "string", description: "Stable identifier for the question (e.g. tier_1_dinner_ritual)." },
			response_text: { type: "string", description: "User's answer. For forced-choice questions pass the option value (e.g. 'table')." },
			member_id: { type: "string", description: "Optional — when the answer comes from a specific household member." },
		},
	}),
	tool("household_onboarding_skip", "Record a skip for a question. No trait penalty; the question may resurface later. Required tier-0 questions cannot be skipped to advance the tier — but skipping an optional question always allows advancement.", {
		type: "object",
		required: ["household_id", "question_kind"],
		properties: {
			household_id: { type: "string" },
			question_kind: { type: "string" },
			member_id: { type: "string" },
		},
	}),
	tool("household_onboarding_status", "Read-only snapshot: current state, all 7 traits with confidence, next-question preview, completion_pct (tiers complete / 5), and engagement_signal.", {
		type: "object",
		required: ["household_id"],
		properties: {
			household_id: { type: "string" },
		},
	}),

	// ── Agent trace + replay debug (Wave 6) ───────────────────────────────
	tool("agent_get_trace", "Fetch a single trace row by trace_id. Returns the tool name, args, result (truncated if oversized), result_summary, caller_kind, and triggered_mutations. Use to expand 'why was meal X composed?' once you have the trace_id.", {
		type: "object",
		required: ["trace_id"],
		properties: { trace_id: { type: "string" } },
	}),
	tool("agent_get_mutation_trace", "Reverse lookup: given a mutation_id (meal_id, batch_id, etc.), return the trace that committed it AND its ancestor chain (parent → grandparent → root). Use to walk the agent's reasoning path back to the user prompt that triggered it.", {
		type: "object",
		required: ["mutation_id"],
		properties: { mutation_id: { type: "string" } },
	}),
	tool("agent_list_plan_traces", "List recent traces for a plan, newest first. Use to scroll through everything the agent did to a plan in the last hour / day.", {
		type: "object",
		required: ["plan_id"],
		properties: {
			plan_id: { type: "string" },
			limit: { type: "number", description: "Default 50, max 500." },
		},
	}),
	tool("agent_list_plan_mutations", "List all committed mutations for a plan with their trace pointers. Use as the index — pick a mutation_id and then call agent_get_mutation_trace to expand its reasoning chain.", {
		type: "object",
		required: ["plan_id"],
		properties: {
			plan_id: { type: "string" },
			limit: { type: "number", description: "Default 100, max 1000." },
		},
	}),

	// ── Brigade (Wave 8B Track C) — manual control surface for live cooks ──
	tool("brigade_start", "Initialize the CookingLeadAgent for a cook session. Triggers the DO to enter active state and arm its 10s scheduler tick + 4h hard timeout. Idempotent — calling twice on the same cook_session_id is safe.", {
		type: "object",
		required: ["cook_session_id", "meal_id"],
		properties: {
			cook_session_id: { type: "string" },
			meal_id: { type: "string" },
			plan_id: { type: "string" },
			household_id: { type: "string" },
		},
	}),
	tool("brigade_grant_token", "Grant a one-time, member-bound, 10-minute WebSocket auth token. Returns {token, expires_at_ms, ws_url} — the phone connects to ws_url and presents the token as the `token` query param. Single-use; consumed on first WS upgrade.", {
		type: "object",
		required: ["cook_session_id", "member_id"],
		properties: {
			cook_session_id: { type: "string" },
			member_id: { type: "string" },
		},
	}),
	tool("brigade_get_state", "Read the brigade's live state + summary: connected members, in-flight assignments, completed count, total tasks, expected completion time. Use to render the lead-agent dashboard.", {
		type: "object",
		required: ["cook_session_id"],
		properties: { cook_session_id: { type: "string" } },
	}),
	tool("brigade_get_event_log", "Replay-ready event log for a cook session. Reads from D1.mise_brigade_events filtered by cook_session_id, since_ms, ordered ASC.", {
		type: "object",
		required: ["cook_session_id"],
		properties: {
			cook_session_id: { type: "string" },
			since_ms: { type: "number", description: "Default 0 — return all events." },
			limit: { type: "number", description: "Default 200, max 1000." },
		},
	}),
	tool("brigade_assign_task_manually", "Override the auto-scheduler: pin a specific task to a specific member. Records assignment in DO, broadcasts task_assigned to the phone, writes a task_assigned event with manual:true.", {
		type: "object",
		required: ["cook_session_id", "task_id", "member_id"],
		properties: {
			cook_session_id: { type: "string" },
			task_id: { type: "string" },
			member_id: { type: "string" },
			reason: { type: "string", description: "Free-text rationale for the override." },
		},
	}),
	tool("brigade_unassign_task", "Free a stuck task back into the assignment pool. Marks all in-flight rows for the task as outcome='reassigned', sends task_unassigned to the held members.", {
		type: "object",
		required: ["cook_session_id", "task_id"],
		properties: {
			cook_session_id: { type: "string" },
			task_id: { type: "string" },
			reason: { type: "string" },
		},
	}),
	tool("brigade_mark_task_complete", "Lead/admin marks a task complete on a member's behalf. If member_id is omitted, marks every in-flight assignment for the task. Fans out a skill-outcome event to MemberAgent if member_id + household are known.", {
		type: "object",
		required: ["cook_session_id", "task_id"],
		properties: {
			cook_session_id: { type: "string" },
			task_id: { type: "string" },
			member_id: { type: "string" },
			outcome: { type: "string", enum: ["success", "succeeded", "partial", "retry", "failure"] },
			notes: { type: "string" },
		},
	}),
	tool("brigade_send_message", "Push a chef-of-staff voice message to one member or broadcast to the whole brigade. Surfaces as a `lead_message` envelope on the phone WS.", {
		type: "object",
		required: ["cook_session_id", "message"],
		properties: {
			cook_session_id: { type: "string" },
			member_id: { type: "string", description: "Omit / null to broadcast." },
			message: { type: "string" },
			correlation_id: { type: "string", description: "Optional — phone can echo back to attribute responses." },
		},
	}),
	tool("brigade_pause", "Pause the scheduler tick (alarm cadence persists, but no new assignments are emitted). Use for a debrief or safety pause mid-cook.", {
		type: "object",
		required: ["cook_session_id"],
		properties: { cook_session_id: { type: "string" } },
	}),
	tool("brigade_resume", "Resume the scheduler after a brigade_pause.", {
		type: "object",
		required: ["cook_session_id"],
		properties: { cook_session_id: { type: "string" } },
	}),
	tool("brigade_end", "Mark the brigade session as completed (or abandoned). Frees the DO state, broadcasts session_ended to all members, signals MealAgent to advance to the next phase if no more cooks remain.", {
		type: "object",
		required: ["cook_session_id"],
		properties: {
			cook_session_id: { type: "string" },
			outcome: { type: "string", enum: ["completed", "abandoned"], description: "Default 'completed'." },
			notes: { type: "string" },
		},
	}),
];

function planIdSchema(): Record<string, unknown> {
	return {
		type: "object",
		required: ["plan_id"],
		properties: { plan_id: { type: "string" } },
	};
}

function tool(name: string, description: string, inputSchema: Record<string, unknown>): Record<string, unknown> {
	return { name, description, inputSchema };
}

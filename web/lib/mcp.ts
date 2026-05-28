/**
 * Typed MCP client for the mise-graph worker.
 *
 * The worker exposes JSON-RPC over HTTP at `/mcp/plan-world`. We wrap the
 * subset of tools Phase 1 cares about with concrete TS types and provide an
 * `mcp_call_any` escape hatch for the long tail.
 *
 * Phase 2+ agents should add tool entries to ToolMap as they wire screens.
 */

export const WORKER_URL =
  process.env.NEXT_PUBLIC_WORKER_URL ??
  "https://mise-graph.9f745064e644311ed09914b9a12e9c7380ce62b7.workers.dev";

const MCP_PATH = "/mcp/plan-world";

export interface McpContext {
  household_id: string;
  /** Optional trace caller info — propagates into the worker's audit log. */
  caller_id?: string;
  caller_kind?: "agent" | "human" | "cron" | "subagent" | "system";
  parent_trace?: string;
}

// ── Result shapes (loose — tighten as we wire screens) ─────────────────────

export interface ChefStatus {
  household_id: string;
  onboarding: {
    current_tier: number;
    tier_0_done: boolean;
    tier_1_done: boolean;
    completion_pct: number;
    next_question: ChefQuestion | null;
    blocked_actions: string[];
    engagement_signal: number;
  };
  recommendation: {
    primary_action:
      | "answer_onboarding_question"
      | "compose_meal"
      | "compose_with_inline_question"
      | "ready_to_plan";
    rationale: string;
    next_question?: ChefQuestion | null;
    suggested_compose_args?: Record<string, unknown> | null;
  };
  signals: HouseholdSignals | null;
}

export interface ChefQuestion {
  id?: string;
  prompt: string;
  kind?: "free_text" | "single_choice" | "multi_choice" | "chips";
  choices?: { id: string; label: string }[];
  tier?: number;
}

export interface HouseholdSignals {
  household_id: string;
  generated_at_ms: number;
  personality: {
    summary: string;
    dimensions: Array<{
      key: string;
      value: number;
      confidence: number;
      label?: string;
    }>;
  };
  traditions: Array<{
    name: string;
    cadence: string;
    description?: string;
    must_include?: string[];
  }>;
  pantry_top: Array<{ category: string; items: string[] }>;
  equipment_available: string[];
  avoidances: {
    dietary: string[];
    allergies: string[];
    dislikes: string[];
  };
  member_spread_guidance: string | null;
}

export interface PlanMeal {
  id: string;
  plan_id?: string;
  household_id?: string;
  slot_date?: string;
  slot_label?: string;
  /** Worker-side shape uses `date` + `slot`. We accept both. */
  date?: string;
  slot?: "breakfast" | "lunch" | "dinner" | "snack";
  title: string;
  format?: string;
  cuisine?: string | string[];
  serves?: number;
  people?: number;
  active_minutes?: number;
  active_time_min?: number;
  total_minutes?: number;
  suggested_start_time?: string;
  components?: Array<{
    role?: string;
    title?: string;
    raw_ingredients?: string[] | Array<{ name?: string; qty?: number; unit?: string }>;
  }>;
  raw_ingredients?: Array<string | { name?: string; qty?: number; unit?: string; prep?: string }>;
  ingredient_names?: string[];
  notes?: string[];
  photo_url?: string;
  recipe_id?: string;
  method_summary?: string | null;
  locked?: boolean;
  meta?: Record<string, unknown>;
}

// ── Brief / weather / plan map / recipe-steps shapes ───────────────────────

export interface WeatherForecast {
  date: string;
  high_f: number;
  low_f: number;
  conditions: string;
  precip_chance: number;
  wind_mph: number;
  sunrise_local: string;
  sunset_local: string;
}

export interface WeatherSummary {
  location: { lat: number; lng: number; tz: string; city?: string };
  forecast: WeatherForecast[];
  pattern_summary: string;
  cooking_hints: string[];
}

export interface CalendarBlock {
  start: string;
  end: string;
  title: string;
  busy?: boolean;
  source?: string;
  location?: string;
}

export interface CalendarWindowSlice {
  start: string;
  end: string;
  duration_min?: number;
}

export interface CalendarWindow {
  date: string;
  busy_blocks: CalendarBlock[];
  cook_window?: CalendarWindowSlice;
  eat_window?: CalendarWindowSlice;
  shop_window?: CalendarWindowSlice;
}

export interface PlanHealthSnapshot {
  plan_id: string;
  hard_grievance_count: number;
  warning_grievance_count: number;
  missed_prep_today: string[];
  headline_issue: string | null;
}

export interface DailyBriefSuggestion {
  kind: "shop_today" | "prep_today" | "expiring_soon" | "tight_window" | "missed_prep";
  message: string;
  plan_id?: string;
}

export interface MorningBrief {
  household_id: string;
  date: string;
  generated_at_ms: number;
  weather: WeatherSummary | null;
  calendar: CalendarWindow[];
  plan_health: PlanHealthSnapshot[];
  suggestions: DailyBriefSuggestion[];
  onboarding_question: ChefQuestion | null;
  notifications_summary: { count_by_kind: Record<string, number> };
}

export interface ActivePlanSummary {
  plan_id: string;
  household_id: string | null;
  status: string;
  updated_at: string;
}

/** A single grievance returned by plan_read_grievances. */
export interface Grievance {
  code: string;
  severity: "hard" | "warning" | "preference";
  message: string;
  meal_id?: string;
  date?: string;
  slot?: string;
  details?: Record<string, unknown>;
}

export interface RecipeIngredient {
  name: string;
  qty: number | null;
  unit: string | null;
  prep: string | null;
  importance: string | null;
  group: string | null;
}

export interface RecipeStep {
  index: number;
  phase: string | null;
  prose: string;
  verb: string | null;
  ingredients: string[];
  equipment: string[];
  completion_signal: string | null;
  idle_time_min: number | null;
}

export interface RecipeStepsResult {
  recipe_id: string;
  title: string;
  description: string | null;
  ingredients: RecipeIngredient[];
  steps: RecipeStep[];
  total_time_min: number | null;
  prep_time_min: number | null;
  cook_time_min: number | null;
  servings: number | null;
  source_url: string | null;
  matched_by: string;
}

// ── Shop / pantry / member result shapes (Phase 4) ─────────────────────────

export interface HouseholdMember {
  member_id: string;
  household_id: string;
  display_name: string;
  age_group: "adult" | "teen" | "kid" | "toddler";
  dietary: string[];
  preferences: { loves: string[]; dislikes: string[]; allergies: string[] };
  safety: {
    stove_authorized: boolean;
    oven_authorized: boolean;
    knife_authorized: boolean | "supervised";
    heavy_lift_authorized: boolean;
    sharp_oils_authorized: boolean;
    minimum_supervision: "none" | "adult" | "designated";
  };
  skills: Array<{
    skill_name: string;
    confidence: number;
    tasks_completed: number;
    last_used_at: string | null;
    speed_multiplier: number;
  }>;
  active_skill_quests: string[];
  privacy: {
    share_skills_with_household: boolean;
    share_tastes_with_household: boolean;
  };
  created_at: string;
  updated_at: string;
}

export interface MemberTraitView {
  member_id: string;
  value: number;
  confidence: number;
}

export interface TraitSpread {
  trait_name: string;
  household_value: number;
  household_confidence: number;
  member_values: MemberTraitView[];
  divergence: number;
  status: "aligned" | "diverging" | "uncalibrated";
  description: string;
}

export interface PresenceSnapshot {
  state:
    | "in_kitchen_idle"
    | "busy"
    | "stepped_away"
    | "offline"
    | string;
  current_task_id?: string | null;
  current_session_id?: string | null;
  last_seen_at?: string | null;
}

// ── Phase 5 — brigade / cook-mode shapes ───────────────────────────────────

export interface BrigadeTokenGrant {
  token: string;
  expires_at_ms: number;
  cook_session_id: string;
  member_id: string;
  ws_url: string;
}

export interface BrigadeMemberPresence {
  member_id: string;
  presence: "absent" | "in_kitchen_idle" | "busy_assigned" | "stepped_away" | "unknown";
  current_task_id?: string | null;
  joined_at_ms?: number | null;
}

export interface BrigadeAssignmentSummary {
  task_id: string;
  member_id: string;
  assigned_at_ms: number;
  started_at_ms: number | null;
  completed_at_ms: number | null;
  outcome: string | null;
}

export interface BrigadeSummary {
  status: string;
  paused?: boolean;
  connected_member_count?: number;
  connected_members?: BrigadeMemberPresence[];
  in_flight_assignments?: BrigadeAssignmentSummary[];
  completed_count?: number;
  total_assignments?: number;
  expected_completion_at_ms?: number | null;
}

export interface BrigadeStateResult {
  state: {
    cook_session_id: string;
    meal_id: string;
    plan_id: string;
    household_id: string | null;
    status: "planned" | "active" | "completed" | "abandoned";
    started_at_ms: number | null;
    completed_at_ms: number | null;
    expected_duration_min: number;
    paused?: boolean;
    paused_at_ms?: number | null;
    last_pause_reason?: string | null;
  };
  brigade?: BrigadeSummary;
}

export interface BrigadeEventRow {
  id: string;
  cook_session_id: string;
  kind: string;
  member_id: string | null;
  payload: Record<string, unknown>;
  emitted_at_ms: number;
}

export interface ToolMap {
  chef_status_check: {
    args: { household_id: string };
    result: ChefStatus;
  };
  chef_dispatch: {
    args: { household_id: string; user_intent?: string };
    result: {
      status: ChefStatus;
      turn_plan: Array<{
        kind: "ask_question" | "ask_user" | "compose_meal";
        args: Record<string, unknown>;
        rationale: string;
      }>;
    };
  };
  plan_create: {
    args: {
      household_id?: string;
      start_date?: string;
      end_date?: string;
      plan?: unknown;
    };
    result: { plan: { id: string; [k: string]: unknown } };
  };
  plan_read_meal: {
    args:
      | { plan_id: string; slot: { date: string; slot: "breakfast" | "lunch" | "dinner" | "snack" } }
      | { meal_id: string }
      | { plan_id: string; slot_date: string; slot_label: string };
    result: { meal: PlanMeal | null; status?: string };
  };
  plan_read_map: {
    args: { plan_id: string; detail?: "compact" | "full"; mode?: "compact" | "full" };
    result: { plan_id: string; mode: string; map: string };
  };
  plan_list: {
    args: { household_id?: string };
    result: { plans: ActivePlanSummary[] };
  };
  plan_read_dependency_edges: {
    args: { plan_id: string; status?: string };
    result: {
      plan_id: string;
      status: string;
      edge_count: number;
      edges: Array<{
        id: string;
        from: string;
        to: string;
        kind: string;
        status: "violated" | "critical" | "marginal" | "ok";
        critical?: boolean;
        message?: string;
      }>;
    };
  };
  plan_read_grievances: {
    args: { plan_id: string; severity?: "hard" | "warning" | "preference" };
    result: {
      plan_id: string;
      severity: string;
      grievances: Grievance[];
      counts: Record<string, number>;
    };
  };
  inspire_read_weather: {
    args: {
      household_id?: string;
      location: { lat: number; lng: number; tz?: string; city?: string };
      start_date?: string;
      end_date?: string;
      days_ahead?: number;
    };
    result: WeatherSummary;
  };
  inspire_read_recipe_steps: {
    args: {
      household_id?: string;
      recipe_id?: string;
      canonical_dish_id?: string | number;
      canonical_dish_title?: string;
    };
    result:
      | ({ ok: true } & RecipeStepsResult)
      | { ok: false; message?: string };
  };
  household_read_brief: {
    args: { household_id: string; date?: string };
    result:
      | { ok: true; brief: MorningBrief }
      | {
          ok: false;
          reason: "no_brief";
          household_id: string;
          for_date: string;
          latest: { id: string; for_date: string; generated_at_ms: number } | null;
        };
  };
  plan_compose_meal: {
    args: {
      household_id: string;
      plan_id?: string;
      slot_date: string;
      slot_label: string;
      meal: Partial<PlanMeal> & { title: string };
    };
    result: { meal: PlanMeal; plan_id: string };
  };
  inspire_read_household_signals: {
    args: { household_id: string };
    result: HouseholdSignals;
  };
  household_onboarding_start: {
    args: { household_id: string };
    result: {
      state: { tier: number; tier_0_completed_at: string | null };
      next_question: ChefQuestion | null;
      tier_progress: Record<string, number>;
    };
  };
  household_onboarding_answer: {
    args: {
      household_id: string;
      // The worker tool's required fields are `question_kind` (stable id like
      // "tier_1_dinner_ritual") and `response_text` (the user's answer string —
      // for forced-choice questions, pass the option value e.g. "table").
      question_kind: string;
      response_text: string;
      member_id?: string;
    };
    result: {
      next_question: ChefQuestion | null;
      tier_advanced: boolean;
    };
  };
  household_onboarding_status: {
    args: { household_id: string };
    result: {
      current_tier: number;
      tier_0_done: boolean;
      tier_1_done: boolean;
      completion_pct: number;
      next_question: ChefQuestion | null;
      engagement_signal?: number;
    };
  };
  household_onboarding_skip: {
    args: { household_id: string; question_kind: string; member_id?: string };
    result: { next_question: ChefQuestion | null };
  };
  household_set_pantry_bulk: {
    args: { household_id: string; text?: string; items?: string[] };
    result: {
      added: number;
      categorized: Array<{ category: string; items: string[] }>;
    };
  };
  household_set_equipment_bulk: {
    args: { household_id: string; equipment_slugs: string[] };
    result: { added: number; equipment: string[] };
  };
  household_set_traditions: {
    args: {
      household_id: string;
      traditions: Array<{
        name: string;
        cadence: string;
        description?: string;
      }>;
    };
    result: { added: number; traditions: Array<{ name: string; cadence: string }> };
  };

  // ── Phase 4 — shop / pantry / member / brief ────────────────────────────

  plan_read_shopping_list: {
    args: { plan_id: string; grouped_by?: string };
    result: {
      plan_id: string;
      grouped_by: string;
      sections: Array<{
        category: string;
        items: Array<{
          name: string;
          quantity: number | null;
          unit: string | null;
          source?: string[];
          grams_total?: number;
        }>;
      }>;
    };
  };
  plan_read_shop_runs: {
    args: { plan_id: string };
    result: {
      plan_id: string;
      shop_runs: Array<{
        id: string;
        date: string;
        label: string;
        categories: string[];
        item_count: number;
        meta?: Record<string, unknown>;
      }>;
    };
  };
  member_list: {
    args: { household_id: string };
    result: { household_id: string; count: number; members: HouseholdMember[] };
  };
  member_get: {
    args: { member_id: string };
    result: { member: HouseholdMember | null };
  };
  member_get_presence: {
    args: { member_id: string };
    result: { member_id: string; presence: PresenceSnapshot | null };
  };
  household_get_traits: {
    args: { household_id: string; with_descriptions?: boolean };
    result: {
      household_id: string;
      traits: Array<{
        trait_name: string;
        value: number;
        confidence: number;
        evidence_count: number;
        last_evidence_at_ms: number | null;
        description?: string;
      }>;
    };
  };
  household_get_trait_spread: {
    args: { household_id: string };
    result: { household_id: string; spreads: TraitSpread[] };
  };

  // ── Phase 5 — brigade (cook mode WS + manual control) ───────────────────

  brigade_grant_token: {
    args: { cook_session_id: string; member_id: string };
    result: BrigadeTokenGrant;
  };
  brigade_get_state: {
    args: { cook_session_id: string };
    result: BrigadeStateResult;
  };
  brigade_get_event_log: {
    args: { cook_session_id: string; since_ms?: number; limit?: number };
    result: { events: BrigadeEventRow[] };
  };
  brigade_send_message: {
    args: {
      cook_session_id: string;
      message: string;
      target_member_id?: string;
    };
    result: { ok: true; broadcast: boolean };
  };
  brigade_pause: {
    args: { cook_session_id: string; reason?: string };
    result: { ok: true; paused: boolean };
  };
  brigade_resume: {
    args: { cook_session_id: string };
    result: { ok: true; paused: boolean };
  };
  brigade_end: {
    args: {
      cook_session_id: string;
      outcome?: "completed" | "abandoned";
      notes?: string;
    };
    result: { ok: true; outcome: string };
  };
  brigade_assign_task_manually: {
    args: {
      cook_session_id: string;
      task_id: string;
      member_id: string;
      reason?: string;
    };
    result: { ok: true; task_id: string; member_id: string };
  };
  brigade_unassign_task: {
    args: { cook_session_id: string; task_id: string; reason?: string };
    result: { ok: true; task_id: string };
  };
  brigade_mark_task_complete: {
    args: {
      cook_session_id: string;
      task_id: string;
      member_id?: string;
      outcome?: "succeeded" | "abandoned" | "skipped" | "failed";
      notes?: string;
    };
    result: { ok: true; outcome: string };
  };

  // ── Phase 5 — meal_agent state-machine helpers ──────────────────────────

  meal_agent_transition: {
    args: {
      plan_id: string;
      slot_date: string;
      slot_label: string;
      to_phase: string;
      reason?: string;
      force?: boolean;
    };
    result: { phase: string; ok: boolean };
  };

  // ── Phase 6 — settings / profile reads & writes ─────────────────────────
  //
  // These wrap household-profile read/update tools the worker exposes.
  // If a particular tool name doesn't exist on the worker, the settings page
  // gracefully falls back via mcp_call_any errors → empty form.

  household_read_profile: {
    args: { household_id: string };
    result: {
      household_id: string;
      household_name?: string;
      primary_member_name?: string;
      location?: string;
      timezone?: string;
      created_at?: string;
    };
  };
  household_update_profile: {
    args: {
      household_id: string;
      household_name?: string;
      location?: string;
      timezone?: string;
    };
    result: { ok: true };
  };
  household_read_observations: {
    args: { household_id: string; limit?: number };
    result: {
      observations: Array<{
        id: string;
        kind: string;
        observed_at: string;
        summary: string;
        confidence?: number;
      }>;
    };
  };
}

export type ToolName = keyof ToolMap;

// ── JSON-RPC client ─────────────────────────────────────────────────────────

let rpcId = 1;
function nextId() {
  return rpcId++;
}

interface JsonRpcResponse<T> {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: { structuredContent?: T; content?: unknown[]; isError?: boolean };
  error?: { code: number; message: string };
}

class McpError extends Error {
  constructor(
    message: string,
    public code?: number,
    public tool?: string,
  ) {
    super(message);
    this.name = "McpError";
  }
}

async function rpcCall<T>(
  method: string,
  params: unknown,
  ctx: McpContext,
): Promise<T> {
  const url = `${WORKER_URL}${MCP_PATH}`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-spence-trace-caller-kind": ctx.caller_kind ?? "agent",
  };
  if (ctx.caller_id) headers["x-spence-trace-caller-id"] = ctx.caller_id;
  if (ctx.parent_trace) headers["x-spence-trace-parent"] = ctx.parent_trace;

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: nextId(),
      method,
      params,
    }),
  });

  if (!res.ok) {
    throw new McpError(`MCP HTTP ${res.status}`, res.status);
  }

  const json = (await res.json()) as JsonRpcResponse<T>;
  if (json.error) {
    throw new McpError(json.error.message, json.error.code);
  }
  if (json.result?.isError) {
    const txt =
      Array.isArray(json.result.content) && json.result.content.length > 0
        ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (json.result.content[0] as any)?.text ?? "tool error"
        : "tool error";
    throw new McpError(String(txt));
  }
  return (json.result?.structuredContent ?? json.result) as T;
}

/** Typed MCP call — preferred entry point for known tools. */
export async function mcp<TName extends ToolName>(
  tool: TName,
  args: ToolMap[TName]["args"],
  ctx: McpContext,
): Promise<ToolMap[TName]["result"]> {
  // Inject household_id where the tool expects it but caller omitted it.
  const merged = injectHouseholdId(args, ctx.household_id);
  return rpcCall<ToolMap[TName]["result"]>(
    "tools/call",
    { name: tool, arguments: merged },
    ctx,
  );
}

/** Untyped escape hatch for tools not in ToolMap. */
export async function mcp_call_any(
  tool: string,
  args: Record<string, unknown>,
  ctx: McpContext,
): Promise<unknown> {
  const merged = injectHouseholdId(args, ctx.household_id);
  return rpcCall<unknown>("tools/call", { name: tool, arguments: merged }, ctx);
}

/** List all available tools from the worker (for agent loop tool catalog). */
export async function listTools(ctx: McpContext): Promise<
  Array<{ name: string; description: string; inputSchema: unknown }>
> {
  const result = await rpcCall<{ tools: Array<{ name: string; description: string; inputSchema: unknown }> }>(
    "tools/list",
    {},
    ctx,
  );
  return result.tools;
}

function injectHouseholdId(
  args: unknown,
  household_id: string,
): Record<string, unknown> {
  if (!args || typeof args !== "object") return { household_id };
  const obj = { ...(args as Record<string, unknown>) };
  if (!("household_id" in obj)) obj.household_id = household_id;
  return obj;
}

export { McpError };

// ── Client-side helper (browser → /api/mcp-proxy) ───────────────────────────

/**
 * `mcpClient` is the browser-safe entry point. It posts to `/api/mcp-proxy`
 * which attaches the household_id from the session and forwards to the
 * worker. This is the ONLY way client components should hit MCP — never raw
 * fetch.
 *
 * Typed against `ToolMap`; falls back to `unknown` if the tool name isn't
 * in the map.
 */
export async function mcpClient<TName extends ToolName>(
  tool: TName,
  args?: Omit<ToolMap[TName]["args"], "household_id"> | ToolMap[TName]["args"],
): Promise<ToolMap[TName]["result"]>;
export async function mcpClient(
  tool: string,
  args?: Record<string, unknown>,
): Promise<unknown>;
export async function mcpClient(
  tool: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const res = await fetch("/api/mcp-proxy", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool, args }),
  });
  if (!res.ok) {
    let detail = "";
    try {
      const json = (await res.json()) as { error?: string };
      detail = json.error ?? "";
    } catch {
      detail = await res.text().catch(() => "");
    }
    throw new McpError(
      `mcp-proxy ${res.status}${detail ? `: ${detail}` : ""}`,
      res.status,
      tool,
    );
  }
  const json = (await res.json()) as { result?: unknown; error?: string };
  if (json.error) throw new McpError(json.error, undefined, tool);
  return json.result;
}

# Spence on Cloudflare-Native Primitives

> Where we are, where Cloudflare's stack has gone (Agents SDK + Workflows GA + Code Mode), and the clean mapping that turns our roll-our-own workflow runner into Cloudflare-native.

---

## What's actually current in the Cloudflare stack (as of mid-2026)

### Agents SDK (`agents` npm — we're already on v0.12.3)
The canonical pattern. Each agent extends a `DurableObject`-backed `Agent` class. Built-in capabilities:

| Capability | API |
|---|---|
| **State** auto-syncs to clients | `setState()`, `initialState`, `onStateChanged()` |
| **Scheduling / alarms** | `schedule()`, `scheduleEvery()`, `getScheduleById()`, `listSchedules()` |
| **Durable execution (per-agent)** | `runFiber()`, `stash()`, `onFiberRecovered()`, `keepAlive()`, `keepAliveWhile()` |
| **Async queues** | `queue()`, `dequeue()`, `dequeueAll()`, `getQueue()` |
| **Hibernating WebSockets** | `onConnect()`, `onMessage()`, `broadcast()` |
| **MCP client** | `addMcpServer()`, `removeMcpServer()`, `getMcpServers()` |
| **Workflows hand-off** | `runWorkflow()`, `waitForApproval()` |

We already use: state, scheduling, hibernating WS. We **don't yet use** Fibers, Queues, or the Workflows hand-off — those are exactly what we need for the workflow story.

### Workflows (GA April 2026)
Durable execution engine. Per-step checkpointing, automatic retries, days-long hibernation. Built for multi-step jobs that span minutes/hours/days. Cloudflare's official guidance:

> *"For work that should run independently of the agent with per-step retries and multi-step orchestration, use Workflows. Fibers are for work that's part of the agent's own execution."*

### Code Mode for MCP (April 2026)
**This is huge for us.** Instead of exposing N flat tools (each eating ~100 tokens), expose just two tools:

- `search(query)` — explores an OpenAPI / typed-SDK spec via JS the model writes
- `execute(code)` — runs JS that calls the API in a Workers isolate sandbox

Cloudflare's own benchmark: their 2500-endpoint API was **1.17M tokens via traditional MCP, ~1K tokens via Code Mode** — same expressiveness, ~1000× tighter.

Pattern matches what we need: our 100+ MCP tools currently force a curated 33-tool allow-list to fit context. With Code Mode, the chef gets full access to all 100+ tools at a tiny context cost.

### MCP Server Portal (Open Beta 2026)
Cloudflare Access in front of MCP, with prompt filtering and observability. Replaces our DIY admin-token + CF Access combo with a managed surface.

### AI Gateway
LLM-front-door: caching, rate limiting, cost caps, observability. We can route the bridge through AI Gateway for free observability without changing the bridge daemon.

### Dynamic Workflows
Tenant-provided code in workflows — less relevant for our single-tenant chef, but useful if we ever do multi-household per-customer customization.

---

## The clean architecture (target state)

```
┌───────────────────────────────────────────────────────────────────────────┐
│  USER (phone / desktop)                                                   │
│    │                                                                      │
│    ▼  Cloudflare Access (auth)                                            │
│  spence-web (Worker, Next.js via @opennextjs/cloudflare)                  │
│    └─ thin proxy → mise-graph                                             │
│                                                                           │
│            ▼                                                              │
│  ┌──────────────────────────────────────────────────────────────────┐    │
│  │  mise-graph (Worker + Agents SDK)                                │    │
│  │                                                                  │    │
│  │  ┌─ /agent/chef ─────────────────────────────────────────┐      │    │
│  │  │                                                         │      │    │
│  │  │  ┌──[1] INTENT ROUTER ─────────────────────────┐       │      │    │
│  │  │  │  Workers AI (cheap, ~50ms)                   │       │      │    │
│  │  │  │  Pick: free_chat | workflow:onboard         │       │      │    │
│  │  │  │       | workflow:plan | quick:save_pref     │       │      │    │
│  │  │  └──┬───────────┬────────────┬─────────────────┘       │      │    │
│  │  │     │           │            │                         │      │    │
│  │  │  ┌──▼───────┐ ┌─▼──────────┐ ▼                         │      │    │
│  │  │  │ free chat│ │  Workflow  │ Quick agent action         │      │    │
│  │  │  │ → Code   │ │  (durable) │ → direct MCP via           │      │    │
│  │  │  │  Mode +  │ │            │   in-process callPlanWorld │      │    │
│  │  │  │  bridge  │ │            │                             │      │    │
│  │  │  └──────────┘ └────────────┘                             │      │    │
│  │  │                                                         │      │    │
│  │  └─────────────────────────────────────────────────────────┘      │    │
│  │                                                                  │    │
│  │  ┌─ Durable Objects (Agents SDK — ALREADY SHIPPED) ───────┐      │    │
│  │  │   HouseholdAgent ─ PlanAgent ─ MealAgent (state mach.) │      │    │
│  │  │   ShopAgent ─ CookAgent ─ MemberAgent                  │      │    │
│  │  │   CookingLeadAgent (hibernating WS for brigade)        │      │    │
│  │  │                                                         │      │    │
│  │  │   Each gets Fibers for in-turn checkpointable work.    │      │    │
│  │  └────────────────────────────────────────────────────────┘      │    │
│  │                                                                  │    │
│  │  ┌─ Cloudflare Workflows (NEW) ─────────────────────────────┐    │    │
│  │  │   OnboardingWorkflow                                       │    │    │
│  │  │     - tier 0 progressive question loop                     │    │    │
│  │  │     - tier 1 progressive question loop                     │    │    │
│  │  │     - bulk pantry/equipment/traditions sub-flows           │    │    │
│  │  │     - durable across days                                  │    │    │
│  │  │                                                            │    │    │
│  │  │   PlanningWorkflow                                         │    │    │
│  │  │     - read seasonality + weather + calendar (parallel)     │    │    │
│  │  │     - propose dishes (LLM step)                            │    │    │
│  │  │     - approval loop per dish (sub-flow with waitForApproval)│    │   │
│  │  │     - plan_create + plan_compose_meal × N (mandatory)      │    │    │
│  │  │     - plan_audit (mandatory)                               │    │    │
│  │  │     - present + handoff to MealAgents                      │    │    │
│  │  │                                                            │    │    │
│  │  │   CookSessionDebrief                                       │    │    │
│  │  │     - kicks off after eaten phase                          │    │    │
│  │  │     - asks taste rating, processes feedback                │    │    │
│  │  │     - updates traits + recipe scores                       │    │    │
│  │  │                                                            │    │    │
│  │  │   HouseholdReindexWorkflow                                 │    │    │
│  │  │     - nightly trait recompute from observation log         │    │    │
│  │  │     - cron-triggered                                       │    │    │
│  │  └────────────────────────────────────────────────────────────┘    │    │
│  │                                                                  │    │
│  │  ┌─ MCP — Code Mode ─────────────────────────────────────────┐    │    │
│  │  │   /mcp/plan-world (existing 100+ tools — unchanged)        │    │    │
│  │  │   /mcp/code-mode  (NEW — exposes search() + execute())     │    │    │
│  │  │     ↳ Workers Isolate sandbox runs JS that calls MCP       │    │    │
│  │  │       Replaces ~33-tool allow-list with full catalog       │    │    │
│  │  │       at ~5K-token context cost (was ~50K)                 │    │    │
│  │  └────────────────────────────────────────────────────────────┘    │    │
│  │                                                                  │    │
│  │  ┌─ AI Gateway (NEW front-door) ────────────────────────────┐    │    │
│  │  │   route bridge calls through AI Gateway for:              │    │    │
│  │  │   • caching                                              │    │    │
│  │  │   • rate limiting                                        │    │    │
│  │  │   • cost dashboard                                       │    │    │
│  │  │   • prompt logging (privacy-controlled)                  │    │    │
│  │  │   ↓                                                      │    │    │
│  │  │   VPC MESH → claude-bridge daemon (CC subscription)      │    │    │
│  │  └──────────────────────────────────────────────────────────┘    │    │
│  │                                                                  │    │
│  │  D1 (recipe-graph-db)   R2 (BRIGADE_PHOTOS)                      │    │
│  │  Workers AI (intent classifier)                                  │    │
│  │  VPC binding → bridge                                            │    │
│  └──────────────────────────────────────────────────────────────────┘    │
└───────────────────────────────────────────────────────────────────────────┘
```

---

## Mapping each piece to Cloudflare primitives

### Layer 1 — Intent Router

**Pattern**: cheap classifier on Workers AI

```typescript
// In /agent/chef route, before deciding what to do
const intent = await env.AI.run("@cf/meta/llama-3.2-3b-instruct", {
  prompt: `Classify the user's intent. Return ONE of:
- "free_chat"
- "workflow:onboard"
- "workflow:plan"
- "workflow:debrief_meal"
- "quick:save_preference"
- "quick:add_to_pantry"

User: ${userMessage}
Intent:`,
  max_tokens: 16,
});
```

~50ms, near-zero cost. We don't burn the bridge for routing.

### Layer 2 — Workflows (durable, multi-step)

**Pattern**: define a Cloudflare Workflow per long-running flow.

```typescript
// worker/src/workflows/planning-workflow.ts
import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from "cloudflare:workers";

export class PlanningWorkflow extends WorkflowEntrypoint<Env, PlanningParams> {
  async run(event: WorkflowEvent<PlanningParams>, step: WorkflowStep) {
    const { household_id, nights, constraints } = event.payload;

    // Step 1: parallel data gather (each step retries independently)
    const [seasonality, weather, calendar, signals] = await Promise.all([
      step.do("read_seasonality", () => mcp("inspire_read_seasonality", { household_id })),
      step.do("read_weather", () => mcp("inspire_read_weather", { household_id, days_ahead: nights })),
      step.do("read_calendar", () => mcp("inspire_read_calendar", { household_id, days: nights })),
      step.do("read_signals", () => mcp("inspire_read_household_signals", { household_id })),
    ]);

    // Step 2: LLM proposes dishes
    const proposed = await step.do("propose_dishes", async () => {
      return callMeshClaude(this.env, {
        prompt: buildProposePrompt(seasonality, weather, calendar, signals, constraints),
        system: PROPOSE_SYSTEM,
      });
    });

    // Step 3: per-dish approval sub-flow (waitForApproval pauses indefinitely)
    const approved = [];
    for (const dish of proposed.dishes) {
      const decision = await step.waitForEvent(`approve_${dish.id}`, {
        type: "user_approval",
        timeout: "1 hour",
      });
      if (decision.approved) approved.push(dish);
    }

    // Step 4: mandatory persistence
    const plan = await step.do("create_plan", () =>
      mcp("plan_create", { household_id, start_date, end_date }),
    );

    for (const dish of approved) {
      await step.do(`compose_${dish.id}`, () =>
        mcp("plan_compose_meal", { plan_id: plan.plan_id, slot: dish.slot, meal: dish }),
      );
    }

    // Step 5: audit
    const audit = await step.do("audit", () =>
      mcp("plan_audit", { plan_id: plan.plan_id, run_critics: "all" }),
    );

    return { plan_id: plan.plan_id, audit };
  }
}
```

**Crucially**: each `step.do(...)` is checkpointed. If the worker restarts mid-plan, the workflow resumes. If `waitForEvent` is open for a day while the user thinks, the workflow hibernates and resumes when the event arrives. This is what we built our roll-our-own runner toward — Cloudflare's already does it for us.

### Layer 3 — Fibers (in-agent durable steps)

**Pattern**: when an Agent does multi-step work that's PART of its own execution loop (not separable into a workflow).

```typescript
// In HouseholdAgent.dailyCheckin
async dailyCheckin() {
  await this.runFiber("morning_brief", async (ctx) => {
    const weather = await fetchWeather(this.state.location);
    ctx.stash({ weather });

    const calendar = await readCalendarWindows(this.env, this.state.household_id);
    ctx.stash({ weather, calendar });

    const briefText = await callMeshClaude(this.env, {
      prompt: composeBriefPrompt(weather, calendar, this.state.signals),
    });

    await this.persistBrief({ weather, calendar, text: briefText.text });
  });
}

// If the worker dies between stash points, onFiberRecovered resumes:
async onFiberRecovered(ctx: FiberRecoveryContext) {
  if (ctx.name === "morning_brief") {
    const snap = ctx.snapshot as { weather?: any; calendar?: any };
    // Resume from wherever we got to.
  }
}
```

Use Fibers in: `HouseholdAgent.dailyCheckin`, `MealAgent` phase entry handlers (currently raw functions), `CookingLeadAgent` scheduler tick (currently a plain alarm).

### Layer 4 — Code Mode for the chef agent's tool surface

**Pattern**: wrap the existing 100+ MCP tools behind two `search()` + `execute()` tools that take JavaScript.

```typescript
// New file: worker/src/code-mode-mcp.ts
//
// Exposes 2 tools:
//   - search(query) → inspect spec for a tool by name/keyword
//   - execute(code) → run JS that calls the worker's MCP tools
// All in a Workers Isolate sandbox (separate from the calling DO).

export async function handleCodeModeExecute(env, code: string) {
  // Parse, validate, run in sandboxed isolate.
  // The JS has a global `mcp` function that proxies to callPlanWorldTool.
  // Returns whatever the JS returns (single value, log, structured data).
}
```

The chef agent's system prompt becomes:

```
You have two tools:
1. search(query) — find tools by keyword. Returns name + schema.
2. execute(code) — run JS that calls them. The runtime exposes `mcp(name, args)`.

Example:
  const plans = await mcp("plan_list", { household_id });
  const today = await mcp("plan_read_meal", { plan_id: plans[0].id, slot: { date: today, slot: "dinner" } });
  return { tonight: today.meal };

Compose multiple calls in one execute() rather than a back-and-forth.
```

**Result**: Claude can call any of our 100+ tools by name without us pre-listing them in the prompt. Context goes from ~50K (the curated list + descriptions) to ~5K (just the two tool descriptions + protocol). And Claude can chain tools in one `execute` call instead of round-tripping each one.

### Layer 5 — AI Gateway in front of the bridge

**Pattern**: route bridge calls through `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/...` instead of directly hitting the daemon over MESH.

Free win:
- Caching identical prompts
- Rate limiting per household
- Cost dashboard (even though the bridge uses CC subscription, we want observability)
- Prompt log (privacy-controlled) for debugging hallucinations

The bridge daemon stays unchanged — AI Gateway is a transparent proxy.

### Layer 6 — MCP Server Portal (Open Beta)

**Pattern**: replace our admin-token-on-bridge-routes with Cloudflare's managed MCP Server Portal.

Get for free:
- CF Access auth in front of MCP
- Prompt filtering (block injection patterns)
- Per-tool rate limiting
- Audit log

---

## What we keep (already correct)

- **Durable Objects** (HouseholdAgent + PlanAgent + MealAgent + ShopAgent + CookAgent + MemberAgent + CookingLeadAgent) — exactly the right shape, exactly what the Agents SDK was designed for.
- **D1** schemas — tables, indexes, migrations. No change.
- **R2** for photos — no change.
- **VPC binding to mesh-claude bridge** — keep, just front it with AI Gateway.
- **The 100+ MCP tool catalog** — keep, but wrap with Code Mode.
- **Web app's UX surface** — keep all routes, components, primitives. Workflow steps render as cards inline in chat.

## What we change

| Today | Cloudflare-native target |
|---|---|
| Roll-our-own `[[TOOL_CALL]]` text envelope parsing | **Code Mode** (`search()` + `execute()`) |
| Curated 33-tool allow-list for context budget | All 100+ tools available via Code Mode |
| In-route multi-iteration loop bounded at 4 | **Cloudflare Workflows** for multi-step durable runs |
| HouseholdAgent.dailyCheckin as bare async function | `runFiber()` for checkpointed step execution |
| Direct bridge call from worker | Route via **AI Gateway** for caching + observability |
| Admin token on `/agent/chef` route | **MCP Server Portal** with managed CF Access |
| No intent routing — bridge handles everything | **Workers AI intent router** (cheap, fast, decides workflow vs free chat) |

---

## Migration phases

### Phase 1 — Code Mode for the chef agent (highest leverage)
Replace `[[TOOL_CALL]]` parsing with Code Mode. The chef gets all 100+ tools at ~5K context cost, hallucinations drop because Claude can compose tool calls in one `execute()`. ~1 day of agent time. Largest single quality improvement.

### Phase 2 — Cloudflare Workflows for OnboardingWorkflow + PlanningWorkflow
Migrate from the Phase-1-of-the-other-roadmap "roll-our-own runner" to Cloudflare Workflows. Get durability + retries + days-long suspension for free. ~2 days of agent time.

### Phase 3 — Intent Router on Workers AI
Add the cheap classifier at the top of /agent/chef. Routes between free_chat / workflow:* / quick:*. ~half day.

### Phase 4 — Fibers inside existing Agents
Migrate HouseholdAgent.dailyCheckin, MealAgent phase handlers, CookingLeadAgent scheduler tick to Fibers. Get checkpoint-recovery for free. ~1 day.

### Phase 5 — AI Gateway in front of bridge
Route mesh calls through AI Gateway. Observability + caching + rate limit. ~half day.

### Phase 6 — MCP Server Portal
Migrate admin-token routes onto the managed portal. CF Access + audit + filtering. ~half day.

**Total**: ~5 agent-days for full migration, with Phase 1 alone delivering the biggest user-visible quality jump (no more hallucinated saves, full tool surface accessible).

---

## Why this is the right answer

1. **Aligned with Cloudflare's official guidance** — Fibers vs Workflows split is exactly how their Agents docs describe the dichotomy ("Fibers for in-agent, Workflows for separable").
2. **Removes ~3K LOC of roll-our-own runner code** — Workflows ships the durability we'd otherwise build.
3. **Solves the hallucination problem** — Code Mode means Claude actually executes our MCP tools (instead of hoping Claude's text contains the right magic string).
4. **Keeps everything we built** — DOs, D1, R2, the bridge, the web app, the MCP catalog. None of those change.
5. **Earns the "Cloudflare-native" badge** — every layer is a managed primitive. Less code to maintain. More leverage as Cloudflare ships improvements.

---

## Sources

- [Cloudflare Agents docs](https://developers.cloudflare.com/agents/)
- [agents npm package](https://www.npmjs.com/package/agents)
- [Agents SDK API reference](https://developers.cloudflare.com/agents/api-reference/agents-api/)
- [Durable execution: Fibers vs Workflows](https://developers.cloudflare.com/agents/api-reference/durable-execution/)
- [Workflows GA (April 2026)](https://blog.cloudflare.com/workflows-ga-production-ready-durable-execution/)
- [Code Mode for MCP](https://blog.cloudflare.com/code-mode-mcp/)
- [Dynamic Workflows](https://blog.cloudflare.com/dynamic-workflows/)
- [MCP Server Portals](https://blog.cloudflare.com/zero-trust-mcp-server-portals/)
- [Cloudflare's internal AI engineering stack](https://blog.cloudflare.com/internal-ai-engineering-stack/)

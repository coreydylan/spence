# Spence Migration Plan — Stateless → Hierarchical Multi-Agent

## Current state (what's shipped, 46 tests passing)

- World model: ResourceLedger, MealComponent, DependencyEdge, RipplePreview, critics, cascade proposals, recipe importer, locks, shopping runs, shelf-life table, dynamic scheduling.
- LLM-Modulo revision loop with 7 wired mutation kinds.
- MCP tool server live at `/mcp/plan-world` with 37 tools.
- Daily check-in cron (deterministic-fallback brief generator).
- Replan webhook for life events.
- Household-memory schema (profiles, threads, kitchen inventory, anchor evolution, meal history).
- Single-shot LLM composer + post-pass + repair pipeline (`/mise-graph/plan` route).
- Bridge daemon on officemac for LLM access.
- Plan-map renderer (markdown total-state view).
- Coherence score (deterministic plan quality metric).

## Target state

```
HouseholdAgent (DO, long-lived per household)
  ├─ alarms: daily check-in, weekly planning prompt
  ├─ knows: profile, members, calendar, weather, learnings, movement memory
  └─ children:
        PlanAgent (DO, per active plan)
          ├─ alarms: re-audit on signal change
          ├─ children:
                ShopAgent (DO, per shop run, state machine)
                CookAgent (DO, per prep session, state machine)
                MealAgent (DO, per meal, state machine)
                  states: planned → pre_eve → day_of → cook_window → active_cook → eaten → archived

CookingLeadAgent (DO, ephemeral, spawned per cook session)
  ├─ subscribes to all firing MealAgents in window
  ├─ merges task graphs into unified brigade timeline
  ├─ resolves equipment / worker conflicts
  └─ multiplexes per-phone WebSockets

MemberAgent (DO, long-lived per household member)
  ├─ skills (knife, sauté, dough, emulsion, ...) with confidence + history
  ├─ safety constraints (stove auth, knife auth, supervision floor)
  ├─ presence (absent / in_kitchen_idle / busy_assigned / stepped_away)
  └─ live state during cook sessions
```

## Architectural decisions (locked)

1. `read_household_context` is the unified first-turn read — bundles seasonality, weather, calendar, household memory, recent menu, taste feedback, recipe library, corpus, fusions, vibes, format library, anchor pressure.
2. Per-person `HouseholdMember` model from day one — every meal record uses `attending: [member_ids]`, every cook task uses `assignable_to: [member_ids]`.
3. Every committed mutation records an `agent_trace_id` (replay debug).
4. Tasks are the unit of cooking-time scheduling, not recipe steps. Every recipe gets a task graph (DAG).
5. `MemberAgent` is its own DO type, long-lived.
6. Cloudflare Agents SDK as runtime base for all entity DOs.
7. State machines are formal (named phases, entry conditions, alarms, exit conditions) — not status fields.
8. Inter-agent communication is event-based via Queue/D1 event log; direct RPC reserved for synchronous reads.

## Phases

### Wave 6 — Inspiration + Per-Person + Calendar/Weather (IMMEDIATE)

**Goal**: chef-of-staff Phase 1 (inspiration) lives in MCP. Per-person model in place. Calendar + weather wired. Concept board for candidate canvassing.

**Modules**
- `inspire-context.ts` — unified `read_household_context` master tool
- `inspire-tools.ts` — fine-grained tools (seasonality, recipe library, corpus, fusions, vibes, format lib, anchor pressure, taste feedback, recent menu)
- `weather-api.ts` — Open-Meteo HTTPS fetch keyed by household location
- `calendar-tools.ts` — read household calendar; write events for shops/cooks/meals; metadata-stamp for round-trip
- `concept-board.ts` — bookmark/read/score/finalize concept candidates
- `household-members.ts` — D1 schema + tool wrappers for per-person profile, skills, safety, presence
- Schema additions: `mise_household_members`, `mise_member_skills`, `mise_concept_board`, `mise_agent_traces`

**Acceptance**: 25+ new MCP tools deployed, ALL tests pass, e2e demo: agent (me) drives Phase 1 (gather → synthesize → bookmark → tetris) using only the new tools, articulating a real movement informed by weather + calendar.

### Wave 7 — DO Migration + Task Graphs + Skills (NEXT)

**Goal**: every entity becomes a DO with state machine. Recipe → task graph decomposition. Skill model auto-learning.

**Modules**
- `agents-sdk-setup` — wrangler bindings, Agent base class scaffolding
- `household-agent.ts` — DO with daily alarm + planning prompt
- `plan-agent.ts` — DO wrapping plan operations
- `meal-agent.ts` — DO with full state machine (7 phases)
- `shop-agent.ts` — DO with state machine
- `cook-agent.ts` — DO with state machine
- `member-agent.ts` — DO with skills + presence
- `task-graph.ts` — recipe → DAG decomposition
- `equipment-tracking.ts` — kitchen resources + conflict resolution
- `skill-model.ts` — auto-learning from completed tasks
- `agent-trace.ts` — replay debug

**Acceptance**: plan operations route through PlanAgent DO; meal commit spawns MealAgent DO; `pre_eve` alarm fires 24h before; recipe imports produce task graphs; skill confidence updates from cook completions; replay shows agent reasoning chain.

### Wave 8 — Live Cooking Surface (FINAL)

**Goal**: brigade-mode cooking. Per-phone WebSockets. Task scheduler. Photo capture loop.

**Modules**
- `cooking-lead-agent.ts` — ephemeral DO per cook session
- `websocket-server.ts` — per-phone subscriptions, hibernation-aware
- `task-scheduler.ts` — online assignment with skill matching + equipment conflict resolution
- `voice-surface.ts` — stub for Siri/Alexa
- `photo-capture.ts` — multipart upload + recipe library file
- `live-cook-feed.ts` — rendered timeline per worker

**Acceptance**: cook session starts; phone WebSocket receives task feed; two workers see only their own tasks; equipment conflicts serialize correctly; photo upload files to recipe library.

## E2E demo at end of each wave

- Wave 6: in this conversation, drive the chef-of-staff Phase 1 → 5 loop using only MCP tools. Live render plan map. Score coherence. Sync to calendar.
- Wave 7: smoke-test by accelerating clock — MealAgent transitions through phases on alarms, replay shows the chain.
- Wave 8: simulate a 2-worker cook session, verify the brigade timeline renders correctly.

# Wave 8B Track B Report — Photo capture + vision pipeline + recipe iteration

## Scope

Implements the brigade photo flow on top of the Wave 8 foundation:

1. Phone uploads an image to a new HTTP route on `CookingLeadAgent`.
2. Worker stores the bytes in R2 (binding `BRIGADE_PHOTOS`).
3. Worker calls bridge-claude vision over the existing MESH/Tailscale path
   for a per-task prompt.
4. Bridge response shape (analysis envelope) is normalised, persisted to
   embedded SQLite + the D1 event log, and broadcast over WS.
5. When the analysis carries an `iteration_suggestion`, the assignment row
   gets an `iteration_note` and a `recipe_iteration_suggested` envelope is
   pushed to the affected member. `action === "redo"` additionally drops
   the assignment's `completed_at_ms` so the scheduler re-queues the task.

## Files created

| Path | Purpose |
|---|---|
| `worker/src/mise-graph/bridge-vision.ts` | `callBridgeVision(env, request)` — HMAC-signed POST to the bridge daemon's `/v1/vision` endpoint over MESH. Plus `normalizeAnalysis` / `bytesToBase64` helpers. Same env shape as `llm-bridge.ts` but accepts the optional MESH binding via `VisionBridgeEnv = Partial<MeshClaudeEnv>`. |
| `worker/src/mise-graph/agents/vision-prompts.ts` | Per-task prompt registry. `visionPromptFor(task, recipeContext)` returns a skill-keyed prompt; `freeFormVisionPrompt(title)` is the no-task fallback. Stub-grade copy with TODO for Wave 8C+ refinement. |
| `worker/src/mise-graph/agents/photo-handler.ts` | Pure helpers the DO composes: `r2BucketAsStorage`, `storePhotoBytes`, `computeR2Key`, `resolveVisionPrompt`, `planVisionApply` (vision result → mutation plan), `serialiseVisionResult`. |
| `worker/test/lib/mock-r2.ts` | `MockR2Bucket` — in-memory R2 stand-in with the put/get surface the photo handler exercises. |
| `worker/test/scenarios/u68_photo_upload_lifecycle.ts` | storePhotoBytes round-trip + R2 key format + prompt routing. |
| `worker/test/scenarios/u69_vision_prompt_registry.ts` | Per-skill prompt differentiation, recipe context interpolation, sub-stage routing (knead/proof, dice/brunoise/julienne). |
| `worker/test/scenarios/u70_iteration_suggestion_flow.ts` | planVisionApply across the five action kinds + bridge-shape normalisation tolerance. |
| `worker/test/scenarios/u71_redo_action_unsets_completion.ts` | Redo plan flips `uncomplete_task=true`; every other action keeps it false; bridge fixture round-trip; in-memory simulation of the assignment row mutation. |

## Files modified

| Path | Change |
|---|---|
| `worker/src/mise-graph/agents/cooking-lead-agent.ts` | **Additive.** New routes (`upload-photo`, `photo`, `photo-analysis`, `photos`); new private methods (`handleUploadPhoto`, `handlePhotoFetch`, `handlePhotoAnalysisFetch`, `getPhotoStorage`, `runVisionAnalysis`, `loadTaskForVision`, `loadRecipeContext`, `listPhotoUploadRows`); extended `onStart` SQLite to add `iteration_note`, `mime`, `size_bytes`, `vision_pending`, `iteration_action`, `iteration_detail`. WS lifecycle / scheduler tick / token verify untouched. |
| `worker/src/mise-graph/agents/schemas/cooking-lead-agent.sql` | Final-shape rewrite: `task_assignments.iteration_note`, `photo_uploads.{mime,size_bytes,vision_pending,iteration_action,iteration_detail}`, plus a partial index on `vision_pending=1`. CREATE TABLE IF NOT EXISTS — DO embedded SQLite is volatile per migration so we author the final shape rather than ALTER. |
| `worker/src/mise-graph/agents/base.ts` | Added optional `BRIGADE_PHOTOS?: R2Bucket` to the augmented `Cloudflare.Env`. |
| `worker/src/mise-graph-worker.ts` | Added optional `BRIGADE_PHOTOS?: R2Bucket` to the worker `Env`. New non-admin route forwarder (`upload-photo` / `photo` / `photo-analysis`) that streams the request body to the DO — auth lives inside the DO via `verifyAndConsumeToken`. |
| `worker/wrangler.mise.toml` | Added `[[r2_buckets]]` binding `BRIGADE_PHOTOS = "spence-brigade-photos"`. The bucket itself must be created out-of-band before deploy (see Phase 2 notes below). |

## HTTP route surface added

| Route | Auth | Purpose |
|---|---|---|
| `POST /upload-photo?member_id=&task_id=&token=` | Single-use brigade token (consumed) | Upload image bytes (raw body); kicks off vision inline; returns `{photo_id, vision_pending, analysis?}` |
| `GET  /photo?photo_id=&token=` | Single-use token (consumed per fetch) | Image bytes |
| `GET  /photo-analysis?photo_id=&token=` | Single-use token (consumed per fetch) | `{pending: true}` or `{analysis, iteration_action, iteration_detail}` |
| `GET  /photos` | Admin (worker gate) | Per-session photo upload list (admin debug) |

The token IS the auth — same scheme as `/ws`. Admin callers (the worker's
`X-Spence-Admin` route) bypass the token check.

## Vision prompt approach

`visionPromptFor` is a `switch` on `task.skill`, each branch composing a:

1. **Structure preamble** — reminds the bridge to reply in the JSON
   envelope (`on_track, confidence, observed, concerns,
   iteration_suggestion?`).
2. **Skill-specific evaluation criteria** — what to look for (sear depth
   for `stove_searing`, windowpane for `dough_handling`, etc.).
3. **Recipe context** — title, protein, cuisine when supplied.
4. **Label-derived sub-stage** — `knife_basic` checks the verb (`dice` /
   `brunoise` / `julienne` / `mince` / `chiffonade`); `dough_handling`
   routes by stage (mixing / kneading / shaping / proofing).

The body is intentionally stub-grade — Wave 8C+ owns prompt curation.
The contract that the **bridge daemon's system prompt** enforces JSON
discipline (so the prompts here describe only the user-facing criteria).

## Recipe iteration loop

`planVisionApply(analysis)` returns a deterministic mutation plan:

| Plan flag | When |
|---|---|
| `update_assignment_iteration` | iteration_suggestion present |
| `iteration_note` | Composed text: `[<action>] <detail> — <ingredient_to_add?> — <±N% temp?> — <+N min?>` |
| `iteration_action` | mirrors suggestion's action |
| `uncomplete_task` | only when `action === "redo"` |
| `broadcast_iteration` | iteration_suggestion present |
| `broadcast_photo_analyzed` | always (success and failure paths) |

`runVisionAnalysis` in the DO mechanically applies the plan:
- writes `vision_response_json`, `iteration_action`, `iteration_detail`
  to `photo_uploads`,
- emits `vision_response_received` to the embedded log + D1 event log,
- updates `task_assignments.iteration_note` (when applicable),
- drops `completed_at_ms`/`outcome` for redo,
- sends a `recipe_iteration_suggested` envelope to the affected member,
- always sends a `lead_message{event:"photo_analyzed"}` so the uploader
  knows the analysis landed.

## R2 setup notes for Phase 2

Per the prompt, the bucket binding is recognized at `--dry-run` time
without the bucket needing to exist. Before the first real deploy:

```bash
# Create the bucket (do NOT run during build)
npx wrangler r2 bucket create spence-brigade-photos --config wrangler.mise.toml
```

Once created, the binding `env.BRIGADE_PHOTOS` will resolve and the
upload route will land bytes. Until then, `getPhotoStorage()` returns
null and the upload is recorded with `r2_key=NULL` (vision still runs
on the in-memory bytes; only retrieval through `/photo` would 503).

R2 lifecycle policy recommendation for Phase 2: 90-day TTL on the
`photos/` prefix. Cook sessions are 4h max so older photos are no
longer referenced by any active DO; they're useful only for taste-
feedback aggregation in `MealAgent` archives.

## Test results

```
SPENCE PLANNER  —  91 of 92 scenarios run
─────────────────────────────────────────
  Passed:  91    Failed:  0    Pending:  0
```

Pre-existing 86 (foundation 78 + Track A 8) + Track C 1 (u72) + Track B
4 (u68–u71) = 91 passing. The 92nd is `t18 daily-brief-live` (live tier).

`npx tsc --noEmit` — exit 0. (Track A's report flagged 21 references in
this file as "Track B/C unimplemented stubs"; by the time my edits
landed, Track C had filled in its handlers and the residual `Buffer`
reference in my own bridge-vision.ts is now solved with a workerd-safe
manual base64 fallback.)

`npx wrangler deploy --config wrangler.mise.toml --dry-run` — validates;
all 8 DO/D1/MESH/R2 bindings present.

## Architectural decisions

1. **Inline vision call (MVP).** The DO awaits `callBridgeVision` inside
   the upload-photo handler — a few-second latency is acceptable and lets
   the response include `analysis` directly. A `vision-callback` async
   path was scoped out; a future refactor can move to a queue if/when
   single-photo latency exceeds 5s.

2. **Pure-function pipeline pieces.** `storePhotoBytes`,
   `resolveVisionPrompt`, `planVisionApply`, `normalizeAnalysis`,
   `serialiseVisionResult` are all pure. The DO composes them; the
   tests drive them directly without booting the Agents SDK.

3. **R2 binding is optional.** `getPhotoStorage()` returns null when
   the binding is absent so the same code compiles and runs in Wave 7
   deploys / unit tests. The upload row still lands (with `r2_key=NULL`);
   only `/photo` retrieval 503s in that mode.

4. **Token consumed per upload.** The phone grants a fresh token via
   `/grant-token` for each photo. Same single-use semantics as the WS
   upgrade. Keeps the auth model uniform: one token = one privileged
   action against the DO.

5. **`recipe_iteration_suggested` is a first-class WS envelope kind** —
   already in `BrigadeMessageKind` from Wave 8 foundation. Track B
   plumbs the actual emit; the wire format was locked at foundation.

6. **Vision result columns on `photo_uploads`** (denormalised
   `iteration_action` / `iteration_detail`) so the analysis fetch
   route doesn't need to JSON-parse `vision_response_json` for the
   common case. The full envelope still lives in JSON for replay.

## Deviations from the prompt

1. **Routes use `?photo_id=` query params, not `:photo_id` path
   segments.** The DO's `onRequest` extracts the route as the LAST
   segment of the URL path; multi-segment routes (`/photo/<id>`)
   would have been read as just `<id>`. Switching to a query param
   keeps the dispatch single-segment without a worker-side rewrite.

2. **No `/vision-callback` route.** The prompt offered it as optional
   for async vision. Inline vision is good enough for MVP; the
   callback can be added without breaking shapes when async is
   needed.

3. **Bridge daemon's `/v1/vision` endpoint is assumed**, not built.
   The Worker side is complete; the daemon at `~/Developer/claude-bridge`
   needs a sibling handler for `kind: "vision"`. This is a documented
   downstream dependency; the Worker fails closed (record-only,
   `vision_pending=1`) when the bridge returns non-200 or a timeout.

4. **`bytesToBase64` uses globalThis.btoa with a manual b64 fallback** —
   no Node Buffer reference (Cloudflare worker types don't ship Buffer).

## What downstream waves should pick up

1. **Bridge daemon `/v1/vision` handler** in `~/Developer/claude-bridge`.
   Contract: HMAC-signed POST with `{kind:"vision", model, image_b64,
   image_mime, prompt}`; respond with `{analysis: {…}, raw_response?,
   cost_usd?}` matching the `VisionAnalysis` shape.

2. **Curate prompts.** `vision-prompts.ts` is stub-grade. Wave 8C+
   should add few-shot exemplars per skill and tighten the
   `iteration_suggestion` heuristics with chef-reviewed copy.

3. **Async vision queue.** If single-call latency creeps past 5s,
   move to fire-and-forget upload + `vision-callback` route. The
   embedded SQLite `vision_pending=1` flag already supports it.

4. **R2 lifecycle policy.** Auto-delete `photos/` after 90 days;
   migrate the most recent photo per task into the personal recipe
   library as a "your last attempt" reference image.

5. **`MealAgent` taste feedback aggregation.** Photos + analyses for
   a session are the seed data for "did this go well?" scoring.
   Wave 8B foundation already routes `vision_response_received` to
   D1; the MealAgent's `eaten` phase can read from there.

6. **Phone client.** iOS app (Wave 9) implements the camera capture
   + token grant + multipart upload + analysis polling against the
   routes locked here.

---

**Track B status:** complete. 91/91 tests passing, typecheck clean,
dry-run validates with the new R2 binding. Bridge daemon vision endpoint
is the only out-of-tree dependency to ship before this flow runs end-to-end.

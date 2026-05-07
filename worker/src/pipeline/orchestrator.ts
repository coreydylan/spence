/**
 * PipelineOrchestrator — Durable Object
 *
 * Coordinates batch processing across recipes:
 *   cluster → aggregate → step structures (Haiku) → draft (Sonnet Batch API) → validate → publish
 *
 * Uses alarm() to drive state machine. Each stage advances to the next.
 * Sonnet drafting uses Anthropic Batch API (50% off) with polling.
 */

import { DurableObject } from "cloudflare:workers";
import type { BatchStage, BatchJob } from "./types";
import { aggregateCanonical } from "./aggregator";
import { callHaiku, createBatch, pollBatch, fetchBatchResults } from "./anthropic";
import { STEP_STRUCTURE_SYSTEM, DRAFTER_SYSTEM, DRAFTER_OUTPUT_SCHEMA } from "./prompts";

interface Env {
  DB: D1Database;
  INGEST_BUCKET: R2Bucket;
  AI: Ai;
  ANTHROPIC_API_KEY: string;
}

interface OrchestratorState {
  current_batch: BatchJob | null;
  last_completed: string | null;
  auto_enabled: boolean;
}

export class PipelineOrchestrator extends DurableObject<Env> {
  private state_cache: OrchestratorState | null = null;

  private async getState(): Promise<OrchestratorState> {
    if (this.state_cache) return this.state_cache;
    this.state_cache = (await this.ctx.storage.get<OrchestratorState>("state")) || {
      current_batch: null,
      last_completed: null,
      auto_enabled: true,
    };
    return this.state_cache;
  }

  private async setState(state: OrchestratorState) {
    this.state_cache = state;
    await this.ctx.storage.put("state", state);
  }

  // ============================================================
  // HTTP handler
  // ============================================================

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/status") return this.handleStatus();
    if (path === "/run" && request.method === "POST") return this.handleRun(request);
    if (path === "/toggle-auto" && request.method === "POST") {
      const state = await this.getState();
      state.auto_enabled = !state.auto_enabled;
      await this.setState(state);
      return Response.json({ auto_enabled: state.auto_enabled });
    }
    if (path === "/reset" && request.method === "POST") {
      await this.setState({
        current_batch: null,
        last_completed: null,
        auto_enabled: true,
      });
      this.state_cache = null;
      return Response.json({ message: "Orchestrator state reset" });
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  }

  private async handleStatus(): Promise<Response> {
    const state = await this.getState();

    const pipeline = await this.env.DB.prepare(`
      SELECT stage, COUNT(*) as cnt FROM recipe_pipeline GROUP BY stage
    `).all<{ stage: string; cnt: number }>();

    const drafts = await this.env.DB.prepare(`
      SELECT status, COUNT(*) as cnt FROM canonical_drafts GROUP BY status
    `).all<{ status: string; cnt: number }>();

    const recentBatches = await this.env.DB.prepare(`
      SELECT id, stage, started_at, completed_at, dishes_affected, cost_usd, error
      FROM pipeline_batches ORDER BY started_at DESC LIMIT 5
    `).all();

    return Response.json({
      pipeline_stages: Object.fromEntries(pipeline.results.map((r) => [r.stage, r.cnt])),
      draft_statuses: Object.fromEntries(drafts.results.map((r) => [r.status, r.cnt])),
      orchestrator: {
        current_batch: state.current_batch,
        last_completed: state.last_completed,
        auto_enabled: state.auto_enabled,
      },
      recent_batches: recentBatches.results,
    });
  }

  private async handleRun(request: Request): Promise<Response> {
    const state = await this.getState();

    if (state.current_batch && !["complete", "error"].includes(state.current_batch.stage)) {
      return Response.json({ error: "Batch already running", batch: state.current_batch }, { status: 409 });
    }

    const body = await request.json().catch(() => ({})) as any;
    const minRecipes = body?.min_recipes || 5;

    const readyCount = await this.env.DB.prepare(
      "SELECT COUNT(*) as cnt FROM recipe_pipeline WHERE stage = 'ready'"
    ).first<{ cnt: number }>();

    // Determine starting stage — skip stages that have no work
    const aggregatedCount = await this.env.DB.prepare(
      "SELECT COUNT(DISTINCT canonical_title) as cnt FROM recipe_pipeline WHERE stage = 'aggregated'"
    ).first<{ cnt: number }>();

    let startStage: string = "clustering";
    if ((readyCount?.cnt || 0) === 0 && (aggregatedCount?.cnt || 0) > 0) {
      startStage = "drafting"; // Skip to drafting — everything is prepped
    } else if ((readyCount?.cnt || 0) === 0) {
      startStage = "clustering"; // Normal flow
    }

    const batchId = `batch_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
    const batch: BatchJob = {
      id: batchId,
      stage: startStage as any,
      started_at: new Date().toISOString(),
      completed_at: null,
      recipes_affected: readyCount?.cnt || 0,
      dishes_affected: 0,
      anthropic_batch_id: null,
      cost_usd: 0,
      error: null,
    };

    await this.env.DB.prepare(
      "INSERT INTO pipeline_batches (id, stage, trigger, recipes_processed) VALUES (?, ?, ?, ?)"
    ).bind(batchId, "clustering", body?.trigger || "manual", readyCount?.cnt || 0).run();

    state.current_batch = batch;
    await this.setState(state);
    await this.ctx.storage.setAlarm(Date.now() + 100);

    return Response.json({ message: "Batch started", batch_id: batchId, ready_recipes: readyCount?.cnt || 0 });
  }

  // ============================================================
  // Cron trigger
  // ============================================================

  async cron() {
    const state = await this.getState();
    if (!state.auto_enabled) return;
    if (state.current_batch && !["complete", "error"].includes(state.current_batch.stage)) return;

    const ready = await this.env.DB.prepare(
      "SELECT COUNT(*) as cnt FROM recipe_pipeline WHERE stage = 'ready'"
    ).first<{ cnt: number }>();

    if ((ready?.cnt || 0) < 10) return;

    const fakeReq = new Request("http://internal/run", {
      method: "POST",
      body: JSON.stringify({ trigger: "cron", min_recipes: 5 }),
    });
    await this.handleRun(fakeReq);
  }

  // ============================================================
  // Alarm — drives the batch state machine
  // ============================================================

  async alarm() {
    const state = await this.getState();
    if (!state.current_batch) return;
    const batch = state.current_batch;

    try {
      switch (batch.stage) {
        case "clustering":
          await this.runClustering(batch);
          batch.stage = "aggregating";
          break;
        case "aggregating":
          await this.runAggregation(batch);
          batch.stage = "generating_steps";
          break;
        case "generating_steps":
          await this.runStepGeneration(batch);
          // Check if there are aggregated dishes to draft — if step gen found nothing new
          // but aggregated dishes exist, still advance to drafting
          batch.stage = "drafting";
          break;
        case "drafting":
          const draftDone = await this.runDrafting(batch);
          if (draftDone) batch.stage = "validating";
          // else: still polling batch API, alarm will re-fire
          break;
        case "validating":
          await this.runValidation(batch);
          batch.stage = "publishing";
          break;
        case "publishing":
          await this.runPublishing(batch);
          batch.stage = "complete";
          batch.completed_at = new Date().toISOString();
          state.last_completed = batch.completed_at;
          await this.env.DB.prepare(
            "UPDATE pipeline_batches SET stage = 'complete', completed_at = ?, dishes_affected = ?, cost_usd = ? WHERE id = ?"
          ).bind(batch.completed_at, batch.dishes_affected, batch.cost_usd, batch.id).run();
          await this.setState(state);
          return; // Done
      }

      await this.env.DB.prepare(
        "UPDATE pipeline_batches SET stage = ?, dishes_affected = ?, cost_usd = ? WHERE id = ?"
      ).bind(batch.stage, batch.dishes_affected, batch.cost_usd, batch.id).run();

      await this.setState(state);
      // Next stage — small delay
      const delay = batch.stage === "drafting" ? 30_000 : 1_000;
      await this.ctx.storage.setAlarm(Date.now() + delay);
    } catch (e: any) {
      batch.stage = "error";
      batch.error = e.message;
      batch.completed_at = new Date().toISOString();
      await this.env.DB.prepare(
        "UPDATE pipeline_batches SET stage = 'error', error = ?, completed_at = ? WHERE id = ?"
      ).bind(e.message, batch.completed_at, batch.id).run();
      await this.setState(state);
    }
  }

  // ============================================================
  // Stage 1: Clustering
  // ============================================================

  private async runClustering(batch: BatchJob) {
    // Get ready recipes — LIMIT to avoid D1 timeout in DO (30s wall time)
    const ready = await this.env.DB.prepare(`
      SELECT rp.recipe_id, r.title
      FROM recipe_pipeline rp
      JOIN raw_recipes r ON rp.recipe_id = r.id
      WHERE rp.stage = 'ready'
      LIMIT 5000
    `).all<{ recipe_id: number; title: string }>();

    if (ready.results.length === 0) {
      // Nothing to cluster — skip ahead
      batch.recipes_affected = 0;
      return;
    }

    const stmts: D1PreparedStatement[] = [];
    for (const row of ready.results) {
      const normalized = row.title
        .toLowerCase()
        .replace(/\b(the best|best|easy|simple|quick|homemade|my|my favorite|favorite|ultimate|perfect|classic|real|authentic|traditional|one pot|one-pot|instant pot|air fryer|slow cooker|vegan|gluten.?free|dairy.?free|healthy|skinny|light|low.?carb|keto|paleo|whole30)\b/gi, "")
        .replace(/[^a-z\s]/g, "")
        .replace(/\s+/g, " ")
        .trim();

      stmts.push(
        this.env.DB.prepare(
          "UPDATE recipe_pipeline SET stage = 'clustered', canonical_title = ?, updated_at = datetime('now') WHERE recipe_id = ?"
        ).bind(normalized || row.title.toLowerCase(), row.recipe_id)
      );
    }

    for (let i = 0; i < stmts.length; i += 100) {
      await this.env.DB.batch(stmts.slice(i, i + 100));
    }

    batch.recipes_affected = ready.results.length;
  }

  // ============================================================
  // Stage 2: Aggregation
  // ============================================================

  private async runAggregation(batch: BatchJob) {
    const dishes = await this.env.DB.prepare(`
      SELECT canonical_title, composition, COUNT(*) as cnt,
             GROUP_CONCAT(recipe_id) as recipe_ids
      FROM recipe_pipeline
      WHERE stage = 'clustered' AND canonical_title IS NOT NULL
      GROUP BY canonical_title
      HAVING cnt >= 3
      ORDER BY cnt DESC
      LIMIT 200
    `).all<{ canonical_title: string; composition: string; cnt: number; recipe_ids: string }>();

    // Process in parallel batches of 20
    let aggregated = 0;
    for (let i = 0; i < dishes.results.length; i += 20) {
      const chunk = dishes.results.slice(i, i + 20);
      await Promise.all(chunk.map(async (dish) => {
        const recipeIds = dish.recipe_ids.split(",").map(Number);
        const agg = await aggregateCanonical(this.env.DB, dish.canonical_title, recipeIds, dish.composition || "unknown");

        const r2Key = `aggregates/${dish.canonical_title.replace(/\s+/g, "_")}.json`;
        await this.env.INGEST_BUCKET.put(r2Key, JSON.stringify(agg));

        const placeholders = recipeIds.map(() => "?").join(",");
        await this.env.DB.prepare(
          `UPDATE recipe_pipeline SET stage = 'aggregated', updated_at = datetime('now') WHERE recipe_id IN (${placeholders})`
        ).bind(...recipeIds).run();

        aggregated++;
      }));
    }

    batch.dishes_affected = aggregated;
  }

  // ============================================================
  // Stage 3: Step structure generation (Haiku)
  // ============================================================

  private async runStepGeneration(batch: BatchJob) {
    if (!this.env.ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY not set — cannot generate step structures");
    }

    const dishes = await this.env.DB.prepare(`
      SELECT DISTINCT canonical_title, composition
      FROM recipe_pipeline
      WHERE stage = 'aggregated'
      GROUP BY canonical_title
    `).all<{ canonical_title: string; composition: string }>();

    // Filter out dishes that already have step structures in R2
    const needSteps: typeof dishes.results = [];
    for (const dish of dishes.results) {
      const key = `step_structures/${dish.canonical_title.replace(/\s+/g, "_")}.json`;
      const exists = await this.env.INGEST_BUCKET.head(key);
      if (!exists) needSteps.push(dish);
    }

    // Process in parallel batches of 10 (Haiku rate limit friendly)
    for (let i = 0; i < needSteps.length; i += 10) {
      const chunk = needSteps.slice(i, i + 10);
      await Promise.all(chunk.map(async (dish) => {
        try {
          await this.generateStepsForDish(dish, batch);
        } catch {
          // Skip failures, don't block the batch
        }
      }));
    }
  }

  private async generateStepsForDish(
    dish: { canonical_title: string; composition: string },
    batch: BatchJob,
  ) {
    const r2Key = `aggregates/${dish.canonical_title.replace(/\s+/g, "_")}.json`;
    const obj = await this.env.INGEST_BUCKET.get(r2Key);
    if (!obj) return;

    const agg = await obj.json() as any;
    const ingredients = agg.ingredient_groups?.[0]?.items || [];
    const ingList = ingredients.slice(0, 15).map((i: any) =>
      `- ${i.canonical_name} (${i.importance}, ${i.role})`
    ).join("\n");

    const userPrompt = `# ${dish.canonical_title} (${dish.composition})

## Ingredients:
${ingList}

## Time: ${agg.time?.total_min || 30} min total (${agg.time?.prep_min || 10} prep, ${agg.time?.cook_min || 20} cook)

Produce the canonical step structure. Use 5-8 steps. Return ONLY a JSON array.`;

    const { result, error } = await callHaiku(
      this.env.ANTHROPIC_API_KEY,
      STEP_STRUCTURE_SYSTEM,
      userPrompt,
    );

    if (error || !result) return;

    let steps: any[];
    try {
      const jsonMatch = result.match(/\[[\s\S]*\]/);
      steps = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(result);
    } catch {
      return;
    }

    const stepsKey = `step_structures/${dish.canonical_title.replace(/\s+/g, "_")}.json`;
    await this.env.INGEST_BUCKET.put(stepsKey, JSON.stringify({
      composition: dish.composition,
      steps,
    }));

    batch.cost_usd += 0.003;
  }

  // ============================================================
  // Stage 4: AI Drafting (Sonnet Batch API)
  // ============================================================

  private async runDrafting(batch: BatchJob): Promise<boolean> {
    if (!this.env.ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY not set — cannot draft");
    }

    // If we already submitted a batch, poll it
    if (batch.anthropic_batch_id) {
      return this.pollDraftBatch(batch);
    }

    // Build batch requests — parallel R2 reads, limit 50 dishes per batch
    const dishes = await this.env.DB.prepare(`
      SELECT DISTINCT canonical_title, composition
      FROM recipe_pipeline
      WHERE stage = 'aggregated'
      GROUP BY canonical_title
      LIMIT 50
    `).all<{ canonical_title: string; composition: string }>();

    if (dishes.results.length === 0) return true; // Nothing to draft

    const batchRequests: any[] = [];
    const idToTitle = new Map<string, string>();

    // Parallel R2 reads in chunks of 10
    for (let i = 0; i < dishes.results.length; i += 10) {
      const chunk = dishes.results.slice(i, i + 10);
      const results = await Promise.all(chunk.map(async (dish) => {
        const slug = dish.canonical_title.replace(/\s+/g, "_");
        const [aggObj, stepsObj] = await Promise.all([
          this.env.INGEST_BUCKET.get(`aggregates/${slug}.json`),
          this.env.INGEST_BUCKET.get(`step_structures/${slug}.json`),
        ]);
        if (!aggObj || !stepsObj) return null;
        const [agg, stepData] = await Promise.all([
          aggObj.json() as Promise<any>,
          stepsObj.json() as Promise<any>,
        ]);
        return { dish, agg, steps: stepData.steps };
      }));

      for (const r of results) {
        if (!r) continue;
        const userPrompt = buildDrafterPrompt(r.agg, r.steps);
        const customId = r.dish.canonical_title.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
        idToTitle.set(customId, r.dish.canonical_title);
        const prompt = buildDrafterPrompt(r.agg, r.steps);
        batchRequests.push({
          custom_id: customId,
          params: {
            model: "claude-sonnet-4-6",
            max_tokens: 16000,
            system: [{
              type: "text",
              text: DRAFTER_SYSTEM,
              cache_control: { type: "ephemeral" },
            }],
            messages: [{ role: "user", content: prompt }],
            tools: [{
              name: "write_recipe_draft",
              description: "Write the prose and editorial fields for a Spence canonical recipe.",
              input_schema: DRAFTER_OUTPUT_SCHEMA,
              cache_control: { type: "ephemeral" },
            }],
            tool_choice: { type: "tool", name: "write_recipe_draft" },
          },
        });
      }
    }

    if (batchRequests.length === 0) return true; // Nothing to draft

    // Store id→title mapping for result processing
    await this.ctx.storage.put("batch_id_map", Object.fromEntries(idToTitle));

    // Submit batch
    const { batch_id, error } = await createBatch(this.env.ANTHROPIC_API_KEY, batchRequests);
    if (error || !batch_id) {
      throw new Error(`Batch creation failed: ${error}`);
    }

    batch.anthropic_batch_id = batch_id;
    batch.dishes_affected = batchRequests.length;
    return false; // Not done yet — need to poll
  }

  private async pollDraftBatch(batch: BatchJob): Promise<boolean> {
    const { status, counts, error } = await pollBatch(
      this.env.ANTHROPIC_API_KEY,
      batch.anthropic_batch_id!,
    );

    if (error) throw new Error(`Batch poll failed: ${error}`);

    if (status !== "ended") {
      // Still processing — alarm will re-fire in 30s
      return false;
    }

    // Batch complete — fetch results
    const { results, error: fetchErr } = await fetchBatchResults(
      this.env.ANTHROPIC_API_KEY,
      batch.anthropic_batch_id!,
    );

    if (fetchErr) throw new Error(`Batch results fetch failed: ${fetchErr}`);

    // Load id→title mapping
    const idMap = (await this.ctx.storage.get<Record<string, string>>("batch_id_map")) || {};

    // Process each result
    for (const entry of results) {
      const title = idMap[entry.custom_id] || entry.custom_id;
      const result = entry.result;

      if (result?.type !== "succeeded") continue;

      // Extract tool_use output
      const toolBlock = result.message?.content?.find((b: any) => b.type === "tool_use");
      if (!toolBlock) continue;

      const drafted = toolBlock.input;
      const usage = result.message?.usage || {};
      const inputTokens = usage.input_tokens || 0;
      const outputTokens = usage.output_tokens || 0;
      // Batch API is 50% off
      const cost = ((inputTokens / 1_000_000) * 3.0 + (outputTokens / 1_000_000) * 15.0) * 0.5;

      // Store full draft in R2
      const r2Key = `drafts/${title.replace(/\s+/g, "_")}.json`;
      await this.env.INGEST_BUCKET.put(r2Key, JSON.stringify({
        title,
        drafted,
        usage,
        cost_usd: cost,
      }));

      // Store metadata in D1
      const stepCount = drafted.steps?.length || 0;
      const strategyCount = (drafted.steps || []).reduce(
        (sum: number, s: any) => sum + (s.strategy_overrides?.length || 0), 0
      );
      const componentCount = (drafted.ingredient_groups || []).filter(
        (g: any) => g.is_reusable
      ).length;

      await this.env.DB.prepare(`
        INSERT OR REPLACE INTO canonical_drafts
        (canonical_title, composition, step_count, strategy_count, component_count,
         draft_model, draft_cost_usd, draft_tokens_in, draft_tokens_out,
         r2_key, status, drafted_at)
        VALUES (?, ?, ?, ?, ?, 'claude-sonnet-4-6', ?, ?, ?, ?, 'draft', datetime('now'))
      `).bind(
        title,
        null, // composition filled during validation
        stepCount, strategyCount, componentCount,
        cost, inputTokens, outputTokens, r2Key,
      ).run();

      batch.cost_usd += cost;
    }

    return true; // Done
  }

  // ============================================================
  // Stage 5: Validation
  // ============================================================

  private async runValidation(batch: BatchJob) {
    const drafts = await this.env.DB.prepare(
      "SELECT canonical_title, r2_key FROM canonical_drafts WHERE status = 'draft'"
    ).all<{ canonical_title: string; r2_key: string }>();

    for (const draft of drafts.results) {
      const obj = await this.env.INGEST_BUCKET.get(draft.r2_key);
      if (!obj) continue;
      const data = await obj.json() as any;
      const d = data.drafted;

      const issues: string[] = [];

      // Check required top-level fields
      for (const field of ["description", "description_short", "steps", "ingredient_annotations",
        "ingredient_groups", "success_indicators", "troubleshooting", "pairings", "lifecycle"]) {
        if (!(field in d)) issues.push(`missing: ${field}`);
      }

      // Check lifecycle is an object
      if (d.lifecycle && typeof d.lifecycle !== "object") {
        issues.push("lifecycle must be object");
      }

      // Check step prose word counts
      for (const step of d.steps || []) {
        const wc = (step.prose || "").split(/\s+/).length;
        if (wc < 20) issues.push(`step ${step.index} prose too short (${wc}w)`);
      }

      // Check all 4 success dimensions
      const dims = new Set((d.success_indicators || []).map((si: any) => si.dimension));
      for (const dim of ["appearance", "texture", "flavor", "aroma"]) {
        if (!dims.has(dim)) issues.push(`missing success dimension: ${dim}`);
      }

      const status = issues.length === 0 ? "validated" : "draft";
      await this.env.DB.prepare(
        "UPDATE canonical_drafts SET status = ? WHERE canonical_title = ?"
      ).bind(status, draft.canonical_title).run();
    }
  }

  // ============================================================
  // Stage 6: Publishing
  // ============================================================

  private async runPublishing(batch: BatchJob) {
    const validated = await this.env.DB.prepare(
      "SELECT canonical_title, r2_key FROM canonical_drafts WHERE status = 'validated'"
    ).all<{ canonical_title: string; r2_key: string }>();

    for (const draft of validated.results) {
      const obj = await this.env.INGEST_BUCKET.get(draft.r2_key);
      if (!obj) continue;
      const data = await obj.json() as any;

      // Load aggregate for full structure
      const aggKey = `aggregates/${draft.canonical_title.replace(/\s+/g, "_")}.json`;
      const aggObj = await this.env.INGEST_BUCKET.get(aggKey);
      const agg = aggObj ? await aggObj.json() as any : {};

      // Build the full CanonicalRecipe by merging aggregate + draft
      const canonical = {
        id: draft.canonical_title.replace(/\s+/g, "-"),
        title: draft.canonical_title,
        description: data.drafted.description,
        composition: agg.composition || "unknown",
        ...agg,
        ...data.drafted,
        _internal: {
          source_recipe_ids: [],
          confidence_score: 0.8,
          corpus_count: agg.recipe_count || 0,
          last_computed: new Date().toISOString(),
          reviewed_at: null,
          reviewer: null,
          status: "ai_drafted",
        },
      };

      // Store full canonical in R2
      const canonicalKey = `canonical/${draft.canonical_title.replace(/\s+/g, "_")}.json`;
      await this.env.INGEST_BUCKET.put(canonicalKey, JSON.stringify(canonical));

      // Update D1 status
      await this.env.DB.prepare(
        "UPDATE canonical_drafts SET status = 'published', published_at = datetime('now') WHERE canonical_title = ?"
      ).bind(draft.canonical_title).run();

      // Update recipe_pipeline for all recipes in this cluster
      await this.env.DB.prepare(
        "UPDATE recipe_pipeline SET stage = 'published', updated_at = datetime('now') WHERE canonical_title = ?"
      ).bind(draft.canonical_title).run();
    }
  }
}

// ============================================================
// Prompt builder (mirrors Python ai_drafter_v2.build_user_prompt)
// ============================================================

function buildDrafterPrompt(agg: any, stepStructure: any[]): string {
  const items = agg.ingredient_groups?.[0]?.items || [];
  const core = items.filter((i: any) => i.importance === "core");
  const expected = items.filter((i: any) => i.importance === "expected");
  const optional = items.filter((i: any) => i.importance === "optional");

  const fmtIng = (i: any) => {
    const q = i.consensus_qty && i.unit ? `${i.consensus_qty} ${i.unit}` : "";
    const prep = i.prep ? `, ${i.prep}` : "";
    return `  - ${q} ${i.canonical_name}${prep} (role: ${i.role}, freq: ${i.frequency})`;
  };

  const fmtStep = (s: any) => {
    const strats = s.strategies?.length ? `\n     strategies: ${JSON.stringify(s.strategies)}` : "";
    return `Step ${s.index} [${s.phase}]: ${s.action}
     ingredients: ${JSON.stringify(s.ingredients || [])}
     params: ${JSON.stringify(s.params || {})}
     cue: ${s.cue || "none"}${strats}`;
  };

  return `# Recipe to draft: ${agg.title}

## Structured data (from corpus aggregation)

**Composition:** ${agg.composition}
**Yield:** ${agg.yield?.display || "Serves 4"}
**Time:** ${agg.time?.total_min || 30} min total (${agg.time?.prep_min || 10} prep, ${agg.time?.cook_min || 20} cook)
**Difficulty:** ${agg.difficulty?.overall || 2}/5

**Allergens:** ${agg.allergens?.contains?.join(", ") || "none"}

**Core ingredients (80%+ of source recipes):**
${core.map(fmtIng).join("\n")}

**Expected ingredients (50-79%):**
${expected.map(fmtIng).join("\n")}

**Optional/common add-ins (20-49%):**
${optional.map(fmtIng).join("\n")}

## Step structure (already canonicalized — you write the prose)

${stepStructure.map(fmtStep).join("\n\n")}

## Task
Write all the prose and editorial fields per the schema:
1. Base prose for each step + strategy_overrides for every listed strategy
2. Conditional hooks (0-3 per step)
3. Parallel task hints where applicable
4. Ingredient annotations for every core/expected ingredient
5. Ingredient groups — split into component groups where sub-components exist
6. Variation descriptions
7. Success indicators across all 4 dimensions
8. Troubleshooting (3-5 entries)
9. Pairings (4-6)
10. Lifecycle prose
11. description + description_short

Use ONLY the data above — do not invent quantities, times, or temperatures.`;
}

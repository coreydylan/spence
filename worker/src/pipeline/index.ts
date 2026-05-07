/**
 * Pipeline module — exports all pipeline components.
 *
 * Architecture:
 *   POST /ingest → D1 raw_recipes → Queue → RecipePipelineWorkflow
 *     Step 1: parse ingredients (deterministic)
 *     Step 2: normalize names (Workers AI)
 *     Step 3: classify composition (rules)
 *     → recipe moves to 'ready' stage
 *
 *   Cron (every 6h) or POST /pipeline/run → PipelineOrchestrator DO
 *     Step 4: cluster ready recipes into canonical dishes
 *     Step 5: aggregate canonical recipe structure
 *     Step 6: generate step structures (Haiku API)
 *     Step 7: draft prose (Sonnet Batch API — 50% off)
 *     Step 8: validate + publish to D1
 *
 *   GET /pipeline/status → full pipeline visibility
 */

export { RecipePipelineWorkflow } from "./recipe-workflow";
export { PipelineOrchestrator } from "./orchestrator";
export { aggregateCanonical } from "./aggregator";
export { callHaiku, callSonnet, createBatch, pollBatch, fetchBatchResults } from "./anthropic";
export { DRAFTER_SYSTEM, DRAFTER_OUTPUT_SCHEMA, STEP_STRUCTURE_SYSTEM } from "./prompts";
export type { RecipeStage, BatchStage, PipelineStatus, BatchJob, QueueMessage } from "./types";

/**
 * Handle queue messages — dispatches to workflow or batch processing.
 */
export async function handlePipelineQueue(
  batch: MessageBatch<any>,
  env: {
    DB: D1Database;
    RECIPE_PIPELINE: Workflow;
    PIPELINE_ORCHESTRATOR: DurableObjectNamespace;
  },
) {
  for (const msg of batch.messages) {
    const data = msg.body as { type: string; recipe_id?: number };

    if (data.type === "process_recipe" && data.recipe_id) {
      // Ensure pipeline record exists
      await env.DB.prepare(
        "INSERT OR IGNORE INTO recipe_pipeline (recipe_id, stage) VALUES (?, 'ingested')"
      ).bind(data.recipe_id).run();

      // Kick off the per-recipe workflow
      await env.RECIPE_PIPELINE.create({
        params: { recipe_id: data.recipe_id },
      });

      msg.ack();
    } else if (data.type === "trigger_batch") {
      // Forward to the orchestrator DO
      const id = env.PIPELINE_ORCHESTRATOR.idFromName("singleton");
      const stub = env.PIPELINE_ORCHESTRATOR.get(id);
      await stub.fetch(new Request("http://internal/run", { method: "POST" }));
      msg.ack();
    } else {
      msg.ack(); // Unknown message, don't retry
    }
  }
}

/**
 * Handle cron trigger — forwards to orchestrator DO.
 */
export async function handlePipelineCron(
  env: { PIPELINE_ORCHESTRATOR: DurableObjectNamespace },
) {
  const id = env.PIPELINE_ORCHESTRATOR.idFromName("singleton");
  const stub = env.PIPELINE_ORCHESTRATOR.get(id);
  await (stub as any).cron();
}

/**
 * Route pipeline HTTP requests.
 */
export async function handlePipelineRequest(
  path: string,
  request: Request,
  env: {
    DB: D1Database;
    PIPELINE_ORCHESTRATOR: DurableObjectNamespace;
    PIPELINE_QUEUE: Queue;
  },
): Promise<Response | null> {
  // GET /pipeline/status
  if (path === "/pipeline/status" && request.method === "GET") {
    const id = env.PIPELINE_ORCHESTRATOR.idFromName("singleton");
    const stub = env.PIPELINE_ORCHESTRATOR.get(id);
    return stub.fetch(new Request("http://internal/status"));
  }

  // POST /pipeline/run — trigger batch processing
  if (path === "/pipeline/run" && request.method === "POST") {
    const id = env.PIPELINE_ORCHESTRATOR.idFromName("singleton");
    const stub = env.PIPELINE_ORCHESTRATOR.get(id);
    return stub.fetch(new Request("http://internal/run", {
      method: "POST",
      body: request.body,
      headers: request.headers,
    }));
  }

  // POST /pipeline/toggle-auto — enable/disable auto batch processing
  if (path === "/pipeline/toggle-auto" && request.method === "POST") {
    const id = env.PIPELINE_ORCHESTRATOR.idFromName("singleton");
    const stub = env.PIPELINE_ORCHESTRATOR.get(id);
    return stub.fetch(new Request("http://internal/toggle-auto", { method: "POST" }));
  }

  // POST /pipeline/reset — reset orchestrator state (unstick after deploy)
  if (path === "/pipeline/reset" && request.method === "POST") {
    const id = env.PIPELINE_ORCHESTRATOR.idFromName("singleton");
    const stub = env.PIPELINE_ORCHESTRATOR.get(id);
    return stub.fetch(new Request("http://internal/reset", { method: "POST" }));
  }

  // POST /pipeline/reprocess — reprocess specific recipes from a stage
  if (path === "/pipeline/reprocess" && request.method === "POST") {
    const body = await request.json().catch(() => ({})) as any;
    if (body?.recipe_ids && body?.from_stage) {
      const recipeIds = body.recipe_ids as number[];
      const fromStage = body.from_stage as string;
      const placeholders = recipeIds.map(() => "?").join(",");
      await env.DB.prepare(
        `UPDATE recipe_pipeline SET stage = ?, updated_at = datetime('now') WHERE recipe_id IN (${placeholders})`
      ).bind(fromStage, ...recipeIds).run();

      for (const id of recipeIds) {
        await env.PIPELINE_QUEUE.send({ type: "process_recipe", recipe_id: id });
      }

      return Response.json({ requeued: recipeIds.length });
    }
    return Response.json({ error: "Required: recipe_ids and from_stage" }, { status: 400 });
  }

  return null; // Not a pipeline route
}

/**
 * Pipeline types — shared across workflow, DO, and queue handlers.
 */

export type RecipeStage =
  | "ingested"      // raw data received
  | "parsed"        // ingredients parsed
  | "normalized"    // ingredient names canonicalized
  | "classified"    // composition assigned
  | "ready"         // ready for batch processing
  | "clustered"     // assigned to a canonical dish cluster
  | "aggregated"    // canonical recipe aggregated
  | "drafted"       // AI prose generated
  | "validated"     // passed quality checks
  | "published";    // live in D1 for the app

export type BatchStage =
  | "idle"
  | "clustering"
  | "aggregating"
  | "generating_steps"
  | "drafting"
  | "validating"
  | "publishing"
  | "complete"
  | "error";

export interface PipelineStatus {
  total_recipes: number;
  by_stage: Record<RecipeStage, number>;
  last_batch_run: string | null;
  last_batch_stage: BatchStage;
  canonical_dishes: number;
  drafted_dishes: number;
  published_dishes: number;
  pending_normalization: number;
}

export interface BatchJob {
  id: string;
  stage: BatchStage;
  started_at: string;
  completed_at: string | null;
  recipes_affected: number;
  dishes_affected: number;
  anthropic_batch_id: string | null;
  cost_usd: number;
  error: string | null;
}

export interface QueueMessage {
  type: "process_recipe" | "trigger_batch" | "batch_poll";
  recipe_id?: number;
  batch_id?: string;
}

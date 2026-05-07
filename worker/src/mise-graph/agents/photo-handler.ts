// Wave 8B Track B — photo upload + vision pipeline.
//
// Pure helpers for the CookingLeadAgent's photo flow. The DO calls these in
// sequence:
//
//   1. storePhotoBytes(deps, args)        — write image to R2 (or D1 BLOB
//                                            fallback), return r2_key
//   2. resolveVisionPrompt(deps, args)    — task lookup + per-task prompt
//   3. callBridgeVision(env, request)     — bridge-vision.ts (already exists)
//   4. applyVisionResult(deps, args)      — write embedded SQLite rows,
//                                            update assignment iteration_note,
//                                            optionally un-complete on "redo"
//
// Each step is a pure function with all side-effect deps injected. The DO
// composes them inside an HTTP handler. The reason to split is testability:
// we can mock R2 + bridge + sql in scenarios without booting the runtime.
//
// The DO still owns:
//   * HTTP routing (POST /upload-photo etc.)
//   * authentication (token verify)
//   * embedded SQLite execution
//   * D1 event log writes (durable replay)
//   * WS broadcast
//
// We just hand it the pure pipeline pieces.

import type { TaskNode } from "../task-graph-types";
import {
	freeFormVisionPrompt,
	visionPromptFor,
	type RecipeContext,
} from "./vision-prompts";
import type {
	VisionAnalysis,
	VisionIterationAction,
	VisionResult,
} from "../bridge-vision";

// ─── R2 / blob storage abstraction ─────────────────────────────────────────
//
// In production we use Cloudflare R2. In tests we use an in-memory map. Both
// expose the same minimal `put`/`get` shape. The helper accepts whichever
// backend the caller wires in — the DO will pass `env.BRIGADE_PHOTOS` (a real
// R2 bucket) and the tests pass the mock from `test/lib/mock-r2.ts`.

export interface PhotoStorage {
	put(key: string, body: ArrayBuffer | Uint8Array, opts?: PhotoStoragePutOptions): Promise<void>;
	get(key: string): Promise<{ body: ArrayBuffer; contentType: string | null } | null>;
}

export interface PhotoStoragePutOptions {
	httpMetadata?: { contentType?: string };
	customMetadata?: Record<string, string>;
}

/**
 * Wrap a Cloudflare R2 bucket binding to match the PhotoStorage shape. R2's
 * put returns an object; we await + discard. R2's get returns an R2Object
 * with .arrayBuffer() — we materialise it before returning so the DO doesn't
 * have to know about R2 types.
 */
export function r2BucketAsStorage(bucket: R2Bucket): PhotoStorage {
	return {
		async put(key, body, opts) {
			const buf = body instanceof Uint8Array ? body : new Uint8Array(body);
			await bucket.put(key, buf, opts);
		},
		async get(key) {
			const obj = await bucket.get(key);
			if (!obj) return null;
			const body = await obj.arrayBuffer();
			const contentType = obj.httpMetadata?.contentType ?? null;
			return { body, contentType };
		},
	};
}

// ─── Photo storage step ────────────────────────────────────────────────────

export interface StorePhotoArgs {
	cook_session_id: string;
	photo_id: string;
	member_id: string;
	task_id: string | null;
	bytes: ArrayBuffer | Uint8Array;
	mime: string;
}

export interface StorePhotoResult {
	r2_key: string;
}

/**
 * Compute the R2 key for a photo + write it. The key encodes session/member/
 * photo_id so retrieval doesn't need a DB lookup. Caller still records
 * (photo_id, r2_key) in embedded SQLite for the listing path.
 */
export async function storePhotoBytes(
	storage: PhotoStorage,
	args: StorePhotoArgs,
): Promise<StorePhotoResult> {
	const r2_key = computeR2Key(args.cook_session_id, args.photo_id);
	await storage.put(r2_key, args.bytes, {
		httpMetadata: { contentType: args.mime },
		customMetadata: {
			cook_session_id: args.cook_session_id,
			member_id: args.member_id,
			...(args.task_id ? { task_id: args.task_id } : {}),
		},
	});
	return { r2_key };
}

export function computeR2Key(cook_session_id: string, photo_id: string): string {
	// Folder layout: photos/<cook_session>/<photo_id> — easy to enumerate by
	// session, no fan-out hot spots.
	return `photos/${cook_session_id}/${photo_id}`;
}

// ─── Vision prompt resolution ──────────────────────────────────────────────

export interface ResolveVisionPromptArgs {
	task: TaskNode | null;
	recipe_context: RecipeContext | null;
}

export interface ResolveVisionPromptResult {
	prompt: string;
	prompt_kind: "task" | "free_form";
}

/**
 * Pick the right prompt for an upload. Falls back to the free-form prompt
 * when no task is attached (e.g. the cook just wants to record progress).
 */
export function resolveVisionPrompt(
	args: ResolveVisionPromptArgs,
): ResolveVisionPromptResult {
	if (args.task && args.recipe_context) {
		return {
			prompt: visionPromptFor(args.task, args.recipe_context),
			prompt_kind: "task",
		};
	}
	const title = args.recipe_context?.title ?? null;
	return {
		prompt: freeFormVisionPrompt(title),
		prompt_kind: "free_form",
	};
}

// ─── Vision-result interpreter ─────────────────────────────────────────────
//
// Pure decision: given the analysis envelope, what does the DO do? Returns a
// plan that the caller mechanically applies. Splitting this from the DO lets
// us test the iteration semantics (especially the "redo" → un-complete branch)
// without an embedded SQLite engine.

export interface VisionApplyPlan {
	/**
	 * Should we update task_assignments.iteration_note? When true, the caller
	 * writes the note text. iteration_action mirrors the suggestion's action.
	 */
	update_assignment_iteration: boolean;
	iteration_note: string | null;
	iteration_action: VisionIterationAction | null;

	/**
	 * Should we un-set task_assignments.completed_at_ms (back to in-flight)?
	 * Only true when the vision suggestion's action === "redo". The caller is
	 * also responsible for *removing* the task from the completed_task_ids
	 * cache that the scheduler reads; we don't touch it here, just signal.
	 */
	uncomplete_task: boolean;

	/**
	 * Should we broadcast a `recipe_iteration_suggested` event over WS? True
	 * iff there's an iteration_suggestion at all.
	 */
	broadcast_iteration: boolean;

	/**
	 * Should we broadcast a `photo_analyzed` event (informational)? Always
	 * true — every analysis result, including "everything looks great", goes
	 * to the connected member.
	 */
	broadcast_photo_analyzed: boolean;
}

export function planVisionApply(analysis: VisionAnalysis | null): VisionApplyPlan {
	if (!analysis) {
		return {
			update_assignment_iteration: false,
			iteration_note: null,
			iteration_action: null,
			uncomplete_task: false,
			broadcast_iteration: false,
			broadcast_photo_analyzed: true,
		};
	}

	const sug = analysis.iteration_suggestion;
	if (!sug) {
		return {
			update_assignment_iteration: false,
			iteration_note: null,
			iteration_action: null,
			uncomplete_task: false,
			broadcast_iteration: false,
			broadcast_photo_analyzed: true,
		};
	}

	const note = composeIterationNote(sug.action, sug.detail, sug);
	return {
		update_assignment_iteration: true,
		iteration_note: note,
		iteration_action: sug.action,
		uncomplete_task: sug.action === "redo",
		broadcast_iteration: true,
		broadcast_photo_analyzed: true,
	};
}

function composeIterationNote(
	action: VisionIterationAction,
	detail: string,
	sug: VisionAnalysis["iteration_suggestion"],
): string {
	const parts: string[] = [];
	parts.push(`[${action}] ${detail}`.trim());
	if (sug?.ingredient_to_add) {
		parts.push(
			`add ${sug.ingredient_to_add.qty} ${sug.ingredient_to_add.unit} ${sug.ingredient_to_add.name}`,
		);
	}
	if (typeof sug?.temp_adjust_pct === "number") {
		const dir = sug.temp_adjust_pct >= 0 ? "raise" : "lower";
		parts.push(`${dir} temp ${Math.abs(sug.temp_adjust_pct)}%`);
	}
	if (typeof sug?.additional_min === "number") {
		parts.push(`+${sug.additional_min}min`);
	}
	return parts.join(" — ");
}

// ─── Vision result wrapper for SQLite serialization ────────────────────────

/**
 * Serialise a VisionResult for the embedded SQLite `vision_response_json`
 * column. Strips the raw_response (often huge) unless `include_raw=true`.
 */
export function serialiseVisionResult(
	result: VisionResult,
	options: { include_raw?: boolean } = {},
): string {
	const base: Record<string, unknown> = {
		ok: result.ok,
		analysis: result.analysis,
		cost_usd: result.cost_usd ?? null,
		elapsed_ms: result.elapsed_ms ?? null,
		error: result.error ?? null,
	};
	if (options.include_raw && result.raw_response) {
		base.raw_response = result.raw_response;
	}
	return JSON.stringify(base);
}

// Wave 8B Track B — per-task vision prompt registry.
//
// Different cook tasks need different vision evaluation criteria. A "deep
// golden sear" prompt is wrong for a "diced onion uniformity" check. This
// module owns the mapping from {task.skill, task.label} → prompt text.
//
// The prompt is sent to the vision bridge alongside the image. The bridge's
// vision model evaluates it and returns the structured envelope defined in
// `bridge-vision.ts` (on_track, observed, concerns, iteration_suggestion?).
//
// TODO(Wave 8C+): refine these prompts with examples + few-shot anchors. For
// MVP we use a single descriptive sentence per skill family. The structured
// JSON contract is enforced by the bridge daemon's system prompt — the prompts
// here describe ONLY the user-facing evaluation criteria.

import type { TaskNode } from "../task-graph-types";

export interface RecipeContext {
	title: string;
	protein?: string;
	cuisine?: string[];
	stage_hint?: string;
}

const STRUCTURE_PREAMBLE =
	"You are evaluating a photo of a cooking task in progress. Reply in the JSON envelope " +
	"the system prompt described: on_track, confidence (0..1), observed (one sentence), " +
	"concerns (array), and optionally iteration_suggestion {action, detail, …}.";

/**
 * Returns the prompt text for a given task. Combines:
 *   1. structure preamble (always the same — JSON discipline)
 *   2. skill-specific evaluation criteria
 *   3. recipe context (title, protein, etc.)
 *   4. task-specific cues (label keywords like "dice", "sear", "knead")
 *
 * The prompts are stubs — Wave 8C+ will replace each branch with curated
 * criteria pulled from the chef knowledge base. For now, the goal is just
 * "different skills get different prompts and the bridge can tell them apart".
 */
export function visionPromptFor(
	task: TaskNode,
	recipeContext: RecipeContext,
): string {
	const recipe = recipeContext.title || "this dish";
	const protein = recipeContext.protein || "the protein";
	const cuisine = recipeContext.cuisine?.join(", ") || "";
	const cuisineSuffix = cuisine ? ` (${cuisine} cuisine)` : "";
	const labelLc = task.label.toLowerCase();

	switch (task.skill) {
		case "stove_searing":
			return [
				STRUCTURE_PREAMBLE,
				`You are evaluating a sear on ${protein} for "${recipe}"${cuisineSuffix}.`,
				`Look for: deep golden-brown crust (uniform), no white/grey pale patches, ` +
					`no charred-black spots. The sear should release from the pan cleanly.`,
				`If the sear is too pale, suggest action="wait" with additional_min and a ` +
					`detail like "let it go another 90 seconds".`,
				`If the sear is too dark in patches, suggest action="adjust_temp" with ` +
					`temp_adjust_pct negative.`,
				`If the protein is dry/overcooked already, suggest action="stop_now".`,
			].join("\n");

		case "knife_basic":
		case "knife_advanced": {
			const dimension = labelLc.includes("dice")
				? "1/4 inch (medium dice) cubes"
				: labelLc.includes("brunoise")
					? "1/8 inch fine cubes"
					: labelLc.includes("mince")
						? "fine, paste-leaning consistency"
						: labelLc.includes("julienne") || labelLc.includes("matchstick")
							? "thin matchsticks ~2 inches long"
							: labelLc.includes("chiffonade")
								? "fine ribbons of leaf"
								: "uniform pieces appropriate to the task";
			return [
				STRUCTURE_PREAMBLE,
				`You are evaluating knife work for "${recipe}": ${task.label}.`,
				`Look for: ${dimension}, consistent piece size, clean cuts (no crushed ` +
					`edges or torn fibres), no oversized stragglers.`,
				`If pieces are uneven, suggest action="redo" with detail describing the size target.`,
			].join("\n");
		}

		case "stove_basic":
		case "stove_emulsion":
			return [
				STRUCTURE_PREAMBLE,
				`You are evaluating ${task.label} for "${recipe}"${cuisineSuffix}.`,
				`Look for: appropriate colour development, controlled heat (no smoking oil, ` +
					`no scorched fond), and the visual texture/sheen the recipe expects.`,
				`If you see scorching, suggest action="adjust_temp" with temp_adjust_pct ` +
					`negative. If under-developed, action="wait" with additional_min.`,
			].join("\n");

		case "oven_basic":
		case "oven_temp_control":
		case "baking":
			return [
				STRUCTURE_PREAMBLE,
				`You are evaluating bake progress for "${recipe}"${cuisineSuffix}: ${task.label}.`,
				`Look for: appropriate top colour (golden if a pastry, deep brown if a ` +
					`crusty bread), structural rise (oven spring, dome shape), set centre.`,
				`If the top is pale, action="wait" with additional_min. If the centre ` +
					`looks raw with the top already dark, action="adjust_temp" negative ` +
					`and additional_min.`,
			].join("\n");

		case "dough_handling": {
			const stage = labelLc.includes("knead")
				? "kneading"
				: labelLc.includes("shap")
					? "shaping"
					: labelLc.includes("proof") || labelLc.includes("rise")
						? "proofing"
						: labelLc.includes("mix") || task.step_idx === 0
							? "mixing"
							: "handling";
			return [
				STRUCTURE_PREAMBLE,
				`You are evaluating dough at the ${stage} stage for "${recipe}"${cuisineSuffix}.`,
				stage === "mixing"
					? `Look for: hydration consistency, no dry flour pockets, dough is ` +
						`coming together but still shaggy is OK at this stage.`
					: stage === "kneading"
						? `Look for: smooth windowpane test surface, gluten development (the ` +
							`dough should look elastic and uniform, not torn).`
						: stage === "shaping"
							? `Look for: tight surface tension, no air pockets at seams, ` +
								`uniform shape matching the recipe target.`
							: stage === "proofing"
								? `Look for: visible volume increase, smooth domed top, slight ` +
									`jiggle, no over-proofed collapse.`
								: `Look for: dough looks alive and well-handled.`,
				`If too dry, suggest action="add_ingredient" with ingredient_to_add ` +
					`{name:"water", qty:1, unit:"tbsp"}. If too wet, action="add_ingredient" ` +
					`{name:"flour", qty:1, unit:"tbsp"}.`,
			].join("\n");
		}

		case "fermentation":
			return [
				STRUCTURE_PREAMBLE,
				`You are evaluating fermentation progress for "${recipe}"${cuisineSuffix}: ${task.label}.`,
				`Look for: bubble formation (size + density), dome shape on the surface, ` +
					`visible volume increase, no off colours or fuzzy growths.`,
				`If under-fermented, suggest action="wait" with additional_min. If ` +
					`signs of contamination or wild yeast off-colour, action="stop_now".`,
			].join("\n");

		case "fryer":
			return [
				STRUCTURE_PREAMBLE,
				`You are evaluating frying progress for "${recipe}"${cuisineSuffix}: ${task.label}.`,
				`Look for: uniform deep-golden colour, no greasy/oil-laden look (means ` +
					`oil too cold), no charred dark patches (oil too hot), pieces floating ` +
					`(typically means done for batter-fried items).`,
				`If pale and oily, action="adjust_temp" positive. If dark or scorching, ` +
					`action="adjust_temp" negative.`,
			].join("\n");

		case "supervision_only":
			return [
				STRUCTURE_PREAMBLE,
				`You are evaluating "${task.label}" for "${recipe}". This is a passive ` +
					`watch task — the cook just wants to confirm the visual state.`,
				`Look for: anything obviously wrong (off colours, surprising volume change, ` +
					`leaks, mess). If everything looks normal, on_track=true with no concerns.`,
			].join("\n");

		default:
			return [
				STRUCTURE_PREAMBLE,
				`You are evaluating "${task.label}" for the recipe "${recipe}"${cuisineSuffix}.`,
				`Look for visual cues that the task is well-executed and complete: ` +
					`uniform appearance, no obvious mistakes, the texture/colour the recipe ` +
					`describes for this step.`,
				`If something looks off, suggest the most appropriate iteration_suggestion ` +
					`action.`,
			].join("\n");
	}
}

/**
 * Lightweight helper for the upload-photo flow when no task is attached
 * (free-form snapshot). The prompt is generic — vision still returns the
 * envelope but `iteration_suggestion` is unlikely.
 */
export function freeFormVisionPrompt(recipeTitle: string | null): string {
	const recipe = recipeTitle || "the in-progress dish";
	return [
		STRUCTURE_PREAMBLE,
		`You are evaluating a free-form progress photo of ${recipe}.`,
		"Describe what you see in `observed`. Flag any obvious problems in " +
			"`concerns`. Skip iteration_suggestion unless a problem is present.",
	].join("\n");
}

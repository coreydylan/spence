// U69 — Vision prompt registry: per-skill differentiation.
//
// `visionPromptFor(task, ctx)` is a pure function that returns the prompt
// the bridge sends to the vision model. Each skill family must yield a
// distinct prompt — otherwise the model loses the task-specific evaluation
// criteria.
//
// We assert:
//   1. Every skill kind we care about returns a prompt that mentions
//      a skill-specific cue (e.g. "sear" for stove_searing).
//   2. The prompts include the recipe title when supplied.
//   3. The structure preamble is consistent across all prompts (so the
//      bridge's JSON-discipline system prompt is always reinforced).
//   4. The default branch handles unknown labels without throwing.

import type { Scenario } from "../lib/types";
import {
	freeFormVisionPrompt,
	visionPromptFor,
	type RecipeContext,
} from "../../src/mise-graph/agents/vision-prompts";
import type { TaskNode, SkillKind } from "../../src/mise-graph/task-graph-types";

function makeTask(skill: SkillKind, label: string, step_idx = 0): TaskNode {
	return {
		id: `t_${skill}`,
		recipe_id: "r_u69",
		step_idx,
		kind: "prep",
		label,
		skill,
		skill_floor: 0.5,
		equipment: [],
		ingredients_in: [],
		produces: "x",
		active_min: 5,
		passive_min: 0,
		parallelizable: true,
		depends_on: [],
	};
}

const PREAMBLE_FRAGMENT = "JSON envelope";

const u69: Scenario = {
	id: "u69",
	name: "Vision prompt registry: per-skill prompt differentiation",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const recipe: RecipeContext = {
			title: "Spicy Bavette Steak",
			protein: "bavette",
			cuisine: ["french"],
		};

		// 1. Per-skill prompts include skill-specific cues.
		const cases: Array<{ skill: SkillKind; label: string; cue: string; tag: string }> = [
			{ skill: "stove_searing", label: "sear bavette", cue: "sear", tag: "searing" },
			{ skill: "knife_basic", label: "dice shallot", cue: "dice", tag: "knife_basic" },
			{ skill: "knife_advanced", label: "brunoise carrot", cue: "1/8 inch", tag: "knife_advanced" },
			{ skill: "stove_basic", label: "sweat aromatics", cue: "colour development", tag: "stove_basic" },
			{ skill: "stove_emulsion", label: "monter au beurre", cue: "colour development", tag: "stove_emulsion" },
			{ skill: "oven_basic", label: "roast carrots", cue: "bake", tag: "oven_basic" },
			{ skill: "baking", label: "bake bread", cue: "bake", tag: "baking" },
			{ skill: "dough_handling", label: "knead dough", cue: "windowpane", tag: "dough_handling" },
			{ skill: "fermentation", label: "watch ferment", cue: "bubble", tag: "fermentation" },
			{ skill: "fryer", label: "fry chicken", cue: "deep-golden", tag: "fryer" },
			{ skill: "supervision_only", label: "watch the proof", cue: "watch task", tag: "supervision_only" },
		];

		for (const c of cases) {
			const prompt = visionPromptFor(makeTask(c.skill, c.label), recipe);
			ctx.assert.contains(
				prompt,
				PREAMBLE_FRAGMENT,
				`${c.tag}: prompt has structure preamble`,
			);
			ctx.assert.contains(prompt, c.cue, `${c.tag}: prompt mentions "${c.cue}"`);
		}

		// 2. Recipe title flows through.
		const stovePrompt = visionPromptFor(makeTask("stove_searing", "sear protein"), recipe);
		ctx.assert.contains(stovePrompt, "Spicy Bavette Steak", "recipe title in prompt");
		ctx.assert.contains(stovePrompt, "bavette", "protein hint surfaced");
		ctx.assert.contains(stovePrompt, "french", "cuisine surfaced");

		// 3. Each prompt is unique (cross-skill check — knife vs sear).
		const searPrompt = visionPromptFor(makeTask("stove_searing", "sear protein"), recipe);
		const dicePrompt = visionPromptFor(makeTask("knife_basic", "dice onion"), recipe);
		ctx.assert.notEq(searPrompt, dicePrompt, "sear and dice prompts differ");
		const dicePrompt2 = visionPromptFor(makeTask("knife_basic", "dice carrot"), recipe);
		// Same skill + similar label → still consistent (deterministic).
		ctx.assert.eq(
			dicePrompt.replace("dice onion", "dice carrot"),
			dicePrompt2,
			"deterministic over label change",
		);

		// 4. Knife sub-types differentiate (dice vs brunoise vs julienne).
		const brunoise = visionPromptFor(makeTask("knife_advanced", "brunoise carrot"), recipe);
		const julienne = visionPromptFor(makeTask("knife_advanced", "julienne leek"), recipe);
		ctx.assert.contains(brunoise, "1/8", "brunoise mentions 1/8 inch");
		ctx.assert.contains(julienne, "matchstick", "julienne mentions matchstick");
		ctx.assert.notEq(brunoise, julienne, "brunoise vs julienne prompts differ");

		// 5. Dough sub-stages: kneading vs proofing differ.
		const knead = visionPromptFor(makeTask("dough_handling", "knead the dough"), recipe);
		const proof = visionPromptFor(makeTask("dough_handling", "proof the dough"), recipe);
		ctx.assert.contains(knead, "windowpane", "kneading prompt");
		ctx.assert.contains(proof, "volume", "proofing prompt mentions volume");
		ctx.assert.notEq(knead, proof, "knead vs proof prompts differ");

		// 6. Default branch handles unknown labels without throwing.
		// (A test by construction — TS prevents creating an unknown skill,
		// so we exercise the default path via supervision_only on a weird
		// label and ensure the function doesn't blow up.)
		const weird = visionPromptFor(makeTask("supervision_only", "watch the chia bloom"), recipe);
		ctx.assert.contains(weird, PREAMBLE_FRAGMENT, "weird label prompt has preamble");

		// 7. freeFormVisionPrompt fallback.
		const ff = freeFormVisionPrompt(null);
		ctx.assert.contains(ff, "in-progress dish", "free-form fallback wording");
		const ffNamed = freeFormVisionPrompt("Sunday Cassoulet");
		ctx.assert.contains(ffNamed, "Sunday Cassoulet", "free-form interpolates title");

		// 8. recipe_context optional fields don't crash.
		const noProtein = visionPromptFor(makeTask("stove_searing", "sear"), { title: "X" });
		ctx.assert.contains(noProtein, "the protein", "missing protein → fallback");
		const noCuisine = visionPromptFor(makeTask("baking", "bake"), { title: "X" });
		ctx.assert.contains(noCuisine, "X", "no cuisine still works");
	},
};

export default u69;

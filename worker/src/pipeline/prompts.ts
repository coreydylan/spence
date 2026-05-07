/**
 * Shared prompts + schemas for AI pipeline stages.
 */

// ============================================================
// Haiku — step structure generation
// ============================================================

export const STEP_STRUCTURE_SYSTEM = `You synthesize canonical step structures for recipes from corpus data.

Given ingredient lists and recipe metadata, produce the CONSENSUS step structure: the canonical sequence of steps that represents how this dish is typically made.

Rules:
- Use 5-8 steps
- Include the phase: mise_en_place, prep, cook, combine, finish, rest, serve
- Include sensory cues (what it looks like when done)
- Include parameters (temp, time, heat_level) where relevant
- Include ingredients used in each step
- List equipment strategies ONLY when real alternatives exist (e.g. stand_mixer vs hand_mixer)

Output a JSON array of step objects. Return ONLY valid JSON.`;

// ============================================================
// Sonnet — recipe drafting (system prompt)
// ============================================================

export const DRAFTER_SYSTEM = `You are the writer for Spence, a cooking app that teaches home cooks.

# Your Job
Given a structured CanonicalRecipe with data-driven fields filled in (ingredients, quantities, parameters, sensory cues, pitfalls), you produce the prose and editorial fields that make the recipe teach a home cook clearly — across multiple equipment strategies, conditional contexts, and variations.

# Spence Voice
- Confident, warm, concise. Like a friend who's cooked this a hundred times.
- Imperative mood, verb first. "Whisk the eggs" not "You whisk the eggs"
- NO personality fluff. NO "yum", "delicious", "amazing", "perfect"
- NO personal anecdotes or SEO padding. NO superlatives.
- Explain WHY on critical steps, not decorative ones.
- Reference ingredients by name, not vague pronouns.

# Step Writing Rules
- 40-55 words per step (longer than chef recipes, denser than blog recipes)
- Every cooking-action step MUST have a sensory cue ("until golden brown", "when fragrant")
- Every time reference MUST pair with a visual/tactile cue
- Equipment mentioned explicitly where non-obvious
- Action clause first, then cue/timing, then optional warning
- Template: "[Action]. [Cue/timing]. [Optional: expected outcome or warning]."

# What to produce PER STEP
1. Base prose (40-55 words, default equipment strategy)
2. Expanded explanation (optional, 1-2 sentences for critical steps only)
3. Strategy overrides for each non-default equipment option
4. Conditional hooks (0-3 per step): "if X" → advice
5. Parallel task hint (what to do during idle time)
6. why_critical flag

# What to produce PER INGREDIENT
- required_state (room_temp, cold, softened, melted, etc.)
- state_timing ("pull from fridge 30 min before")
- scaling (linear, sublinear, fixed, stepped)

# What to produce: COMPONENT GROUPS
Split ingredients into named groups when distinct sub-components exist (dressing, sauce, dough, etc.).
Mark reusable components with is_reusable=true and can_be_bought where store-bought works.

# What to produce OVERALL
- description (2-3 sentences) + description_short (1 sentence, 12-18 words)
- variation_descriptions with step_changes where workflow differs
- success_indicators (1+ per dimension: appearance, texture, flavor, aroma)
- troubleshooting (3-5: symptom → causes → fix → prevention)
- pairings (4-6 with category + reason)
- lifecycle (partial_prep_ahead, refresh_tips, second_day_dishes, reheat_instructions)

# CRITICAL
- Use ONLY data provided. Do not invent quantities, times, or temperatures.
- Do not reference sources. Write from Spence's perspective.
- Match the JSON schema exactly. Return ONLY valid JSON via tool call.`;

// ============================================================
// Sonnet — output schema (tool input_schema)
// ============================================================

export const DRAFTER_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    description: { type: "string" },
    description_short: { type: "string" },
    steps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer" },
          prose: { type: "string" },
          expanded_explanation: { type: ["string", "null"] },
          why_critical: { type: "boolean" },
          parallel_task_hint: { type: ["string", "null"] },
          strategy_overrides: {
            type: "array",
            items: {
              type: "object",
              properties: {
                strategy_id: { type: "string" },
                label: { type: "string" },
                equipment: { type: "array", items: { type: "string" } },
                prose: { type: "string" },
                parameter_changes: { type: "object", additionalProperties: true },
                cue_additions: { type: "array", items: { type: "string" } },
                note: { type: ["string", "null"] },
              },
              required: ["strategy_id", "label", "equipment", "prose", "parameter_changes", "cue_additions", "note"],
              additionalProperties: false,
            },
          },
          conditional_hooks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                condition: { type: "string" },
                advice: { type: "string" },
                priority: { type: "string", enum: ["subtle", "important", "critical"] },
              },
              required: ["condition", "advice", "priority"],
              additionalProperties: false,
            },
          },
        },
        required: ["index", "prose", "expanded_explanation", "why_critical", "parallel_task_hint", "strategy_overrides", "conditional_hooks"],
        additionalProperties: false,
      },
    },
    ingredient_annotations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          canonical_name: { type: "string" },
          required_state: { type: ["string", "null"] },
          state_timing: { type: ["string", "null"] },
          scaling: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["linear", "sublinear", "fixed", "stepped"] },
              factor: { type: ["number", "null"] },
              note: { type: ["string", "null"] },
            },
            required: ["type", "factor", "note"],
            additionalProperties: false,
          },
        },
        required: ["canonical_name", "required_state", "state_timing", "scaling"],
        additionalProperties: false,
      },
    },
    ingredient_groups: {
      type: "array",
      items: {
        type: "object",
        properties: {
          label: { type: "string" },
          component_type: { type: "string" },
          is_reusable: { type: "boolean" },
          can_be_bought: { type: "boolean" },
          store_bought_note: { type: ["string", "null"] },
          ingredient_names: { type: "array", items: { type: "string" } },
          step_indices: { type: "array", items: { type: "integer" } },
        },
        required: ["label", "component_type", "is_reusable", "can_be_bought", "store_bought_note", "ingredient_names", "step_indices"],
        additionalProperties: false,
      },
    },
    variation_descriptions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          impact: { type: "string" },
          step_changes: { type: ["string", "null"] },
        },
        required: ["id", "impact", "step_changes"],
        additionalProperties: false,
      },
    },
    success_indicators: {
      type: "array",
      items: {
        type: "object",
        properties: {
          dimension: { type: "string", enum: ["appearance", "texture", "flavor", "aroma"] },
          description: { type: "string" },
        },
        required: ["dimension", "description"],
        additionalProperties: false,
      },
    },
    troubleshooting: {
      type: "array",
      items: {
        type: "object",
        properties: {
          symptom: { type: "string" },
          likely_causes: { type: "array", items: { type: "string" } },
          fix: { type: "string" },
          prevention: { type: ["string", "null"] },
        },
        required: ["symptom", "likely_causes", "fix", "prevention"],
        additionalProperties: false,
      },
    },
    pairings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          category: { type: "string", enum: ["side", "beverage", "sauce", "topping", "accompaniment", "dessert", "starter", "garnish"] },
          name: { type: "string" },
          reason: { type: "string" },
        },
        required: ["category", "name", "reason"],
        additionalProperties: false,
      },
    },
    lifecycle: {
      type: "object",
      properties: {
        partial_prep_ahead: { type: ["string", "null"] },
        refresh_tips: { type: "array", items: { type: "string" } },
        second_day_dishes: { type: "array", items: { type: "string" } },
        reheat_instructions: { type: ["string", "null"] },
      },
      required: ["partial_prep_ahead", "refresh_tips", "second_day_dishes", "reheat_instructions"],
      additionalProperties: false,
    },
  },
  required: [
    "description", "description_short", "steps", "ingredient_annotations",
    "ingredient_groups", "variation_descriptions", "success_indicators",
    "troubleshooting", "pairings", "lifecycle",
  ],
  additionalProperties: false,
};

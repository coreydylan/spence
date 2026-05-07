/**
 * Structural validator for CanonicalRecipe objects.
 * Returns pass/fail + list of specific issues.
 */

import type { CanonicalRecipe, CanonicalStep } from "../types/canonical";

export interface ValidationIssue {
  severity: "error" | "warning";
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  error_count: number;
  warning_count: number;
}

const VALID_COMPOSITIONS = new Set([
  "baked_good", "soup", "pasta", "curry", "salad", "bowl",
  "stir_fry", "pizza", "sandwich", "taco", "casserole",
  "dip", "drink", "eggs", "component", "dessert",
  "preserve", "snack",
]);

const VALID_PHASES = new Set([
  "mise_en_place", "prep", "cook", "combine",
  "finish", "rest", "serve",
]);

const VALID_ROLES = new Set([
  "protein", "base", "vegetable", "fruit", "dairy", "fat",
  "seasoning", "herb", "sauce", "sweetener", "leavener",
  "acid", "nut", "liquid", "thickener", "grain", "legume",
]);

const COOKING_ACTION_VERBS = new Set([
  "bake", "roast", "simmer", "boil", "fry", "sauté", "saute",
  "sear", "braise", "steam", "cook", "broil", "grill", "toast",
  "brown", "caramelize", "reduce", "thicken", "knead", "proof",
]);

export function validateCanonicalRecipe(r: CanonicalRecipe): ValidationResult {
  const issues: ValidationIssue[] = [];

  const err = (path: string, message: string) =>
    issues.push({ severity: "error", path, message });
  const warn = (path: string, message: string) =>
    issues.push({ severity: "warning", path, message });

  // === Required fields ===
  if (!r.id) err("id", "Required");
  if (!r.title || r.title.length < 2) err("title", "Required, min 2 chars");
  if (!r.composition) err("composition", "Required");
  if (r.composition && !VALID_COMPOSITIONS.has(r.composition)) {
    err("composition", `Invalid: ${r.composition}`);
  }

  // === Component consistency ===
  if (r.is_component && !r.component_role) {
    err("component_role", "Required when is_component=true");
  }
  if (r.is_component && r.composition !== "component") {
    warn("composition", "is_component=true but composition is not 'component'");
  }

  // === Yield ===
  if (!r.yield) {
    err("yield", "Required");
  } else {
    if (typeof r.yield.canonical_amount !== "number" || r.yield.canonical_amount <= 0) {
      err("yield.canonical_amount", "Must be a positive number");
    }
    if (!r.yield.canonical_unit) {
      err("yield.canonical_unit", "Required");
    }
    if (!r.yield.display) {
      warn("yield.display", "Human-readable display string is recommended");
    }
    // Components should have transformation info when applicable
    if (r.is_component && r.yield.input_amount === null && r.yield.transformation_ratio === null) {
      warn("yield.transformation_ratio", "Components often benefit from transformation_ratio (e.g., 1 cup raw → 2 cups cooked)");
    }
  }

  // === Time ===
  if (!r.time) {
    err("time", "Required");
  } else {
    const { prep_min, cook_min, active_min, idle_min, total_min } = r.time;
    if (total_min < 0) err("time.total_min", "Must be >= 0");
    if (active_min < 0) err("time.active_min", "Must be >= 0");
    if (active_min > total_min) {
      warn("time.active_min", "active_min > total_min (probably wrong)");
    }
  }

  // === Ingredients ===
  if (!r.ingredient_groups || r.ingredient_groups.length === 0) {
    err("ingredient_groups", "At least one ingredient group required");
  } else {
    let hasCore = false;
    const allIngredientNames = new Set<string>();
    r.ingredient_groups.forEach((group, gi) => {
      if (!group.label) err(`ingredient_groups[${gi}].label`, "Required");
      // If has component_ref, items can be empty
      if (group.component_ref) {
        if (group.items && group.items.length > 0) {
          warn(`ingredient_groups[${gi}]`, "Has both component_ref AND inline items");
        }
      } else {
        if (!group.items || group.items.length === 0) {
          err(`ingredient_groups[${gi}].items`, "Required when no component_ref");
        }
        group.items?.forEach((ing, ii) => {
          if (!ing.canonical_name) err(`ingredient_groups[${gi}].items[${ii}].canonical_name`, "Required");
          if (!ing.role) err(`ingredient_groups[${gi}].items[${ii}].role`, "Required");
          if (ing.role && !VALID_ROLES.has(ing.role)) {
            err(`ingredient_groups[${gi}].items[${ii}].role`, `Invalid role: ${ing.role}`);
          }
          if (ing.importance === "core") hasCore = true;
          if (typeof ing.frequency !== "number" || ing.frequency < 0 || ing.frequency > 1) {
            warn(`ingredient_groups[${gi}].items[${ii}].frequency`, "Should be 0-1");
          }
          allIngredientNames.add(ing.canonical_name);
        });
      }
    });
    if (!hasCore && r.ingredient_groups.some(g => !g.component_ref)) {
      warn("ingredient_groups", "No ingredient marked as 'core' importance");
    }

    // === Step ingredient refs resolve ===
    const checkSteps = (steps: CanonicalStep[], pathPrefix: string) => {
      steps.forEach((step, si) => {
        step.ingredient_refs?.forEach(ref => {
          if (!allIngredientNames.has(ref) && !group_component_refs(r).has(ref)) {
            warn(`${pathPrefix}[${si}].ingredient_refs`, `Reference '${ref}' not in ingredient_groups`);
          }
        });
      });
    };
    if (r.steps?.length) checkSteps(r.steps, "steps");
    r.method_variants?.forEach((mv, mi) => {
      if (mv.steps?.length) checkSteps(mv.steps, `method_variants[${mi}].steps`);
    });
  }

  // === Steps ===
  // If method variants have their own steps, use those. Otherwise use top-level steps.
  const methodVariantsWithSteps = r.method_variants?.filter(mv => mv.steps?.length > 0) || [];
  const stepSources = methodVariantsWithSteps.length > 0
    ? methodVariantsWithSteps.map(mv => ({ steps: mv.steps, label: `method_variants[${mv.id}]` }))
    : [{ steps: r.steps || [], label: "steps" }];

  stepSources.forEach(({ steps, label }) => {
    if (!steps || steps.length < 2) {
      err(label, "At least 2 steps required");
      return;
    }

    // First step should be mise_en_place or prep
    if (steps[0].phase !== "mise_en_place" && steps[0].phase !== "prep") {
      warn(`${label}[0].phase`, `First step should be mise_en_place or prep, got '${steps[0].phase}'`);
    }

    // Last step should be serve/finish/rest
    const lastPhase = steps[steps.length - 1].phase;
    if (!["serve", "finish", "rest"].includes(lastPhase)) {
      warn(`${label}[${steps.length - 1}].phase`, `Last step should be serve/finish/rest, got '${lastPhase}'`);
    }

    steps.forEach((step, si) => {
      const stepPath = `${label}[${si}]`;

      if (step.phase && !VALID_PHASES.has(step.phase)) {
        err(`${stepPath}.phase`, `Invalid phase: ${step.phase}`);
      }

      if (!step.primary_action?.verb) {
        err(`${stepPath}.primary_action.verb`, "Required");
      }

      if (!step.prose) {
        err(`${stepPath}.prose`, "Required");
      }

      // Cooking-action steps need completion signal OR sensory cue
      const verb = step.primary_action?.verb?.toLowerCase() || "";
      if (COOKING_ACTION_VERBS.has(verb)) {
        const hasCue = step.sensory_cues?.length > 0;
        const hasSignal = !!step.completion_signal;
        const hasTime = !!step.parameters?.time;
        if (!hasCue && !hasSignal && !hasTime) {
          warn(`${stepPath}`, `Cooking action '${verb}' has no sensory cues, completion signal, or time`);
        }
      }

      // Pitfall refs (non-empty check)
      if (step.why_critical && (!step.pitfall_refs || step.pitfall_refs.length === 0) && !step.causal_rule_ref) {
        warn(`${stepPath}`, "Marked why_critical=true but has no pitfall_refs or causal_rule_ref");
      }
    });
  });

  // === Method variants ===
  if (r.method_variants?.length) {
    const defaultMethods = r.method_variants.filter(m => m.is_default);
    if (defaultMethods.length === 0) {
      err("method_variants", "No method variant marked as is_default=true");
    } else if (defaultMethods.length > 1) {
      err("method_variants", "Multiple method variants marked as is_default");
    }
    if (r.default_method && !r.method_variants.find(m => m.id === r.default_method)) {
      err("default_method", `'${r.default_method}' not found in method_variants`);
    }
  }

  // === Equipment ===
  if (!r.equipment) {
    warn("equipment", "Equipment spec is recommended");
  } else {
    r.equipment.full_inventory?.forEach((item, i) => {
      if (!item.item) err(`equipment.full_inventory[${i}].item`, "Required");
      if (typeof item.count !== "number" || item.count < 1) {
        err(`equipment.full_inventory[${i}].count`, "Must be >= 1");
      }
    });
  }

  // === Variations ===
  r.variations?.forEach((v, vi) => {
    if (!v.id) err(`variations[${vi}].id`, "Required");
    if (!v.label) err(`variations[${vi}].label`, "Required");
  });

  const error_count = issues.filter(i => i.severity === "error").length;
  const warning_count = issues.filter(i => i.severity === "warning").length;

  return {
    valid: error_count === 0,
    issues,
    error_count,
    warning_count,
  };
}

function group_component_refs(r: CanonicalRecipe): Set<string> {
  const s = new Set<string>();
  r.ingredient_groups?.forEach(g => {
    if (g.component_ref) s.add(g.component_ref);
  });
  return s;
}

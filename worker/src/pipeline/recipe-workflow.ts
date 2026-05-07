/**
 * RecipePipeline Workflow
 *
 * Processes a single raw recipe through: parse → normalize → classify.
 * Triggered by queue message when a new recipe is ingested.
 *
 * Each step is independently retryable. State persists across steps
 * via Cloudflare Workflows durable execution.
 */

import {
  WorkflowEntrypoint,
  WorkflowStep,
  WorkflowEvent,
} from "cloudflare:workers";

interface Env {
  DB: D1Database;
  AI: Ai;
  PIPELINE_QUEUE: Queue;
}

interface RecipeWorkflowParams {
  recipe_id: number;
}

// ============================================================
// Ingredient parsing (deterministic — no AI)
// ============================================================

interface ParsedIngredient {
  raw_text: string;
  quantity: number | null;
  unit: string | null;
  name: string;
  prep: string | null;
  group_name: string | null;
  sort_order: number;
}

const UNIT_PATTERN = /^(\d+\/\d+|\d+\.?\d*)\s*(cups?|tbsp|tsp|tablespoons?|teaspoons?|oz|ounces?|lbs?|pounds?|g|grams?|kg|ml|liters?|quarts?|pints?|gallons?|sticks?|cloves?|heads?|bunche?s?|cans?|packages?|bags?|slices?|pieces?|pinche?s?|dashe?s?|sprigs?|stalks?|inches?|medium|large|small|whole)\.?\s*/i;

const PREP_WORDS = /\b(chopped|diced|minced|sliced|grated|shredded|crushed|melted|softened|room temperature|cold|warm|hot|frozen|thawed|drained|rinsed|peeled|seeded|pitted|trimmed|halved|quartered|cubed|julienned|chiffonade|torn|crumbled)\b/gi;

function parseIngredientLine(raw: string, sortOrder: number, groupName: string | null): ParsedIngredient {
  let text = raw.trim();

  // Extract quantity
  let quantity: number | null = null;
  let unit: string | null = null;

  const unitMatch = text.match(UNIT_PATTERN);
  if (unitMatch) {
    const qStr = unitMatch[1];
    if (qStr.includes("/")) {
      const [num, den] = qStr.split("/");
      quantity = parseInt(num) / parseInt(den);
    } else {
      quantity = parseFloat(qStr);
    }
    unit = unitMatch[2]?.toLowerCase() || null;
    text = text.slice(unitMatch[0].length).trim();
  }

  // Extract prep instructions
  const preps: string[] = [];
  let name = text.replace(PREP_WORDS, (match) => {
    preps.push(match.toLowerCase());
    return "";
  }).replace(/,\s*,/g, ",").replace(/^\s*,|,\s*$/g, "").trim();

  // Clean up parenthetical notes
  name = name.replace(/\s*\([^)]*\)\s*/g, " ").trim();
  // Remove trailing commas/spaces
  name = name.replace(/[,\s]+$/, "").trim();

  return {
    raw_text: raw,
    quantity,
    unit,
    name: name || raw,
    prep: preps.length > 0 ? preps.join(", ") : null,
    group_name: groupName,
    sort_order: sortOrder,
  };
}

function parseIngredients(rawIngredients: string[], ingredientGroups: string[]): ParsedIngredient[] {
  const results: ParsedIngredient[] = [];
  let currentGroup: string | null = null;
  let groupIndex = 0;

  // If we have group labels, map them to ingredient sections
  // Groups are section headers that appear in order
  const groupBoundaries = ingredientGroups.length > 0 ? [...ingredientGroups] : [];

  for (let i = 0; i < rawIngredients.length; i++) {
    const line = rawIngredients[i]?.trim();
    if (!line) continue;

    // Check if this line matches a group header
    if (groupBoundaries.length > 0 && groupIndex < groupBoundaries.length) {
      const nextGroup = groupBoundaries[groupIndex];
      if (line.toLowerCase().includes(nextGroup.toLowerCase().replace(/[:\s]+$/, ""))) {
        currentGroup = nextGroup;
        groupIndex++;
        continue;
      }
    }

    results.push(parseIngredientLine(line, i, currentGroup));
  }

  return results;
}


// ============================================================
// Ingredient normalization (Workers AI)
// ============================================================

async function normalizeIngredients(
  parsed: ParsedIngredient[],
  ai: Ai,
  db: D1Database,
): Promise<Map<string, string>> {
  const nameMap = new Map<string, string>();

  // Check existing normalization map first
  const names = [...new Set(parsed.map((p) => p.name.toLowerCase()))];
  const placeholders = names.map(() => "?").join(",");
  const existing = await db
    .prepare(`SELECT raw_name, canonical_name FROM normalization_map WHERE raw_name IN (${placeholders})`)
    .bind(...names)
    .all<{ raw_name: string; canonical_name: string }>();

  for (const row of existing.results) {
    nameMap.set(row.raw_name, row.canonical_name);
  }

  // Find names that need normalization
  const needNorm = names.filter((n) => !nameMap.has(n));
  if (needNorm.length === 0) return nameMap;

  // Batch normalize via Workers AI
  const prompt = `Normalize these ingredient names to their canonical form. Return JSON array of objects with "raw" and "canonical" fields. Use lowercase, singular form, no brand names.

Ingredients:
${needNorm.map((n) => `- ${n}`).join("\n")}

Return ONLY valid JSON.`;

  try {
    const result = await ai.run("@cf/meta/llama-3.1-8b-instruct" as any, {
      messages: [{ role: "user", content: prompt }],
      max_tokens: 1024,
    }) as any;

    const text = result.response || "";
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const mappings = JSON.parse(jsonMatch[0]) as Array<{ raw: string; canonical: string }>;
      const stmts: D1PreparedStatement[] = [];
      for (const m of mappings) {
        const raw = m.raw?.toLowerCase().trim();
        const canonical = m.canonical?.toLowerCase().trim();
        if (raw && canonical) {
          nameMap.set(raw, canonical);
          stmts.push(
            db.prepare("INSERT OR REPLACE INTO normalization_map (raw_name, canonical_name, normalized_by) VALUES (?, ?, 'workers_ai')")
              .bind(raw, canonical)
          );
        }
      }
      if (stmts.length > 0) {
        await db.batch(stmts);
      }
    }
  } catch (e) {
    // Fall through — use raw names as canonical
    for (const n of needNorm) {
      nameMap.set(n, n);
    }
  }

  return nameMap;
}


// ============================================================
// Composition classification (rule-based)
// ============================================================

const COMPOSITION_RULES: Array<{ pattern: RegExp; composition: string }> = [
  { pattern: /\b(cookie|brownie|blondie|bar)\b/i, composition: "baked_good" },
  { pattern: /\b(cake|cupcake|muffin|scone|biscuit)\b/i, composition: "baked_good" },
  { pattern: /\b(bread|loaf|roll|bun|focaccia)\b/i, composition: "baked_good" },
  { pattern: /\b(pie|tart|galette|quiche)\b/i, composition: "baked_good" },
  { pattern: /\b(soup|chowder|bisque|stew|chili)\b/i, composition: "soup" },
  { pattern: /\b(pasta|spaghetti|linguine|penne|fettuccine|noodle|mac and cheese|lasagna)\b/i, composition: "pasta" },
  { pattern: /\b(curry|tikka|masala|korma|vindaloo)\b/i, composition: "curry" },
  { pattern: /\b(salad)\b/i, composition: "salad" },
  { pattern: /\b(bowl|buddha|grain bowl|poke)\b/i, composition: "bowl" },
  { pattern: /\b(stir.?fry|fried rice|lo mein)\b/i, composition: "stir_fry" },
  { pattern: /\b(pizza|flatbread)\b/i, composition: "pizza" },
  { pattern: /\b(sandwich|burger|wrap|panini|sub)\b/i, composition: "sandwich" },
  { pattern: /\b(taco|burrito|enchilada|quesadilla|tostada)\b/i, composition: "taco" },
  { pattern: /\b(casserole|gratin|bake)\b/i, composition: "casserole" },
  { pattern: /\b(dip|hummus|guacamole|salsa)\b/i, composition: "dip" },
  { pattern: /\b(smoothie|latte|juice|cocktail|drink|punch)\b/i, composition: "drink" },
  { pattern: /\b(scrambled|omelet|frittata|egg)\b/i, composition: "eggs" },
  { pattern: /\b(ice cream|pudding|mousse|panna cotta|tiramisu)\b/i, composition: "dessert" },
  { pattern: /\b(jam|pickle|preserve|ferment|kimchi|sauerkraut)\b/i, composition: "preserve" },
  { pattern: /\b(granola|chips|popcorn|crackers|nuts)\b/i, composition: "snack" },
  // Components detected by structural signals
  { pattern: /\b(sauce|dressing|vinaigrette|pesto|frosting|glaze|marinade|rub|broth|stock)\b/i, composition: "component" },
  { pattern: /\b(rice|quinoa|couscous|polenta|mashed potato)\b/i, composition: "component" },
];

function classifyComposition(title: string): string {
  for (const rule of COMPOSITION_RULES) {
    if (rule.pattern.test(title)) {
      return rule.composition;
    }
  }
  return "unknown";
}


// ============================================================
// Workflow definition
// ============================================================

export class RecipePipelineWorkflow extends WorkflowEntrypoint<Env, RecipeWorkflowParams> {
  async run(event: WorkflowEvent<RecipeWorkflowParams>, step: WorkflowStep) {
    const { recipe_id } = event.payload;

    // Step 1: Load raw recipe
    const raw = await step.do("load-recipe", async () => {
      const row = await this.env.DB.prepare(
        "SELECT id, title, raw_ingredients, ingredient_groups FROM raw_recipes WHERE id = ?"
      ).bind(recipe_id).first<{
        id: number;
        title: string;
        raw_ingredients: string;
        ingredient_groups: string;
      }>();

      if (!row) throw new Error(`Recipe ${recipe_id} not found`);
      return row;
    });

    // Step 2: Parse ingredients
    const parsed = await step.do("parse-ingredients", async () => {
      const rawIngs: string[] = JSON.parse(raw.raw_ingredients || "[]");
      const groups: string[] = JSON.parse(raw.ingredient_groups || "[]");
      const results = parseIngredients(rawIngs, groups);

      // Write to D1
      const stmts = results.map((p) =>
        this.env.DB.prepare(
          `INSERT OR REPLACE INTO parsed_ingredients
           (raw_recipe_id, sort_order, raw_text, quantity, unit, name, prep, group_name)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(recipe_id, p.sort_order, p.raw_text, p.quantity, p.unit, p.name, p.prep, p.group_name)
      );

      stmts.push(
        this.env.DB.prepare(
          "UPDATE recipe_pipeline SET stage = 'parsed', parse_status = 'done', updated_at = datetime('now') WHERE recipe_id = ?"
        ).bind(recipe_id)
      );

      await this.env.DB.batch(stmts);
      return results;
    });

    // Step 3: Normalize ingredient names
    await step.do("normalize-ingredients", async () => {
      const nameMap = await normalizeIngredients(parsed, this.env.AI, this.env.DB);

      // Update parsed_ingredients with canonical names
      const stmts = parsed.map((p) => {
        const canonical = nameMap.get(p.name.toLowerCase()) || p.name.toLowerCase();
        return this.env.DB.prepare(
          "UPDATE parsed_ingredients SET canonical_name = ? WHERE raw_recipe_id = ? AND sort_order = ?"
        ).bind(canonical, recipe_id, p.sort_order);
      });

      stmts.push(
        this.env.DB.prepare(
          "UPDATE recipe_pipeline SET stage = 'normalized', normalize_status = 'done', updated_at = datetime('now') WHERE recipe_id = ?"
        ).bind(recipe_id)
      );

      await this.env.DB.batch(stmts);
    });

    // Step 4: Classify composition
    await step.do("classify-composition", async () => {
      const composition = classifyComposition(raw.title);

      await this.env.DB.prepare(
        "UPDATE recipe_pipeline SET stage = 'ready', classify_status = 'done', composition = ?, updated_at = datetime('now') WHERE recipe_id = ?"
      ).bind(composition, recipe_id);
    });
  }
}

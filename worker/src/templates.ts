/**
 * Composition templates — variant sets for each composition type.
 * Mined from the recipe corpus by cuisine fingerprint.
 */

import type { Card } from "./cards";

interface Slot {
  name: string;
  required: boolean;
  min: number;
  max: number;
}

interface VariantIngredient {
  name: string;
  frequency: number;
  count: number;
}

interface VariantSet {
  cuisine: string;
  label: string;
  recipe_count: number;
  slots: Record<string, VariantIngredient[]>;
}

interface CompositionTemplate {
  slots: Slot[];
  variant_sets: VariantSet[];
}

// Embedded composition templates (mined from data)
// In production this would come from D1, but for now it's baked in
let cardIdCounter = 10000;
function nextId(prefix: string): string {
  return `${prefix}_${++cardIdCounter}_${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Build a card stream for a composition builder template.
 * User picks "Bowl" → gets this stream with slots + variant set carousel.
 */
export function buildCompositionTemplateStream(
  compositionName: string,
  template: CompositionTemplate,
): Card[] {
  const stream: Card[] = [];

  // Title (empty, user will fill)
  stream.push({
    id: nextId("title"),
    type: "title",
    content: { title: "" },
    lock: "user",
    source: "user",
    binding: "identity.title",
    meta: { editable: true },
  });

  // Composition header
  stream.push({
    id: nextId("comp_header"),
    type: "composition_header" as any,
    content: {
      composition: compositionName,
      description: describeComposition(compositionName, template.slots),
    },
    lock: "inferred",
    source: "canonical",
    meta: { editable: false },
  });

  // Variant set carousel — full cultural presets
  if (template.variant_sets.length > 0) {
    stream.push({
      id: nextId("variants"),
      type: "variant_set_carousel" as any,
      content: {
        active_index: 0,
        sets: template.variant_sets.map((vs) => ({
          label: vs.label,
          cuisine: vs.cuisine,
          recipe_count: vs.recipe_count,
          slots: vs.slots,
        })),
      },
      lock: "inferred",
      source: "canonical",
      meta: { editable: true },
    });
  }

  // Individual slot cards — use first variant set as initial fill
  const initialSet = template.variant_sets[0];
  for (const slot of template.slots) {
    const slotIngredients = initialSet?.slots[slot.name] || [];

    // Build variant list for this slot — pull from ALL variant sets
    const variants: any[] = [];
    for (const vs of template.variant_sets) {
      const ings = vs.slots[slot.name] || [];
      if (ings.length > 0) {
        variants.push({
          cuisine: vs.cuisine,
          label: vs.label,
          ingredients: ings,
        });
      }
    }

    if (slot.max === 1) {
      // Single-item slot
      stream.push({
        id: nextId("slot"),
        type: "slot" as any,
        content: {
          slot_name: slot.name,
          required: slot.required,
          active_variant_index: 0,
          variants,
          current: slotIngredients.slice(0, 1),
          pinned: false,
        },
        lock: "inferred",
        source: "canonical",
        binding: `slots.${slot.name}`,
        meta: { editable: true },
      });
    } else {
      // Multi-item slot (vegetables, finish)
      stream.push({
        id: nextId("multislot"),
        type: "multi_slot" as any,
        content: {
          slot_name: slot.name,
          required: slot.required,
          min_items: slot.min,
          max_items: slot.max,
          current_items: slotIngredients.slice(0, slot.max),
          variants,
          suggested_additions: [],
        },
        lock: "inferred",
        source: "canonical",
        binding: `slots.${slot.name}`,
        meta: { editable: true },
      });
    }
  }

  // Yield placeholder
  stream.push({
    id: nextId("yield"),
    type: "yield",
    content: { unit: "serves", amount: 4 },
    lock: "user",
    source: "user",
    binding: "structure.yield",
  });

  return stream;
}

function describeComposition(name: string, slots: Slot[]): string {
  const slotNames = slots.map(s => s.name).join(", ");
  const descriptions: Record<string, string> = {
    bowl: "A base, a protein, vegetables, sauce, and a finish.",
    pasta: "Pasta, sauce, and toppings.",
    curry: "A protein or vegetable in a spiced sauce.",
    salad: "Greens, vegetables, protein, and a dressing.",
    stir_fry: "Protein and vegetables in a quick-cooking sauce.",
    taco: "A shell, a filling, and toppings.",
    soup: "A liquid base with vegetables, protein, and seasoning.",
  };
  return descriptions[name] || `Build with: ${slotNames}`;
}

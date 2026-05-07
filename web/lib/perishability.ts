/**
 * Perishability classifier.
 *
 * Maps an ingredient name to a tier:
 *   Tier 1 — use within 48h (delicate produce, fresh herbs, ripe fruit, fresh fish)
 *   Tier 2 — use within ~5 days (most produce, dairy, opened condiments)
 *   Tier 3 — pantry stable (dry goods, canned, oils, frozen)
 *
 * The lookup is intentionally simple: lowercase the name, run substring
 * matchers, return the first hit. Name canonicalization in the worker is
 * already aggressive enough that "asparagus", "asparagus tips", and "fresh
 * asparagus" all land on `asparagus`.
 *
 * If nothing matches we default to Tier 2 — the safe middle that says "treat
 * this like fresh produce until proven otherwise". The caller can override
 * with explicit `expires_at` from the inventory row when present.
 */

export type PerishTierId = 1 | 2 | 3;

export interface PerishTier {
  id: PerishTierId;
  label: string;
  blurb: string;
  /** Token name for accents — `amber` (Tier 1), `terracotta` (Tier 2), `sage` (Tier 3). */
  accent: "amber" | "terracotta" | "sage";
  /** Approximate shelf life in days from acquisition. */
  approx_days: number;
}

export const PERISH_TIERS: Record<PerishTierId, PerishTier> = {
  1: {
    id: 1,
    label: "Tier 1 — use within 48h",
    blurb: "Eat first.",
    accent: "amber",
    approx_days: 2,
  },
  2: {
    id: 2,
    label: "Tier 2 — use within 5 days",
    blurb: "Plan around these next.",
    accent: "terracotta",
    approx_days: 5,
  },
  3: {
    id: 3,
    label: "Tier 3 — pantry stable",
    blurb: "Long-shelf staples.",
    accent: "sage",
    approx_days: 90,
  },
};

const TIER_1_KEYWORDS = [
  "arugula",
  "asparagus",
  "avocado",
  "basil",
  "berries",
  "blueberry",
  "blueberries",
  "raspberry",
  "raspberries",
  "strawberry",
  "strawberries",
  "blackberry",
  "blackberries",
  "cilantro",
  "chive",
  "chives",
  "dill",
  "fish",
  "salmon",
  "tuna",
  "trout",
  "shrimp",
  "scallop",
  "scallops",
  "mussel",
  "oyster",
  "mint",
  "parsley",
  "spinach",
  "watercress",
  "tarragon",
  "ground meat",
  "ground beef",
  "ground pork",
  "ground turkey",
  "ground chicken",
  "ground lamb",
  "raw chicken",
  "raw beef",
  "raw pork",
  "fresh pasta",
  "thai basil",
  "delicate greens",
  "lettuce",
  "butter lettuce",
  "spring mix",
  "microgreens",
  "raw oyster",
];

const TIER_3_KEYWORDS = [
  "rice",
  "jasmine rice",
  "basmati",
  "brown rice",
  "pasta",
  "spaghetti",
  "penne",
  "rigatoni",
  "quinoa",
  "couscous",
  "barley",
  "farro",
  "lentil",
  "lentils",
  "bean",
  "beans",
  "chickpea",
  "chickpeas",
  "black bean",
  "kidney bean",
  "canned",
  "olive oil",
  "vegetable oil",
  "sesame oil",
  "coconut oil",
  "vinegar",
  "soy sauce",
  "fish sauce",
  "tamari",
  "miso",
  "honey",
  "maple syrup",
  "sugar",
  "salt",
  "pepper",
  "spice",
  "spices",
  "cumin",
  "coriander",
  "paprika",
  "turmeric",
  "cinnamon",
  "flour",
  "cornmeal",
  "polenta",
  "oats",
  "nuts",
  "almond",
  "almonds",
  "walnut",
  "walnuts",
  "cashew",
  "cashews",
  "peanut",
  "peanuts",
  "pistachio",
  "pistachios",
  "seed",
  "seeds",
  "chia",
  "flax",
  "sesame",
  "tahini",
  "peanut butter",
  "almond butter",
  "tomato paste",
  "tomato sauce",
  "stock",
  "broth",
  "tea",
  "coffee",
  "frozen",
  "raisin",
  "raisins",
  "dried fruit",
  "dried apricot",
  "dried apricots",
  "dried cranberry",
  "harissa",
  "calabrian chili",
  "chili paste",
  "curry paste",
  "olive",
  "olives",
];

/**
 * Classify an ingredient name into a perishability tier.
 * Case-insensitive substring match.
 */
export function classifyPerishTier(name: string): PerishTierId {
  if (!name) return 2;
  const n = name.toLowerCase().trim();
  for (const k of TIER_1_KEYWORDS) {
    if (n.includes(k)) return 1;
  }
  for (const k of TIER_3_KEYWORDS) {
    if (n.includes(k)) return 3;
  }
  return 2;
}

/** Get full tier metadata for a tier id. */
export function getTier(id: PerishTierId): PerishTier {
  return PERISH_TIERS[id];
}

/**
 * If the inventory row carries an explicit `expires_at`, prefer that to
 * recompute the tier dynamically. Items expiring within 48h are Tier 1
 * regardless of name.
 */
export function classifyWithExpiry(
  name: string,
  expires_at: string | null | undefined,
  now: Date = new Date(),
): PerishTierId {
  if (expires_at) {
    const exp = new Date(expires_at).getTime();
    if (Number.isFinite(exp)) {
      const days = (exp - now.getTime()) / (1000 * 60 * 60 * 24);
      if (days <= 2) return 1;
      if (days <= 5) return 2;
    }
  }
  return classifyPerishTier(name);
}

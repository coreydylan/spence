import { headers } from "next/headers";
import { getSessionFromHeaders } from "@/lib/auth";
import { mcp, type McpContext } from "@/lib/mcp";
import { classifyPerishTier, type PerishTierId } from "@/lib/perishability";
import { PerishTierSection } from "./components/perish-tier";
import { PantryItemRow } from "./components/pantry-item-row";
import { PantryQuickAdd } from "./components/pantry-quick-add";

export const dynamic = "force-dynamic";

interface ClassifiedItem {
  name: string;
  qty: number | null;
  unit: string | null;
  category: string;
  tier: PerishTierId;
  expiringSoon: boolean;
}

/**
 * /pantry — inventory grouped by perishability tier (1/2/3).
 *
 * Source: `inspire_read_household_signals.pantry_top` is the only public
 * read into the kitchen inventory today (returns name lists grouped by
 * category). We classify each name into a tier via name-based heuristics
 * in `lib/perishability.ts`. When a kitchen-inventory MCP tool ships, swap
 * the data source — the rest of the page is structured around `Item[]`.
 */
export default async function PantryPage() {
  const session = await getSessionFromHeaders(await headers());
  const ctx: McpContext = {
    household_id: session.household_id,
    caller_kind: "human",
    caller_id: "spence-web-pantry",
  };

  const signals = await mcp(
    "inspire_read_household_signals",
    { household_id: session.household_id },
    ctx,
  ).catch(() => null);

  const items: ClassifiedItem[] = [];
  for (const section of signals?.pantry_top ?? []) {
    for (const raw of section.items ?? []) {
      const name = (raw ?? "").toString().trim();
      if (!name) continue;
      const { qty, unit, label } = parseNameAndQty(name);
      const tier = classifyPerishTier(label);
      items.push({
        name: label,
        qty,
        unit,
        category: section.category,
        tier,
        expiringSoon: tier === 1,
      });
    }
  }

  // Roll-up duplicates within a tier (same lowercase label).
  const byTier: Record<PerishTierId, Map<string, ClassifiedItem>> = {
    1: new Map(),
    2: new Map(),
    3: new Map(),
  };
  for (const it of items) {
    const key = it.name.toLowerCase();
    const existing = byTier[it.tier].get(key);
    if (existing) {
      // increment qty (count) when both have numeric qty
      if (existing.qty != null && it.qty != null && existing.unit === it.unit) {
        existing.qty += it.qty;
      } else if (existing.qty == null && it.qty != null) {
        existing.qty = it.qty;
        existing.unit = it.unit;
      }
    } else {
      byTier[it.tier].set(key, { ...it });
    }
  }

  const tier1 = Array.from(byTier[1].values()).sort(byName);
  const tier2 = Array.from(byTier[2].values()).sort(byName);
  const tier3 = Array.from(byTier[3].values()).sort(byName);

  const totalCount = items.length;

  return (
    <>
      <header className="px-1">
        <h1 className="font-serif text-4xl text-ink tracking-tight">Pantry</h1>
        <p className="text-ink-soft mt-1">
          {totalCount} {totalCount === 1 ? "item" : "items"}
        </p>
      </header>

      <div className="mt-6">
        <PantryQuickAdd />
      </div>

      <div className="mt-8">
        {tier1.length > 0 && (
          <PerishTierSection tier={1} count={tier1.length}>
            {tier1.map((it) => (
              <PantryItemRow
                key={`t1:${it.name}`}
                name={it.name}
                qty={it.qty}
                unit={it.unit}
                tier={1}
                expiringSoon={it.expiringSoon}
              />
            ))}
          </PerishTierSection>
        )}

        {tier2.length > 0 && (
          <PerishTierSection tier={2} count={tier2.length}>
            {tier2.map((it) => (
              <PantryItemRow
                key={`t2:${it.name}`}
                name={it.name}
                qty={it.qty}
                unit={it.unit}
                tier={2}
              />
            ))}
          </PerishTierSection>
        )}

        {tier3.length > 0 && (
          <PerishTierSection tier={3} count={tier3.length}>
            {tier3.map((it) => (
              <PantryItemRow
                key={`t3:${it.name}`}
                name={it.name}
                qty={it.qty}
                unit={it.unit}
                tier={3}
              />
            ))}
          </PerishTierSection>
        )}

        {totalCount === 0 && (
          <div className="mt-12 text-center text-ink-soft px-6">
            <p>Nothing in the pantry yet.</p>
            <p className="text-sm mt-1">Add an item above, or paste a list during onboarding.</p>
          </div>
        )}
      </div>
    </>
  );
}

function byName(a: { name: string }, b: { name: string }) {
  return a.name.localeCompare(b.name);
}

/**
 * Parse strings like "asparagus", "asparagus 700g", "feta (300g)", "tofu ×2"
 * into structured {label, qty, unit}. Defensive — falls back to {label} when
 * parsing fails.
 */
function parseNameAndQty(raw: string): {
  label: string;
  qty: number | null;
  unit: string | null;
} {
  // Patterns: "name 300g", "name 2 cups", "name (×2)", "name x2"
  const xMatch = raw.match(/^(.+?)\s*[(\s][×x]\s*(\d+)\)?\s*$/i);
  if (xMatch) {
    return { label: xMatch[1].trim(), qty: Number(xMatch[2]), unit: null };
  }
  const trailing = raw.match(/^(.+?)\s+(\d+(?:\.\d+)?)\s*([a-zA-Z]{1,8})$/);
  if (trailing) {
    return {
      label: trailing[1].trim(),
      qty: Number(trailing[2]),
      unit: trailing[3].toLowerCase(),
    };
  }
  return { label: raw.trim(), qty: null, unit: null };
}

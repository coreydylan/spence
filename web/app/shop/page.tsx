import { headers } from "next/headers";
import { getSessionFromHeaders } from "@/lib/auth";
import { mcp, type McpContext } from "@/lib/mcp";
import { EmptyShop } from "./components/empty-shop";
import { ShopRunsClient, type ShopRunWithSections } from "./components/shop-runs-client";

export const dynamic = "force-dynamic";

/**
 * /shop — shopping list grouped by shop_run, then by category.
 *
 * Pulls the active plan via plan_list (first one), then plan_read_shop_runs
 * + plan_read_shopping_list. Items are bucketed into runs by category — each
 * run lists which categories belong to it.
 */
export default async function ShopPage() {
  const session = await getSessionFromHeaders(await headers());
  const ctx: McpContext = {
    household_id: session.household_id,
    caller_kind: "human",
    caller_id: "spence-web-shop",
  };

  // Find an active plan for this household.
  let planId: string | null = null;
  try {
    const list = await mcp("plan_list", { household_id: session.household_id }, ctx);
    planId = list.plans[0]?.plan_id ?? null;
  } catch {
    planId = null;
  }

  if (!planId) {
    return (
      <>
        <PageHeader subtitle="Plan a few dinners and the list builds itself." />
        <EmptyShop reason="no_plan" />
      </>
    );
  }

  // Pull both in parallel — same plan, no dependency.
  const [shopRunsRes, shoppingListRes] = await Promise.all([
    mcp("plan_read_shop_runs", { plan_id: planId }, ctx).catch(() => null),
    mcp("plan_read_shopping_list", { plan_id: planId }, ctx).catch(() => null),
  ]);

  const runs = shopRunsRes?.shop_runs ?? [];
  const sections = shoppingListRes?.sections ?? [];

  if (runs.length === 0 || sections.length === 0) {
    return (
      <>
        <PageHeader subtitle="Nothing to pick up just now." />
        <EmptyShop />
      </>
    );
  }

  // Bucket sections into runs based on `categories` membership.
  const sectionByCategory = new Map(sections.map((s) => [s.category, s]));
  const enrichedRuns: ShopRunWithSections[] = runs
    .map((run) => {
      const runSections = run.categories
        .map((c) => sectionByCategory.get(c))
        .filter((s): s is (typeof sections)[number] => Boolean(s));
      const totalItems = runSections.reduce((acc, s) => acc + s.items.length, 0);
      return {
        id: run.id,
        date: run.date,
        label: run.label,
        itemCount: totalItems > 0 ? totalItems : run.item_count,
        sections: runSections,
      };
    })
    .filter((r) => r.sections.length > 0);

  // Fall-back: if no run claims any sections (legacy plans), bundle all into a single virtual run.
  if (enrichedRuns.length === 0) {
    const totalItems = sections.reduce((acc, s) => acc + s.items.length, 0);
    enrichedRuns.push({
      id: `${planId}:all`,
      date: runs[0]?.date ?? "",
      label: "This week",
      itemCount: totalItems,
      sections,
    });
  }

  const totalItems = enrichedRuns.reduce((acc, r) => acc + r.itemCount, 0);
  const subtitle = `${totalItems} ${totalItems === 1 ? "item" : "items"} across ${enrichedRuns.length} ${enrichedRuns.length === 1 ? "run" : "runs"}`;

  return (
    <>
      <PageHeader subtitle={subtitle} />
      <div className="mt-6">
        <ShopRunsClient runs={enrichedRuns} />
      </div>
    </>
  );
}

function PageHeader({ subtitle }: { subtitle: string }) {
  return (
    <header className="px-1">
      <h1 className="font-serif text-4xl text-ink tracking-tight">This week</h1>
      <p className="text-ink-soft mt-1">{subtitle}</p>
    </header>
  );
}

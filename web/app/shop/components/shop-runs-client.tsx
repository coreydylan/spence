"use client";

import * as React from "react";
import { ShopRunTabs, type ShopRunTab } from "./shop-run-tabs";
import { CategorySection } from "./category-section";

export interface ShopRunWithSections {
  id: string;
  date: string;
  label: string;
  itemCount: number;
  sections: Array<{
    category: string;
    items: Array<{ name: string; quantity: number | null; unit: string | null }>;
  }>;
}

interface Props {
  runs: ShopRunWithSections[];
}

/**
 * Client island: holds the active run id, renders the tab strip + the
 * sections for the active run. Server-rendered data is passed in once.
 */
export function ShopRunsClient({ runs }: Props) {
  const [activeId, setActiveId] = React.useState(runs[0]?.id ?? "");
  const active = runs.find((r) => r.id === activeId) ?? runs[0];

  const tabs: ShopRunTab[] = runs.map((r) => ({
    id: r.id,
    label: r.label,
    date: r.date,
    itemCount: r.itemCount,
  }));

  return (
    <div className="flex flex-col gap-4">
      <ShopRunTabs runs={tabs} activeId={active?.id ?? ""} onSelect={setActiveId} />
      <div>
        {active?.sections.length ? (
          active.sections.map((s) => (
            <CategorySection
              key={`${active.id}:${s.category}`}
              shopRunId={active.id}
              category={s.category}
              items={s.items}
            />
          ))
        ) : (
          <p className="text-ink-soft text-sm px-3 py-4">
            Nothing in this run.
          </p>
        )}
      </div>
    </div>
  );
}

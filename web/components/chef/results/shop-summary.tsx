import Link from "next/link";
import { Card, CardContent } from "@/components/primitives/card";
import { Badge } from "@/components/primitives/badge";

interface ShopSummaryProps {
  sections: Array<{
    category: string;
    items: Array<{ name: string; quantity?: number | null; unit?: string | null }>;
  }>;
  runs?: Array<{ id: string; date: string; label: string; item_count: number }>;
}

/**
 * Inline summary of a shopping list when the agent calls
 * `plan_read_shopping_list` mid-chat. Shows category counts + a link to /shop.
 */
export function ShopSummary({ sections, runs }: ShopSummaryProps) {
  const total = sections.reduce((acc, s) => acc + (s.items?.length ?? 0), 0);
  return (
    <Card>
      <CardContent className="p-4 flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h4 className="font-serif text-lg text-ink tracking-tight">
            Shopping list
          </h4>
          <Badge tone="terracotta">{total}</Badge>
        </div>
        <ul className="flex flex-wrap gap-1.5">
          {sections.map((s) => (
            <li key={s.category}>
              <span className="inline-flex items-center gap-1 rounded-[var(--radius-full)] bg-cream-deep px-2.5 py-0.5 text-xs">
                <span className="text-ink-soft">{humanize(s.category)}</span>
                <span className="font-mono text-ink">{s.items.length}</span>
              </span>
            </li>
          ))}
        </ul>
        {runs && runs.length > 0 && (
          <p className="text-xs text-ink-soft">
            {runs.length} {runs.length === 1 ? "shop run" : "shop runs"}
          </p>
        )}
        <Link
          href="/shop"
          className="text-sm text-terracotta underline underline-offset-4 mt-1"
        >
          Open list →
        </Link>
      </CardContent>
    </Card>
  );
}

function humanize(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

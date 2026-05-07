import Link from "next/link";
import { Card, CardContent } from "@/components/primitives/card";
import { Badge } from "@/components/primitives/badge";

interface PantrySummaryProps {
  items: Array<{ category: string; items: string[] }>;
}

/**
 * Inline pantry summary — category chips with item counts, plus a deep link
 * into /pantry for the full tier breakdown.
 */
export function PantrySummary({ items }: PantrySummaryProps) {
  const total = items.reduce((acc, s) => acc + (s.items?.length ?? 0), 0);
  return (
    <Card>
      <CardContent className="p-4 flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h4 className="font-serif text-lg text-ink tracking-tight">
            Pantry
          </h4>
          <Badge tone="sage">{total}</Badge>
        </div>
        <ul className="flex flex-wrap gap-1.5">
          {items.map((s) => (
            <li key={s.category}>
              <span className="inline-flex items-center gap-1 rounded-[var(--radius-full)] bg-cream-deep px-2.5 py-0.5 text-xs">
                <span className="text-ink-soft">{humanize(s.category)}</span>
                <span className="font-mono text-ink">{s.items.length}</span>
              </span>
            </li>
          ))}
        </ul>
        <Link
          href="/pantry"
          className="text-sm text-terracotta underline underline-offset-4 mt-1"
        >
          Open pantry →
        </Link>
      </CardContent>
    </Card>
  );
}

function humanize(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

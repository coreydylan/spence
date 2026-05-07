import Link from "next/link";
import { Card, CardContent } from "@/components/primitives/card";
import { Badge } from "@/components/primitives/badge";
import type { TraitSpread } from "@/lib/mcp";

interface Props {
  spreads: TraitSpread[];
}

/**
 * Inline summary of household trait spread — leads with diverging traits,
 * collapsing the rest into a soft footer count.
 */
export function TraitSpreadSummary({ spreads }: Props) {
  const diverging = spreads.filter((s) => s.status === "diverging");
  const aligned = spreads.filter((s) => s.status === "aligned");

  return (
    <Card>
      <CardContent className="p-4 flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h4 className="font-serif text-lg text-ink tracking-tight">
            Trait spread
          </h4>
          {diverging.length > 0 ? (
            <Badge tone="amber">{diverging.length} diverging</Badge>
          ) : (
            <Badge tone="sage">aligned</Badge>
          )}
        </div>

        {diverging.length > 0 ? (
          <ul className="space-y-1.5 text-sm">
            {diverging.slice(0, 3).map((s) => (
              <li key={s.trait_name} className="text-ink leading-relaxed">
                {s.description}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-ink-soft">
            Everyone&apos;s pulling in the same direction.
          </p>
        )}

        <p className="text-xs text-ink-soft">
          {aligned.length} aligned · {diverging.length} diverging ·{" "}
          {spreads.length - aligned.length - diverging.length} uncalibrated
        </p>

        <Link
          href="/members"
          className="text-sm text-terracotta underline underline-offset-4 mt-1"
        >
          Open household →
        </Link>
      </CardContent>
    </Card>
  );
}

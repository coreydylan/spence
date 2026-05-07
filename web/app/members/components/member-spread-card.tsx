import { Card, CardContent } from "@/components/primitives/card";
import { Badge } from "@/components/primitives/badge";
import type { TraitSpread } from "@/lib/mcp";

interface Props {
  spreads: TraitSpread[];
}

/**
 * Surfaces traits where the household members visibly diverge. The worker's
 * `getHouseholdTraitSpread` already labels each spread `aligned | diverging
 * | uncalibrated` and gives us a human-readable description — we just pick
 * the diverging ones and surface them.
 *
 * If nothing is diverging, the card collapses to a soft "everyone's on the
 * same page" state.
 */
export function MemberSpreadCard({ spreads }: Props) {
  const diverging = spreads.filter((s) => s.status === "diverging");

  if (diverging.length === 0) {
    return (
      <Card variant="muted">
        <CardContent className="p-5">
          <h3 className="font-serif text-xl text-ink tracking-tight">
            Aligned across the board
          </h3>
          <p className="text-ink-soft text-sm mt-1.5">
            Nobody&apos;s pulling the household in different directions right
            now. Spence will plan toward the shared center.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="p-5 flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <h3 className="font-serif text-xl text-ink tracking-tight">
            Diverging traits in this household
          </h3>
          <Badge tone="amber">{diverging.length}</Badge>
        </div>
        <ul className="space-y-3">
          {diverging.map((s) => (
            <li
              key={s.trait_name}
              className="flex flex-col gap-1.5 border-t border-ink/5 pt-3 first:border-0 first:pt-0"
            >
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs text-ink-soft">
                  {s.trait_name.replace(/_/g, " ")}
                </span>
                <span className="font-mono text-xs text-amber tabular-nums">
                  Δ {s.divergence.toFixed(2)}
                </span>
              </div>
              <p className="text-sm text-ink leading-relaxed">{s.description}</p>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

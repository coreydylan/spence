import Link from "next/link";
import { Card, CardContent } from "@/components/primitives/card";
import type { HouseholdMember } from "@/lib/mcp";

interface Props {
  members: HouseholdMember[];
}

/**
 * Compact household roster — one line per member with name + age group.
 * Tap → /members.
 */
export function MemberSummary({ members }: Props) {
  return (
    <Card>
      <CardContent className="p-4 flex flex-col gap-2">
        <h4 className="font-serif text-lg text-ink tracking-tight">
          Household
        </h4>
        <ul className="space-y-1">
          {members.map((m) => (
            <li key={m.member_id} className="flex items-center gap-2 text-sm">
              <span className="h-6 w-6 shrink-0 rounded-full bg-terracotta text-cream flex items-center justify-center text-xs font-medium">
                {(m.display_name || "?").slice(0, 1).toUpperCase()}
              </span>
              <span className="text-ink">{m.display_name}</span>
              <span className="text-ink-soft">
                · {m.age_group}
                {m.dietary?.length ? ` · ${m.dietary.slice(0, 2).join(", ")}` : ""}
              </span>
            </li>
          ))}
        </ul>
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

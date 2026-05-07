import Link from "next/link";
import { Card, CardContent } from "@/components/primitives/card";
import { Badge } from "@/components/primitives/badge";
import { TraitBar } from "./trait-bar";
import type { HouseholdMember, MemberTraitView, TraitSpread } from "@/lib/mcp";

interface Props {
  member: HouseholdMember;
  /** Optional trait spread, scoped to this member only. */
  traitSpreads?: TraitSpread[];
  /** Whether to wrap the card in a link to /members/[member_id]. */
  linkToDetail?: boolean;
}

/**
 * Roster card. Big circle avatar (initials), name, age-group/dietary chips,
 * and a small inline list of trait readings sourced from the household
 * trait_spread (filtered to this member).
 */
export function MemberCard({ member, traitSpreads, linkToDetail = true }: Props) {
  const initial = (member.display_name || "?").trim().slice(0, 1).toUpperCase();
  const ageDietLine = [
    member.age_group,
    ...((member.dietary || []).slice(0, 3)),
  ]
    .filter(Boolean)
    .join(" · ");

  // Pull this member's view from each spread; only show ones that have a row for them.
  const myTraits = (traitSpreads ?? [])
    .map<{ name: string; reading: MemberTraitView | undefined }>((s) => ({
      name: s.trait_name,
      reading: s.member_values.find((m) => m.member_id === member.member_id),
    }))
    .filter(
      (x): x is { name: string; reading: MemberTraitView } => Boolean(x.reading),
    )
    .slice(0, 3);

  const inner = (
    <Card variant="default">
      <CardContent className="p-5 flex flex-col gap-4">
        <div className="flex items-center gap-4">
          <div className="h-12 w-12 shrink-0 rounded-full bg-terracotta text-cream flex items-center justify-center font-serif text-xl">
            {initial}
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="font-serif text-2xl text-ink leading-tight tracking-tight truncate">
              {member.display_name}
            </h3>
            {ageDietLine && (
              <p className="text-sm text-ink-soft mt-0.5 truncate">
                {ageDietLine}
              </p>
            )}
          </div>
          {member.skills.length > 0 && (
            <Badge tone="sage">
              {member.skills.length}{" "}
              {member.skills.length === 1 ? "skill" : "skills"}
            </Badge>
          )}
        </div>

        {myTraits.length > 0 && (
          <div className="space-y-2">
            <div className="text-xs font-medium text-ink-soft uppercase tracking-wide">
              Trait spread
            </div>
            {myTraits.map(({ name, reading }) => (
              <TraitBar
                key={name}
                name={name}
                value={reading.value}
                confidence={reading.confidence}
                compact
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );

  return linkToDetail ? (
    <Link
      href={`/members/${encodeURIComponent(member.member_id)}`}
      className="block hover:opacity-95 transition-opacity"
    >
      {inner}
    </Link>
  ) : (
    inner
  );
}

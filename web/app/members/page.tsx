import { headers } from "next/headers";
import { getSessionFromHeaders } from "@/lib/auth";
import { mcp, type McpContext } from "@/lib/mcp";
import { MemberCard } from "./components/member-card";
import { MemberSpreadCard } from "./components/member-spread-card";
import { Card, CardContent } from "@/components/primitives/card";

export const dynamic = "force-dynamic";

/**
 * /members — household roster.
 *
 * Pulls all members + the multi-member trait spread, then renders one
 * `MemberCard` per person and a final `MemberSpreadCard` summarizing
 * divergence across the household.
 */
export default async function MembersPage() {
  const session = await getSessionFromHeaders(await headers());
  const ctx: McpContext = {
    household_id: session.household_id,
    caller_kind: "human",
    caller_id: "spence-web-members",
  };

  const [memberRes, spreadRes] = await Promise.all([
    mcp("member_list", { household_id: session.household_id }, ctx).catch(() => null),
    mcp(
      "household_get_trait_spread",
      { household_id: session.household_id },
      ctx,
    ).catch(() => null),
  ]);

  const members = memberRes?.members ?? [];
  const spreads = spreadRes?.spreads ?? [];

  // Friendly subtitle — count adults vs kids vs teens.
  const counts = members.reduce<Record<string, number>>((acc, m) => {
    acc[m.age_group] = (acc[m.age_group] ?? 0) + 1;
    return acc;
  }, {});
  const subtitle = buildSubtitle(counts);

  return (
    <>
      <header className="px-1">
        <h1 className="font-serif text-4xl text-ink tracking-tight">Household</h1>
        <p className="text-ink-soft mt-1">{subtitle}</p>
      </header>

      <div className="mt-6 space-y-4">
        {members.length === 0 && <EmptyMembers />}
        {members.map((member) => (
          <MemberCard
            key={member.member_id}
            member={member}
            traitSpreads={spreads}
          />
        ))}
      </div>

      {members.length >= 2 && spreads.length > 0 && (
        <div className="mt-8">
          <MemberSpreadCard spreads={spreads} />
        </div>
      )}
    </>
  );
}

function buildSubtitle(counts: Record<string, number>): string {
  const parts: string[] = [];
  if (counts.adult)
    parts.push(`${counts.adult} ${counts.adult === 1 ? "adult" : "adults"}`);
  if (counts.teen)
    parts.push(`${counts.teen} ${counts.teen === 1 ? "teen" : "teens"}`);
  if (counts.kid)
    parts.push(`${counts.kid} ${counts.kid === 1 ? "kid" : "kids"}`);
  if (counts.toddler)
    parts.push(
      `${counts.toddler} ${counts.toddler === 1 ? "toddler" : "toddlers"}`,
    );
  if (parts.length === 0) return "Nobody on the roster yet.";
  return parts.join(" · ");
}

function EmptyMembers() {
  return (
    <Card>
      <CardContent className="p-6">
        <h2 className="font-serif text-2xl text-ink">No members yet.</h2>
        <p className="text-ink-soft text-sm mt-1.5">
          During onboarding Spence will ask who else lives here. Until then,
          everything in your plan assumes a single cook.
        </p>
      </CardContent>
    </Card>
  );
}

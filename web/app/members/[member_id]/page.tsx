import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getSessionFromHeaders } from "@/lib/auth";
import { mcp, type McpContext } from "@/lib/mcp";
import { MemberCard } from "../components/member-card";
import { SkillRow } from "../components/skill-row";
import { TraitBar } from "../components/trait-bar";
import { Card, CardContent } from "@/components/primitives/card";
import { Badge } from "@/components/primitives/badge";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ member_id: string }>;
}

/**
 * /members/[member_id] — full member detail.
 *
 * Shows the member card again at the top, then sections:
 *   - skills (with confidence bars)
 *   - presence (current state + last seen)
 *   - per-member trait readings (full set, not just the top 3)
 *   - dietary, allergies, dislikes, loves
 */
export default async function MemberDetailPage({ params }: PageProps) {
  const { member_id } = await params;
  const session = await getSessionFromHeaders(await headers());
  const ctx: McpContext = {
    household_id: session.household_id,
    caller_kind: "human",
    caller_id: "spence-web-member-detail",
  };

  const [memberRes, presenceRes, spreadRes] = await Promise.all([
    mcp("member_get", { member_id }, ctx).catch(() => null),
    mcp("member_get_presence", { member_id }, ctx).catch(() => null),
    mcp(
      "household_get_trait_spread",
      { household_id: session.household_id },
      ctx,
    ).catch(() => null),
  ]);

  const member = memberRes?.member ?? null;
  if (!member) notFound();

  const presence = presenceRes?.presence ?? null;
  const spreads = spreadRes?.spreads ?? [];

  // All trait readings for this member — even ones not surfaced on the card.
  const myReadings = spreads
    .map((s) => ({
      trait_name: s.trait_name,
      reading: s.member_values.find((m) => m.member_id === member_id),
      household_value: s.household_value,
      status: s.status,
    }))
    .filter(
      (
        x,
      ): x is {
        trait_name: string;
        reading: { member_id: string; value: number; confidence: number };
        household_value: number;
        status: typeof spreads[number]["status"];
      } => Boolean(x.reading),
    );

  return (
    <>
      <Link
        href="/members"
        className="inline-flex items-center gap-1 text-sm text-ink-soft hover:text-terracotta px-1"
      >
        <span aria-hidden>←</span> Household
      </Link>

      <div className="mt-3">
        <MemberCard member={member} traitSpreads={spreads} linkToDetail={false} />
      </div>

      <section className="mt-8">
        <h2 className="font-serif text-2xl text-ink tracking-tight px-1">
          Presence
        </h2>
        <Card className="mt-3">
          <CardContent className="p-5">
            {presence ? (
              <div className="flex items-center gap-3">
                <span
                  aria-hidden
                  className={
                    "h-2.5 w-2.5 rounded-full " +
                    (presence.state === "in_kitchen_idle"
                      ? "bg-sage"
                      : presence.state === "busy"
                        ? "bg-amber"
                        : "bg-ink/30")
                  }
                />
                <span className="text-base capitalize">
                  {presence.state.replace(/_/g, " ")}
                </span>
                {presence.last_seen_at && (
                  <span className="text-sm text-ink-soft">
                    last seen {humanizeDate(presence.last_seen_at)}
                  </span>
                )}
              </div>
            ) : (
              <p className="text-ink-soft text-sm">
                No presence pings yet — Spence will track this once cook mode runs.
              </p>
            )}
          </CardContent>
        </Card>
      </section>

      {member.skills.length > 0 && (
        <section className="mt-8">
          <h2 className="font-serif text-2xl text-ink tracking-tight px-1">
            Skills
          </h2>
          <Card className="mt-3">
            <CardContent className="p-5">
              <ul className="divide-y divide-ink/5">
                {member.skills.map((s) => (
                  <SkillRow
                    key={s.skill_name}
                    skill_name={s.skill_name}
                    confidence={s.confidence}
                    tasks_completed={s.tasks_completed}
                    speed_multiplier={s.speed_multiplier}
                    last_used_at={s.last_used_at}
                  />
                ))}
              </ul>
            </CardContent>
          </Card>
        </section>
      )}

      {myReadings.length > 0 && (
        <section className="mt-8">
          <h2 className="font-serif text-2xl text-ink tracking-tight px-1">
            Trait readings
          </h2>
          <Card className="mt-3">
            <CardContent className="p-5 space-y-4">
              {myReadings.map((r) => (
                <TraitBar
                  key={r.trait_name}
                  name={r.trait_name}
                  value={r.reading.value}
                  confidence={r.reading.confidence}
                />
              ))}
            </CardContent>
          </Card>
        </section>
      )}

      {(member.preferences.loves.length > 0 ||
        member.preferences.dislikes.length > 0 ||
        member.preferences.allergies.length > 0) && (
        <section className="mt-8">
          <h2 className="font-serif text-2xl text-ink tracking-tight px-1">
            Preferences
          </h2>
          <Card className="mt-3">
            <CardContent className="p-5 space-y-4 text-sm">
              {member.preferences.allergies.length > 0 && (
                <PreferenceRow
                  label="Allergies"
                  tone="amber"
                  items={member.preferences.allergies}
                />
              )}
              {member.preferences.loves.length > 0 && (
                <PreferenceRow
                  label="Loves"
                  tone="sage"
                  items={member.preferences.loves}
                />
              )}
              {member.preferences.dislikes.length > 0 && (
                <PreferenceRow
                  label="Dislikes"
                  tone="neutral"
                  items={member.preferences.dislikes}
                />
              )}
            </CardContent>
          </Card>
        </section>
      )}
    </>
  );
}

function PreferenceRow({
  label,
  tone,
  items,
}: {
  label: string;
  tone: "amber" | "sage" | "neutral";
  items: string[];
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge tone={tone}>{label}</Badge>
      {items.map((it) => (
        <span
          key={it}
          className="inline-flex items-center rounded-[var(--radius-full)] bg-cream-deep px-2.5 py-0.5 text-sm text-ink-soft"
        >
          {it}
        </span>
      ))}
    </div>
  );
}

function humanizeDate(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

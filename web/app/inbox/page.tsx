import { headers } from "next/headers";
import { getSessionFromHeaders } from "@/lib/auth";
import { mcp, type McpContext, type MorningBrief } from "@/lib/mcp";
import { BriefCard } from "./components/brief-card";
import { EmptyInbox } from "./components/empty-inbox";

export const dynamic = "force-dynamic";

const DAYS_BACK = 7;

interface BriefBucket {
  label: string;
  briefs: MorningBrief[];
}

/**
 * /inbox — newest-first list of daily morning briefs.
 *
 * The worker doesn't expose a brief-list tool yet; we walk the past 7 days
 * calling `household_read_brief` once per date in parallel. Days without a
 * brief are silently skipped. Cards bucket into "Today / Yesterday / This
 * week" so the eye can scan.
 */
export default async function InboxPage() {
  const session = await getSessionFromHeaders(await headers());
  const ctx: McpContext = {
    household_id: session.household_id,
    caller_kind: "human",
    caller_id: "spence-web-inbox",
  };

  const dates = recentIsoDates(DAYS_BACK);
  const results = await Promise.all(
    dates.map((d) =>
      mcp(
        "household_read_brief",
        { household_id: session.household_id, date: d },
        ctx,
      ).catch(() => null),
    ),
  );

  const briefs: MorningBrief[] = [];
  for (const r of results) {
    if (r && "ok" in r && r.ok) briefs.push(r.brief);
  }

  // Sort newest first.
  briefs.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  if (briefs.length === 0) {
    return (
      <>
        <Header />
        <div className="mt-6">
          <EmptyInbox />
        </div>
      </>
    );
  }

  const buckets = bucketByRecency(briefs);

  return (
    <>
      <Header />
      <div className="mt-6 flex flex-col gap-8">
        {buckets.map((b) => (
          <section key={b.label}>
            <h2 className="font-serif text-xl text-ink-soft tracking-tight px-1 mb-3">
              {b.label}
            </h2>
            <ul className="flex flex-col gap-3">
              {b.briefs.map((brief) => (
                <li key={brief.date}>
                  <BriefCard brief={brief} />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </>
  );
}

function Header() {
  return (
    <header className="px-1">
      <h1 className="font-serif text-4xl text-ink tracking-tight">Inbox</h1>
      <p className="text-ink-soft mt-1">A timeline of what Spence has been thinking.</p>
    </header>
  );
}

function recentIsoDates(n: number): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = 0; i < n; i++) {
    const d = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i),
    );
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function bucketByRecency(briefs: MorningBrief[]): BriefBucket[] {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = (() => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  })();

  const todayBucket: MorningBrief[] = [];
  const yesterdayBucket: MorningBrief[] = [];
  const earlier: MorningBrief[] = [];

  for (const b of briefs) {
    if (b.date === today) todayBucket.push(b);
    else if (b.date === yesterday) yesterdayBucket.push(b);
    else earlier.push(b);
  }

  const out: BriefBucket[] = [];
  if (todayBucket.length) out.push({ label: "Today", briefs: todayBucket });
  if (yesterdayBucket.length)
    out.push({ label: "Yesterday", briefs: yesterdayBucket });
  if (earlier.length) out.push({ label: "Earlier this week", briefs: earlier });
  return out;
}

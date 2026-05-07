import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getSessionFromHeaders } from "@/lib/auth";
import { mcp, type McpContext } from "@/lib/mcp";
import { BriefDetail } from "../components/brief-detail";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ brief_id: string }>;
}

/**
 * /inbox/[brief_id] — full brief detail view.
 *
 * The brief_id is the YYYY-MM-DD date — briefs are one per household per
 * day, so the date doubles as a stable identifier.
 */
export default async function BriefDetailPage({ params }: PageProps) {
  const { brief_id } = await params;
  const session = await getSessionFromHeaders(await headers());
  const ctx: McpContext = {
    household_id: session.household_id,
    caller_kind: "human",
    caller_id: "spence-web-brief-detail",
  };

  if (!/^\d{4}-\d{2}-\d{2}$/.test(brief_id)) notFound();

  const res = await mcp(
    "household_read_brief",
    { household_id: session.household_id, date: brief_id },
    ctx,
  ).catch(() => null);

  if (!res || !("ok" in res) || !res.ok) {
    notFound();
  }

  const brief = res.brief;

  return (
    <>
      <Link
        href="/inbox"
        className="inline-flex items-center gap-1 text-sm text-ink-soft hover:text-terracotta px-1"
      >
        <span aria-hidden>←</span> Inbox
      </Link>

      <header className="px-1 mt-3">
        <h1 className="font-serif text-3xl text-ink tracking-tight">
          {humanizeDate(brief.date)}
        </h1>
        <p className="text-ink-soft mt-1 text-sm">
          Generated {humanizeMs(brief.generated_at_ms)}
        </p>
      </header>

      <div className="mt-6">
        <BriefDetail brief={brief} />
      </div>
    </>
  );
}

function humanizeDate(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

function humanizeMs(ms: number): string {
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

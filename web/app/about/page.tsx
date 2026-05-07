import Link from "next/link";
import { Card, CardContent } from "@/components/primitives/card";
import { Badge } from "@/components/primitives/badge";

const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? "0.6.0";
const BUILD_HASH =
  process.env.NEXT_PUBLIC_BUILD_HASH ??
  process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ??
  process.env.NEXT_PUBLIC_CF_PAGES_COMMIT_SHA ??
  "dev";
const GITHUB_URL = process.env.NEXT_PUBLIC_GITHUB_URL ?? "";

export const metadata = {
  title: "About — Spence",
  description: "A chef-of-staff that lives on your phone.",
};

export default function AboutPage() {
  return (
    <div className="max-w-2xl mx-auto px-5 py-12 flex flex-col gap-6">
      <header>
        <h1 className="font-serif text-5xl text-ink dark:text-cream tracking-tight leading-tight">
          Spence is your chef-of-staff.
        </h1>
      </header>

      <div className="flex flex-col gap-4 text-lg leading-relaxed text-ink dark:text-cream/85">
        <p>
          Spence plans your week, walks you through tonight&apos;s cook, and quietly
          learns what you actually like. No dashboards. No streaks. Just a
          friend who happens to know what&apos;s in your fridge.
        </p>
        <p>
          The conversation is the front door — every screen is an artifact of
          something Spence said. Tap a meal card, you opened a recipe. Pin
          tonight&apos;s dinner, you&apos;ve agreed on the plan. Everything you do here
          is grounded in a real tool call against a real ledger; Spence
          never makes up an ingredient or a recipe step.
        </p>
      </div>

      <Card variant="muted">
        <CardContent className="p-5 flex flex-col gap-2 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-ink-soft dark:text-cream/60">Version</span>
            <Badge tone="neutral" className="font-mono">{APP_VERSION}</Badge>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-ink-soft dark:text-cream/60">Build</span>
            <span className="font-mono text-xs text-ink dark:text-cream/80">
              {BUILD_HASH.slice(0, 8)}
            </span>
          </div>
          {GITHUB_URL && (
            <div className="flex items-center justify-between mt-1 pt-2 border-t border-ink/10">
              <span className="text-ink-soft dark:text-cream/60">Source</span>
              <a
                href={GITHUB_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="text-terracotta hover:text-terracotta/80 text-sm"
              >
                GitHub →
              </a>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="pt-2">
        <Link
          href="/chat"
          className="text-terracotta hover:text-terracotta/80 underline underline-offset-2"
        >
          Back to chat
        </Link>
      </div>
    </div>
  );
}

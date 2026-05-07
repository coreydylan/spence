import Link from "next/link";
import { Card, CardContent, CardHeader, CardSubtitle, CardTitle } from "@/components/primitives/card";
import { Badge } from "@/components/primitives/badge";

const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? "0.6.0";
const BUILD_HASH =
  process.env.NEXT_PUBLIC_BUILD_HASH ??
  process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ??
  process.env.NEXT_PUBLIC_CF_PAGES_COMMIT_SHA ??
  "dev";

/**
 * AboutSection — version + build hash + link to /about. Read at build time
 * via NEXT_PUBLIC_APP_VERSION and NEXT_PUBLIC_BUILD_HASH (set by the deploy
 * pipeline). Falls back to "dev" when running locally.
 */
export function AboutSection() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-2xl">About</CardTitle>
        <CardSubtitle>Spence is software, not magic.</CardSubtitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <span className="text-ink-soft dark:text-cream/60 text-sm">Version</span>
          <Badge tone="neutral" className="font-mono">{APP_VERSION}</Badge>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-ink-soft dark:text-cream/60 text-sm">Build</span>
          <span className="font-mono text-xs text-ink dark:text-cream/80">
            {BUILD_HASH.slice(0, 8)}
          </span>
        </div>
        <Link
          href="/about"
          className="text-terracotta text-sm hover:text-terracotta/80 self-start mt-1"
        >
          More about Spence →
        </Link>
      </CardContent>
    </Card>
  );
}

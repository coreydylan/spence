"use client";

import * as React from "react";
import { Button } from "@/components/primitives/button";
import { Card, CardContent } from "@/components/primitives/card";

/**
 * Global error boundary — catches uncaught errors in any route segment.
 * Distinct from the React-level <ErrorBoundary> in `components/system/`,
 * this one is the Next.js framework-level handler invoked when a Server
 * Component throws or a route segment crashes.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="max-w-xl mx-auto px-5 pt-12">
      <Card>
        <CardContent className="p-8 flex flex-col gap-3">
          <h1 className="font-serif text-3xl text-ink dark:text-cream">Something burned.</h1>
          <p className="text-ink-soft dark:text-cream/70 leading-relaxed">
            Spence hit an unexpected error. Try again — if it keeps happening,
            head to the chat and I&apos;ll figure it out from there.
          </p>
          <details className="text-xs text-ink-soft/80 font-mono mt-2">
            <summary className="cursor-pointer">Error detail</summary>
            <pre className="whitespace-pre-wrap break-words mt-2">{error.message}</pre>
            {error.digest && (
              <pre className="opacity-60 mt-1">digest: {error.digest}</pre>
            )}
          </details>
          <div className="flex gap-3 mt-2">
            <Button variant="primary" size="md" onClick={reset}>
              Try again
            </Button>
            <Button
              variant="outline"
              size="md"
              onClick={() => {
                if (typeof window !== "undefined") window.location.href = "/chat";
              }}
            >
              Back to chat
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

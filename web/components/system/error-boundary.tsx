"use client";

import * as React from "react";
import { Button } from "@/components/primitives/button";
import { Card, CardContent } from "@/components/primitives/card";

interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** Optional fallback render fn. Defaults to a friendly card with a reset CTA. */
  fallback?: (error: Error, reset: () => void) => React.ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * ErrorBoundary — class component (React still requires class for catching).
 *
 * Mount near the top of the app (or per route) so a single crashing client
 * subtree doesn't blank the whole app. The fallback is intentionally human
 * — Spence's voice, not a stack trace.
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Surface to console for local dev; production logging would go here.
    if (typeof console !== "undefined") {
      console.error("[Spence ErrorBoundary]", error, info);
    }
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  render(): React.ReactNode {
    if (this.state.error) {
      if (this.props.fallback) {
        return this.props.fallback(this.state.error, this.reset);
      }
      return <DefaultFallback error={this.state.error} onReset={this.reset} />;
    }
    return this.props.children;
  }
}

function DefaultFallback({ error, onReset }: { error: Error; onReset: () => void }) {
  return (
    <div className="max-w-xl mx-auto px-5 pt-12">
      <Card>
        <CardContent className="p-8 flex flex-col gap-3">
          <h1 className="font-serif text-3xl text-ink dark:text-cream">
            Something burned.
          </h1>
          <p className="text-ink-soft dark:text-cream/70 leading-relaxed">
            Spence hit an unexpected error. Try again — if it keeps happening, head
            back to the chat and I&apos;ll figure it out from there.
          </p>
          <details className="text-xs text-ink-soft/80 dark:text-cream/50 font-mono mt-2">
            <summary className="cursor-pointer">Error detail</summary>
            <pre className="whitespace-pre-wrap break-words mt-2">{error.message}</pre>
          </details>
          <div className="flex gap-3 mt-2">
            <Button variant="primary" size="md" onClick={onReset}>
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

import * as React from "react";
import Link from "next/link";
import { Card, CardContent } from "@/components/primitives/card";
import { Button } from "@/components/primitives/button";
import { cn } from "@/lib/cn";

interface EmptyStateProps {
  /** Big serif headline. */
  title: string;
  /** Soft helper line under the headline. */
  message?: string;
  /** Primary CTA — typically "Back to chat" or "Plan something". */
  cta?: {
    label: string;
    href: string;
  };
  /** Optional secondary link. */
  secondary?: {
    label: string;
    href: string;
  };
  className?: string;
}

/**
 * EmptyState — friendly card for "no data" routes.
 *
 * Used by /today (no plan), /plan (empty week), /shop (nothing to buy),
 * /recipe/[id] (not found), etc. Centered card with serif headline + a CTA
 * to push the user back to the conversation.
 */
export function EmptyState({ title, message, cta, secondary, className }: EmptyStateProps) {
  return (
    <div className={cn("max-w-xl mx-auto px-5 pt-12", className)}>
      <Card>
        <CardContent className="p-8 flex flex-col gap-3">
          <h1 className="font-serif text-3xl text-ink dark:text-cream leading-tight">
            {title}
          </h1>
          {message && (
            <p className="text-ink-soft dark:text-cream/70 leading-relaxed">{message}</p>
          )}
          {(cta || secondary) && (
            <div className="flex flex-wrap gap-3 mt-2">
              {cta && (
                <Link href={cta.href}>
                  <Button variant="primary">{cta.label}</Button>
                </Link>
              )}
              {secondary && (
                <Link href={secondary.href}>
                  <Button variant="outline">{secondary.label}</Button>
                </Link>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

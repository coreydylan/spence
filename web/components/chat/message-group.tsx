import * as React from "react";
import { cn } from "@/lib/cn";

interface MessageGroupProps {
  role: "user" | "assistant";
  /** First message in a streak from the same author shows the avatar. */
  isFirstInGroup?: boolean;
  /** Last in streak gets a slightly larger bottom margin. */
  isLastInGroup?: boolean;
  children: React.ReactNode;
  className?: string;
}

/**
 * MessageGroup — wraps a single message and supplies grouping semantics.
 *
 * Foundation's `<ChefBubble>` always renders the Spence avatar inline. To
 * keep the visual stacked-avatar effect for consecutive Spence messages,
 * we apply the `spence-avatar-hidden` class to non-first messages — a
 * stylesheet rule in `globals.css` makes the inner avatar invisible so the
 * bubble stays aligned with the avatar gutter above without double-stamping
 * a Spence dot.
 *
 * - Spence streaks: first message shows avatar, follow-ups are flush-aligned.
 * - User streaks: right-aligned, no avatar in either case.
 * - Spacing: `mb-3` between authors, `mb-1` within a streak.
 */
export function MessageGroup({
  role,
  isFirstInGroup = true,
  isLastInGroup = true,
  children,
  className,
}: MessageGroupProps) {
  if (role === "user") {
    return (
      <div
        className={cn(
          "flex justify-end",
          isLastInGroup ? "mb-3" : "mb-1",
          className,
        )}
      >
        {children}
      </div>
    );
  }

  return (
    <div
      className={cn(
        !isFirstInGroup && "spence-avatar-hidden",
        isLastInGroup ? "mb-3" : "mb-1",
        className,
      )}
    >
      {children}
    </div>
  );
}

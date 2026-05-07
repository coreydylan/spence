import * as React from "react";
import { cn } from "@/lib/cn";

interface UserBubbleProps {
  children: React.ReactNode;
  className?: string;
}

/**
 * UserBubble — right-aligned, plain. No avatar (the user is implicit).
 * Use for echoing what the user just typed back into the conversation log.
 */
export function UserBubble({ children, className }: UserBubbleProps) {
  return (
    <div className={cn("flex justify-end max-w-[42rem] ml-auto animate-fade-up", className)}>
      <div className="rounded-[var(--radius-lg)] rounded-tr-md bg-ink text-cream px-4 py-3 max-w-full whitespace-pre-wrap break-words">
        {children}
      </div>
    </div>
  );
}

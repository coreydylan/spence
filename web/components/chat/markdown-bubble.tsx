import * as React from "react";
import { renderMarkdown } from "@/lib/markdown";
import { cn } from "@/lib/cn";

interface MarkdownBubbleProps {
  text: string;
  className?: string;
}

/**
 * MarkdownBubble — renders chat text content as markdown.
 *
 * Wraps the safe markdown renderer (`lib/markdown`) with chat-specific styles:
 * tight `leading-relaxed`, `prose-like` list spacing. No raw HTML allowed.
 *
 * Use inside a ChefBubble:
 *
 *   <ChefBubble>
 *     <MarkdownBubble text={message.text} />
 *   </ChefBubble>
 */
export function MarkdownBubble({ text, className }: MarkdownBubbleProps) {
  if (!text) return null;
  return (
    <div className={cn("flex flex-col gap-2 leading-relaxed", className)}>
      {renderMarkdown(text)}
    </div>
  );
}

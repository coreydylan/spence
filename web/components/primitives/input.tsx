import * as React from "react";
import { cn } from "@/lib/cn";

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

/** Single-line input. Use for short fields (email, name, etc.). */
export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  function Input({ className, ...rest }, ref) {
    return (
      <input
        ref={ref}
        className={cn(
          "h-11 w-full rounded-[var(--radius-md)] border border-ink/15 bg-white/80 px-4 text-base text-ink placeholder:text-ink-soft/60",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta",
          className,
        )}
        {...rest}
      />
    );
  },
);

export interface TextareaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {}

/** Multi-line input — used for the chef chat composer. */
export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  function Textarea({ className, ...rest }, ref) {
    return (
      <textarea
        ref={ref}
        className={cn(
          "w-full rounded-[var(--radius-md)] border border-ink/15 bg-white/80 p-4 text-base text-ink placeholder:text-ink-soft/60 resize-none",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta",
          className,
        )}
        {...rest}
      />
    );
  },
);

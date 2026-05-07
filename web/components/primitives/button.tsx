import * as React from "react";
import { cn } from "@/lib/cn";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "outline";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    "bg-terracotta text-cream hover:bg-terracotta/90 active:bg-terracotta/80 shadow-[var(--shadow-soft)]",
  secondary:
    "bg-sage text-cream hover:bg-sage/90 active:bg-sage/80 shadow-[var(--shadow-soft)]",
  ghost: "bg-transparent text-ink hover:bg-cream-deep",
  outline: "border border-ink/15 bg-transparent text-ink hover:bg-cream-deep",
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-sm rounded-[var(--radius-sm)]",
  md: "h-11 px-5 text-base rounded-[var(--radius-md)]",
  lg: "h-14 px-7 text-lg rounded-[var(--radius-md)]",
};

/**
 * Button — the canonical interactive primitive.
 *
 * Variants:
 *   primary   — terracotta CTA (one per screen ideally)
 *   secondary — sage, for non-destructive secondary actions
 *   ghost     — text-only, for inline actions
 *   outline   — bordered, for cancel / dismiss
 *
 * Sizes: sm (chips), md (default), lg (hero CTAs).
 */
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    { className, variant = "primary", size = "md", loading, disabled, children, ...rest },
    ref,
  ) {
    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        className={cn(
          "inline-flex items-center justify-center gap-2 font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta focus-visible:ring-offset-2 focus-visible:ring-offset-cream",
          variantClasses[variant],
          sizeClasses[size],
          className,
        )}
        {...rest}
      >
        {loading && (
          <span className="h-3 w-3 rounded-full border-2 border-current border-t-transparent animate-spin" />
        )}
        {children}
      </button>
    );
  },
);

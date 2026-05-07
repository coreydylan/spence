import * as React from "react";
import { cn } from "@/lib/cn";

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: "default" | "raised" | "muted";
}

/**
 * Card — content surface. The default surface is a subtle off-cream with the
 * `--shadow-soft` token; `raised` uses `--shadow-card` (used for hero meal
 * cards); `muted` is a flat cream-deep panel for secondary content.
 */
export const Card = React.forwardRef<HTMLDivElement, CardProps>(function Card(
  { className, variant = "default", ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn(
        "rounded-[var(--radius-lg)] border border-ink/5",
        variant === "default" && "bg-white/60 shadow-[var(--shadow-soft)]",
        variant === "raised" && "bg-white shadow-[var(--shadow-card)]",
        variant === "muted" && "bg-cream-deep",
        className,
      )}
      {...rest}
    />
  );
});

export const CardHeader = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(function CardHeader({ className, ...rest }, ref) {
  return (
    <div
      ref={ref}
      className={cn("p-5 pb-3 flex flex-col gap-1", className)}
      {...rest}
    />
  );
});

export const CardTitle = React.forwardRef<
  HTMLHeadingElement,
  React.HTMLAttributes<HTMLHeadingElement>
>(function CardTitle({ className, ...rest }, ref) {
  return (
    <h3
      ref={ref}
      className={cn(
        "font-serif text-2xl leading-tight text-ink tracking-tight",
        className,
      )}
      {...rest}
    />
  );
});

export const CardSubtitle = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(function CardSubtitle({ className, ...rest }, ref) {
  return (
    <p
      ref={ref}
      className={cn("text-sm text-ink-soft", className)}
      {...rest}
    />
  );
});

export const CardContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(function CardContent({ className, ...rest }, ref) {
  return <div ref={ref} className={cn("p-5 pt-2", className)} {...rest} />;
});

export const CardFooter = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(function CardFooter({ className, ...rest }, ref) {
  return (
    <div
      ref={ref}
      className={cn(
        "p-5 pt-3 flex items-center gap-3 border-t border-ink/5",
        className,
      )}
      {...rest}
    />
  );
});

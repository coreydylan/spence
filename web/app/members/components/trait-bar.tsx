import { cn } from "@/lib/cn";

interface Props {
  /** Trait name, e.g. `comfort_vs_adventure`. */
  name: string;
  /** Value in [0, 1]. */
  value: number;
  /** Optional confidence in [0, 1] — controls saturation/opacity. */
  confidence?: number;
  /** Compact variant: smaller font, tighter padding. */
  compact?: boolean;
}

/**
 * Trait bar — a single horizontal track from 0..1 with a marker at `value`.
 * The trait name and numeric value sit above the track. Confidence dims the
 * marker dot and the track color so low-confidence reads look "preliminary".
 *
 * Used in the per-member detail view and on the household roster cards.
 */
export function TraitBar({ name, value, confidence = 1, compact }: Props) {
  const v = clamp01(value);
  const conf = clamp01(confidence);
  const opacity = 0.4 + conf * 0.6; // floor at 0.4 so even uncalibrated reads are legible
  return (
    <div className={cn("flex flex-col gap-1", compact && "gap-0.5")}>
      <div className="flex items-baseline justify-between">
        <span
          className={cn(
            "font-mono text-ink-soft tracking-tight",
            compact ? "text-[10px]" : "text-xs",
          )}
        >
          {humanize(name)}
        </span>
        <span
          className={cn(
            "font-mono tabular-nums",
            compact ? "text-[10px]" : "text-xs",
          )}
          style={{ opacity }}
        >
          {v.toFixed(2)}
        </span>
      </div>
      <div
        className={cn(
          "relative w-full rounded-full bg-cream-deep",
          compact ? "h-1.5" : "h-2",
        )}
      >
        <div
          className="absolute top-1/2 -translate-y-1/2 h-3 w-3 rounded-full bg-terracotta border-2 border-cream"
          style={{
            left: `calc(${v * 100}% - 6px)`,
            opacity,
          }}
          aria-hidden
        />
      </div>
    </div>
  );
}

function humanize(name: string): string {
  return name.replace(/_/g, " ");
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

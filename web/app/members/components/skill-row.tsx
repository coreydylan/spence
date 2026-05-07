import { cn } from "@/lib/cn";

interface Props {
  skill_name: string;
  confidence: number;
  tasks_completed: number;
  speed_multiplier?: number;
  last_used_at?: string | null;
}

/**
 * One skill per row — name, a confidence bar, and a tiny meta line with
 * tasks-completed + speed multiplier. Sage tone for the bar (skills are
 * "settled" knowledge, not warming-up traits).
 */
export function SkillRow({
  skill_name,
  confidence,
  tasks_completed,
  speed_multiplier,
  last_used_at,
}: Props) {
  const conf = Math.max(0, Math.min(1, confidence));
  const pct = Math.round(conf * 100);

  return (
    <li className="flex flex-col gap-1.5 py-2">
      <div className="flex items-baseline justify-between">
        <span className="text-sm font-medium text-ink">
          {humanize(skill_name)}
        </span>
        <span className="font-mono text-xs text-ink-soft tabular-nums">
          {pct}%
        </span>
      </div>
      <div
        className="relative h-1.5 rounded-full bg-cream-deep overflow-hidden"
        aria-label={`${humanize(skill_name)} confidence ${pct}%`}
      >
        <div
          className={cn(
            "absolute inset-y-0 left-0 rounded-full bg-sage transition-[width]",
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="text-xs text-ink-soft flex items-center gap-3">
        <span>{tasks_completed} {tasks_completed === 1 ? "task" : "tasks"}</span>
        {speed_multiplier != null && Math.abs(speed_multiplier - 1) > 0.05 && (
          <span className="font-mono">×{speed_multiplier.toFixed(2)}</span>
        )}
        {last_used_at && (
          <span className="text-ink-soft/70">
            last used {humanizeDate(last_used_at)}
          </span>
        )}
      </div>
    </li>
  );
}

function humanize(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function humanizeDate(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

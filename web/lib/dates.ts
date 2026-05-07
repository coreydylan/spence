/**
 * Date formatting helpers for the Spence web frontend.
 *
 * All helpers operate on ISO `YYYY-MM-DD` strings or `Date` objects. We avoid
 * `toLocaleDateString` outside browser code because the Cloudflare Pages /
 * Next.js server runtime has limited ICU; we hand-roll names instead.
 */

export const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

export const DAY_NAMES_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

export const MONTH_NAMES_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** Today as YYYY-MM-DD using the local clock. */
export function todayIso(): string {
  return toIsoDate(new Date());
}

/** Format a Date as YYYY-MM-DD in its local timezone. */
export function toIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Parse a YYYY-MM-DD string into a local Date (12:00 noon to dodge DST edge). */
export function fromIsoDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1, 12, 0, 0, 0);
}

/** Add `days` to an iso date and return a new iso date. */
export function addDays(iso: string, days: number): string {
  const d = fromIsoDate(iso);
  d.setDate(d.getDate() + days);
  return toIsoDate(d);
}

/** "Thursday" */
export function dayName(iso: string): string {
  return DAY_NAMES[fromIsoDate(iso).getDay()];
}

/** "Thu" */
export function dayNameShort(iso: string): string {
  return DAY_NAMES_SHORT[fromIsoDate(iso).getDay()];
}

/** "May 7" */
export function prettyDate(iso: string): string {
  const d = fromIsoDate(iso);
  return `${MONTH_NAMES[d.getMonth()]} ${d.getDate()}`;
}

/** "5/8" */
export function shortDate(iso: string): string {
  const d = fromIsoDate(iso);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** "Thu 5/8" */
export function dayShort(iso: string): string {
  return `${dayNameShort(iso)} ${shortDate(iso)}`;
}

/** "Week of May 7" — anchored to the first day of the iso list. */
export function weekOfLabel(startIso: string): string {
  return `Week of ${prettyDate(startIso)}`;
}

/** Build an inclusive list of iso dates from start..end. */
export function isoRange(start: string, end: string): string[] {
  const out: string[] = [];
  let cur = start;
  while (cur <= end) {
    out.push(cur);
    cur = addDays(cur, 1);
  }
  return out;
}

/** Difference in days (b - a). */
export function diffDays(a: string, b: string): number {
  const da = fromIsoDate(a).getTime();
  const db = fromIsoDate(b).getTime();
  return Math.round((db - da) / 86400000);
}

/** "tonight", "tomorrow", "in 2 days", "Sat 5/10". */
export function relativeDay(iso: string, today = todayIso()): string {
  const delta = diffDays(today, iso);
  if (delta === 0) return "tonight";
  if (delta === 1) return "tomorrow";
  if (delta < 0) return dayShort(iso);
  if (delta < 7) return `in ${delta} days`;
  return dayShort(iso);
}

/**
 * Format an ISO timestamp string like "2026-05-07T17:55:00-07:00" or "17:55"
 * into a "5:55 PM" 12-hour string. Falls back to the input if it can't parse.
 */
export function pretty12h(input: string | undefined | null): string {
  if (!input) return "";
  // Bare HH:MM
  const hhmm = /^(\d{1,2}):(\d{2})/.exec(input);
  if (hhmm) {
    const h = Number(hhmm[1]);
    const m = Number(hhmm[2]);
    return formatHM(h, m);
  }
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return input;
  return formatHM(d.getHours(), d.getMinutes());
}

function formatHM(h: number, m: number): string {
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const mm = String(m).padStart(2, "0");
  return `${h12}:${mm} ${ampm}`;
}

/** "17:55" → "5:55 PM"; HH:MM input only. Convenience for the `suggested_start_time` field. */
export function pretty24hTime(hhmm: string | undefined): string {
  return pretty12h(hhmm);
}

/** Compute the start-cooking time given an eat-time HH:MM and active minutes. */
export function backDate(eatTime: string, activeMinutes: number): string {
  const m = /^(\d{1,2}):(\d{2})/.exec(eatTime);
  if (!m) return eatTime;
  const total = Number(m[1]) * 60 + Number(m[2]) - activeMinutes;
  const safe = ((total % (24 * 60)) + 24 * 60) % (24 * 60);
  const hh = Math.floor(safe / 60);
  const mm = safe % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

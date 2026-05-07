// Shared helpers for the household-memory layer.
//
// Lives in a separate module so household-model.ts, conversation-threads.ts,
// and kitchen-inventory.ts each stay under 350 lines and don't drift on
// JSON parsing / date math / anchor canonicalization.

export const RECENCY_TAU_DAYS = 14;

export function parseStringArray(value: string | null | undefined): string[] {
	if (!value || typeof value !== "string") return [];
	try {
		const parsed = JSON.parse(value);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((v): v is string => typeof v === "string" && !!v.trim()).map(v => v.trim());
	} catch {
		return [];
	}
}

export function parseNumberMap(value: string | null | undefined): Record<string, number> {
	if (!value || typeof value !== "string") return {};
	try {
		const parsed = JSON.parse(value);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		const out: Record<string, number> = {};
		for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
			if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
		}
		return out;
	} catch {
		return {};
	}
}

export function parseGenericObject<T = Record<string, unknown>>(value: string | null | undefined): T | null {
	if (!value || typeof value !== "string") return null;
	try {
		const parsed = JSON.parse(value);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		return parsed as T;
	} catch {
		return null;
	}
}

export function isoDateNDaysAgo(days: number): string {
	const d = new Date();
	d.setUTCDate(d.getUTCDate() - days);
	return d.toISOString().slice(0, 10);
}

export function daysBetween(today: Date, isoDate: string): number | null {
	if (!isoDate || typeof isoDate !== "string") return null;
	const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
	if (!m) return null;
	const then = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
	const now = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
	return (now - then) / (1000 * 60 * 60 * 24);
}

export function clamp01(n: number): number {
	if (!Number.isFinite(n)) return 0;
	if (n < 0) return 0;
	if (n > 1) return 1;
	return n;
}

export function round3(n: number): number {
	return Math.round(n * 1000) / 1000;
}

export function normalizeMaxToOne(weighted: Map<string, number>): Record<string, number> {
	if (weighted.size === 0) return {};
	let max = 0;
	for (const v of weighted.values()) if (v > max) max = v;
	if (max <= 0) return {};
	const out: Record<string, number> = {};
	for (const [k, v] of weighted.entries()) {
		out[k] = round3(v / max);
	}
	return out;
}

const ANCHOR_STOP_PREFIXES = [
	"roasted ", "raw ", "fresh ", "dried ", "cooked ", "grilled ", "boiled ",
	"steamed ", "fried ", "smoked ", "pickled ", "frozen ", "canned ",
	"chopped ", "diced ", "sliced ", "minced ", "ground ", "whole ", "crushed ",
];

export function canonicalAnchor(raw: string): string {
	if (typeof raw !== "string") return "";
	let s = raw.toLowerCase().trim();
	if (!s) return "";
	s = s.replace(/\s*\([^)]*\)\s*$/g, "").trim();
	for (const prefix of ANCHOR_STOP_PREFIXES) {
		if (s.startsWith(prefix)) {
			s = s.slice(prefix.length).trim();
			break;
		}
	}
	if (s.startsWith("a ")) s = s.slice(2);
	if (s.startsWith("the ")) s = s.slice(4);
	s = s.replace(/\s+/g, " ").trim();
	return s;
}

export function slugify(value: string | null | undefined, maxLen = 48): string {
	if (!value) return "untitled";
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_|_$/g, "")
		.slice(0, maxLen) || "untitled";
}

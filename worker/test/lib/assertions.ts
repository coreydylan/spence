// Assertion helpers + a pending sentinel.
//
// Every assertion captures (ok, message, actual, expected) so the runner can
// pretty-print failures with full context. Pending throws a tagged error that
// the runner recognizes and routes to the "pending" bucket instead of "fail".

import type { AssertionContext, AssertionResult } from "./types";

export const PENDING_TAG = "__SCENARIO_PENDING__";
export const FAIL_TAG = "__SCENARIO_FAIL__";

export class PendingError extends Error {
	constructor(public reason: string) {
		super(`${PENDING_TAG} ${reason}`);
		this.name = "PendingError";
	}
}

export class AssertionError extends Error {
	constructor(public result: AssertionResult) {
		super(`${FAIL_TAG} ${result.message}`);
		this.name = "AssertionError";
	}
}

export function makeAssertionContext(failures: AssertionResult[], counters: { run: number; passed: number; failed: number }): AssertionContext {
	const record = (ok: boolean, message: string, actual?: unknown, expected?: unknown) => {
		counters.run++;
		const result: AssertionResult = { ok, message, actual, expected };
		if (ok) {
			counters.passed++;
		} else {
			counters.failed++;
			failures.push(result);
			throw new AssertionError(result);
		}
	};
	return {
		ok: (cond, msg) => record(cond, msg, cond, true),
		eq: (a, e, msg) => record(deepEqual(a, e), msg, a, e),
		notEq: (a, e, msg) => record(!deepEqual(a, e), msg, a, e),
		gte: (a, e, msg) => record(a >= e, msg, a, e),
		lte: (a, e, msg) => record(a <= e, msg, a, e),
		gt: (a, e, msg) => record(a > e, msg, a, e),
		contains: (haystack, needle, msg) => {
			const found = typeof haystack === "string"
				? haystack.includes(String(needle))
				: Array.isArray(haystack) && haystack.some(item => deepEqual(item, needle));
			record(found, msg, haystack, needle);
		},
		matches: (text, pattern, msg) => record(pattern.test(text), msg, text, pattern.source),
		hasShape: (actual, shape, msg) => record(matchesShape(actual, shape), msg, actual, shape),
		pending: (reason) => { throw new PendingError(reason); },
	};
}

function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (a === null || b === null) return false;
	if (typeof a !== "object" || typeof b !== "object") return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	if (Array.isArray(a) && Array.isArray(b)) {
		if (a.length !== b.length) return false;
		return a.every((v, i) => deepEqual(v, b[i]));
	}
	const ao = a as Record<string, unknown>;
	const bo = b as Record<string, unknown>;
	const ak = Object.keys(ao).sort();
	const bk = Object.keys(bo).sort();
	if (ak.length !== bk.length) return false;
	if (!ak.every((k, i) => k === bk[i])) return false;
	return ak.every(k => deepEqual(ao[k], bo[k]));
}

function matchesShape(actual: unknown, shape: Record<string, unknown>): boolean {
	if (typeof actual !== "object" || actual === null) return false;
	const a = actual as Record<string, unknown>;
	for (const [key, expected] of Object.entries(shape)) {
		if (!(key in a)) return false;
		if (typeof expected === "function") {
			if (!(expected as (v: unknown) => boolean)(a[key])) return false;
		} else if (expected !== undefined && !deepEqual(a[key], expected)) {
			return false;
		}
	}
	return true;
}

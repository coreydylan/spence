// Shared types for the Spence test harness.
//
// Tests are pure TypeScript files that export a default `Scenario`. The runner
// discovers them, runs them, and aggregates results. Each scenario can return
// `pass`, `fail`, or `pending` (when the feature it specs hasn't been built
// yet) — pending tests document the contract for upcoming work without
// blocking the suite.

export type ScenarioStatus = "pass" | "fail" | "pending" | "skip";

export interface AssertionResult {
	ok: boolean;
	message: string;
	expected?: unknown;
	actual?: unknown;
}

export interface ScenarioResult {
	id: string;
	name: string;
	group: string;
	status: ScenarioStatus;
	duration_ms: number;
	assertions_run: number;
	assertions_passed: number;
	assertions_failed: number;
	failed: AssertionResult[];
	pending_reason?: string;
	error?: string;
	notes: string[];
}

export interface Scenario {
	id: string;                     // "t01"
	name: string;                   // human-readable
	group: "golden" | "ripple" | "integration" | "adversarial" | "unit";
	tier: "fast" | "live";          // fast = no LLM; live = hits real bridge
	pending?: string;               // if set, scenario is spec-only until feature ships
	run: (ctx: ScenarioContext) => Promise<void>;
}

export interface ScenarioContext {
	assert: AssertionContext;
	loadFixture: <T = unknown>(name: string) => T;
	livePlanResponse?: () => Promise<unknown>;  // for tier=live
	notes: string[];
}

export interface AssertionContext {
	ok: (cond: boolean, message: string) => void;
	eq: <T>(actual: T, expected: T, message: string) => void;
	notEq: <T>(actual: T, expected: T, message: string) => void;
	gte: (actual: number, expected: number, message: string) => void;
	lte: (actual: number, expected: number, message: string) => void;
	gt: (actual: number, expected: number, message: string) => void;
	contains: <T>(haystack: T[] | string, needle: unknown, message: string) => void;
	matches: (text: string, pattern: RegExp, message: string) => void;
	hasShape: (actual: unknown, shape: Record<string, unknown>, message: string) => void;
	pending: (reason: string) => never;  // throws a special sentinel
}

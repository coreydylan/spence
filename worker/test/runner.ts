// Spence test runner — discovers scenarios under test/scenarios/, runs them,
// prints a grouped summary, and exits non-zero on any FAIL.
//
// Pending scenarios (spec-only, feature not yet built) are reported but do NOT
// fail the suite. They show up in the summary as a "spec backlog" view.
//
// Usage:
//   npm test                  → all fast scenarios
//   npm test -- --tier=live   → also runs live (real bridge) scenarios
//   npm test -- --only=t04    → run scenarios whose id starts with "t04"
//   npm test -- --group=ripple → run scenarios in given group

import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeAssertionContext, AssertionError, PendingError } from "./lib/assertions";
import { loadFixture } from "./lib/fixtures";
import type { Scenario, ScenarioResult, AssertionResult } from "./lib/types";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCENARIOS_DIR = join(HERE, "scenarios");

const args = parseArgs(process.argv.slice(2));

async function main() {
	const files = readdirSync(SCENARIOS_DIR).filter(f => f.endsWith(".ts")).sort();
	const scenarios: Scenario[] = [];
	for (const file of files) {
		try {
			const mod = await import(pathToFileURL(join(SCENARIOS_DIR, file)).href);
			const scenario = mod.default as Scenario;
			if (!scenario || !scenario.id || !scenario.run) {
				console.error(`!! skipping ${file}: no default Scenario export`);
				continue;
			}
			scenarios.push(scenario);
		} catch (err) {
			console.error(`!! failed to load ${file}: ${(err as Error).message}`);
		}
	}

	const filtered = scenarios.filter(s => {
		if (args.only && !s.id.startsWith(args.only)) return false;
		if (args.group && s.group !== args.group) return false;
		if (s.tier === "live" && !args.live) return false;
		return true;
	});

	const results: ScenarioResult[] = [];
	for (const scenario of filtered) {
		results.push(await runOne(scenario));
	}

	printSummary(results, scenarios.length, filtered.length);
	const hasFailure = results.some(r => r.status === "fail");
	process.exit(hasFailure ? 1 : 0);
}

async function runOne(scenario: Scenario): Promise<ScenarioResult> {
	const failures: AssertionResult[] = [];
	const notes: string[] = [];
	const counters = { run: 0, passed: 0, failed: 0 };
	const started = Date.now();

	if (scenario.pending) {
		return {
			id: scenario.id,
			name: scenario.name,
			group: scenario.group,
			status: "pending",
			duration_ms: 0,
			assertions_run: 0,
			assertions_passed: 0,
			assertions_failed: 0,
			failed: [],
			notes,
			pending_reason: scenario.pending,
		};
	}

	const ctx = {
		assert: makeAssertionContext(failures, counters),
		loadFixture,
		notes,
	};

	let status: ScenarioResult["status"] = "pass";
	let pending_reason: string | undefined;
	let error: string | undefined;

	try {
		await scenario.run(ctx);
	} catch (err) {
		if (err instanceof PendingError) {
			status = "pending";
			pending_reason = err.reason;
		} else if (err instanceof AssertionError) {
			status = "fail";
		} else {
			status = "fail";
			error = err instanceof Error ? err.message : String(err);
		}
	}

	if (status === "pass" && counters.failed > 0) status = "fail";

	return {
		id: scenario.id,
		name: scenario.name,
		group: scenario.group,
		status,
		duration_ms: Date.now() - started,
		assertions_run: counters.run,
		assertions_passed: counters.passed,
		assertions_failed: counters.failed,
		failed: failures,
		notes,
		pending_reason,
		error,
	};
}

function printSummary(results: ScenarioResult[], total: number, ran: number) {
	console.log("");
	console.log("─────────────────────────────────────────────────────────────────────");
	console.log(`  SPENCE PLANNER  —  ${ran} of ${total} scenarios run`);
	console.log("─────────────────────────────────────────────────────────────────────");

	const groups = new Map<string, ScenarioResult[]>();
	for (const r of results) {
		if (!groups.has(r.group)) groups.set(r.group, []);
		groups.get(r.group)!.push(r);
	}

	const groupOrder = ["unit", "golden", "ripple", "integration", "adversarial"];
	for (const group of groupOrder) {
		const list = groups.get(group);
		if (!list || list.length === 0) continue;
		console.log(`\n  ${group.toUpperCase()}`);
		for (const r of list) {
			const icon = iconFor(r.status);
			const name = `${r.id} · ${r.name}`.padEnd(58);
			const duration = `${r.duration_ms}ms`.padStart(7);
			const counts = r.assertions_run > 0
				? `(${r.assertions_passed}/${r.assertions_run})`
				: "";
			console.log(`    ${icon} ${name} ${duration} ${counts}`);
			if (r.status === "pending" && r.pending_reason) {
				console.log(`         spec: ${r.pending_reason}`);
			}
			if (r.status === "fail") {
				if (r.error) console.log(`         ERROR: ${r.error}`);
				for (const f of r.failed) {
					console.log(`         ✗ ${f.message}`);
					if (f.expected !== undefined || f.actual !== undefined) {
						console.log(`           expected: ${stringify(f.expected)}`);
						console.log(`           actual:   ${stringify(f.actual)}`);
					}
				}
			}
			for (const note of r.notes) {
				console.log(`         note: ${note}`);
			}
		}
	}

	const passed = results.filter(r => r.status === "pass").length;
	const failed = results.filter(r => r.status === "fail").length;
	const pending = results.filter(r => r.status === "pending").length;
	console.log("");
	console.log("─────────────────────────────────────────────────────────────────────");
	console.log(`  Passed:  ${passed}    Failed:  ${failed}    Pending:  ${pending}`);
	console.log("─────────────────────────────────────────────────────────────────────\n");
}

function iconFor(status: ScenarioResult["status"]): string {
	switch (status) {
		case "pass":    return "✓";
		case "fail":    return "✗";
		case "pending": return "○";
		case "skip":    return "·";
	}
}

function stringify(value: unknown): string {
	if (value === undefined) return "undefined";
	if (value instanceof RegExp) return value.toString();
	try {
		const s = JSON.stringify(value);
		if (s && s.length > 200) return s.slice(0, 200) + "…";
		return s ?? String(value);
	} catch {
		return String(value);
	}
}

function parseArgs(argv: string[]): { only?: string; group?: string; live: boolean } {
	const out: { only?: string; group?: string; live: boolean } = { live: false };
	for (const arg of argv) {
		if (arg.startsWith("--only=")) out.only = arg.slice(7);
		else if (arg.startsWith("--group=")) out.group = arg.slice(8);
		else if (arg === "--tier=live" || arg === "--live") out.live = true;
	}
	return out;
}

main().catch(err => {
	console.error("runner crashed:", err);
	process.exit(2);
});

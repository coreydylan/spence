// Fixture loader. Tests import JSON snapshots of plans / intents / world
// states. Centralized here so paths and parse errors are consistent.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, "..", "fixtures");

export function loadFixture<T = unknown>(relativePath: string): T {
	const full = join(FIXTURES_DIR, relativePath);
	if (!existsSync(full)) {
		throw new Error(`fixture not found: ${relativePath} (looked in ${full})`);
	}
	const raw = readFileSync(full, "utf-8");
	try {
		return JSON.parse(raw) as T;
	} catch (err) {
		throw new Error(`fixture ${relativePath} is not valid JSON: ${(err as Error).message}`);
	}
}

export function fixtureExists(relativePath: string): boolean {
	return existsSync(join(FIXTURES_DIR, relativePath));
}

export function fixtureDir(): string {
	return FIXTURES_DIR;
}

// Wave 7B Track B — MemberAgent presence-timeout logic, extracted as pure
// functions for unit testability.
//
// MemberAgent calls these from its alarm callback. The DO wraps with state
// updates + tracing.

import type { MiseGraphEnv } from "../types";
import { timeoutStalePresence, getPresence } from "../member-presence";

export const PRESENCE_STALE_TIMEOUT_SEC = 30 * 60; // 30 min
export const PRESENCE_ALARM_INTERVAL_MS = 30 * 60 * 1000;

export interface PresenceTimeoutResult {
	flipped: number;
	timeout_sec: number;
}

/**
 * Sweep stale presence rows for a household. Wraps the existing
 * `timeoutStalePresence` helper so the DO doesn't have to know the exact
 * timeout semantics.
 */
export async function sweepHouseholdPresence(
	env: MiseGraphEnv,
	household_id: string,
	timeout_sec: number = PRESENCE_STALE_TIMEOUT_SEC,
): Promise<PresenceTimeoutResult> {
	const result = await timeoutStalePresence(env, household_id, timeout_sec);
	return { flipped: result.flipped_to_stepped_away, timeout_sec };
}

/**
 * Decide whether a single member is "stale" (last ping older than timeout).
 * Returns true when the agent should self-flip its in-memory presence to
 * `absent` because the iOS client has been silent for too long.
 *
 * Pure (sort of): reads D1 via getPresence but doesn't mutate. Called from
 * the MemberAgent's onPresenceTimeout alarm.
 */
export async function isMemberPresenceStale(
	env: MiseGraphEnv,
	member_id: string,
	timeout_ms: number = PRESENCE_ALARM_INTERVAL_MS,
	now: Date = new Date(),
): Promise<boolean> {
	const snap = await getPresence(env, member_id);
	if (!snap.last_ping_at) return true;
	const last = Date.parse(snap.last_ping_at);
	if (!Number.isFinite(last)) return true;
	return now.getTime() - last > timeout_ms;
}

/** Schedule next presence sweep — used by the MemberAgent alarm. */
export function nextPresenceSweepAt(from: Date = new Date()): Date {
	return new Date(from.getTime() + PRESENCE_ALARM_INTERVAL_MS);
}

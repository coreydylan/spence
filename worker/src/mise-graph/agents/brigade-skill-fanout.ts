// Wave 8B Track C — pure skill-outcome fan-out helper.
//
// When a member completes a brigade task (either via WS `complete_task` or
// the lead's manual mark-complete), the CookingLeadAgent fans out to the
// MemberAgent so the long-lived skill model can update its confidence.
//
// This module is split out as a pure function so:
//   1. The DO can call it without inlining the routing logic.
//   2. Unit tests can mock the namespace and assert the fan-out contract
//      WITHOUT booting the Agents SDK runtime.
//   3. Future Wave 8B Track A enhancements (passing the skill name through
//      the assignment row) can extend the input shape without touching the
//      DO body.
//
// Behaviour:
//   * Missing MEMBER_AGENT binding → silent no-op. The brigade event log
//     is authoritative; the fan-out is sidecar.
//   * Missing household_id → silent no-op (we can't address the MemberAgent
//     without a household).
//   * Empty member_id / task_id → silent no-op (defensive).
//   * Any thrown error from the stub fetch is caught + logged. We never
//     propagate errors out of the fan-out; the cook session must keep
//     running even if MemberAgent is down.

import { memberAgentName } from "./base";

export interface SkillFanOutArgs {
	env: { MEMBER_AGENT?: DurableObjectNamespace };
	household_id: string | null;
	member_id: string;
	task_id: string;
	outcome: string;
	meal_id?: string | null;
	notes?: string | null;
	/** Optional override; defaults to "general" until Track A wires it through. */
	skill_name?: string;
}

export interface SkillFanOutResult {
	ok: boolean;
	skipped?: "missing_binding" | "missing_household" | "missing_member" | "missing_task";
	error?: string;
	posted?: { url: string; body: Record<string, unknown> };
}

/**
 * POST a skill outcome to the MemberAgent. Best-effort.
 */
export async function fanOutBrigadeSkillOutcome(
	args: SkillFanOutArgs,
): Promise<SkillFanOutResult> {
	if (!args.member_id) return { ok: false, skipped: "missing_member" };
	if (!args.task_id) return { ok: false, skipped: "missing_task" };
	if (!args.household_id) return { ok: false, skipped: "missing_household" };
	const ns = args.env.MEMBER_AGENT;
	if (!ns) return { ok: false, skipped: "missing_binding" };

	const skill_name = args.skill_name || "general";
	const body = {
		skill_name,
		outcome: args.outcome,
		task_id: args.task_id,
		meal_id: args.meal_id ?? undefined,
		notes: args.notes ?? undefined,
	};
	const url = `https://agent/internal/skill-outcome`;
	try {
		const stub = ns.get(ns.idFromName(memberAgentName(args.household_id, args.member_id)));
		await stub.fetch(new Request(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}));
		return { ok: true, posted: { url, body } };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.warn(
			`[brigade-skill-fanout] ${args.household_id}/${args.member_id}/${args.task_id}: ${message}`,
		);
		return { ok: false, error: message };
	}
}

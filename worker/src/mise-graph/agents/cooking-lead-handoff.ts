// Wave 8 hand-off: spawn CookingLeadAgent from MealAgent.active_cook entry.
//
// Pure module — no Agents SDK import — so unit tests for the hand-off can
// run under Node without booting the runtime. The MealAgent's
// `spawnCookingLeadAgent` instance method delegates here.
//
// Behaviour:
//   * If the env doesn't have COOKING_LEAD_AGENT bound (Wave 7-only deploy
//     or test env), skip silently with `skipped: true`.
//   * Otherwise issue a one-off POST to the DO's `/init` route. The DO is
//     idempotent so repeated calls don't produce duplicate sessions.
//   * Errors don't propagate — we log + return `{ ok: false, error }`. This
//     preserves the MealAgent active_cook contract (still transitions, still
//     persists the cook_session_marker) even when the brigade lead is down.

export interface SpawnCookingLeadArgs {
	env: { COOKING_LEAD_AGENT?: DurableObjectNamespace };
	cook_session_id: string;
	meal_id: string | null;
	plan_id: string | null;
	household_id: string | null;
}

export interface SpawnCookingLeadResult {
	ok: boolean;
	skipped: boolean;
	skip_reason?: "binding_absent" | "missing_cook_session_id";
	error?: string;
	/** Captured from the DO response when ok===true. Useful for debugging. */
	response?: unknown;
}

export async function spawnCookingLeadAgent(
	args: SpawnCookingLeadArgs,
): Promise<SpawnCookingLeadResult> {
	if (!args.cook_session_id) {
		return { ok: false, skipped: true, skip_reason: "missing_cook_session_id" };
	}
	const ns = args.env.COOKING_LEAD_AGENT;
	if (!ns) {
		return { ok: false, skipped: true, skip_reason: "binding_absent" };
	}
	try {
		const stub = ns.get(ns.idFromName(`cooking_lead:${args.cook_session_id}`));
		const resp = await stub.fetch(new Request("https://agent/internal/init", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				cook_session_id: args.cook_session_id,
				meal_id: args.meal_id,
				plan_id: args.plan_id,
				household_id: args.household_id ?? undefined,
			}),
		}));
		let response: unknown;
		try {
			const text = await resp.text();
			response = text ? JSON.parse(text) : null;
		} catch {
			response = null;
		}
		return { ok: resp.ok, skipped: false, response };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.warn(
			`[meal-agent] cooking-lead spawn failed (cook_session_id=${args.cook_session_id}): ${message}`,
		);
		return { ok: false, skipped: false, error: message };
	}
}

// U56 — Brigade WS auth token lifecycle.
//
// Locks the contract for `cooking-lead-tokens.ts`:
//   1. grantToken inserts a row with consumed_at_ms = NULL.
//   2. verifyAndConsumeToken on a fresh token returns ok:true and flips the
//      row to consumed.
//   3. A second verify of the same token returns ok:false reason:consumed.
//   4. An expired token returns ok:false reason:expired (without flipping
//      the row).
//   5. A token presented with the wrong cook_session_id returns
//      ok:false reason:session_mismatch.
//   6. A missing or unknown token returns ok:false with the appropriate
//      reason.

import type { Scenario } from "../lib/types";
import {
	grantToken,
	verifyAndConsumeToken,
} from "../../src/mise-graph/agents/cooking-lead-tokens";
import { BRIGADE_TOKEN_TTL_MS } from "../../src/mise-graph/agents/cooking-lead-types";
import { BrigadeFakeD1 } from "../lib/wave7c-fake-d1";

const u56: Scenario = {
	id: "u56",
	name: "Brigade tokens: grant → verify (single-use, member-bound, TTL-checked)",
	group: "unit",
	tier: "fast",
	async run(ctx) {
		const db = new BrigadeFakeD1();
		const env = { DB: db as unknown as D1Database };

		const cook_session_id = "cs_brigade_u56";
		const member_id = "mem_alice";
		const baseNow = 1_750_000_000_000;

		// 1. Grant a token.
		const grant = await grantToken(env, { cook_session_id, member_id }, { now_ms: baseNow });
		ctx.assert.ok(typeof grant.token === "string", "grant returned a token string");
		ctx.assert.eq(grant.token.length, 32, "token is 32 chars");
		ctx.assert.eq(grant.cook_session_id, cook_session_id, "echoes cook_session_id");
		ctx.assert.eq(grant.member_id, member_id, "echoes member_id");
		ctx.assert.eq(
			grant.expires_at_ms,
			baseNow + BRIGADE_TOKEN_TTL_MS,
			"expiry is now + 10min",
		);

		// Check the row landed and is unconsumed.
		const row = db.tokens.get(grant.token);
		ctx.assert.ok(!!row, "token row was inserted");
		ctx.assert.eq(row!.consumed_at_ms, null, "row starts unconsumed");

		// 2. First verify succeeds.
		const v1 = await verifyAndConsumeToken(env, grant.token, { now_ms: baseNow + 1_000 });
		ctx.assert.ok(v1.ok, "first verify is ok");
		if (v1.ok) {
			ctx.assert.eq(v1.cook_session_id, cook_session_id, "verify returns cook_session_id");
			ctx.assert.eq(v1.member_id, member_id, "verify returns member_id");
		}
		ctx.assert.notEq(
			db.tokens.get(grant.token)!.consumed_at_ms,
			null,
			"row marked consumed after first verify",
		);

		// 3. Second verify rejects (consumed).
		const v2 = await verifyAndConsumeToken(env, grant.token, { now_ms: baseNow + 2_000 });
		ctx.assert.ok(!v2.ok, "second verify rejects");
		if (!v2.ok) ctx.assert.eq(v2.reason, "consumed", "rejected as already consumed");

		// 4. Expired token rejects without flipping anything.
		const grantExp = await grantToken(env, {
			cook_session_id,
			member_id: "mem_bob",
		}, { now_ms: baseNow });
		const expiredAt = baseNow + BRIGADE_TOKEN_TTL_MS + 1;
		const vExp = await verifyAndConsumeToken(env, grantExp.token, { now_ms: expiredAt });
		ctx.assert.ok(!vExp.ok, "expired token rejects");
		if (!vExp.ok) ctx.assert.eq(vExp.reason, "expired", "reason is expired");
		ctx.assert.eq(
			db.tokens.get(grantExp.token)!.consumed_at_ms,
			null,
			"expired row is NOT marked consumed (still NULL)",
		);

		// 5. Session mismatch.
		const grantOther = await grantToken(env, {
			cook_session_id: "cs_other",
			member_id,
		}, { now_ms: baseNow });
		const vMismatch = await verifyAndConsumeToken(env, grantOther.token, {
			now_ms: baseNow + 1_000,
			expected_cook_session_id: cook_session_id,
		});
		ctx.assert.ok(!vMismatch.ok, "session mismatch rejects");
		if (!vMismatch.ok) {
			ctx.assert.eq(vMismatch.reason, "session_mismatch", "reason is session_mismatch");
		}
		ctx.assert.eq(
			db.tokens.get(grantOther.token)!.consumed_at_ms,
			null,
			"mismatched-session token is not consumed",
		);

		// 6. Missing / unknown.
		const vMissing = await verifyAndConsumeToken(env, null);
		ctx.assert.ok(!vMissing.ok, "missing token rejects");
		if (!vMissing.ok) ctx.assert.eq(vMissing.reason, "missing", "reason is missing");

		const vUnknown = await verifyAndConsumeToken(env, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
		ctx.assert.ok(!vUnknown.ok, "unknown token rejects");
		if (!vUnknown.ok) ctx.assert.eq(vUnknown.reason, "not_found", "reason is not_found");
	},
};

export default u56;

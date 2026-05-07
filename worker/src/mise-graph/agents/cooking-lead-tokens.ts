// Wave 8 foundation — one-time WS auth tokens for the CookingLeadAgent.
//
// Flow:
//   1. Admin (or MealAgent at active_cook entry) calls grantToken(env, {...}).
//   2. We insert a row into D1.mise_brigade_pending_tokens with consumed=NULL
//      and expires_at_ms = now + BRIGADE_TOKEN_TTL_MS.
//   3. Phone connects to wss://.../cooking-lead/<id>/ws?token=<token>.
//   4. The CookingLeadAgent calls verifyAndConsumeToken(env, token).
//   5. On success the token row is marked consumed (single-use) and we
//      return {ok:true, cook_session_id, member_id}. On failure {ok:false}.
//
// All functions here are best-effort: they do NOT throw on infra failure,
// they return structured errors so the DO can decide how to respond.
//
// Token format: 32-char base32 (Crockford alphabet, no I/L/O/U). The
// alphabet is unambiguous when read aloud, lower-case-tolerant, and URL-safe.
// 32 chars × 5 bits = 160 bits — same as a SHA-1 digest, plenty for a
// 10-minute single-use credential.

import type { MiseGraphEnv } from "../types";
import {
	BRIGADE_TOKEN_TTL_MS,
	type GrantTokenRequest,
	type GrantTokenResponse,
	type VerifyTokenResult,
} from "./cooking-lead-types";

const TOKEN_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TOKEN_LENGTH = 32;

/**
 * Generate a fresh brigade token. Uses crypto.getRandomValues — workerd
 * provides this on the global scope. Falls back to Math.random when run
 * under Node tests where crypto isn't bound to globalThis.
 */
export function generateBrigadeToken(): string {
	const bytes = new Uint8Array(TOKEN_LENGTH);
	const cryptoLike: { getRandomValues?: (a: Uint8Array) => Uint8Array } | undefined =
		typeof globalThis !== "undefined" ? (globalThis as unknown as {
			crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array };
		}).crypto : undefined;
	if (cryptoLike?.getRandomValues) {
		cryptoLike.getRandomValues(bytes);
	} else {
		for (let i = 0; i < TOKEN_LENGTH; i++) {
			bytes[i] = Math.floor(Math.random() * 256);
		}
	}
	let out = "";
	for (let i = 0; i < TOKEN_LENGTH; i++) {
		out += TOKEN_ALPHABET[bytes[i] % TOKEN_ALPHABET.length];
	}
	return out;
}

export interface GrantOptions {
	now_ms?: number;
	ttl_ms?: number;
}

/**
 * Insert a fresh pending-token row. Returns the token + its expiry. The
 * caller is responsible for delivering the token to the member's phone
 * out-of-band (push notification, SMS, etc. — Wave 8B owns delivery).
 */
export async function grantToken(
	env: MiseGraphEnv,
	args: GrantTokenRequest,
	opts: GrantOptions = {},
): Promise<GrantTokenResponse> {
	if (!args.cook_session_id) throw new Error("cook_session_id required");
	if (!args.member_id) throw new Error("member_id required");

	const token = generateBrigadeToken();
	const now = opts.now_ms ?? Date.now();
	const ttl = opts.ttl_ms ?? BRIGADE_TOKEN_TTL_MS;
	const expires = now + ttl;

	await env.DB.prepare(`
		INSERT INTO mise_brigade_pending_tokens
			(token, cook_session_id, member_id, expires_at_ms, consumed_at_ms, created_at_ms)
		VALUES (?, ?, ?, ?, NULL, ?)
	`).bind(
		token,
		args.cook_session_id,
		args.member_id,
		expires,
		now,
	).run();

	return {
		token,
		expires_at_ms: expires,
		cook_session_id: args.cook_session_id,
		member_id: args.member_id,
	};
}

interface PendingTokenRow {
	token: string;
	cook_session_id: string;
	member_id: string;
	expires_at_ms: number;
	consumed_at_ms: number | null;
}

export interface VerifyOptions {
	now_ms?: number;
	expected_cook_session_id?: string;
}

/**
 * Verify and atomically consume a token. The atomic-consume step uses an
 * UPDATE … WHERE consumed_at_ms IS NULL — D1 reports `meta.changes` so we
 * know whether we won the race. If two CookingLeadAgent instances raced on
 * the same token, exactly one wins. The other gets {ok:false, "consumed"}.
 */
export async function verifyAndConsumeToken(
	env: MiseGraphEnv,
	token: string | null | undefined,
	opts: VerifyOptions = {},
): Promise<VerifyTokenResult> {
	if (!token) return { ok: false, reason: "missing" };

	const row = await env.DB.prepare(`
		SELECT token, cook_session_id, member_id, expires_at_ms, consumed_at_ms
		FROM mise_brigade_pending_tokens
		WHERE token = ?
		LIMIT 1
	`).bind(token).first<PendingTokenRow>();

	if (!row) return { ok: false, reason: "not_found" };
	if (row.consumed_at_ms !== null) return { ok: false, reason: "consumed" };

	const now = opts.now_ms ?? Date.now();
	if (row.expires_at_ms < now) return { ok: false, reason: "expired" };

	if (
		opts.expected_cook_session_id &&
		row.cook_session_id !== opts.expected_cook_session_id
	) {
		return { ok: false, reason: "session_mismatch" };
	}

	const consumeResult = await env.DB.prepare(`
		UPDATE mise_brigade_pending_tokens
		SET consumed_at_ms = ?
		WHERE token = ? AND consumed_at_ms IS NULL
	`).bind(now, token).run();

	const changes = consumeResult.meta?.changes ?? 0;
	if (changes < 1) return { ok: false, reason: "consumed" };

	return {
		ok: true,
		cook_session_id: row.cook_session_id,
		member_id: row.member_id,
	};
}

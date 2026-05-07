/**
 * Cloudflare Access authentication helper.
 *
 * In production, CF Access fronts the Pages project and injects
 * `Cf-Access-Authenticated-User-Email` on every authenticated request.
 *
 * For local development, set `DEV_USER_EMAIL` in `.env.local` — the same
 * email string is used as the canonical identity. household_id is derived
 * deterministically from the email so MCP tool calls always have a household.
 */

export class UnauthorizedError extends Error {
  status = 401;
  constructor(message = "unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export interface Session {
  user_email: string;
  household_id: string;
}

const ACCESS_HEADER = "cf-access-authenticated-user-email";

/** Slug an email into a deterministic household_id. */
export function householdIdFromEmail(email: string): string {
  const safe = email.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return `hh_${safe}`;
}

/** Read a session from a Request — throws UnauthorizedError if none. */
export async function getSessionFromRequest(req: Request): Promise<Session> {
  const headerEmail = req.headers.get(ACCESS_HEADER);
  const fallback = process.env.DEV_USER_EMAIL ?? null;
  const email = headerEmail ?? fallback;
  if (!email) {
    throw new UnauthorizedError(
      "no auth — set up Cloudflare Access in prod, or DEV_USER_EMAIL locally",
    );
  }
  return {
    user_email: email,
    household_id: householdIdFromEmail(email),
  };
}

/** Variant that returns null instead of throwing — useful in Server Components. */
export async function tryGetSession(req: Request): Promise<Session | null> {
  try {
    return await getSessionFromRequest(req);
  } catch {
    return null;
  }
}

/** Headers helper for Server Components — reads via next/headers. */
export async function getSessionFromHeaders(
  headers: Headers | { get: (k: string) => string | null },
): Promise<Session> {
  const email = headers.get(ACCESS_HEADER) ?? process.env.DEV_USER_EMAIL ?? null;
  if (!email) throw new UnauthorizedError("no auth header");
  return {
    user_email: email,
    household_id: householdIdFromEmail(email),
  };
}

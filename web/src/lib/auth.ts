import type { NextRequest } from "next/server";
import { usersConfigured, verifySessionToken } from "./session";

/**
 * Request authentication, in order of preference:
 * 1. Session cookie (APP_USERS + APP_SESSION_SECRET set) — the real sign-in.
 * 2. x-app-key header (APP_KEY set) — the vertical-slice gate, kept for dev.
 * 3. Neither configured — open, for local development only.
 * Returns the acting user identity for the audit log.
 */
export function authenticate(req: NextRequest): { ok: boolean; user: string } {
  if (usersConfigured()) {
    const token = req.cookies.get("session")?.value;
    if (token) {
      const email = verifySessionToken(token);
      if (email) return { ok: true, user: email };
    }
    // Fall through to app-key only if one is also configured (transition aid).
  }
  const key = process.env.APP_KEY;
  if (key) {
    if (req.headers.get("x-app-key") === key) return { ok: true, user: "app-key" };
    return { ok: false, user: "" };
  }
  if (usersConfigured()) return { ok: false, user: "" };
  // Never run open on a public host: outside local dev, no configured auth
  // means no access at all.
  if (process.env.NODE_ENV === "production") return { ok: false, user: "" };
  return { ok: true, user: "dev" };
}

/** Back-compat boolean used by existing routes. */
export function authorized(req: NextRequest): boolean {
  return authenticate(req).ok;
}

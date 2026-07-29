import type { NextRequest } from "next/server";
import { usersConfigured, verifySessionToken } from "./session";
import { getUser, type Role } from "./users";

/**
 * Request authentication, in order of preference:
 * 1. Session cookie (user store or APP_USERS seed + APP_SESSION_SECRET).
 * 2. x-app-key header (APP_KEY set) — dev/transition gate, acts as admin.
 * 3. Neither configured — open in local dev only; production fails closed.
 */
export function authenticate(req: NextRequest): { ok: boolean; user: string; role: Role } {
  if (usersConfigured()) {
    const token = req.cookies.get("session")?.value;
    if (token) {
      const email = verifySessionToken(token);
      if (email) {
        const record = getUser(email);
        // A deleted user's outstanding cookie must stop working immediately.
        if (record) return { ok: true, user: email, role: record.role };
      }
    }
  }
  const key = process.env.APP_KEY;
  if (key) {
    if (req.headers.get("x-app-key") === key) return { ok: true, user: "app-key", role: "admin" };
    return { ok: false, user: "", role: "member" };
  }
  if (usersConfigured()) return { ok: false, user: "", role: "member" };
  if (process.env.NODE_ENV === "production") return { ok: false, user: "", role: "member" };
  return { ok: true, user: "dev", role: "admin" };
}

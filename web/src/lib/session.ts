import crypto from "node:crypto";

/**
 * Cookie-session sign-in (Phase C). Users come from the APP_USERS env var
 * ("email:password,email:password" — the allow-list model from
 * IMPLEMENTATION_SPEC §5); sessions are HMAC-signed tokens in an HttpOnly
 * cookie. No identity provider, no database — right-sized for a household.
 */

const SESSION_DAYS = 90;

function secret(): string {
  const s = process.env.APP_SESSION_SECRET;
  if (!s) throw new Error("APP_SESSION_SECRET is not set");
  return s;
}

export function usersConfigured(): boolean {
  return Boolean(process.env.APP_USERS && process.env.APP_SESSION_SECRET);
}

export function checkCredentials(email: string, password: string): boolean {
  const users = (process.env.APP_USERS ?? "").split(",");
  const norm = email.trim().toLowerCase();
  for (const u of users) {
    const idx = u.indexOf(":");
    if (idx < 1) continue;
    const uEmail = u.slice(0, idx).trim().toLowerCase();
    const uPass = u.slice(idx + 1);
    if (uEmail !== norm) continue;
    const a = Buffer.from(uPass);
    const b = Buffer.from(password);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  return false;
}

function sign(payload: string): string {
  return crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
}

export function createSessionToken(email: string, nowMs = Date.now()): string {
  const exp = nowMs + SESSION_DAYS * 24 * 3600 * 1000;
  const payload = Buffer.from(`${email}|${exp}`).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function verifySessionToken(token: string, nowMs = Date.now()): string | null {
  const dot = token.lastIndexOf(".");
  if (dot < 1) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expect = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const decoded = Buffer.from(payload, "base64url").toString();
  const sep = decoded.lastIndexOf("|");
  if (sep < 1) return null;
  const email = decoded.slice(0, sep);
  const exp = Number(decoded.slice(sep + 1));
  if (!Number.isFinite(exp) || nowMs > exp) return null;
  return email;
}

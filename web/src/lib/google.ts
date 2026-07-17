import crypto from "node:crypto";

/**
 * "Sign in with Google" — OAuth 2.0 authorization-code flow, kept deliberately
 * small. Google only replaces the password check: it proves "this person
 * controls that Gmail address", and then the app's own allow-list (the user
 * store) decides whether that address may sign in at all, with which role.
 * Session issuance is the same HMAC cookie as password sign-in.
 *
 * The ID token arrives directly from Google's token endpoint over TLS, so
 * per Google's guidance its signature need not be re-verified; we still
 * validate issuer, audience, expiry, and email_verified.
 */

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

export function googleConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

/**
 * Public base URL for building absolute URLs sent to the BROWSER. Behind
 * Railway's proxy the request origin is the internal bind address
 * (https://0.0.0.0:8080), which a browser cannot navigate to — so
 * APP_BASE_URL wins whenever it is set, and the request origin is only a
 * local-dev fallback.
 */
export function appBaseUrl(requestOrigin: string): string {
  return (process.env.APP_BASE_URL || requestOrigin).replace(/\/+$/, "");
}

export function redirectUri(requestOrigin: string): string {
  return `${appBaseUrl(requestOrigin)}/api/auth/google/callback`;
}

/** Random state value, HMAC-signed so the callback can verify we minted it. */
export function createStateToken(nowMs = Date.now()): string {
  const secret = process.env.APP_SESSION_SECRET;
  if (!secret) throw new Error("APP_SESSION_SECRET is not set");
  const payload = Buffer.from(`${crypto.randomBytes(12).toString("hex")}|${nowMs + 10 * 60_000}`).toString("base64url");
  const sig = crypto.createHmac("sha256", secret + "|oauth-state").update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyStateToken(state: string, nowMs = Date.now()): boolean {
  const secret = process.env.APP_SESSION_SECRET;
  if (!secret) return false;
  const dot = state.lastIndexOf(".");
  if (dot < 1) return false;
  const payload = state.slice(0, dot);
  const expect = crypto.createHmac("sha256", secret + "|oauth-state").update(payload).digest("base64url");
  const a = Buffer.from(state.slice(dot + 1));
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  const exp = Number(Buffer.from(payload, "base64url").toString().split("|")[1]);
  return Number.isFinite(exp) && nowMs <= exp;
}

export function googleAuthUrl(requestOrigin: string, state: string): string {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    redirect_uri: redirectUri(requestOrigin),
    response_type: "code",
    scope: "openid email",
    state,
    prompt: "select_account",
  });
  return `${AUTH_ENDPOINT}?${params}`;
}

/** Validate an ID-token payload; returns the verified email or null. */
export function emailFromIdTokenPayload(
  payload: Record<string, unknown>,
  clientId: string,
  nowMs = Date.now(),
): string | null {
  if (payload.iss !== "https://accounts.google.com" && payload.iss !== "accounts.google.com") return null;
  if (payload.aud !== clientId) return null;
  if (typeof payload.exp !== "number" || nowMs / 1000 > payload.exp) return null;
  if (payload.email_verified !== true) return null;
  if (typeof payload.email !== "string" || !payload.email) return null;
  return payload.email.trim().toLowerCase();
}

/** Exchange the authorization code and return the verified email, or throw. */
export async function exchangeCodeForEmail(code: string, requestOrigin: string): Promise<string> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: redirectUri(requestOrigin),
      grant_type: "authorization_code",
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Google token exchange failed (HTTP ${res.status})`);
  const body = (await res.json()) as { id_token?: string };
  if (!body.id_token) throw new Error("Google response had no id_token");
  const parts = body.id_token.split(".");
  if (parts.length !== 3) throw new Error("malformed id_token");
  const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString()) as Record<string, unknown>;
  const email = emailFromIdTokenPayload(payload, process.env.GOOGLE_CLIENT_ID!);
  if (!email) throw new Error("id_token failed validation");
  return email;
}

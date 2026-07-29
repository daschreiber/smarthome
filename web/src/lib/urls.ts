import crypto from "node:crypto";

/**
 * Public base URL for building absolute URLs sent to the browser or
 * registered with OAuth providers. Behind Railway's proxy the request
 * origin is the internal bind address (https://0.0.0.0:8080), which a
 * browser cannot navigate to and which never byte-matches a provider's
 * registered redirect URI — so APP_BASE_URL wins whenever it is set,
 * RAILWAY_PUBLIC_DOMAIN backs it up, and the request origin is only a
 * local-dev fallback. Callers with no origin to fall back on (Spotify's
 * dashboard-registered redirect) get a hard error instead of a URL that
 * cannot work.
 */
export function publicBaseUrl(requestOrigin?: string): string {
  const base =
    process.env.APP_BASE_URL ||
    (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null) ||
    requestOrigin;
  if (!base) throw new Error("APP_BASE_URL is not set — required to build public URLs");
  return base.replace(/\/+$/, "");
}

/**
 * HMAC-signed OAuth state: a random nonce + expiry, signed with the app
 * session secret, so a callback can verify we minted the state without any
 * server-side storage — it survives restarts and works across instances.
 * Shared by the Google sign-in and Spotify link flows.
 */
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

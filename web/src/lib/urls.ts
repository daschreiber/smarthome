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

/** The flows that mint OAuth state. Part of each token's HMAC key. */
export type OAuthStatePurpose = "google-signin" | "spotify-link";

/**
 * HMAC-signed OAuth state: a random nonce + expiry, signed with the app
 * session secret, so a callback can verify we minted the state without any
 * server-side storage — it survives restarts and works across instances.
 *
 * The PURPOSE is part of the key, never optional: the Google sign-in route
 * that mints its state is unauthenticated (it's a sign-in button), while
 * the Spotify link mint is admin-gated. With a shared key, a state fished
 * out of the Google redirect would verify in the Spotify callback and let
 * anyone overwrite the household's Spotify link (Codex review, PR #91).
 * Purpose-scoped keys keep each callback accepting only its own flow's
 * states.
 */
/**
 * The optional SUBJECT rides inside the signed payload, which is what makes
 * per-user Spotify linking safe: the Spotify callback carries no app
 * credentials of its own, so "which household account is this consent for?"
 * has to be unforgeable. Signed into the state, it cannot be edited into
 * someone else's — a member cannot come back from Spotify holding a state
 * that overwrites the admin's link.
 */
export function createStateToken(purpose: OAuthStatePurpose, nowMs = Date.now(), subject = ""): string {
  const secret = process.env.APP_SESSION_SECRET;
  if (!secret) throw new Error("APP_SESSION_SECRET is not set");
  const nonce = crypto.randomBytes(12).toString("hex");
  // Subject-less tokens keep their original two-field payload, so states
  // minted by the previous build still verify across a deploy.
  const body = subject
    ? `${nonce}|${nowMs + 10 * 60_000}|${Buffer.from(subject).toString("base64url")}`
    : `${nonce}|${nowMs + 10 * 60_000}`;
  const payload = Buffer.from(body).toString("base64url");
  const sig = crypto.createHmac("sha256", `${secret}|oauth-state|${purpose}`).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

/** Verify and unpack: `subject` is null for tokens minted without one. */
export function readStateToken(
  purpose: OAuthStatePurpose,
  state: string,
  nowMs = Date.now(),
): { ok: boolean; subject: string | null } {
  const no = { ok: false, subject: null };
  const secret = process.env.APP_SESSION_SECRET;
  if (!secret) return no;
  const dot = state.lastIndexOf(".");
  if (dot < 1) return no;
  const payload = state.slice(0, dot);
  const expect = crypto.createHmac("sha256", `${secret}|oauth-state|${purpose}`).update(payload).digest("base64url");
  const a = Buffer.from(state.slice(dot + 1));
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return no;
  const [, expRaw, subRaw] = Buffer.from(payload, "base64url").toString().split("|");
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || nowMs > exp) return no;
  return { ok: true, subject: subRaw ? Buffer.from(subRaw, "base64url").toString() : null };
}

export function verifyStateToken(purpose: OAuthStatePurpose, state: string, nowMs = Date.now()): boolean {
  return readStateToken(purpose, state, nowMs).ok;
}

/**
 * In-memory lockout for password verification (sign-in and lock unlock).
 *
 * The password is the single factor guarding disruptive and safety-sensitive
 * actions — since Phase F it also stands between a stolen, signed-in phone and
 * the front-door deadbolt (the unlock route re-checks it). A fixed per-request
 * delay alone does not stop parallel or sustained online guessing, so failures
 * are counted per account and per source IP and the principal is paused once
 * either crosses its threshold.
 *
 * State is process-local. Railway runs a single always-on instance
 * (docs/DEPLOY_RAILWAY.md), so one map is sufficient; it resets on redeploy,
 * which only ever *clears* a lockout — an attacker cannot use a redeploy to
 * escape one, and a legitimate user is never stuck locked across a deploy.
 * If the app is ever scaled to multiple replicas, move this to a shared store.
 */

const WINDOW_MS = 15 * 60_000; // failures older than this no longer count
const LOCKOUT_MS = 15 * 60_000; // how long a tripped threshold stays locked
const ACCOUNT_MAX = 5; // failures for one email before that account pauses
const IP_MAX = 20; // failures from one IP (a household NAT hosts a few users)
const MAX_KEYS = 10_000; // guard against unbounded growth under a spray attack

interface Attempts {
  count: number;
  windowStart: number;
  lockedUntil: number;
}

const byAccount = new Map<string, Attempts>();
const byIp = new Map<string, Attempts>();

export interface ThrottleStatus {
  locked: boolean;
  /** Milliseconds until the caller may try again; 0 when not locked. */
  retryAfterMs: number;
}

function statusOf(map: Map<string, Attempts>, key: string, now: number): ThrottleStatus {
  const a = map.get(key);
  if (!a || now >= a.lockedUntil) return { locked: false, retryAfterMs: 0 };
  return { locked: true, retryAfterMs: a.lockedUntil - now };
}

function bump(map: Map<string, Attempts>, key: string, max: number, now: number): void {
  sweep(map, now);
  let a = map.get(key);
  if (!a || now - a.windowStart > WINDOW_MS) {
    a = { count: 0, windowStart: now, lockedUntil: a?.lockedUntil ?? 0 };
    map.set(key, a);
  }
  a.count += 1;
  if (a.count >= max) a.lockedUntil = now + LOCKOUT_MS;
}

/** Drop entries that are neither locked nor inside their counting window. */
function sweep(map: Map<string, Attempts>, now: number): void {
  if (map.size < MAX_KEYS) return;
  for (const [key, a] of map) {
    if (now >= a.lockedUntil && now - a.windowStart > WINDOW_MS) map.delete(key);
  }
}

function ipKey(ip: string): string {
  return ip || "unknown";
}

/**
 * Whether this (account, ip) pair is currently locked out, and for how long.
 * Locked if *either* the account or the source IP has crossed its threshold.
 */
export function throttleStatus(email: string, ip: string, now: number = Date.now()): ThrottleStatus {
  const a = statusOf(byAccount, email, now);
  const i = statusOf(byIp, ipKey(ip), now);
  if (!a.locked && !i.locked) return { locked: false, retryAfterMs: 0 };
  return { locked: true, retryAfterMs: Math.max(a.retryAfterMs, i.retryAfterMs) };
}

/** Record a failed password check against both the account and the IP. */
export function recordFailure(email: string, ip: string, now: number = Date.now()): void {
  bump(byAccount, email, ACCOUNT_MAX, now);
  bump(byIp, ipKey(ip), IP_MAX, now);
}

/** Clear counters after a successful check so normal use is never penalised. */
export function recordSuccess(email: string, ip: string): void {
  byAccount.delete(email);
  byIp.delete(ipKey(ip));
}

/** Best-effort client IP from the proxy chain (Railway sets x-forwarded-for). */
export function clientIp(req: { headers: { get(name: string): string | null } }): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}

export const throttleLimits = { WINDOW_MS, LOCKOUT_MS, ACCOUNT_MAX, IP_MAX };

/** Test-only: wipe all counters between cases. */
export function __resetThrottle(): void {
  byAccount.clear();
  byIp.clear();
}

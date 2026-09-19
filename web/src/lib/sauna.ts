/**
 * Adapter for the KLAFS sauna app (github.com/daschreiber/sauna, deployed as
 * its own service). The sauna joins the registry as a virtual device; this module is
 * the only code that talks to the sauna service. All KLAFS complexity
 * (session management, preselection recovery, heating watchdog) lives in the
 * sauna app — we deliberately consume its verified /api/quick endpoints
 * rather than reimplement any of it.
 */

const STATUS_TIMEOUT_MS = 8000;
// /api/quick/start verifies heating server-side and can take a while.
const COMMAND_TIMEOUT_MS = 90_000;

/**
 * Server-side read cache. The dashboard polls /api/home every 3s and the
 * scheduler ticks every 30s; without this, every poll became two sauna-app
 * requests, each costing that app several Upstash Redis commands. One open
 * dashboard tab burned through the sauna app's 500k-requests/month Redis
 * quota in days (live incident 2026-09-19: nobody could sign in to the sauna
 * app, and its hammered KLAFS login tripped the KLAFS account lockout).
 * Cabin temperature moves a degree a minute at most; 30s staleness is
 * invisible from the sofa. Errors are cached briefly too, so a down sauna
 * app is not re-polled every 3s. Commands invalidate the cache so the
 * card reflects a start/stop on the next poll.
 */
const STATUS_CACHE_MS = 30_000;
const SCHEDULE_CACHE_MS = 60_000;
const ERROR_CACHE_MS = 15_000;

interface Memo<T> {
  value?: { result: T; at: number };
  error?: { err: unknown; at: number };
  inflight?: Promise<T>;
}

const statusMemo: Memo<SaunaStatus> = {};
const scheduleMemo: Memo<{ stopAt: string | null }> = {};

async function memoized<T>(memo: Memo<T>, ttlMs: number, fetcher: () => Promise<T>): Promise<T> {
  const now = Date.now();
  if (memo.value && now - memo.value.at < ttlMs) return memo.value.result;
  if (memo.error && now - memo.error.at < ERROR_CACHE_MS) throw memo.error.err;
  if (memo.inflight) return memo.inflight;
  memo.inflight = fetcher()
    .then((result) => {
      memo.value = { result, at: Date.now() };
      memo.error = undefined;
      return result;
    })
    .catch((err: unknown) => {
      memo.error = { err, at: Date.now() };
      throw err;
    })
    .finally(() => {
      memo.inflight = undefined;
    });
  return memo.inflight;
}

/** Drop cached reads — after a command, or in tests. */
export function invalidateSaunaCache(): void {
  statusMemo.value = statusMemo.error = statusMemo.inflight = undefined;
  scheduleMemo.value = scheduleMemo.error = scheduleMemo.inflight = undefined;
}

export interface SaunaStatus {
  poweredOn: boolean;
  connected: boolean;
  currentTemperature: number;
  selectedTemperature: number;
  readyForUse: boolean;
}

export function saunaConfigured(): boolean {
  return Boolean(process.env.SAUNA_BASE_URL && process.env.SAUNA_API_TOKEN);
}

async function quick(
  path: string,
  params: Record<string, string>,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const base = (process.env.SAUNA_BASE_URL ?? "").replace(/\/+$/, "");
  const token = process.env.SAUNA_API_TOKEN ?? "";
  if (!base || !token) throw new Error("sauna is not configured");
  const qs = new URLSearchParams({ token, ...params });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}${path}?${qs}`, {
      signal: controller.signal,
      cache: "no-store",
    });
    // Gateway errors (Vercel timeouts) return plain text, not JSON.
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      /* non-JSON body; the status code carries the story */
    }
    if (!res.ok || body.error) {
      throw new Error(String(body.error ?? `sauna API HTTP ${res.status} ${text.slice(0, 80)}`));
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

/** Current cabin status, served from a 30s server-side cache (see STATUS_CACHE_MS). */
export function saunaStatus(): Promise<SaunaStatus> {
  return memoized(statusMemo, STATUS_CACHE_MS, async () => {
    const b = await quick("/api/quick/status", {}, STATUS_TIMEOUT_MS);
    return {
      poweredOn: Boolean(b.isPoweredOn),
      connected: Boolean(b.isConnected),
      currentTemperature: Number(b.currentTemperature ?? 0),
      selectedTemperature: Number(b.selectedTemperature ?? 0),
      readyForUse: Boolean(b.isReadyForUse),
    };
  });
}

export interface SaunaCommandResult {
  /** true = the sauna app verified the outcome; false = command landed, verification continues server-side. */
  verified: boolean;
  message: string;
}

/**
 * The sauna app's /api/quick/start verifies REAL heating by polling cabin
 * temperature for up to two minutes — longer than its serverless platform
 * allows, so the HTTP call can die mid-verification. That is anticipated:
 * the app arms a watchdog cron BEFORE verifying, and the watchdog owns the
 * start from the moment the command lands. So a gateway timeout/5xx here is
 * NOT a failure — it's "sent, being verified"; only an explicit refusal
 * (bad token, KLAFS safety lock, verified non-ignition) is an error.
 */
function sentDespite(err: unknown, message: string): SaunaCommandResult {
  const m = err instanceof Error ? err.message : String(err);
  if (/HTTP 5\d\d|timed? ?out|abort|network|socket/i.test(m)) {
    return { verified: false, message };
  }
  throw err;
}

export interface SaunaStartOptions {
  /** Target °C (40-100); the sauna app defaults to 85 when omitted. */
  temp?: number;
  /** Auto-stop after N minutes (15-480), scheduled by the sauna app. */
  stopAfterMinutes?: number;
}

/** Starts with server-side heating verification; options ride the query string. */
export async function saunaStart(opts: SaunaStartOptions = {}): Promise<SaunaCommandResult & { stopAt?: string | null }> {
  const params: Record<string, string> = {};
  if (opts.temp != null) params.temp = String(Math.round(opts.temp));
  if (opts.stopAfterMinutes != null) params.stop_after = String(Math.round(opts.stopAfterMinutes));
  invalidateSaunaCache();
  try {
    const b = await quick("/api/quick/start", params, COMMAND_TIMEOUT_MS);
    if (b.success !== true) {
      throw new Error(String(b.warning ?? "sauna start not confirmed"));
    }
    return {
      verified: b.verified !== false,
      message: String(b.message ?? "sauna starting"),
      stopAt: typeof b.stop_at === "string" ? b.stop_at : null,
    };
  } catch (err) {
    return sentDespite(err, "start sent — the sauna app's watchdog is verifying ignition");
  }
}

/** Schedule (or replace) the app-managed auto-stop for a running sauna. */
export async function saunaStopIn(minutes: number): Promise<{ stopAt: string }> {
  invalidateSaunaCache();
  const b = await quick("/api/quick/stop-in", { minutes: String(Math.round(minutes)) }, STATUS_TIMEOUT_MS);
  if (b.success !== true || typeof b.stop_at !== "string") {
    throw new Error(String(b.error ?? "auto-stop not scheduled"));
  }
  return { stopAt: b.stop_at };
}

/** Pending app-managed auto-stop, if any. Null when the endpoint is absent (older sauna app). */
export function saunaScheduleStatus(): Promise<{ stopAt: string | null }> {
  return memoized(scheduleMemo, SCHEDULE_CACHE_MS, async () => {
    try {
      const b = await quick("/api/quick/schedule-status", {}, STATUS_TIMEOUT_MS);
      return { stopAt: typeof b.stop_at === "string" ? b.stop_at : null };
    } catch {
      return { stopAt: null };
    }
  });
}

export async function saunaStop(): Promise<SaunaCommandResult> {
  invalidateSaunaCache();
  try {
    const b = await quick("/api/quick/stop", {}, COMMAND_TIMEOUT_MS);
    if (b.success !== true) {
      throw new Error(String(b.warning ?? "sauna stop not confirmed"));
    }
    return { verified: true, message: String(b.message ?? "sauna stopped") };
  } catch (err) {
    return sentDespite(err, "stop sent — check the cabin status in a moment");
  }
}

export async function saunaSetTemperature(temp: number): Promise<void> {
  // Last gate before the heater: refuse an out-of-range set-point outright
  // rather than trusting callers. Callers should already have passed
  // assertCommandAllowed, but this adapter must not forward an unsafe value.
  if (!Number.isFinite(temp) || temp < 40 || temp > 100) {
    throw new Error(`sauna temperature ${temp} out of safe range 40-100`);
  }
  invalidateSaunaCache();
  const b = await quick(
    "/api/quick/temperature",
    { temp: String(Math.round(temp)) },
    COMMAND_TIMEOUT_MS,
  );
  if (b.success !== true) throw new Error("temperature change not confirmed");
}

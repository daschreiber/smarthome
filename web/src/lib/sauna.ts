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

export async function saunaStatus(): Promise<SaunaStatus> {
  const b = await quick("/api/quick/status", {}, STATUS_TIMEOUT_MS);
  return {
    poweredOn: Boolean(b.isPoweredOn),
    connected: Boolean(b.isConnected),
    currentTemperature: Number(b.currentTemperature ?? 0),
    selectedTemperature: Number(b.selectedTemperature ?? 0),
    readyForUse: Boolean(b.isReadyForUse),
  };
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

/** Starts at the sauna app's default 85°C with server-side heating verification. */
export async function saunaStart(): Promise<SaunaCommandResult> {
  try {
    const b = await quick("/api/quick/start", {}, COMMAND_TIMEOUT_MS);
    if (b.success !== true) {
      throw new Error(String(b.warning ?? "sauna start not confirmed"));
    }
    return {
      verified: b.verified !== false,
      message: String(b.message ?? "sauna starting"),
    };
  } catch (err) {
    return sentDespite(err, "start sent — the sauna app's watchdog is verifying ignition");
  }
}

export async function saunaStop(): Promise<SaunaCommandResult> {
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
  const b = await quick(
    "/api/quick/temperature",
    { temp: String(Math.round(temp)) },
    COMMAND_TIMEOUT_MS,
  );
  if (b.success !== true) throw new Error("temperature change not confirmed");
}

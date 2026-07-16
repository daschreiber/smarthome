/**
 * Adapter for the KLAFS sauna app (github.com/daschreiber/sauna, deployed on
 * Vercel). The sauna joins the registry as a virtual device; this module is
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
    const body = (await res.json()) as Record<string, unknown>;
    if (!res.ok || body.error) {
      throw new Error(String(body.error ?? `sauna API HTTP ${res.status}`));
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

/** Starts at the sauna app's default 85°C with server-side heating verification. */
export async function saunaStart(): Promise<string> {
  const b = await quick("/api/quick/start", {}, COMMAND_TIMEOUT_MS);
  if (b.success !== true) {
    throw new Error(String(b.warning ?? "sauna start not confirmed"));
  }
  return String(b.message ?? "sauna starting");
}

export async function saunaStop(): Promise<string> {
  const b = await quick("/api/quick/stop", {}, COMMAND_TIMEOUT_MS);
  if (b.success !== true) {
    throw new Error(String(b.warning ?? "sauna stop not confirmed"));
  }
  return String(b.message ?? "sauna stopped");
}

export async function saunaSetTemperature(temp: number): Promise<void> {
  const b = await quick(
    "/api/quick/temperature",
    { temp: String(Math.round(temp)) },
    COMMAND_TIMEOUT_MS,
  );
  if (b.success !== true) throw new Error("temperature change not confirmed");
}

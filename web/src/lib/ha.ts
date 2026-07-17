/**
 * Home Assistant adapter. The only module that talks to HA; everything above
 * works with application models (DESIGN_AND_DELIVERY_LOOP Loop 3).
 * 5s timeout, no blind retries for commands (IMPLEMENTATION_SPEC §10).
 */

const TIMEOUT_MS = 5000;

export interface HaState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_updated: string;
  /** Changes only on real state transitions (on↔off), not attribute updates. */
  last_changed: string;
}

function baseUrl(): string {
  const url = process.env.HA_BASE_URL;
  if (!url) throw new Error("HA_BASE_URL is not set");
  return url.replace(/\/+$/, "");
}

async function haFetch(pathname: string, init?: RequestInit): Promise<Response> {
  const token = process.env.HA_TOKEN;
  if (!token) throw new Error("HA_TOKEN is not set");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(`${baseUrl()}${pathname}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...init?.headers,
      },
      signal: controller.signal,
      cache: "no-store",
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function haHealth(): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await haFetch("/api/");
    if (!res.ok) return { ok: false, message: `HTTP ${res.status}` };
    const body = (await res.json()) as { message?: string };
    return { ok: true, message: body.message ?? "API running." };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export async function getStates(): Promise<HaState[]> {
  const res = await haFetch("/api/states");
  if (!res.ok) throw new Error(`GET /api/states failed: HTTP ${res.status}`);
  return (await res.json()) as HaState[];
}

export async function getState(entityId: string): Promise<HaState | null> {
  const res = await haFetch(`/api/states/${encodeURIComponent(entityId)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET state failed: HTTP ${res.status}`);
  return (await res.json()) as HaState;
}

/** POST /api/services/<domain>/<service>. Never sets states directly. */
export async function callService(
  domain: string,
  service: string,
  data: Record<string, unknown>,
): Promise<void> {
  const res = await haFetch(`/api/services/${domain}/${service}`, {
    method: "POST",
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`service ${domain}.${service} failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
}

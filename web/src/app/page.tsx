"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Vertical-slice UI (Loop 2): shows one room's real devices, sends typed
 * commands, and displays only HA-confirmed state. Pending / confirmed /
 * failed / unavailable are all explicit. Not the final design — the point
 * is proving the full path browser -> backend -> HA -> device -> browser.
 */

interface UiDevice {
  id: string;
  label: string;
  room: string;
  floor: number | null;
  group: string;
  kind: string;
  capabilities: string[];
  state: string;
  available: boolean;
  brightnessPct: number | null;
}

type Pending = { command: string; sentAt: number } | null;

const ROOM = "Daniel's Study";

export default function Page() {
  const [devices, setDevices] = useState<UiDevice[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Record<string, Pending>>({});
  const [flash, setFlash] = useState<Record<string, "ok" | "fail">>({});
  const [appKey, setAppKey] = useState<string>("");
  const keyRef = useRef("");

  useEffect(() => {
    const k = localStorage.getItem("appKey") ?? "";
    setAppKey(k);
    keyRef.current = k;
  }, []);

  const headers = useCallback(
    (): HeadersInit =>
      keyRef.current ? { "x-app-key": keyRef.current } : {},
    [],
  );

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/home", { headers: headers() });
      if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`);
      const body = (await res.json()) as { devices: UiDevice[] };
      setDevices(body.devices.filter((d) => d.room === ROOM));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load");
    }
  }, [headers]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  const send = useCallback(
    async (id: string, command: string, extra: Record<string, unknown> = {}) => {
      setPending((p) => ({ ...p, [id]: { command, sentAt: Date.now() } }));
      try {
        const res = await fetch(`/api/devices/${id}/command`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers() },
          body: JSON.stringify({ command, ...extra }),
        });
        const body = await res.json();
        if (!res.ok || body.status !== "confirmed") {
          throw new Error(body.error ?? "command failed");
        }
        setFlash((f) => ({ ...f, [id]: "ok" }));
      } catch {
        setFlash((f) => ({ ...f, [id]: "fail" }));
      } finally {
        setPending((p) => ({ ...p, [id]: null }));
        setTimeout(() => setFlash((f) => ({ ...f, [id]: undefined as never })), 1500);
        refresh();
      }
    },
    [headers, refresh],
  );

  const groups = useMemo(() => {
    const m = new Map<string, UiDevice[]>();
    for (const d of devices) m.set(d.group, [...(m.get(d.group) ?? []), d]);
    return [...m.entries()];
  }, [devices]);

  return (
    <main style={{ maxWidth: 480, margin: "0 auto", padding: "24px 16px" }}>
      <h1 style={{ fontSize: 22, margin: "0 0 4px" }}>{ROOM}</h1>
      <p style={{ color: "#7d8a97", fontSize: 13, marginTop: 0 }}>
        Vertical slice — commands are confirmed by Home Assistant before shown.
      </p>

      <details style={{ marginBottom: 16 }}>
        <summary style={{ color: "#7d8a97", fontSize: 13, cursor: "pointer" }}>
          App key
        </summary>
        <input
          type="password"
          value={appKey}
          placeholder="only needed if APP_KEY is set"
          onChange={(e) => {
            setAppKey(e.target.value);
            keyRef.current = e.target.value;
            localStorage.setItem("appKey", e.target.value);
          }}
          style={{
            width: "100%", padding: 8, marginTop: 8, borderRadius: 8,
            border: "1px solid #2a3644", background: "#121924", color: "#e8edf2",
          }}
        />
      </details>

      {error && (
        <div style={{
          background: "#3a1518", border: "1px solid #6e2228", color: "#ffb4ba",
          padding: 12, borderRadius: 10, marginBottom: 16, fontSize: 14,
        }}>
          {error}
        </div>
      )}

      {groups.map(([group, ds]) => (
        <section key={group} style={{ marginBottom: 20 }}>
          <h2 style={{ fontSize: 13, color: "#7d8a97", textTransform: "uppercase", letterSpacing: 1 }}>
            {group}
          </h2>
          {ds.map((d) => {
            const p = pending[d.id];
            const f = flash[d.id];
            const on = d.state === "on" || d.state === "open";
            return (
              <div key={d.id} style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                background: "#121924", borderRadius: 12, padding: "12px 14px", marginBottom: 8,
                border: `1px solid ${f === "ok" ? "#2f6f4f" : f === "fail" ? "#6e2228" : "#1d2733"}`,
                opacity: d.available ? 1 : 0.45, transition: "border-color .3s",
              }}>
                <div>
                  <div style={{ fontSize: 15 }}>{d.label}</div>
                  <div style={{ fontSize: 12, color: on ? "#ffd479" : "#7d8a97" }}>
                    {p ? `${p.command}…` : d.available ? d.state + (d.brightnessPct != null ? ` · ${d.brightnessPct}%` : "") : "unavailable"}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  {d.kind === "light" && (
                    <Btn label={on ? "Off" : "On"} busy={!!p} onClick={() => send(d.id, on ? "turn_off" : "turn_on")} />
                  )}
                  {d.kind === "cover" && (
                    <>
                      <Btn label="Open" busy={!!p} onClick={() => send(d.id, "open")} />
                      <Btn label="Stop" busy={!!p} onClick={() => send(d.id, "stop")} />
                      <Btn label="Close" busy={!!p} onClick={() => send(d.id, "close")} />
                    </>
                  )}
                  {d.kind === "climate" && (
                    <span style={{ fontSize: 12, color: "#7d8a97" }}>{d.state}</span>
                  )}
                </div>
              </div>
            );
          })}
        </section>
      ))}

      {devices.length === 0 && !error && (
        <p style={{ color: "#7d8a97" }}>Loading devices…</p>
      )}
    </main>
  );
}

function Btn({ label, busy, onClick }: { label: string; busy: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      style={{
        padding: "8px 14px", borderRadius: 10, border: "1px solid #2a3644",
        background: busy ? "#1a2330" : "#1d2a3a", color: "#e8edf2",
        fontSize: 14, cursor: busy ? "wait" : "pointer",
      }}
    >
      {label}
    </button>
  );
}

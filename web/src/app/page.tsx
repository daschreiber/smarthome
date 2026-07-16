"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Phase C app shell in the decided design direction (docs/DESIGN_DIRECTION.md):
 * Plaster (light) / Ember (dark, via prefers-color-scheme). Rooms-by-floor is
 * the primary structure; scenes are a shelf; climate cards are first-class;
 * the sauna requires a physical hold. State shown is only what the backend
 * confirms from Home Assistant.
 */

interface UiDevice {
  id: string;
  label: string;
  room: string;
  floor: number | null;
  group: string;
  kind: string;
  category: string;
  capabilities: string[];
  requiresConfirmation: boolean;
  state: string;
  available: boolean;
  brightnessPct: number | null;
  currentTemperature: number | null;
  targetTemperature: number | null;
  hvacMode: string | null;
}

type View = { t: "home" } | { t: "room"; room: string };
type Flash = "ok" | "sent" | "fail";

const GROUP_ORDER = ["Lighting", "Shades", "Climate & Comfort", "Media", "Utilities", "Appliances"];

export default function Page() {
  const [devices, setDevices] = useState<UiDevice[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>({ t: "home" });
  const [floor, setFloor] = useState<6 | 5>(6);
  const [flash, setFlash] = useState<Record<string, Flash>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [appKey, setAppKey] = useState("");
  const [mounted, setMounted] = useState(false);
  const keyRef = useRef("");

  useEffect(() => {
    const k = localStorage.getItem("appKey") ?? "";
    setAppKey(k);
    keyRef.current = k;
    setMounted(true);
  }, []);

  const headers = useCallback(
    (): HeadersInit => (keyRef.current ? { "x-app-key": keyRef.current } : {}),
    [],
  );

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/home", { headers: headers() });
      if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`);
      setDevices(((await res.json()) as { devices: UiDevice[] }).devices);
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
    async (id: string, body: Record<string, unknown>) => {
      setBusy((b) => ({ ...b, [id]: true }));
      try {
        const res = await fetch(`/api/devices/${id}/command`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers() },
          body: JSON.stringify(body),
        });
        const out = await res.json();
        if (!res.ok || (out.status !== "confirmed" && out.status !== "sent")) {
          throw new Error(out.error ?? "command failed");
        }
        setFlash((f) => ({ ...f, [id]: out.status === "confirmed" ? "ok" : "sent" }));
        return true;
      } catch {
        setFlash((f) => ({ ...f, [id]: "fail" }));
        return false;
      } finally {
        setBusy((b) => ({ ...b, [id]: false }));
        setTimeout(() => setFlash((f) => { const n = { ...f }; delete n[id]; return n; }), 1500);
        refresh();
      }
    },
    [headers, refresh],
  );

  const scenes = useMemo(
    () => devices.filter((d) => d.category === "scene_switch"),
    [devices],
  );

  const rooms = useMemo(() => {
    const m = new Map<string, { floor: number | null; lightsOn: number; total: number; climate: UiDevice | null }>();
    for (const d of devices) {
      if (!d.room || d.room === "Whole House") continue;
      const r = m.get(d.room) ?? { floor: d.floor, lightsOn: 0, total: 0, climate: null };
      r.total += 1;
      if (d.kind === "light" && d.state === "on") r.lightsOn += 1;
      if (d.kind === "climate" || d.kind === "sauna") r.climate = r.climate ?? d;
      m.set(d.room, r);
    }
    return m;
  }, [devices]);

  const lightsOnTotal = useMemo(
    () => devices.filter((d) => d.kind === "light" && d.state === "on").length,
    [devices],
  );

  const roomDevices = useMemo(() => {
    if (view.t !== "room") return [];
    return devices.filter((d) => d.room === view.room);
  }, [devices, view]);

  const groups = useMemo(() => {
    const m = new Map<string, UiDevice[]>();
    for (const d of roomDevices) m.set(d.group, [...(m.get(d.group) ?? []), d]);
    return [...m.entries()].sort(
      (a, b) => GROUP_ORDER.indexOf(a[0]) - GROUP_ORDER.indexOf(b[0]),
    );
  }, [roomDevices]);

  return (
    <main className="shell">
      {view.t === "home" ? (
        <>
          <h1 className="h-title">Home</h1>
          <p className="h-sub">
            {devices.length === 0 && !error
              ? "Connecting…"
              : `${lightsOnTotal} light${lightsOnTotal === 1 ? "" : "s"} on`}
          </p>

          {error && <div className="error-banner">{error}</div>}

          <div className="floors" role="tablist" aria-label="Floors">
            {[6, 5].map((f) => (
              <button
                key={f}
                className="floor-tab"
                aria-pressed={floor === f}
                onClick={() => setFloor(f as 6 | 5)}
              >
                Floor {f}
              </button>
            ))}
          </div>

          <div className="rooms">
            {[...rooms.entries()]
              .filter(([, r]) => r.floor === floor)
              .sort((a, b) => a[0].localeCompare(b[0]))
              .map(([name, r]) => (
                <button key={name} className="room-card" onClick={() => setView({ t: "room", room: name })}>
                  <div className="rn">{name}</div>
                  <div className={`rs ${r.lightsOn > 0 ? "on" : ""}`}>
                    {r.lightsOn > 0 ? `${r.lightsOn} light${r.lightsOn === 1 ? "" : "s"} on` : "all off"}
                    {r.climate?.currentTemperature != null ? ` · ${r.climate.currentTemperature}°` : ""}
                  </div>
                </button>
              ))}
          </div>

          {scenes.length > 0 && (
            <>
              <div className="section-label">Scenes</div>
              <div className="scenes">
                {scenes.map((s) => (
                  <button
                    key={s.id}
                    className="scene-pill"
                    disabled={!!busy[s.id]}
                    onClick={() => send(s.id, { command: "turn_on" })}
                  >
                    {s.label.replace(/^All House /, "")}
                  </button>
                ))}
              </div>
            </>
          )}

          <details className="appkey">
            <summary>App key</summary>
            {mounted && (
              <input
                type="password"
                value={appKey}
                placeholder="only needed if APP_KEY is set"
                onChange={(e) => {
                  setAppKey(e.target.value);
                  keyRef.current = e.target.value;
                  localStorage.setItem("appKey", e.target.value);
                }}
              />
            )}
          </details>
        </>
      ) : (
        <RoomView
          room={view.room}
          groups={groups}
          flash={flash}
          busy={busy}
          send={send}
          back={() => setView({ t: "home" })}
        />
      )}
    </main>
  );
}

function RoomView({
  room, groups, flash, busy, send, back,
}: {
  room: string;
  groups: [string, UiDevice[]][];
  flash: Record<string, Flash>;
  busy: Record<string, boolean>;
  send: (id: string, body: Record<string, unknown>) => Promise<boolean>;
  back: () => void;
}) {
  return (
    <>
      <button className="h-back" onClick={back}>‹ Home</button>
      <h1 className="h-title">{room}</h1>
      <p className="h-sub">&nbsp;</p>
      {groups.map(([group, ds]) => (
        <section key={group}>
          <div className="section-label">{group}</div>
          {ds.map((d) => (
            <Device key={d.id} d={d} flash={flash[d.id]} busy={!!busy[d.id]} send={send} />
          ))}
        </section>
      ))}
    </>
  );
}

function flashClass(f?: Flash) {
  return f === "ok" ? "dev-flash-ok" : f === "sent" ? "dev-flash-sent" : f === "fail" ? "dev-flash-fail" : "";
}

function Device({
  d, flash, busy, send,
}: {
  d: UiDevice;
  flash?: Flash;
  busy: boolean;
  send: (id: string, body: Record<string, unknown>) => Promise<boolean>;
}) {
  if (d.kind === "sauna") return <SaunaCard d={d} busy={busy} send={send} />;
  if (d.kind === "climate") return <ClimateCard d={d} flash={flash} busy={busy} send={send} />;
  if (d.kind === "cover") {
    return (
      <div className={`dev ${d.available ? "" : "unavailable"} ${flashClass(flash)}`}>
        <div>
          <div className="nm">{d.label}</div>
          <div className="st">{busy ? "…" : d.available ? d.state : "unavailable"}</div>
        </div>
        <div className="btn-row">
          <button className="mini-btn" disabled={busy} onClick={() => send(d.id, { command: "open" })}>Open</button>
          <button className="mini-btn" disabled={busy} onClick={() => send(d.id, { command: "stop" })}>Stop</button>
          <button className="mini-btn" disabled={busy} onClick={() => send(d.id, { command: "close" })}>Close</button>
        </div>
      </div>
    );
  }

  // Lights and media players: toggle, plus a dimmer slider where supported.
  const on = d.state === "on";
  const hasDimmer = d.capabilities.includes("brightness");
  const row = (
    <div className={`dev ${on ? "on" : ""} ${d.available ? "" : "unavailable"} ${hasDimmer ? "" : flashClass(flash)}`}>
      <div>
        <div className="nm">{d.label}</div>
        <div className="st">
          {busy ? "…" : d.available ? `${d.state}${on && d.brightnessPct != null ? ` · ${d.brightnessPct}%` : ""}` : "unavailable"}
        </div>
      </div>
      <button
        className="toggle"
        aria-pressed={on}
        aria-label={`${d.label} ${on ? "off" : "on"}`}
        disabled={busy || !d.available}
        onClick={() => send(d.id, { command: on ? "turn_off" : "turn_on" })}
      />
    </div>
  );
  if (!hasDimmer) return row;
  return (
    <div className={`dev-block ${flashClass(flash)}`}>
      {row}
      <div className="slider-row">
        <input
          type="range"
          min={1}
          max={100}
          defaultValue={d.brightnessPct ?? 50}
          aria-label={`${d.label} brightness`}
          disabled={busy || !d.available}
          onPointerUp={(e) =>
            send(d.id, { command: "set_brightness", brightnessPct: Number((e.target as HTMLInputElement).value) })
          }
          onKeyUp={(e) => {
            if (e.key === "Enter") {
              send(d.id, { command: "set_brightness", brightnessPct: Number((e.target as HTMLInputElement).value) });
            }
          }}
        />
      </div>
    </div>
  );
}

function ClimateCard({
  d, flash, busy, send,
}: {
  d: UiDevice;
  flash?: Flash;
  busy: boolean;
  send: (id: string, body: Record<string, unknown>) => Promise<boolean>;
}) {
  const [target, setTarget] = useState<number | null>(null);
  const shown = target ?? d.targetTemperature ?? 24;
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const step = (delta: number) => {
    const next = Math.min(32, Math.max(10, Math.round((shown + delta) * 2) / 2));
    setTarget(next);
    if (commitTimer.current) clearTimeout(commitTimer.current);
    commitTimer.current = setTimeout(() => {
      send(d.id, { command: "set_temperature", temperature: next }).then(() => setTarget(null));
    }, 900);
  };

  const active = d.hvacMode != null && d.hvacMode !== "off";
  return (
    <div className={`climate-card ${flashClass(flash)} ${d.available ? "" : "unavailable"}`}>
      <div>
        <div className="now">{d.currentTemperature != null ? `${d.currentTemperature}°` : "—"}</div>
        <div className={`mode ${active ? "active" : ""}`}>
          {d.available ? (d.hvacMode ?? "unknown") : "unavailable"}
        </div>
      </div>
      <div className="climate-set">
        <button className="round-btn" disabled={busy || !d.available} onClick={() => step(-0.5)} aria-label="Lower target">−</button>
        <div className="target">{shown}°</div>
        <button className="round-btn" disabled={busy || !d.available} onClick={() => step(0.5)} aria-label="Raise target">+</button>
      </div>
    </div>
  );
}

function SaunaCard({
  d, busy, send,
}: {
  d: UiDevice;
  busy: boolean;
  send: (id: string, body: Record<string, unknown>) => Promise<boolean>;
}) {
  const [fill, setFill] = useState(0);
  const [label, setLabel] = useState<string | null>(null);
  const raf = useRef<number | null>(null);
  const start = useRef(0);
  const HOLD_MS = 1100;
  const on = d.state === "on";

  const tick = useCallback(() => {
    const p = Math.min(1, (Date.now() - start.current) / HOLD_MS);
    setFill(p);
    if (p >= 1) {
      setFill(0);
      setLabel(on ? "Stopping — verifying…" : "Starting — verifying heating…");
      send(d.id, { command: on ? "turn_off" : "turn_on", confirm: true }).then((ok) => {
        setLabel(ok ? null : "Command failed");
        if (!ok) setTimeout(() => setLabel(null), 2500);
      });
      return;
    }
    raf.current = requestAnimationFrame(tick);
  }, [on, d.id, send]);

  const press = () => {
    if (busy) return;
    start.current = Date.now();
    raf.current = requestAnimationFrame(tick);
  };
  const release = () => {
    if (raf.current) cancelAnimationFrame(raf.current);
    setFill(0);
  };

  return (
    <div className="dev-block">
      <div className={`dev ${on ? "on" : ""} ${d.available ? "" : "unavailable"}`}>
        <div>
          <div className="nm">{d.label}</div>
          <div className="st">
            {d.available
              ? `${on ? "heating" : "off"} · cabin ${d.currentTemperature ?? "—"}° · target ${d.targetTemperature ?? "—"}°`
              : "unavailable"}
          </div>
        </div>
      </div>
      <div className="slider-row">
        <button
          className={`hold-btn ${on ? "armed" : ""}`}
          disabled={busy || !d.available}
          onPointerDown={press}
          onPointerUp={release}
          onPointerLeave={release}
        >
          <span className="fill" style={{ width: `${fill * 100}%` }} />
          <span className="tx">
            {label ?? (busy ? "Working…" : on ? "Hold to stop sauna" : "Hold to start heating")}
          </span>
        </button>
      </div>
    </div>
  );
}

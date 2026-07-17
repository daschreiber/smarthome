"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import NavBar from "../../NavBar";
import { BlindsIcon, BulbIcon, FlameIcon, SnowIcon } from "../../icons";

/**
 * System view: one function across the whole house (lighting / climate /
 * shades), with universal controls up top and per-room control below.
 * Master buttons use a two-tap arm/confirm so a stray tap can't switch the
 * whole house off. State shown is only what the backend confirms.
 */

interface UiDevice {
  id: string;
  label: string;
  room: string;
  floor: number | null;
  group: string;
  kind: string;
  category: string;
  state: string;
  available: boolean;
  currentTemperature: number | null;
  targetTemperature: number | null;
  hvacMode: string | null;
}

const SYSTEMS = {
  lighting: { title: "Lighting", icon: BulbIcon, sub: "Every light in the house" },
  climate: { title: "Climate", icon: SnowIcon, sub: "A/C & heating zones" },
  heating: { title: "Underfloor heating", icon: FlameIcon, sub: "Warm floors, room by room" },
  shades: { title: "Shades", icon: BlindsIcon, sub: "All the blinds and shades" },
} as const;

type SystemKey = keyof typeof SYSTEMS;

export default function SystemPage() {
  const params = useParams<{ system: string }>();
  const system = (params.system in SYSTEMS ? params.system : null) as SystemKey | null;

  const [devices, setDevices] = useState<UiDevice[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const keyRef = useRef("");

  useEffect(() => {
    keyRef.current = localStorage.getItem("appKey") ?? "";
  }, []);
  const headers = useCallback((): HeadersInit => {
    const k = keyRef.current.trim();
    return k && /^[\x21-\x7e]+$/.test(k) ? { "x-app-key": k } : {};
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/home", { headers: headers() });
      if (res.status === 401) { location.href = "/"; return; }
      if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`);
      setDevices(((await res.json()) as { devices: UiDevice[] }).devices);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load");
    }
  }, [headers]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  // Disarm a pending master button after a few seconds.
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(null), 4000);
    return () => clearTimeout(t);
  }, [armed]);

  const members = useMemo(() => {
    if (!system) return [];
    if (system === "lighting")
      return devices.filter((d) => d.kind === "light" && d.group === "Lighting" && d.category !== "scene_switch");
    if (system === "climate") return devices.filter((d) => d.kind === "climate");
    if (system === "heating") return devices.filter((d) => d.kind === "heating");
    return devices.filter((d) => d.kind === "cover");
  }, [devices, system]);

  const byFloor = useMemo(() => {
    const floors = new Map<number, Map<string, UiDevice[]>>();
    for (const d of members) {
      const f = d.floor ?? 0;
      const rooms = floors.get(f) ?? new Map<string, UiDevice[]>();
      rooms.set(d.room, [...(rooms.get(d.room) ?? []), d]);
      floors.set(f, rooms);
    }
    return [...floors.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([floor, rooms]) => ({
        floor,
        rooms: [...rooms.entries()].sort((a, b) => a[0].localeCompare(b[0])),
      }));
  }, [members]);

  const systemCommand = useCallback(
    async (command: string, rooms?: string[]) => {
      if (!system) return;
      setBusy(true);
      setNote(null);
      try {
        const res = await fetch("/api/systems/command", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers() },
          body: JSON.stringify({ system, command, ...(rooms ? { rooms } : {}) }),
        });
        const out = await res.json();
        if (!res.ok) throw new Error(out.error ?? "command failed");
        setNote(
          out.ok
            ? `Sent to ${out.targets} device${out.targets === 1 ? "" : "s"}.`
            : `${out.failed.length} of ${out.targets} failed — check the rooms below.`,
        );
      } catch (e) {
        setNote(e instanceof Error ? e.message : "command failed");
      } finally {
        setBusy(false);
        setTimeout(refresh, 1200);
        setTimeout(() => setNote(null), 5000);
      }
    },
    [system, headers, refresh],
  );

  const deviceCommand = useCallback(
    async (id: string, body: Record<string, unknown>) => {
      setBusy(true);
      try {
        await fetch(`/api/devices/${id}/command`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers() },
          body: JSON.stringify(body),
        });
      } finally {
        setBusy(false);
        refresh();
      }
    },
    [headers, refresh],
  );

  const master = (label: string, command: string, danger = false) => {
    const key = `master:${command}`;
    const isArmed = armed === key;
    return (
      <button
        key={key}
        className="scene-pill"
        disabled={busy}
        style={danger && isArmed ? { background: "var(--danger)" } : undefined}
        onClick={() => {
          if (!isArmed) { setArmed(key); return; }
          setArmed(null);
          systemCommand(command);
        }}
      >
        {isArmed ? "Tap again to confirm" : label}
      </button>
    );
  };

  if (!system) {
    return (
      <main className="shell">
        <a className="h-back" href="/systems">‹ Systems</a>
        <h1 className="h-title">Unknown system</h1>
      </main>
    );
  }
  const meta = SYSTEMS[system];

  const onCount = members.filter((d) =>
    system === "shades" ? d.state === "open" : d.state !== "off" && d.state !== "unavailable" && d.available,
  ).length;

  return (
    <main className="shell">
      <a className="h-back" href="/systems">‹ Systems</a>
      <h1 className="h-title" style={{ display: "flex", alignItems: "center", gap: 9 }}><meta.icon size={24} /> {meta.title}</h1>
      <p className="h-sub">
        {meta.sub} — {members.length} device{members.length === 1 ? "" : "s"},{" "}
        {system === "shades" ? `${onCount} open` : `${onCount} on`}
      </p>
      {error && <div className="error-banner">{error}</div>}

      <div className="scenes" style={{ marginBottom: 6 }}>
        {system === "lighting" && master("All lights off", "turn_off", true)}
        {system === "climate" && master("All A/C off", "turn_off", true)}
        {system === "heating" && master("All heating off", "turn_off", true)}
        {system === "shades" && (
          <>
            {master("Open all", "open")}
            {master("Close all", "close", true)}
          </>
        )}
      </div>
      {note && <p className="h-sub" style={{ color: "var(--accent)" }}>{note}</p>}

      {byFloor.map(({ floor, rooms }) => (
        <section key={floor}>
          <div className="section-label">{floor === 0 ? "Whole house" : `Floor ${floor}`}</div>
          <div className="dev-list">
            {rooms.map(([room, ds]) =>
              system === "climate" ? (
                ds.map((d) => (
                  <ClimateRow key={d.id} d={d} busy={busy} send={deviceCommand} />
                ))
              ) : (
                <div key={room} className="dev">
                  <div>
                    <div className="nm">{room}</div>
                    <div className={`st ${ds.some((x) => (system === "shades" ? x.state === "open" : x.state === "on")) ? "on" : ""}`}>
                      {system === "shades"
                        ? `${ds.length} shade${ds.length === 1 ? "" : "s"} · ${ds.filter((x) => x.state === "open").length} open`
                        : `${ds.filter((x) => x.state === "on").length} of ${ds.length} on`}
                    </div>
                  </div>
                  <div className="btn-row">
                    {system === "lighting" || system === "heating" ? (
                      <>
                        <button className="mini-btn" disabled={busy} onClick={() => systemCommand("turn_on", [room])}>On</button>
                        <button className="mini-btn" disabled={busy} onClick={() => systemCommand("turn_off", [room])}>Off</button>
                      </>
                    ) : (
                      <>
                        <button className="mini-btn" disabled={busy} onClick={() => systemCommand("open", [room])}>Open</button>
                        <button className="mini-btn" disabled={busy} onClick={() => systemCommand("stop", [room])}>Stop</button>
                        <button className="mini-btn" disabled={busy} onClick={() => systemCommand("close", [room])}>Close</button>
                      </>
                    )}
                  </div>
                </div>
              ),
            )}
          </div>
        </section>
      ))}
      <NavBar />
    </main>
  );
}

function ClimateRow({
  d, busy, send,
}: {
  d: UiDevice;
  busy: boolean;
  send: (id: string, body: Record<string, unknown>) => void;
}) {
  const [pending, setPending] = useState<number | null>(null);
  // KNX doesn't echo setpoints reliably; keep showing the last target sent.
  const [committed, setCommitted] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reported = d.targetTemperature != null && d.targetTemperature >= 10 ? d.targetTemperature : null;
  const seed =
    d.currentTemperature != null
      ? Math.min(32, Math.max(10, Math.round(d.currentTemperature * 2) / 2))
      : 21;
  const target = pending ?? reported ?? committed ?? seed;
  const active = d.available && d.state !== "off" && d.state !== "unavailable";

  const step = (delta: number) => {
    const next = Math.min(32, Math.max(10, target + delta));
    setPending(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      send(d.id, { command: "set_temperature", temperature: next });
      setCommitted(next);
      setPending(null);
    }, 800);
  };

  return (
    <div className={`climate-card ${d.available ? "" : "unavailable"}`} style={{ marginBottom: 0 }}>
      <div>
        <div className="nm">{d.room}</div>
        <div className={`mode ${active ? "active" : ""}`}>
          {d.currentTemperature != null ? `${d.currentTemperature}° now · ` : ""}
          {d.available ? (active ? d.state : "off") : "unavailable"}
        </div>
      </div>
      <div className="climate-set">
        <button className="round-btn" disabled={busy || !d.available} onClick={() => step(-0.5)} aria-label={`Lower ${d.room} target`}>−</button>
        <div className="target">{target}°</div>
        <button className="round-btn" disabled={busy || !d.available} onClick={() => step(0.5)} aria-label={`Raise ${d.room} target`}>+</button>
        <button
          className="mini-btn"
          disabled={busy || !d.available}
          onClick={() => send(d.id, { command: active ? "turn_off" : "turn_on" })}
        >
          {active ? "Off" : "On"}
        </button>
      </div>
    </div>
  );
}

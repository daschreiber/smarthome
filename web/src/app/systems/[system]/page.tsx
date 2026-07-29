"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import NavBar from "../../NavBar";
import { BlindsIcon, BulbIcon, FlameIcon, SnowIcon } from "../../icons";
import type { SystemKey } from "@/lib/commandRules";
import { appKeyHeaders } from "@/lib/appKey";
import ClimateCard from "../../ClimateCard";

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
  fanSpeed?: string | null;
  fanSpeedList?: string[] | null;
}

// Keyed by the server's SystemKey so a new system is a compile error here.
const SYSTEMS: Record<SystemKey, { title: string; icon: typeof BulbIcon; sub: string }> = {
  lighting: { title: "Lighting", icon: BulbIcon, sub: "Every light in the house" },
  climate: { title: "Climate", icon: SnowIcon, sub: "A/C & heating zones" },
  heating: { title: "Underfloor heating", icon: FlameIcon, sub: "Warm floors, room by room" },
  shades: { title: "Shades", icon: BlindsIcon, sub: "All the blinds and shades" },
};

export default function SystemPage() {
  const params = useParams<{ system: string }>();
  const system = (params.system in SYSTEMS ? params.system : null) as SystemKey | null;

  const [devices, setDevices] = useState<UiDevice[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // Server-vouched cover state (COVER_STATE_TRUSTED=1 once C4 feedback works).
  const [coverTrust, setCoverTrust] = useState(false);
  const headers = useCallback((): HeadersInit => appKeyHeaders(), []);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/home", { headers: headers() });
      if (res.status === 401) { location.href = "/"; return; }
      if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`);
      const out = (await res.json()) as { devices: UiDevice[]; coverStateTrusted?: boolean };
      setDevices(out.devices);
      setCoverTrust(out.coverStateTrusted === true);
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
          // Whole-house sends (no rooms) go through the two-tap arm/confirm
          // above; carry that confirmation to the server, which requires it.
          body: JSON.stringify({ system, command, confirm: true, ...(rooms ? { rooms } : {}) }),
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
    async (id: string, body: Record<string, unknown>): Promise<{ ok: boolean }> => {
      setBusy(true);
      try {
        const res = await fetch(`/api/devices/${id}/command`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers() },
          body: JSON.stringify(body),
        });
        return { ok: res.ok };
      } catch {
        return { ok: false };
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
    // Shades count as "open" only when the server vouches for cover state;
    // C4's stuck feedback (~1% -> "open" forever) is otherwise fiction.
    system === "shades" ? coverTrust && d.state === "open" : d.state !== "off" && d.state !== "unavailable" && d.available,
  ).length;

  return (
    <main className="shell">
      <a className="h-back" href="/systems">‹ Systems</a>
      <h1 className="h-title" style={{ display: "flex", alignItems: "center", gap: 9 }}><meta.icon size={24} /> {meta.title}</h1>
      <p className="h-sub">
        {meta.sub} — {members.length} device{members.length === 1 ? "" : "s"}
        {system === "shades" && !coverTrust ? "" : `, ${onCount} ${system === "shades" ? "open" : "on"}`}
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
                  <ClimateCard key={d.id} d={d} title={d.room} busy={busy} send={deviceCommand} />
                ))
              ) : (
                <div key={room} className="dev">
                  <div>
                    <div className="nm">{room}</div>
                    <div className={`st ${ds.some((x) => (system === "shades" ? coverTrust && x.state === "open" : x.state === "on")) ? "on" : ""}`}>
                      {system === "shades"
                        ? coverTrust
                          ? `${ds.filter((x) => x.state === "open").length} of ${ds.length} open`
                          : `${ds.length} shade${ds.length === 1 ? "" : "s"}`
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

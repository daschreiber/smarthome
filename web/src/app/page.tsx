"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import FloorPlan from "./FloorPlan";
import NavBar from "./NavBar";
import { BlindsIcon, BulbIcon, FlameIcon, GridIcon, LockIcon, MapIcon, SnowIcon } from "./icons";

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
  /** Sauna only: why the card is unavailable, when it is. */
  note?: string | null;
  /** Sauna only: pending auto-stop time (HH:MM house time). */
  stopAt?: string | null;
  /** White-noise machine only. */
  noiseType?: string | null;
  /** White-noise machine and media players. */
  volumePct?: number | null;
  /** Media players only: current input, the zone's inputs, and whether the
   * player supports turn_on (Control4 matrix zones don't — they wake by
   * source selection). */
  source?: string | null;
  sourceList?: string[] | null;
  mediaTitle?: string | null;
  canTurnOn?: boolean;
  /** Eight Sleep bed sides only: occupancy from the presence sensor, and
   * when that reading last changed (it's cloud-derived and often stale). */
  bedPresence?: boolean | null;
  bedPresenceSince?: string | null;
  /** Vacuums only. */
  batteryPct?: number | null;
  fanSpeed?: string | null;
  fanSpeedList?: string[] | null;
  /** Lights only: keeps its own card instead of collapsing into "Room lights". */
  pinned?: boolean;
}

type View = { t: "home" } | { t: "room"; room: string };
type Flash = "ok" | "sent" | "fail";

/** Command outcome, with the server's reason when it failed. */
interface SendResult {
  ok: boolean;
  status?: string;
  error?: string;
}

interface CustomScene {
  id: string;
  name: string;
  room: string | null;
  deviceCount: number;
  /** Contains the sauna heater — applying asks for confirmation first. */
  hasSauna?: boolean;
  /** Server-decided: admins delete anything, others only their own scenes. */
  canDelete: boolean;
}

/** The household Spotify session (from /api/music/now). */
interface MusicNow {
  playing: boolean;
  track: string | null;
  artist: string | null;
  artUrl: string | null;
  deviceName: string | null;
  room: string | null;
}

/** A floor's heat/cool changeover state (from /api/home `floorModes`). */
interface FloorModeInfo {
  mode: "heat" | "cool" | null;
  pending: "heat" | "cool" | null;
  error: string | null;
}

const GROUP_ORDER = ["Lighting", "Shades", "Climate & Comfort", "Media", "Utilities", "Appliances"];
/** Display names for groups whose entity-map name reads wrong in the UI.
 * "Media" is owner-renamed to "Music" — the section is the room's sound,
 * not a device category. The map keeps "Media" (ids/groups are data). */
const GROUP_DISPLAY: Record<string, string> = { Media: "Music" };

/** A room's A/C (or sauna) counts as running for the card indicators. */
function climateActive(c: UiDevice | null): boolean {
  return (
    c != null && c.available && c.state !== "off" && c.state !== "unavailable" && c.state !== "unknown"
  );
}

export default function Page() {
  const [devices, setDevices] = useState<UiDevice[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>({ t: "home" });
  const [floor, setFloor] = useState<6 | 5>(6);
  const [flash, setFlash] = useState<Record<string, Flash>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [favs, setFavs] = useState<string[]>([]);
  const [customScenes, setCustomScenes] = useState<CustomScene[]>([]);
  const [editScenes, setEditScenes] = useState(false);
  const [authNeeded, setAuthNeeded] = useState(false);
  const [layout, setLayout] = useState<"grid" | "plan">("grid");
  const [role, setRole] = useState<"admin" | "member" | "guest">("member");
  const [floorHeating, setFloorHeating] = useState<string[]>([]);
  const [floorModes, setFloorModes] = useState<Record<string, FloorModeInfo>>({});
  const [musicNow, setMusicNow] = useState<MusicNow | null>(null);
  // True only when the server vouches for cover state (COVER_STATE_TRUSTED=1
  // after the C4 position-feedback fix). Until then shades show no state.
  const [coverTrust, setCoverTrust] = useState(false);
  const keyRef = useRef("");
  const canProgram = role !== "guest";

  useEffect(() => {
    keyRef.current = localStorage.getItem("appKey") ?? "";
    // Explicit choice wins; otherwise the plan suits wide screens, the grid phones.
    const stored = localStorage.getItem("homeLayout");
    if (stored === "plan" || stored === "grid") setLayout(stored);
    else if (window.innerWidth >= 720) setLayout("plan");
  }, []);

  // Rooms are URLs (/?room=Kitchen): browser/PWA back returns Home instead
  // of leaving the app, and room views can be shared or reopened.
  useEffect(() => {
    const applyUrl = () => {
      const room = new URLSearchParams(location.search).get("room");
      setView(room ? { t: "room", room } : { t: "home" });
    };
    applyUrl();
    window.addEventListener("popstate", applyUrl);
    return () => window.removeEventListener("popstate", applyUrl);
  }, []);

  const openRoom = useCallback((room: string) => {
    setView({ t: "room", room });
    history.pushState({ room }, "", `/?room=${encodeURIComponent(room)}`);
  }, []);

  const goHome = useCallback(() => {
    setView({ t: "home" });
    history.pushState({}, "", "/");
  }, []);

  const headers = useCallback((): HeadersInit => {
    // A stored app key with whitespace or non-ASCII (paste artifacts) makes
    // Safari reject the whole fetch with a cryptic SyntaxError — send the
    // header only when the value is a legal header token.
    const k = keyRef.current.trim();
    return k && /^[\x21-\x7e]+$/.test(k) ? { "x-app-key": k } : {};
  }, []);

  const loadFavs = useCallback(async () => {
    try {
      const res = await fetch("/api/favorites", { headers: headers() });
      if (res.ok) setFavs(((await res.json()) as { favorites: string[] }).favorites);
    } catch { /* favorites are non-critical */ }
  }, [headers]);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/home", { headers: headers() });
      if (res.status === 401) {
        setAuthNeeded(true);
        setError(null);
        return;
      }
      if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`);
      setAuthNeeded(false);
      const out = (await res.json()) as {
        devices: UiDevice[];
        role?: "admin" | "member" | "guest";
        floorHeatingRooms?: string[];
        floorModes?: Record<string, FloorModeInfo>;
        coverStateTrusted?: boolean;
      };
      setDevices(out.devices);
      if (out.role) setRole(out.role);
      setFloorHeating(out.floorHeatingRooms ?? []);
      setFloorModes(out.floorModes ?? {});
      setCoverTrust(out.coverStateTrusted === true);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load");
    }
  }, [headers]);

  const loadScenes = useCallback(async () => {
    try {
      const res = await fetch("/api/scenes", { headers: headers() });
      if (res.ok) setCustomScenes(((await res.json()) as { scenes: CustomScene[] }).scenes);
    } catch { /* non-critical */ }
  }, [headers]);

  useEffect(() => {
    refresh();
    loadFavs();
    loadScenes();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh, loadFavs, loadScenes]);

  // The household Spotify session, polled gently (the server caches it too):
  // Music cards show track/artist/art and "playing in <room>" from this.
  useEffect(() => {
    let stop = false;
    const load = () =>
      fetch("/api/music/now", { headers: headers() })
        .then((r) => (r.ok ? r.json() : null))
        .then((v: MusicNow | null) => { if (!stop && v) setMusicNow(v); })
        .catch(() => {});
    load();
    const t = setInterval(load, 10_000);
    return () => { stop = true; clearInterval(t); };
  }, [headers]);

  const sceneOp = useCallback(
    async (body: Record<string, unknown>) => {
      try {
        const res = await fetch("/api/scenes", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers() },
          body: JSON.stringify(body),
        });
        const out = await res.json();
        if (!res.ok) throw new Error(out.error ?? "scene operation failed");
        loadScenes();
        refresh();
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : "scene operation failed");
        return false;
      }
    },
    [headers, loadScenes, refresh],
  );

  const toggleFav = useCallback(
    async (deviceId: string) => {
      try {
        const res = await fetch("/api/favorites", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers() },
          body: JSON.stringify({ deviceId }),
        });
        if (res.ok) setFavs(((await res.json()) as { favorites: string[] }).favorites);
      } catch { /* non-critical */ }
    },
    [headers],
  );

  const send = useCallback(
    async (id: string, body: Record<string, unknown>): Promise<SendResult> => {
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
        return { ok: true, status: out.status, error: undefined };
      } catch (err) {
        setFlash((f) => ({ ...f, [id]: "fail" }));
        return { ok: false, error: err instanceof Error ? err.message : "command failed" };
      } finally {
        setBusy((b) => ({ ...b, [id]: false }));
        setTimeout(() => setFlash((f) => { const n = { ...f }; delete n[id]; return n; }), 1500);
        refresh();
      }
    },
    [headers, refresh],
  );

  // Floor heat/cool changeover: the server runs the ~13s Control4-derived
  // relay sequence in the background, so this returns fast and the normal
  // /api/home polling shows `pending` until the relay reports the new mode.
  const sendFloorMode = useCallback(
    async (fl: 5 | 6, mode: "heat" | "cool") => {
      const key = `mode:${fl}`;
      setBusy((b) => ({ ...b, [key]: true }));
      try {
        const res = await fetch("/api/climate/mode", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers() },
          body: JSON.stringify({ floor: fl, mode }),
        });
        const out = await res.json();
        if (!res.ok || out.ok === false) throw new Error(out.error ?? "changeover failed");
        // Optimistic: show "switching" before the next poll catches up.
        setFloorModes((m) => ({
          ...m,
          [fl]: { ...(m[fl] ?? { mode: null, error: null }), pending: mode },
        }));
      } catch (err) {
        setError(err instanceof Error ? err.message : "changeover failed");
      } finally {
        setBusy((b) => ({ ...b, [key]: false }));
      }
    },
    [headers],
  );

  // Room-scoped system fan-out ("Room lights off", "Shades open") — one
  // request, the server sweeps the room. Busy/flash are keyed per room+system
  // so the combined cards get the same feedback as single devices.
  const sendSystem = useCallback(
    async (system: string, command: string, room: string, extra?: Record<string, unknown>): Promise<SendResult> => {
      const key = `sys:${system}:${room}`;
      setBusy((b) => ({ ...b, [key]: true }));
      try {
        const res = await fetch("/api/systems/command", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers() },
          body: JSON.stringify({ system, command, rooms: [room], ...extra }),
        });
        const out = await res.json();
        if (!res.ok || out.ok === false) throw new Error(out.error ?? "command failed");
        setFlash((f) => ({ ...f, [key]: "sent" }));
        return { ok: true, status: "sent", error: undefined };
      } catch (err) {
        setFlash((f) => ({ ...f, [key]: "fail" }));
        return { ok: false, error: err instanceof Error ? err.message : "command failed" };
      } finally {
        setBusy((b) => ({ ...b, [key]: false }));
        setTimeout(() => setFlash((f) => { const n = { ...f }; delete n[key]; return n; }), 1500);
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

  const climateOnTotal = useMemo(
    () =>
      devices.filter(
        (d) => d.kind === "climate" && d.available && d.state !== "off" && d.state !== "unavailable",
      ).length,
    [devices],
  );

  // Count by default: the Control4 covers' position feedback is stuck near
  // 1%, so every cover reports "open" forever — the same broken signal that
  // once kept Sleep sense from ever arming. Only when the server vouches
  // for cover state (coverTrust) do we claim an open count.
  const shadesTotal = useMemo(
    () => devices.filter((d) => d.kind === "cover").length,
    [devices],
  );
  const shadesOpen = useMemo(
    () => devices.filter((d) => d.kind === "cover" && d.state === "open").length,
    [devices],
  );

  const heatingOnTotal = useMemo(
    () => devices.filter((d) => d.kind === "heating" && d.state === "on").length,
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

  if (authNeeded) {
    return (
      <main className="shell">
        <Login onDone={() => { setAuthNeeded(false); refresh(); loadFavs(); }} />
      </main>
    );
  }

  const favDevices = devices.filter((d) => favs.includes(d.id));
  const fm = floorModes[String(floor)];
  const fmShown = fm?.pending ?? fm?.mode ?? null;

  return (
    <main className="shell">
      {view.t === "home" ? (
        <>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
            <div>
              <h1 className="h-title">Home</h1>
              <p className="h-sub">
                {devices.length === 0 && !error
                  ? "Connecting…"
                  : `${lightsOnTotal} light${lightsOnTotal === 1 ? "" : "s"} on`}
              </p>
            </div>
            <AwaySwitch headers={headers} />
          </div>

          {error && <div className="error-banner">{error}</div>}

          {favDevices.length > 0 && (
            <>
              <div className="section-label">Favorites</div>
              <div className="dev-list">
                {favDevices.map((d) => (
                  <Device key={d.id} d={d} flash={flash[d.id]} busy={!!busy[d.id]} send={send} fav={true} onFav={toggleFav} music={musicNow} />
                ))}
              </div>
            </>
          )}

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
            <div className="view-toggle" role="group" aria-label="Room view style">
              {(["grid", "plan"] as const).map((v) => (
                <button
                  key={v}
                  aria-pressed={layout === v}
                  onClick={() => {
                    setLayout(v);
                    localStorage.setItem("homeLayout", v);
                  }}
                >
                  {v === "grid" ? <GridIcon size={15} /> : <MapIcon size={15} />}
                  {v === "grid" ? "Grid" : "Plan"}
                </button>
              ))}
            </div>
          </div>

          {/* Whole-floor heat/cool changeover: one floor = one central unit,
              so rooms can't mix modes — this flips the whole selected floor
              via the Control4-derived relay sequence (lib/changeover). */}
          <div className="mode-row">
            <div>
              <div className="mode-title">A/C mode</div>
              <div className="mode-sub">
                {fm?.pending
                  ? `switching floor ${floor} to ${fm.pending === "heat" ? "heating" : "cooling"}…`
                  : fm?.mode
                    ? `floor ${floor} is on ${fm.mode === "heat" ? "heating" : "cooling"}`
                    : `floor ${floor} mode unknown`}
                {!fm?.pending && fm?.error ? " · last switch failed" : ""}
              </div>
            </div>
            <div className="onoff" role="group" aria-label={`Floor ${floor} A/C mode`}>
              {(["cool", "heat"] as const).map((m) => (
                <button
                  key={m}
                  aria-pressed={fmShown === m}
                  disabled={!!busy[`mode:${floor}`] || !!fm?.pending}
                  onClick={() => {
                    if (fmShown === m) return;
                    if (
                      window.confirm(
                        `Switch floor ${floor} to ${m === "heat" ? "heating" : "cooling"}?\nThe changeover takes about 15 seconds.`,
                      )
                    ) {
                      sendFloorMode(floor, m);
                    }
                  }}
                  style={{ display: "inline-flex", alignItems: "center", gap: 5 }}
                >
                  {m === "cool" ? <SnowIcon size={14} /> : <FlameIcon size={14} />}
                  {m === "cool" ? "Cool" : "Heat"}
                </button>
              ))}
            </div>
          </div>

          {devices.length === 0 && !error ? (
            <div className="rooms">
              {Array.from({ length: 6 }, (_, i) => (
                <div key={i} className="room-card skeleton" aria-hidden>
                  <div className="sk-line" style={{ width: "60%" }} />
                  <div className="sk-line" style={{ width: "40%", marginTop: 8 }} />
                </div>
              ))}
            </div>
          ) : layout === "plan" ? (
            <FloorPlan floor={floor} rooms={rooms} onOpen={openRoom} />
          ) : (
            <div className="rooms">
              {[...rooms.entries()]
                .filter(([, r]) => r.floor === floor)
                .sort((a, b) => a[0].localeCompare(b[0]))
                .map(([name, r]) => (
                  <button key={name} className="room-card" onClick={() => openRoom(name)}>
                    <div className="rn" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
                      <span>{name}</span>
                      <span style={{ display: "flex", gap: 5, flexShrink: 0 }}>
                        {r.lightsOn > 0 && <span style={{ color: "var(--active)", display: "flex" }}><BulbIcon size={15} /></span>}
                        {climateActive(r.climate) && <span style={{ color: "var(--accent)", display: "flex" }}><SnowIcon size={15} /></span>}
                        {floorHeating.includes(name) && <span style={{ color: "var(--danger)", display: "flex" }}><FlameIcon size={15} /></span>}
                      </span>
                    </div>
                    <div className={`rs ${r.lightsOn > 0 ? "on" : ""}`}>
                      {r.lightsOn > 0 ? `${r.lightsOn} light${r.lightsOn === 1 ? "" : "s"} on` : "all off"}
                      {r.climate?.currentTemperature != null ? ` · ${r.climate.currentTemperature}°` : ""}
                    </div>
                  </button>
                ))}
            </div>
          )}

          <div className="section-label">Systems</div>
          <div className="rooms">
            <a className="room-card" href="/systems/lighting" style={{ textDecoration: "none", display: "block" }}>
              <div className="rn" style={{ display: "flex", alignItems: "center", gap: 7 }}><BulbIcon size={18} /> Lighting</div>
              <div className={`rs ${lightsOnTotal > 0 ? "on" : ""}`}>
                {lightsOnTotal > 0 ? `${lightsOnTotal} on` : "all off"}
              </div>
            </a>
            <a className="room-card" href="/systems/climate" style={{ textDecoration: "none", display: "block" }}>
              <div className="rn" style={{ display: "flex", alignItems: "center", gap: 7 }}><SnowIcon size={18} /> Climate</div>
              <div className={`rs ${climateOnTotal > 0 ? "on" : ""}`}>
                {climateOnTotal > 0 ? `${climateOnTotal} zone${climateOnTotal === 1 ? "" : "s"} active` : "all off"}
              </div>
            </a>
            <a className="room-card" href="/systems/heating" style={{ textDecoration: "none", display: "block" }}>
              <div className="rn" style={{ display: "flex", alignItems: "center", gap: 7 }}><FlameIcon size={18} /> Underfloor heating</div>
              <div className={`rs ${heatingOnTotal > 0 ? "on" : ""}`}>
                {heatingOnTotal > 0 ? `${heatingOnTotal} room${heatingOnTotal === 1 ? "" : "s"}` : "all off"}
              </div>
            </a>
            <a className="room-card" href="/systems/shades" style={{ textDecoration: "none", display: "block" }}>
              <div className="rn" style={{ display: "flex", alignItems: "center", gap: 7 }}><BlindsIcon size={18} /> Shades</div>
              <div className={`rs ${coverTrust && shadesOpen > 0 ? "on" : ""}`}>
                {coverTrust
                  ? shadesOpen > 0 ? `${shadesOpen} open` : "all closed"
                  : `${shadesTotal} shade${shadesTotal === 1 ? "" : "s"}`}
              </div>
            </a>
          </div>

          {(scenes.length > 0 || customScenes.length > 0) && (
            <>
              <div className="section-label">
                Scenes{" "}
                {canProgram && customScenes.some((s) => s.canDelete) && (
                  <button
                    onClick={() => setEditScenes((v) => !v)}
                    style={{ background: "none", border: "none", color: "var(--dim)", font: "inherit", fontSize: 11, cursor: "pointer", textDecoration: "underline", textTransform: "none", letterSpacing: 0 }}
                  >
                    {editScenes ? "done" : "edit"}
                  </button>
                )}
              </div>
              <div className="scenes">
                {/* Control4 scene switches and app scenes dress alike — tapping
                    does the same job. The tiny lock is the one honest tell:
                    C4 programming is fixed by the installer, so "edit" can
                    never apply to these. */}
                {scenes.map((s) => (
                  <button
                    key={s.id}
                    className="scene-pill"
                    disabled={!!busy[s.id]}
                    title="Control4 scene — programmed by the installer, not editable in the app"
                    onClick={() => send(s.id, { command: "turn_on" })}
                    style={{ display: "inline-flex", alignItems: "center", gap: 5 }}
                  >
                    {s.label.replace(/^All House /, "")}
                    <span style={{ opacity: 0.55, display: "flex" }} aria-label="fixed Control4 scene"><LockIcon size={11} /></span>
                  </button>
                ))}
                {customScenes.map((s) => (
                  <button
                    key={s.id}
                    className="scene-pill"
                    disabled={editScenes && !s.canDelete}
                    onClick={() => {
                      if (editScenes) {
                        if (s.canDelete && window.confirm(`Delete scene "${s.name}"?`)) {
                          sceneOp({ action: "delete", id: s.id });
                        }
                      } else if (s.hasSauna) {
                        // The one safety rule scenes don't bypass: a heater
                        // start stays an explicit human decision, per apply.
                        const heat = window.confirm(
                          `"${s.name}" includes the sauna heater. Start it too?\nOK = everything incl. sauna · Cancel = everything except the sauna`,
                        );
                        sceneOp({ action: "apply", id: s.id, confirmSauna: heat });
                      } else {
                        sceneOp({ action: "apply", id: s.id });
                      }
                    }}
                  >
                    {editScenes && s.canDelete ? `✕ ${s.name}` : s.name}
                  </button>
                ))}
              </div>
            </>
          )}

        </>
      ) : (
        <RoomView
          room={view.room}
          groups={groups}
          flash={flash}
          busy={busy}
          music={musicNow}
          send={send}
          sendSystem={sendSystem}
          favs={favs}
          onFav={toggleFav}
          onCapture={
            canProgram
              ? (room, name, shades) =>
                  sceneOp({
                    action: "capture", name, room,
                    ...(shades !== "skip" ? { shades } : {}),
                  })
              : null
          }
          coverTrust={coverTrust}
          back={goHome}
        />
      )}
      <NavBar />
    </main>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [forgot, setForgot] = useState(false);
  const [googleAvailable, setGoogleAvailable] = useState(false);

  useEffect(() => {
    fetch("/api/auth/methods")
      .then((r) => r.json())
      .then((m: { google?: boolean }) => setGoogleAvailable(!!m.google))
      .catch(() => {});
    // Errors bounced back from the Google callback arrive as ?error=…
    const code = new URLSearchParams(location.search).get("error");
    if (code === "not-invited") {
      setErr("That Google account isn't on the user list — ask an admin to add your email.");
    } else if (code === "google-signin-failed") {
      setErr("Google sign-in didn't complete — try again, or use your password.");
    } else if (code === "google-not-configured") {
      setErr("Google sign-in isn't set up on the server.");
    }
    if (code) history.replaceState(null, "", "/");
  }, []);
  const [note, setNote] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "sign-in failed");
      onDone();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "sign-in failed");
    } finally {
      setBusy(false);
    }
  };

  const requestReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/auth/reset-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "request failed");
      setNote(body.message);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "request failed");
    } finally {
      setBusy(false);
    }
  };

  if (forgot) {
    return (
      <form className="auth-form" onSubmit={requestReset}>
        <h1 className="h-title">Reset password</h1>
        <p className="h-sub">Enter your email and we&apos;ll get you a reset link.</p>
        {err && <div className="error-banner">{err}</div>}
        {note && <p className="h-sub" style={{ color: "var(--accent)" }}>{note}</p>}
        <div className="appkey" style={{ margin: 0 }}>
          <input type="email" value={email} placeholder="email" autoComplete="username" onChange={(e) => setEmail(e.target.value)} />
        </div>
        <button className="scene-pill" disabled={busy || !email} style={{ width: "100%", marginTop: 14, padding: 12 }}>
          {busy ? "Sending…" : "Send reset link"}
        </button>
        <p className="h-sub" style={{ marginTop: 12 }}>
          <button type="button" onClick={() => { setForgot(false); setNote(null); setErr(null); }}
            style={{ background: "none", border: "none", color: "var(--dim)", font: "inherit", padding: 0, cursor: "pointer", textDecoration: "underline" }}>
            Back to sign in
          </button>
        </p>
      </form>
    );
  }

  return (
    <form className="auth-form" onSubmit={submit}>
      <h1 className="h-title">Home</h1>
      <p className="h-sub">Sign in to control the house.</p>
      {err && <div className="error-banner">{err}</div>}
      {googleAvailable && (
        <>
          <button
            type="button"
            className="scene-pill"
            style={{ width: "100%", padding: 12, marginBottom: 12, background: "var(--card)", color: "var(--ink)", border: "1px solid var(--card-line)" }}
            onClick={() => { location.href = "/api/auth/google"; }}
          >
            Continue with Google
          </button>
          <p className="h-sub" style={{ textAlign: "center", margin: "0 0 12px" }}>or with a password</p>
        </>
      )}
      <div className="appkey" style={{ margin: 0 }}>
        <input
          type="email"
          value={email}
          placeholder="email"
          autoComplete="username"
          onChange={(e) => setEmail(e.target.value)}
          style={{ marginBottom: 8 }}
        />
        <input
          type="password"
          value={password}
          placeholder="password"
          autoComplete="current-password"
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      <button className="scene-pill" disabled={busy} style={{ width: "100%", marginTop: 14, padding: 12 }}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
      <p className="h-sub" style={{ marginTop: 12 }}>
        <button type="button" onClick={() => setForgot(true)}
          style={{ background: "none", border: "none", color: "var(--dim)", font: "inherit", padding: 0, cursor: "pointer", textDecoration: "underline" }}>
          Forgot password?
        </button>
      </p>
    </form>
  );
}

/**
 * Rooms with this many fixtures get the collapsed lighting view: one
 * "Room lights" control + pinned reading lights, the rest behind an
 * expander. 4+ covers the bedrooms, studies, Den, Kitchen, Lounge, and
 * bathrooms; corridors and balconies (1-3 lights) stay as plain rows.
 */
const COLLAPSE_LIGHTS_AT = 4;
/**
 * Lights that keep their own rows in a collapsed room: reading lights by name
 * ("Reading Left", "Read Right", "Reading light") and anything pinned in the
 * entity map (e.g. the Study Spots).
 */
const keepsOwnRow = (d: UiDevice) => /\bread/i.test(d.label) || !!d.pinned;

function RoomView({
  room, groups, flash, busy, music, send, sendSystem, favs, onFav, onCapture, coverTrust, back,
}: {
  room: string;
  groups: [string, UiDevice[]][];
  flash: Record<string, Flash>;
  busy: Record<string, boolean>;
  music: MusicNow | null;
  send: (id: string, body: Record<string, unknown>) => Promise<SendResult>;
  sendSystem: (system: string, command: string, room: string, extra?: Record<string, unknown>) => Promise<SendResult>;
  favs: string[];
  onFav: (id: string) => void;
  onCapture: ((room: string, name: string, shades: "skip" | "open" | "close") => void) | null;
  coverTrust: boolean;
  back: () => void;
}) {
  const [capOpen, setCapOpen] = useState(false);
  const [capName, setCapName] = useState("");
  // What the scene should DO with this room's shades. Their live state can't
  // be read (stuck C4 feedback), so the capturer declares it; default: leave
  // them out of the scene entirely.
  const [capShades, setCapShades] = useState<"skip" | "open" | "close">("skip");
  const hasShades = groups.some(([g]) => g === "Shades");
  const rows = (ds: UiDevice[]) =>
    ds.map((d) => (
      <Device
        key={d.id}
        d={d}
        flash={flash[d.id]}
        busy={!!busy[d.id]}
        send={send}
        fav={favs.includes(d.id)}
        onFav={onFav}
        music={music}
        coverTrust={coverTrust}
      />
    ));
  const saveCapture = () => {
    if (!capName.trim() || !onCapture) return;
    onCapture(room, capName.trim(), capShades);
    setCapOpen(false);
    setCapName("");
    setCapShades("skip");
  };
  return (
    <>
      <button className="h-back" onClick={back}>‹ Home</button>
      <h1 className="h-title">{room}</h1>
      {onCapture && !capOpen && (
        <p className="h-sub">
          <button
            onClick={() => setCapOpen(true)}
            style={{ background: "none", border: "none", color: "var(--dim)", font: "inherit", padding: 0, cursor: "pointer", textDecoration: "underline" }}
          >
            save current look as a scene
          </button>
        </p>
      )}
      {onCapture && capOpen && (
        <div className="dev-block" style={{ padding: 12, marginBottom: 10 }}>
          <input
            placeholder="scene name (an existing name adds this room to it)"
            value={capName}
            autoFocus
            onChange={(e) => setCapName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") saveCapture(); }}
            style={{
              width: "100%", padding: 9, borderRadius: 10, border: "1px solid var(--card-line)",
              background: "var(--card)", color: "var(--ink)", fontFamily: "inherit", marginBottom: 8,
            }}
          />
          {hasShades && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginBottom: 8 }}>
              <span className="st">Shades in this scene:</span>
              {([["skip", "Leave out"], ["open", "Open"], ["close", "Closed"]] as const).map(([v, lbl]) => (
                <button
                  key={v}
                  className="mini-btn"
                  aria-pressed={capShades === v}
                  onClick={() => setCapShades(v)}
                >
                  {lbl}
                </button>
              ))}
            </div>
          )}
          {hasShades && capShades === "skip" && (
            <p className="st" style={{ margin: "0 0 8px" }}>
              Shades can&apos;t report their position, so tell the scene what they should do — or leave them out.
            </p>
          )}
          <div style={{ display: "flex", gap: 6 }}>
            <button className="mini-btn" disabled={!capName.trim()} onClick={saveCapture}>Save scene</button>
            <button className="mini-btn" onClick={() => { setCapOpen(false); setCapName(""); setCapShades("skip"); }}>Cancel</button>
          </div>
        </div>
      )}
      {groups.map(([group, ds]) => (
        <section key={group}>
          <div className="section-label">{GROUP_DISPLAY[group] ?? group}</div>
          {group === "Lighting" && ds.length >= COLLAPSE_LIGHTS_AT ? (
            <RoomLightsBlock room={room} lights={ds} flash={flash} busy={busy} sendSystem={sendSystem} rows={rows} />
          ) : group === "Shades" && ds.length > 1 ? (
            <RoomShadesBlock room={room} shades={ds} flash={flash} busy={busy} sendSystem={sendSystem} rows={rows} coverTrust={coverTrust} />
          ) : (
            <div className="dev-list">{rows(ds)}</div>
          )}
        </section>
      ))}
    </>
  );
}

/**
 * Collapsed room lighting: one "Room lights" card (on/off + a dim slider
 * for the room's dimmers) and any reading lights on their own rows. Every
 * other fixture stays reachable behind "All lights…".
 */
function RoomLightsBlock({
  room, lights, flash, busy, sendSystem, rows,
}: {
  room: string;
  lights: UiDevice[];
  flash: Record<string, Flash>;
  busy: Record<string, boolean>;
  sendSystem: (system: string, command: string, room: string, extra?: Record<string, unknown>) => Promise<SendResult>;
  rows: (ds: UiDevice[]) => React.ReactNode;
}) {
  const [showAll, setShowAll] = useState(false);
  const [drag, setDrag] = useState<number | null>(null);
  const key = `sys:lighting:${room}`;
  const isBusy = !!busy[key];
  const featured = lights.filter(keepsOwnRow);
  const others = lights.filter((d) => !keepsOwnRow(d));
  const onCount = lights.filter((d) => d.state === "on").length;
  const anyOn = onCount > 0;
  const dimmers = lights.filter((d) => d.capabilities.includes("brightness"));
  // The slider reads the average of the lit dimmers (0 when everything is
  // off) — with a mixed room, "brightest light" showed 100% while half the
  // room was dark. Committing fans set_brightness across the room's dimmers.
  const lit = dimmers.filter((d) => d.state === "on").map((d) => d.brightnessPct ?? 100);
  const current = lit.length > 0 ? Math.round(lit.reduce((a, b) => a + b, 0) / lit.length) : 0;
  const value = drag ?? current;
  const commit = (v: number) => {
    setDrag(null);
    if (v === 0) sendSystem("lighting", "turn_off", room);
    else sendSystem("lighting", "set_brightness", room, { brightnessPct: v });
  };
  return (
    <div className="dev-list">
      <div className={`dev-block hero ${flashClass(flash[key])}`}>
        <div className={`dev ${anyOn ? "on" : ""}`}>
          <div>
            <div className="nm">Room lights</div>
            <div className="st">{isBusy ? "…" : anyOn ? `${onCount} of ${lights.length} on` : "off"}</div>
          </div>
          <button
            className="toggle"
            aria-pressed={anyOn}
            aria-label={`${room} lights ${anyOn ? "off" : "on"}`}
            disabled={isBusy}
            onClick={() => sendSystem("lighting", anyOn ? "turn_off" : "turn_on", room)}
          />
        </div>
        {dimmers.length > 0 && (
          <div className="slider-row">
            <input
              type="range"
              min={0}
              max={100}
              value={value}
              aria-label={`${room} lights brightness`}
              disabled={isBusy}
              onChange={(e) => setDrag(Number(e.target.value))}
              onPointerUp={(e) => commit(Number((e.target as HTMLInputElement).value))}
              onKeyUp={(e) => { if (e.key === "Enter") commit(Number((e.target as HTMLInputElement).value)); }}
            />
          </div>
        )}
      </div>
      {rows(featured)}
      {others.length > 0 && (
        <button className="mini-btn expander" aria-expanded={showAll} onClick={() => setShowAll((v) => !v)}>
          {showAll ? "Hide individual lights" : `All lights (${others.length})`}
        </button>
      )}
      {showAll && rows(others)}
    </div>
  );
}

/** Rooms with several shades: one card moves them all; each stays reachable. */
function RoomShadesBlock({
  room, shades, flash, busy, sendSystem, rows, coverTrust,
}: {
  room: string;
  shades: UiDevice[];
  flash: Record<string, Flash>;
  busy: Record<string, boolean>;
  sendSystem: (system: string, command: string, room: string, extra?: Record<string, unknown>) => Promise<SendResult>;
  rows: (ds: UiDevice[]) => React.ReactNode;
  coverTrust: boolean;
}) {
  const [showAll, setShowAll] = useState(false);
  const key = `sys:shades:${room}`;
  const isBusy = !!busy[key];
  // Open/closed summary and button highlights appear only when the server
  // vouches for cover state (C4 feedback fixed); until then, count only.
  const open = shades.filter((d) => d.state === "open").length;
  const allOpen = coverTrust && open === shades.length;
  const allClosed = coverTrust && open === 0;
  const summary = !coverTrust
    ? `${shades.length} shades`
    : allOpen ? `${shades.length} shades · open`
    : allClosed ? `${shades.length} shades · closed`
    : `${open} of ${shades.length} open`;
  return (
    <div className="dev-list">
      <div className={`dev hero ${flashClass(flash[key])}`}>
        <div>
          <div className="nm">Shades</div>
          <div className="st">{isBusy ? "…" : summary}</div>
        </div>
        <div className="btn-row">
          <button className="mini-btn" aria-pressed={allOpen} disabled={isBusy} onClick={() => sendSystem("shades", "open", room)}>Open</button>
          <button className="mini-btn" disabled={isBusy} onClick={() => sendSystem("shades", "stop", room)}>Stop</button>
          <button className="mini-btn" aria-pressed={allClosed} disabled={isBusy} onClick={() => sendSystem("shades", "close", room)}>Close</button>
        </div>
      </div>
      {shades.length > 1 && (
        <button className="mini-btn expander" aria-expanded={showAll} onClick={() => setShowAll((v) => !v)}>
          {showAll ? "Hide individual shades" : `Each shade (${shades.length})`}
        </button>
      )}
      {showAll && rows(shades)}
    </div>
  );
}

function Star({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button
      className={`fav-star ${on ? "on" : ""}`}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      aria-label={`${on ? "Remove" : "Add"} ${label} ${on ? "from" : "to"} favorites`}
    >
      {on ? "★" : "☆"}
    </button>
  );
}

function flashClass(f?: Flash) {
  return f === "ok" ? "dev-flash-ok" : f === "sent" ? "dev-flash-sent" : f === "fail" ? "dev-flash-fail" : "";
}

function Device({
  d, flash, busy, send, fav, onFav, music, coverTrust,
}: {
  d: UiDevice;
  flash?: Flash;
  busy: boolean;
  send: (id: string, body: Record<string, unknown>) => Promise<SendResult>;
  fav?: boolean;
  onFav?: (id: string) => void;
  music?: MusicNow | null;
  coverTrust?: boolean;
}) {
  const star = onFav ? <Star on={!!fav} onClick={() => onFav(d.id)} label={d.label} /> : null;
  if (d.kind === "sauna") return <SaunaCard d={d} busy={busy} send={send} />;
  if (d.kind === "noise") return <NoiseCard d={d} busy={busy} send={send} />;
  if (d.kind === "bed") return <BedCard d={d} busy={busy} send={send} star={star} />;
  if (d.kind === "climate") return <ClimateCard d={d} flash={flash} busy={busy} send={send} star={star} />;
  if (d.kind === "vacuum") return <VacuumCard d={d} flash={flash} busy={busy} send={send} star={star} />;
  // Media zones with selectable inputs (the Control4 matrix rooms) get the
  // full source/transport card; plain streamers keep the toggle row below.
  if (d.kind === "media_player" && (d.sourceList?.length ?? 0) > 0) {
    return <MediaCard d={d} flash={flash} busy={busy} send={send} star={star} music={music ?? null} />;
  }
  if (d.kind === "cover") {
    // State text + button highlight only when the server vouches for cover
    // state (coverTrust); C4's stuck feedback otherwise shows fiction.
    // Commands work either way.
    const isOpen = coverTrust && d.state === "open";
    const isClosed = coverTrust && d.state === "closed";
    return (
      <div className={`dev ${d.available ? "" : "unavailable"} ${flashClass(flash)}`}>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          {star}
          <div>
            <div className="nm">{d.label}</div>
            <div className="st">
              {busy ? "…" : !d.available ? "unavailable" : coverTrust ? d.state : ""}
            </div>
          </div>
        </div>
        <div className="btn-row">
          <button className="mini-btn" aria-pressed={isOpen} disabled={busy} onClick={() => send(d.id, { command: "open" })}>Open</button>
          <button className="mini-btn" disabled={busy} onClick={() => send(d.id, { command: "stop" })}>Stop</button>
          <button className="mini-btn" aria-pressed={isClosed} disabled={busy} onClick={() => send(d.id, { command: "close" })}>Close</button>
        </div>
      </div>
    );
  }

  // Lights and media players: toggle, plus a dimmer slider where supported.
  const on = d.state === "on";
  const hasDimmer = d.capabilities.includes("brightness");
  // Display-name fixes, presentational only (device ids stay stable):
  // most rooms' media player carries the room's own name — inside that
  // room's page "Speakers" says what it is; the TV lift's "on/off" hides
  // which way the TV actually went.
  const label =
    d.kind === "media_player" && d.label === d.room
      ? "Speakers"
      : d.category === "motorized_furniture"
        ? d.label.replace(/^MBR\s+/, "")
        : d.label;
  const stateText =
    d.category === "motorized_furniture" ? (on ? "TV up" : "TV hidden") : d.state;
  const row = (
    <div className={`dev ${on ? "on" : ""} ${d.available ? "" : "unavailable"} ${hasDimmer ? "" : flashClass(flash)}`}>
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        {star}
        <div>
          <div className="nm">{label}</div>
          <div className="st">
            {busy ? "…" : d.available ? `${stateText}${on && d.brightnessPct != null ? ` · ${d.brightnessPct}%` : ""}` : "unavailable"}
          </div>
        </div>
      </div>
      <button
        className="toggle"
        aria-pressed={on}
        aria-label={`${label} ${on ? "off" : "on"}`}
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
        <Dimmer d={d} on={on} busy={busy} send={send} />
      </div>
    </div>
  );
}

/**
 * The slider shows the truth: 0 when the light is off, the reported
 * brightness when on. Local state only exists while dragging.
 */
function Dimmer({
  d, on, busy, send,
}: {
  d: UiDevice;
  on: boolean;
  busy: boolean;
  send: (id: string, body: Record<string, unknown>) => Promise<SendResult>;
}) {
  const [drag, setDrag] = useState<number | null>(null);
  const value = drag ?? (on ? d.brightnessPct ?? 100 : 0);
  const commit = (v: number) => {
    setDrag(null);
    if (v === 0) send(d.id, { command: "turn_off" });
    else send(d.id, { command: "set_brightness", brightnessPct: v });
  };
  return (
    <input
      type="range"
      min={0}
      max={100}
      value={value}
      aria-label={`${d.label} brightness`}
      disabled={busy || !d.available}
      onChange={(e) => setDrag(Number(e.target.value))}
      onPointerUp={(e) => commit(Number((e.target as HTMLInputElement).value))}
      onKeyUp={(e) => {
        if (e.key === "Enter") commit(Number((e.target as HTMLInputElement).value));
      }}
    />
  );
}

function ClimateCard({
  d, flash, busy, send, star,
}: {
  d: UiDevice;
  flash?: Flash;
  busy: boolean;
  send: (id: string, body: Record<string, unknown>) => Promise<SendResult>;
  star?: React.ReactNode;
}) {
  const [target, setTarget] = useState<number | null>(null);
  // The KNX side doesn't reliably echo the setpoint back (reports 0), so
  // remember the last target we sent: the thermostat aligns to it, and the
  // card must keep saying so. HA's echo still wins whenever it reports one.
  const [committed, setCommitted] = useState<number | null>(null);
  const known =
    d.targetTemperature != null && d.targetTemperature >= 10 ? d.targetTemperature : null;
  // With no setpoint at all, start stepping from the room's actual temperature.
  const seed =
    d.currentTemperature != null
      ? Math.min(32, Math.max(10, Math.round(d.currentTemperature * 2) / 2))
      : 24;
  const shown = target ?? known ?? committed ?? seed;
  const hasTarget = target != null || known != null || committed != null;
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const step = (delta: number) => {
    const next = Math.min(32, Math.max(10, Math.round((shown + delta) * 2) / 2));
    setTarget(next);
    if (commitTimer.current) clearTimeout(commitTimer.current);
    commitTimer.current = setTimeout(() => {
      send(d.id, { command: "set_temperature", temperature: next }).then((r) => {
        if (r.ok) setCommitted(next);
        setTarget(null);
      });
    }, 900);
  };

  const active = d.hvacMode != null && d.hvacMode !== "off";
  const pretty = (s: string) => (s.charAt(0).toUpperCase() + s.slice(1)).replace(/_/g, " ");
  // The card answers "how warm is it / what did I ask for": both numbers are
  // labelled, and the setpoint row only exists while the zone runs — when it's
  // off the On|Off segment is the whole story, so a second "off" and a stale
  // target would just be noise.
  return (
    <div className={`climate-card hero ${active ? "on" : ""} ${flashClass(flash)} ${d.available ? "" : "unavailable"}`}>
      <div className="climate-main">
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          {star}
          <div>
            {/* Owner's call: the room reading is context, not the hero —
                quiet and grey; no mode pill (the tinted card + On segment
                already say "running", and the fan row implies the mode). */}
            <div className="now-quiet">
              Room {d.currentTemperature != null ? `${d.currentTemperature}°` : "—"}
            </div>
            {!d.available && <div className="mode">unavailable</div>}
          </div>
        </div>
        <div className="climate-set">
          {active && (
            <>
              <button className="round-btn" disabled={busy || !d.available} onClick={() => step(-0.5)} aria-label="Lower target">−</button>
              <div>
                <div className="temp-lbl" style={{ textAlign: "center" }}>Set</div>
                <div className="target">{hasTarget ? `${shown}°` : "—"}</div>
              </div>
              <button className="round-btn" disabled={busy || !d.available} onClick={() => step(0.5)} aria-label="Raise target">+</button>
            </>
          )}
          <div className="onoff" role="group" aria-label={`${d.label} power`}>
            <button
              aria-pressed={active}
              disabled={busy || !d.available}
              onClick={() => { if (!active) send(d.id, { command: "turn_on" }); }}
            >
              On
            </button>
            <button
              aria-pressed={!active}
              disabled={busy || !d.available}
              onClick={() => { if (active) send(d.id, { command: "turn_off" }); }}
            >
              Off
            </button>
          </div>
        </div>
      </div>
      {active && d.fanSpeedList && d.fanSpeedList.length > 0 && (
        <div className="climate-fan" role="group" aria-label={`${d.label} fan strength`}>
          <span className="st">Fan</span>
          {d.fanSpeedList.map((f) => (
            <button
              key={f}
              className="fan-chip"
              aria-pressed={d.fanSpeed === f}
              disabled={busy}
              onClick={() => { if (d.fanSpeed !== f) send(d.id, { command: "set_fan_mode", fanMode: f }); }}
            >
              {pretty(f)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Roborock vacuums (one per floor). Clean opens an options panel — rooms
 * (map segments fetched from the vacuum's own map), suction level, and
 * passes — then Start fires through the standard command path. Pause and
 * Dock stay one-tap. State and battery are whatever Home Assistant reports.
 */
function VacuumCard({
  d, flash, busy, send, star,
}: {
  d: UiDevice;
  flash?: Flash;
  busy: boolean;
  send: (id: string, body: Record<string, unknown>) => Promise<SendResult>;
  star?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [segs, setSegs] = useState<{ id: number; name: string; named?: boolean }[] | null>(null);
  const [segsFailed, setSegsFailed] = useState(false);
  const [sel, setSel] = useState<number[]>([]);
  const [passes, setPasses] = useState(1);
  const [fan, setFan] = useState<string | null>(null);
  // "Name rooms" mode: the robot's map only knows numbers ("Room 16"), so
  // the panel lets you attach the app's own room names to the segment ids.
  const [roomOptions, setRoomOptions] = useState<string[]>([]);
  const [canRename, setCanRename] = useState(false);
  const [naming, setNaming] = useState(false);
  const [renameTarget, setRenameTarget] = useState<number | null>(null);
  const [renameFailed, setRenameFailed] = useState(false);
  const cleaning = d.state === "cleaning";
  const paused = d.state === "paused";

  // Room list is lazy: fetched from the vacuum's map the first time the
  // panel opens (roborock.get_maps is a real round trip to the robot).
  useEffect(() => {
    if (!open || segs !== null || segsFailed) return;
    fetch(`/api/devices/${d.id}/vacuum`)
      .then(async (res) => {
        if (!res.ok) throw new Error();
        const out = (await res.json()) as {
          segments: { id: number; name: string; named?: boolean }[];
          roomOptions?: string[];
          canRename?: boolean;
        };
        setSegs(out.segments);
        setRoomOptions(out.roomOptions ?? []);
        setCanRename(!!out.canRename);
        if (out.segments.length === 0) setSegsFailed(true);
      })
      .catch(() => setSegsFailed(true));
  }, [open, segs, segsFailed, d.id]);

  const toggleSeg = (id: number) =>
    setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const rename = async (segId: number, name: string | null) => {
    setRenameFailed(false);
    try {
      const res = await fetch(`/api/devices/${d.id}/vacuum`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ segment: segId, name }),
      });
      if (!res.ok) throw new Error();
      setSegs((cur) =>
        cur?.map((s) =>
          s.id === segId ? { id: segId, name: name ?? `Room ${segId}`, named: name != null } : s,
        ) ?? cur,
      );
      setRenameTarget(null);
    } catch {
      setRenameFailed(true);
    }
  };

  const pretty = (s: string) => (s.charAt(0).toUpperCase() + s.slice(1)).replace(/_/g, " ");
  const shownFan = fan ?? d.fanSpeed ?? null;

  const start = async () => {
    setOpen(false);
    if (fan && fan !== d.fanSpeed) {
      const r = await send(d.id, { command: "set_fan_speed", fanSpeed: fan });
      if (!r.ok) return; // send() already flashed the failure
    }
    const body: Record<string, unknown> = { command: "start_cleaning" };
    // Explicit rooms clean just those; no selection means everywhere. Extra
    // passes only exist in Roborock's segment clean, so "everywhere with
    // passes" sends the full segment list.
    if (sel.length > 0) body.segments = sel;
    else if (passes > 1 && segs && segs.length > 0) body.segments = segs.map((s) => s.id);
    if (passes > 1 && Array.isArray(body.segments)) body.repeat = passes;
    await send(d.id, body);
    setSel([]);
    setPasses(1);
    setFan(null);
  };

  const row = (
    <div className={`dev ${cleaning ? "on" : ""} ${d.available ? "" : "unavailable"}`}>
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        {star}
        <div>
          <div className="nm">{d.label}</div>
          <div className="st">
            {busy
              ? "…"
              : d.available
                ? `${d.state}${d.batteryPct != null ? ` · ${d.batteryPct}%` : ""}` +
                  (d.fanSpeed && (cleaning || paused) ? ` · ${pretty(d.fanSpeed).toLowerCase()}` : "")
                : `unavailable${d.note ? ` — ${d.note}` : ""}`}
          </div>
        </div>
      </div>
      <div className="btn-row">
        {cleaning ? (
          <button className="mini-btn" disabled={busy} onClick={() => send(d.id, { command: "pause_cleaning" })}>
            Pause
          </button>
        ) : paused ? (
          // Resume is one tap: a plain start continues the interrupted job.
          <button className="mini-btn" disabled={busy} onClick={() => send(d.id, { command: "start_cleaning" })}>
            Resume
          </button>
        ) : (
          <button
            className="mini-btn"
            disabled={busy || !d.available}
            aria-expanded={open}
            style={open ? { borderColor: "var(--accent)", color: "var(--accent)" } : undefined}
            onClick={() => setOpen((v) => !v)}
          >
            Clean
          </button>
        )}
        <button
          className="mini-btn"
          disabled={busy || !d.available}
          onClick={() => { setOpen(false); send(d.id, { command: "return_to_dock" }); }}
        >
          Dock
        </button>
      </div>
    </div>
  );

  if (!open || cleaning || paused) return <div className={`dev-block ${flashClass(flash)}`}>{row}</div>;

  return (
    <div className={`dev-block ${flashClass(flash)}`}>
      {row}
      <div className="slider-row" style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", paddingBottom: 6 }}>
        <span className="st">Rooms</span>
        {segs === null && !segsFailed && <span className="st">loading map…</span>}
        {segsFailed && <span className="st">whole floor (no rooms on the map)</span>}
        {(segs ?? []).map((s) => (
          <button
            key={s.id}
            className="mini-btn"
            style={
              (naming ? renameTarget === s.id : sel.includes(s.id))
                ? { background: "var(--accent)", color: "var(--accent-ink)", borderColor: "var(--accent)" }
                : undefined
            }
            onClick={() => (naming ? setRenameTarget((t) => (t === s.id ? null : s.id)) : toggleSeg(s.id))}
          >
            {naming && s.named ? `${s.id} · ${s.name}` : s.name}
          </button>
        ))}
        {canRename && segs && segs.length > 0 && (
          <button
            className="mini-btn"
            style={naming ? { borderColor: "var(--accent)", color: "var(--accent)" } : { color: "var(--dim)" }}
            onClick={() => { setNaming((v) => !v); setRenameTarget(null); setRenameFailed(false); }}
          >
            {naming ? "Done" : "Name rooms"}
          </button>
        )}
      </div>
      {naming && (
        <div className="slider-row" style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", paddingBottom: 6 }}>
          {renameTarget === null ? (
            <span className="st">
              {renameFailed ? "rename failed — try again" : "tap a room number, then pick which room it is"}
            </span>
          ) : (
            <>
              <span className="st">{`${renameFailed ? "failed, try again — " : ""}Room ${renameTarget} is`}</span>
              {roomOptions.map((r) => (
                <button key={r} className="mini-btn" onClick={() => rename(renameTarget, r)}>
                  {r}
                </button>
              ))}
              <button
                className="mini-btn"
                style={{ color: "var(--dim)" }}
                onClick={() => rename(renameTarget, null)}
              >
                Clear name
              </button>
            </>
          )}
        </div>
      )}
      {d.fanSpeedList && d.fanSpeedList.length > 0 && (
        <div className="slider-row" style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", paddingBottom: 6 }}>
          <span className="st">Suction</span>
          {d.fanSpeedList.map((f) => (
            <button
              key={f}
              className="mini-btn"
              style={shownFan === f ? { background: "var(--accent)", color: "var(--accent-ink)", borderColor: "var(--accent)" } : undefined}
              onClick={() => setFan(f)}
            >
              {pretty(f)}
            </button>
          ))}
        </div>
      )}
      {segs && segs.length > 0 && (
        <div className="slider-row" style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", paddingBottom: 6 }}>
          <span className="st">Passes</span>
          {[1, 2, 3].map((n) => (
            <button
              key={n}
              className="mini-btn"
              style={passes === n ? { borderColor: "var(--accent)", color: "var(--accent)" } : undefined}
              onClick={() => setPasses(n)}
            >
              {n}×
            </button>
          ))}
        </div>
      )}
      <div className="slider-row">
        <button className="mini-btn" style={{ width: "100%", padding: 10 }} disabled={busy} onClick={start}>
          {`Start · ${
            sel.length > 0
              ? `${sel.length} room${sel.length === 1 ? "" : "s"}`
              : "everywhere"
          }${passes > 1 ? ` · ${passes} passes` : ""}`}
        </button>
      </div>
    </div>
  );
}

/**
 * Media zone with selectable inputs — the Control4 matrix rooms. These zones
 * have NO turn_on: tapping a source is how a zone wakes, so the card leads
 * with the source chips. Transport (play/pause) and Off appear once
 * something is active; volume always works.
 *
 * Chips show only inputs that produce sound in this house: physical sources
 * (Gramophone, the room's TV, XBox). Hidden on purpose:
 * - "Unknown Device - …": unnamed matrix inputs, until identified in
 *   Composer (leading suspects for the VSSL streaming feeds).
 * - TuneIn / My Music / Digital Media: Control4's built-in streaming apps,
 *   never configured on the Core — selecting them switches the zone to a
 *   silent app. Streaming here is Spotify Connect / AirPlay via the VSSL
 *   amps instead (docs plan, phase M3).
 */
const HIDDEN_SOURCES =
  // Owner's call (2026-07-23, twice refined): the Music card is play +
  // volume, full stop — no input chips. TV/XBox, the C4 apps, and finally
  // the Gramophone too. C4's own automation still routes TV audio when a
  // TV turns on; the turntable stays reachable from the Control4 keypads.
  /^(Unknown Device\b|TuneIn$|My Music$|Digital Media$|Smart TV\b|XBox$|Gramophone$)/i;
/** The now-playing line names C4's internals in installer-speak; translate
 * the two a family member actually meets. ("Spotify C4 Terrace" on the Den
 * card = the shared Spotify stream, not the Terrace's speakers.) */
function prettyNowPlaying(t: string): string {
  if (/^Spotify C4 /.test(t)) return "Spotify";
  // "TV" alone read as a destination ("music playing on the TV") — say
  // what's true: the room speakers are carrying the TV's sound.
  if (/^Smart TV /.test(t)) return "TV sound";
  return t;
}
/**
 * MusicCast receivers (Den/Lounge/MBR Yamahas) list ~25 inputs, nearly all
 * noise for this house: unused music services (Napster/TIDAL/…), bare HDMI
 * and AUDIO jacks, tuner. Daniel's ask: streaming chips only — Spotify and
 * AirPlay (plus Bluetooth and TV audio, which cost nothing and get used).
 * Receivers are recognized by advertising Spotify in their source list.
 */
const RECEIVER_SOURCES = ["Spotify", "AirPlay", "Bluetooth", "TV"];
function MediaCard({
  d, flash, busy, send, star, music,
}: {
  d: UiDevice;
  flash?: Flash;
  busy: boolean;
  send: (id: string, body: Record<string, unknown>) => Promise<SendResult>;
  star?: React.ReactNode;
  music: MusicNow | null;
}) {
  const [drag, setDrag] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const active = ["playing", "paused", "buffering", "on"].includes(d.state);
  const playing = d.state === "playing";
  const label = d.label === d.room ? "Speakers" : d.label;
  const isReceiver = (d.sourceList ?? []).includes("Spotify");
  const sources = (d.sourceList ?? []).filter((s) =>
    isReceiver ? RECEIVER_SOURCES.includes(s) : !HIDDEN_SOURCES.test(s),
  );
  const volume = drag ?? d.volumePct ?? 0;
  // The Spotify session lives HERE when its Connect device maps to this
  // room: the card upgrades to track/artist/art + skip (via the Spotify
  // API — the C4 zones themselves can't skip through HA).
  const sessionHere = !!music?.room && music.room === d.room && active;
  const playingElsewhere = !!music?.playing && !!music.room && music.room !== d.room && !active;
  const doSkip = (direction: "next" | "previous") => {
    fetch("/api/music/skip", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ direction }),
    }).catch(() => {});
  };
  // Idle Play = "continue my Spotify here": the backend resumes the
  // household account on this room's Connect endpoint (/api/music/play).
  const playHere = () => {
    setNote("starting…");
    fetch("/api/music/play", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ room: d.room }),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? "play failed");
        setNote(null);
      })
      .catch((e) => {
        setNote(e instanceof Error ? e.message : "play failed");
        setTimeout(() => setNote(null), 8000);
      });
  };
  return (
    <div className={`dev-block hero ${flashClass(flash)} ${d.available ? "" : "unavailable"}`}>
      <div className={`dev ${active ? "on" : ""}`}>
        <div style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}>
          {star}
          {sessionHere && music?.artUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={music.artUrl} alt="" width={40} height={40}
              style={{ borderRadius: 8, marginRight: 6, flexShrink: 0 }} />
          )}
          <div style={{ minWidth: 0 }}>
            <div className="nm">{label}</div>
            <div className="st">
              {note ??
                (busy
                  ? "…"
                  : !d.available
                    ? "unavailable"
                    : sessionHere && music?.track
                      ? `${music.track}${music.artist ? ` — ${music.artist}` : ""}`
                      : active && (d.mediaTitle || d.source)
                        ? // What's actually playing beats the input name; both
                          // pass through prettyNowPlaying (session names →
                          // "Spotify", C4 TV inputs → "TV").
                          `${d.state} · ${prettyNowPlaying(d.mediaTitle ?? d.source ?? "")}`
                        : playingElsewhere
                          ? `${d.state} · Spotify is in the ${music!.room}`
                          : d.state)}
            </div>
          </div>
        </div>
        <div className="btn-row">
          {sessionHere && (
            <button className="mini-btn" aria-label="Previous track" disabled={busy} onClick={() => doSkip("previous")}>
              ⏮
            </button>
          )}
          <button
            className="mini-btn"
            disabled={busy || !d.available}
            // Play means MUSIC: pause/resume only govern a Spotify session
            // that's actually here. A zone carrying TV audio (or anything
            // else) treats Play as "bring my Spotify to this room" — a
            // media_play at the TV feed did nothing, verifiably confusingly.
            onClick={() =>
              playing
                ? send(d.id, { command: "pause" })
                : sessionHere
                  ? send(d.id, { command: "play" })
                  : playHere()
            }
          >
            {playing ? "Pause" : "Play"}
          </button>
          {sessionHere && (
            <button className="mini-btn" aria-label="Next track" disabled={busy} onClick={() => doSkip("next")}>
              ⏭
            </button>
          )}
          {(active || d.canTurnOn) && (
            <button
              className="mini-btn"
              disabled={busy || !d.available}
              onClick={() => send(d.id, { command: active ? "turn_off" : "turn_on" })}
            >
              {active ? "Off" : "On"}
            </button>
          )}
        </div>
      </div>
      {sources.length > 0 && (
        <div className="slider-row" style={{ display: "flex", gap: 6, flexWrap: "wrap", paddingBottom: 6 }}>
          {sources.map((s) => (
            <button
              key={s}
              className="mini-btn"
              disabled={busy || !d.available}
              style={d.source === s ? { background: "var(--accent)", color: "var(--accent-ink)", borderColor: "var(--accent)" } : undefined}
              onClick={() => send(d.id, { command: "select_source", source: s })}
            >
              {s}
            </button>
          ))}
        </div>
      )}
      <div className="slider-row">
        <input
          type="range"
          min={0}
          max={100}
          value={volume}
          aria-label={`${label} volume`}
          disabled={busy || !d.available}
          onChange={(e) => setDrag(Number(e.target.value))}
          onPointerUp={(e) => {
            const v = Number((e.target as HTMLInputElement).value);
            setDrag(null);
            send(d.id, { command: "set_volume", volumePct: v });
          }}
        />
      </div>
    </div>
  );
}

/**
 * White-noise machine: the sound (type + volume) is ours to control; on/off
 * belongs to the Control4 bedside button, so the card reports playing/idle
 * honestly from the server's listener count instead of pretending.
 */
/**
 * The I'm-home / Away switch, on the Home screen where it gets flipped on
 * the way out the door. What it changes lives server-side (lib/away):
 * automations run by their Always / When home / When away setting, sleep
 * sense stands down while away, timers keep working, and the Eight Sleep
 * sides follow. The Automations screen's Away card explains the details.
 */
function AwaySwitch({ headers }: { headers: () => HeadersInit }) {
  const [st, setSt] = useState<{ away: boolean; canToggle: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  // The Eight Sleep away sync is best-effort server-side; a failure must
  // still reach whoever flipped the switch, not only the audit log.
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/away", { headers: headers() })
      .then((r) => (r.ok ? r.json() : null))
      .then(setSt)
      .catch(() => setSt(null));
  }, [headers]);

  if (!st) return null;

  const set = (away: boolean) => {
    if (busy || away === st.away) return;
    setBusy(true);
    setNote(null);
    fetch("/api/away", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers() },
      body: JSON.stringify({ away }),
    })
      .then((r) => r.json())
      .then((out: { ok?: boolean; away?: boolean; bed?: { synced: boolean } | null }) => {
        if (out.ok) {
          setSt({ ...st, away: out.away === true });
          if (out.bed && !out.bed.synced) setNote("bed didn't sync — set Away in the Eight Sleep app");
        }
      })
      .catch(() => {})
      .finally(() => setBusy(false));
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4, marginTop: 4 }}>
      <div className="view-toggle" role="group" aria-label="Home or away">
        <button aria-pressed={!st.away} disabled={busy || !st.canToggle} onClick={() => set(false)}>
          I&rsquo;m home
        </button>
        <button aria-pressed={st.away} disabled={busy || !st.canToggle} onClick={() => set(true)}>
          Away
        </button>
      </div>
      {note && (
        <div className="st" style={{ color: "var(--danger)", textAlign: "right", maxWidth: 190 }}>{note}</div>
      )}
    </div>
  );
}

/**
 * An Eight Sleep bed side: presence + warmth on the Pod's own -100…+100
 * scale (not °C — Eight Sleep's unit). The Pod's entities can't echo a
 * side's on/off or its level back, so the card offers actions and shows a
 * transient "sent" note instead of pretending to know the resulting state.
 */
function BedCard({
  d, busy, send, star,
}: {
  d: UiDevice;
  busy: boolean;
  send: (id: string, body: Record<string, unknown>) => Promise<SendResult>;
  star?: React.ReactNode;
}) {
  const [drag, setDrag] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const level = drag ?? 0;

  const flashNote = (msg: string) => {
    setNote(msg);
    setTimeout(() => setNote(null), 5000);
  };

  // Setting a warmth level wakes the side first (like "AC on at °C") —
  // heat_set on a sleeping side shouldn't silently do nothing.
  const commitLevel = async (v: number) => {
    setDrag(null);
    const on = await send(d.id, { command: "turn_on" });
    if (!on.ok) return flashNote(on.error ?? "failed");
    const r = await send(d.id, { command: "set_bed_level", level: v });
    flashNote(r.ok ? `sent — warmth ${v > 0 ? "+" : ""}${v}` : r.error ?? "failed");
  };

  // Presence is cloud-derived from processed heart-rate data and lags by
  // minutes to hours (field-tested). A fresh reading stands alone; a stale
  // one carries its timestamp so nobody mistakes last night for now.
  const presence = (() => {
    if (d.bedPresence == null) return null;
    const text = d.bedPresence ? "someone's in bed" : "bed empty";
    const changed = d.bedPresenceSince ? Date.parse(d.bedPresenceSince) : NaN;
    if (!Number.isFinite(changed) || Date.now() - changed < 10 * 60_000) return text;
    const t = new Date(changed);
    const stamp =
      Date.now() - changed < 86_400_000
        ? t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        : t.toLocaleDateString([], { month: "short", day: "numeric" });
    return `${text} (as of ${stamp})`;
  })();
  return (
    <div className={`dev-block hero ${d.available ? "" : "unavailable"}`}>
      <div className="dev">
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          {star}
          <div>
            <div className="nm">{d.label}</div>
            <div className="st">
              {note ??
                (d.available
                  ? [presence, d.currentTemperature != null ? `reads ${d.currentTemperature}°` : null]
                      .filter(Boolean).join(" · ") || "ready"
                  : `unavailable${d.note ? ` — ${d.note}` : ""}`)}
            </div>
          </div>
        </div>
        <button
          className="mini-btn"
          disabled={busy || !d.available}
          onClick={() =>
            send(d.id, { command: "turn_off" }).then((r) =>
              flashNote(r.ok ? "sent — side off" : r.error ?? "failed"),
            )
          }
        >
          Off
        </button>
      </div>
      <div className="slider-row" style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", paddingBottom: 6 }}>
        <button className="mini-btn" disabled={busy || !d.available} onClick={() => commitLevel(-30)}>
          Cool
        </button>
        <button className="mini-btn" disabled={busy || !d.available} onClick={() => commitLevel(30)}>
          Warm
        </button>
        <input
          type="range"
          min={-100}
          max={100}
          step={5}
          value={level}
          aria-label={`${d.label} warmth`}
          disabled={busy || !d.available}
          style={{ flex: "1 1 120px" }}
          onChange={(e) => setDrag(Number(e.target.value))}
          onPointerUp={(e) => commitLevel(Number((e.target as HTMLInputElement).value))}
          onKeyUp={(e) => {
            if (e.key === "Enter") commitLevel(Number((e.target as HTMLInputElement).value));
          }}
        />
      </div>
    </div>
  );
}

function NoiseCard({
  d, busy, send,
}: {
  d: UiDevice;
  busy: boolean;
  send: (id: string, body: Record<string, unknown>) => Promise<SendResult>;
}) {
  const [drag, setDrag] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const playing = d.state === "on";
  const volume = drag ?? d.volumePct ?? 50;

  // Noise TYPE has no CommandSchema equivalent, so it goes to the dedicated
  // route; on/off and volume ride the standard command path (so scenes,
  // automations, and the assistant get them too).
  const setType = (noiseType: string) => {
    setNote(null);
    fetch("/api/noise", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ noiseType }),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json()).error ?? "failed");
      })
      .catch((e) => {
        setNote(e instanceof Error ? e.message : "failed");
        setTimeout(() => setNote(null), 6000);
      });
  };

  return (
    <div className={`dev-block hero ${d.available ? "" : "unavailable"}`}>
      <div className={`dev ${playing ? "on" : ""}`}>
        <div>
          <div className="nm">{d.label}</div>
          <div className="st">
            {note ??
              (d.available
                ? playing
                  ? `playing · ${d.noiseType ?? "white"}`
                  : "off"
                : `unavailable${d.note ? ` — ${d.note}` : ""}`)}
          </div>
        </div>
        <button
          className="toggle"
          aria-pressed={playing}
          aria-label={`${d.label} ${playing ? "off" : "on"}`}
          disabled={busy || !d.available}
          onClick={() =>
            send(d.id, { command: playing ? "turn_off" : "turn_on" }).then((r) => {
              if (!r.ok) { setNote(r.error ?? "failed"); setTimeout(() => setNote(null), 6000); }
            })
          }
        />
      </div>
      <div className="slider-row" style={{ display: "flex", gap: 6, flexWrap: "wrap", paddingBottom: 6 }}>
        {(["white", "brown", "pink"] as const).map((t) => (
          <button
            key={t}
            className="mini-btn"
            disabled={busy || !d.available}
            style={d.noiseType === t ? { background: "var(--accent)", color: "var(--accent-ink)", borderColor: "var(--accent)" } : undefined}
            onClick={() => setType(t)}
          >
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      <div className="slider-row">
        <input
          type="range"
          min={0}
          max={100}
          value={volume}
          aria-label="Noise volume"
          disabled={busy || !d.available}
          onChange={(e) => setDrag(Number(e.target.value))}
          onPointerUp={(e) => {
            const v = Number((e.target as HTMLInputElement).value);
            setDrag(null);
            send(d.id, { command: "set_volume", volumePct: v });
          }}
        />
      </div>
    </div>
  );
}

function SaunaCard({
  d, busy, send,
}: {
  d: UiDevice;
  busy: boolean;
  send: (id: string, body: Record<string, unknown>) => Promise<SendResult>;
}) {
  const [fill, setFill] = useState(0);
  const [label, setLabel] = useState<string | null>(null);
  const [pendingTemp, setPendingTemp] = useState<number | null>(null);
  const [committedTemp, setCommittedTemp] = useState<number | null>(null);
  // Run time: null = no app auto-stop (the KLAFS bathing-time limit governs).
  const [runFor, setRunFor] = useState<number | null>(120);
  const tempTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const raf = useRef<number | null>(null);
  const start = useRef(0);
  const HOLD_MS = 1100;
  const on = d.state === "on";

  // While running, picking a duration replaces the pending auto-stop.
  const setTimerNow = (minutes: number) => {
    setLabel("Scheduling auto-stop…");
    fetch("/api/sauna/timer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ minutes }),
    })
      .then(async (res) => {
        const out = await res.json();
        if (!res.ok) throw new Error(out.error ?? "auto-stop failed");
        setLabel(null);
      })
      .catch((e) => {
        setLabel(e instanceof Error ? e.message : "auto-stop failed");
        setTimeout(() => setLabel(null), 6000);
      });
  };

  // KLAFS target (40-100°C, 5° steps). Preference: mid-adjustment value,
  // then — for a grace window after we send a change, because KLAFS's
  // GetData lags behind ChangeTemperature — the target we sent, then the
  // cabin's reported target.
  const committedAt = useRef(0);
  const reported = d.targetTemperature != null && d.targetTemperature >= 40 ? d.targetTemperature : null;
  const commitFresh = Date.now() - committedAt.current < 90_000;
  const shownTarget = pendingTemp ?? (commitFresh ? committedTemp ?? reported : reported ?? committedTemp);

  const stepTemp = (delta: number) => {
    const base = shownTarget ?? 85;
    const next = Math.min(100, Math.max(40, base + delta));
    setPendingTemp(next);
    if (tempTimer.current) clearTimeout(tempTimer.current);
    tempTimer.current = setTimeout(() => {
      send(d.id, { command: "set_temperature", temperature: next, confirm: true }).then((r) => {
        setPendingTemp(null);
        if (r.ok) {
          setCommittedTemp(next);
          committedAt.current = Date.now();
        } else {
          setLabel(r.error ?? "temperature change failed");
          setTimeout(() => setLabel(null), 6000);
        }
      });
    }, 900);
  };

  const tick = useCallback(() => {
    const p = Math.min(1, (Date.now() - start.current) / HOLD_MS);
    setFill(p);
    if (p >= 1) {
      setFill(0);
      setLabel(on ? "Stopping — verifying…" : "Starting — verifying heating…");
      const body: Record<string, unknown> = { command: on ? "turn_off" : "turn_on", confirm: true };
      if (!on) {
        // Start carries the chosen target and run time; the sauna app
        // schedules the auto-stop server-side.
        if (shownTarget != null) body.temperature = shownTarget;
        if (runFor != null) body.runForMinutes = runFor;
      }
      send(d.id, body).then((r) => {
        // Show the server's actual reason, not a mute "Command failed".
        setLabel(r.ok ? null : r.error ?? "Command failed");
        if (!r.ok) setTimeout(() => setLabel(null), 8000);
      });
      return;
    }
    raf.current = requestAnimationFrame(tick);
  }, [on, d.id, send, shownTarget, runFor]);

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
    <div className="dev-block hero">
      <div className={`dev ${on ? "on" : ""} ${d.available ? "" : "unavailable"}`}>
        <div>
          <div className="nm">{d.label}</div>
          <div className="st">
            {d.available
              ? `${on ? "heating" : "off"} · cabin ${d.currentTemperature ?? "—"}°` +
                (on && d.stopAt ? ` · stops at ${d.stopAt}` : "")
              : `unavailable${d.note ? ` — ${d.note}` : ""}`}
          </div>
        </div>
        <div className="climate-set">
          <button
            className="round-btn"
            disabled={busy || !d.available}
            onClick={() => stepTemp(-5)}
            aria-label="Lower sauna target"
          >
            −
          </button>
          <div className="target">{shownTarget != null ? `${shownTarget}°` : "—"}</div>
          <button
            className="round-btn"
            disabled={busy || !d.available}
            onClick={() => stepTemp(5)}
            aria-label="Raise sauna target"
          >
            +
          </button>
        </div>
      </div>
      <div className="slider-row" style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", paddingBottom: 6 }}>
        <span className="st">{on ? "Stop after" : "Run for"}</span>
        {[60, 120, 180].map((m) => (
          <button
            key={m}
            className="mini-btn"
            style={!on && runFor === m ? { borderColor: "var(--accent)", color: "var(--accent)" } : undefined}
            disabled={busy || !d.available}
            onClick={() => (on ? setTimerNow(m) : setRunFor(m))}
          >
            {m / 60}h
          </button>
        ))}
        {!on && (
          <button
            className="mini-btn"
            style={runFor === null ? { borderColor: "var(--accent)", color: "var(--accent)" } : undefined}
            disabled={busy || !d.available}
            onClick={() => setRunFor(null)}
          >
            No limit
          </button>
        )}
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

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import FloorPlan from "./FloorPlan";
import NavBar from "./NavBar";
import { BlindsIcon, BulbIcon, FlameIcon, GridIcon, MapIcon, SnowIcon } from "./icons";

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
}

const GROUP_ORDER = ["Lighting", "Shades", "Climate & Comfort", "Media", "Utilities", "Appliances"];

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
      };
      setDevices(out.devices);
      if (out.role) setRole(out.role);
      setFloorHeating(out.floorHeatingRooms ?? []);
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

  const shadesOpenTotal = useMemo(
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

          {favDevices.length > 0 && (
            <>
              <div className="section-label">Favorites</div>
              <div className="dev-list">
                {favDevices.map((d) => (
                  <Device key={d.id} d={d} flash={flash[d.id]} busy={!!busy[d.id]} send={send} fav={true} onFav={toggleFav} />
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
              <div className="rn" style={{ display: "flex", alignItems: "center", gap: 7 }}><FlameIcon size={18} /> Heating</div>
              <div className={`rs ${heatingOnTotal > 0 ? "on" : ""}`}>
                {heatingOnTotal > 0 ? `${heatingOnTotal} room${heatingOnTotal === 1 ? "" : "s"}` : "all off"}
              </div>
            </a>
            <a className="room-card" href="/systems/shades" style={{ textDecoration: "none", display: "block" }}>
              <div className="rn" style={{ display: "flex", alignItems: "center", gap: 7 }}><BlindsIcon size={18} /> Shades</div>
              <div className={`rs ${shadesOpenTotal > 0 ? "on" : ""}`}>
                {shadesOpenTotal > 0 ? `${shadesOpenTotal} open` : "all closed"}
              </div>
            </a>
          </div>

          {(scenes.length > 0 || customScenes.length > 0) && (
            <>
              <div className="section-label">
                Scenes{" "}
                {canProgram && customScenes.length > 0 && (
                  <button
                    onClick={() => setEditScenes((v) => !v)}
                    style={{ background: "none", border: "none", color: "var(--dim)", font: "inherit", fontSize: 11, cursor: "pointer", textDecoration: "underline", textTransform: "none", letterSpacing: 0 }}
                  >
                    {editScenes ? "done" : "edit"}
                  </button>
                )}
              </div>
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
                {customScenes.map((s) => (
                  <button
                    key={s.id}
                    className="scene-pill"
                    style={{ background: "var(--chip)", color: "var(--ink)", border: "1px solid var(--card-line)" }}
                    onClick={() => {
                      if (editScenes) {
                        if (window.confirm(`Delete scene "${s.name}"?`)) sceneOp({ action: "delete", id: s.id });
                      } else {
                        sceneOp({ action: "apply", id: s.id });
                      }
                    }}
                  >
                    {editScenes ? `✕ ${s.name}` : s.name}
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
          send={send}
          favs={favs}
          onFav={toggleFav}
          onCapture={
            canProgram
              ? (room) => {
                  const name = window.prompt(`Save ${room} as a scene — name it:`);
                  if (name?.trim()) sceneOp({ action: "capture", name: name.trim(), room });
                }
              : null
          }
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

function RoomView({
  room, groups, flash, busy, send, favs, onFav, onCapture, back,
}: {
  room: string;
  groups: [string, UiDevice[]][];
  flash: Record<string, Flash>;
  busy: Record<string, boolean>;
  send: (id: string, body: Record<string, unknown>) => Promise<SendResult>;
  favs: string[];
  onFav: (id: string) => void;
  onCapture: ((room: string) => void) | null;
  back: () => void;
}) {
  return (
    <>
      <button className="h-back" onClick={back}>‹ Home</button>
      <h1 className="h-title">{room}</h1>
      {onCapture && (
        <p className="h-sub">
          <button
            onClick={() => onCapture(room)}
            style={{ background: "none", border: "none", color: "var(--dim)", font: "inherit", padding: 0, cursor: "pointer", textDecoration: "underline" }}
          >
            save current look as a scene
          </button>
        </p>
      )}
      {groups.map(([group, ds]) => (
        <section key={group}>
          <div className="section-label">{group}</div>
          <div className="dev-list">
            {ds.map((d) => (
              <Device
                key={d.id}
                d={d}
                flash={flash[d.id]}
                busy={!!busy[d.id]}
                send={send}
                fav={favs.includes(d.id)}
                onFav={onFav}
              />
            ))}
          </div>
        </section>
      ))}
    </>
  );
}

function Star({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      aria-label={`${on ? "Remove" : "Add"} ${label} ${on ? "from" : "to"} favorites`}
      style={{
        background: "none", border: "none", cursor: "pointer", padding: "0 2px",
        fontSize: 16, color: on ? "var(--active)" : "var(--dim)", opacity: on ? 1 : 0.55,
      }}
    >
      {on ? "★" : "☆"}
    </button>
  );
}

function flashClass(f?: Flash) {
  return f === "ok" ? "dev-flash-ok" : f === "sent" ? "dev-flash-sent" : f === "fail" ? "dev-flash-fail" : "";
}

function Device({
  d, flash, busy, send, fav, onFav,
}: {
  d: UiDevice;
  flash?: Flash;
  busy: boolean;
  send: (id: string, body: Record<string, unknown>) => Promise<SendResult>;
  fav?: boolean;
  onFav?: (id: string) => void;
}) {
  const star = onFav ? <Star on={!!fav} onClick={() => onFav(d.id)} label={d.label} /> : null;
  if (d.kind === "sauna") return <SaunaCard d={d} busy={busy} send={send} />;
  if (d.kind === "climate") return <ClimateCard d={d} flash={flash} busy={busy} send={send} star={star} />;
  if (d.kind === "cover") {
    return (
      <div className={`dev ${d.available ? "" : "unavailable"} ${flashClass(flash)}`}>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          {star}
          <div>
            <div className="nm">{d.label}</div>
            <div className="st">{busy ? "…" : d.available ? d.state : "unavailable"}</div>
          </div>
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
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        {star}
        <div>
          <div className="nm">{d.label}</div>
          <div className="st">
            {busy ? "…" : d.available ? `${d.state}${on && d.brightnessPct != null ? ` · ${d.brightnessPct}%` : ""}` : "unavailable"}
          </div>
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
  return (
    <div className={`climate-card ${flashClass(flash)} ${d.available ? "" : "unavailable"}`}>
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        {star}
        <div>
          <div className="now">{d.currentTemperature != null ? `${d.currentTemperature}°` : "—"}</div>
          <div className={`mode ${active ? "active" : ""}`}>
            {d.available ? (d.hvacMode ?? "unknown") : "unavailable"}
          </div>
        </div>
      </div>
      <div className="climate-set">
        <button className="round-btn" disabled={busy || !d.available} onClick={() => step(-0.5)} aria-label="Lower target">−</button>
        <div className="target">{hasTarget ? `${shown}°` : "—"}</div>
        <button className="round-btn" disabled={busy || !d.available} onClick={() => step(0.5)} aria-label="Raise target">+</button>
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
    <div className="dev-block">
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

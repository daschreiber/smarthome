"use client";

import { useCallback, useEffect, useState } from "react";
import NavBar from "../NavBar";

/**
 * Automations screen: list + a pragmatic builder for time-triggered steps.
 * Richer creation (arbitrary devices, natural language) arrives with the
 * conversational layer, which produces the same automation spec.
 */

interface Step {
  time: string;
  days?: number[];
  date?: string;
  actions: Array<
    | { type: "scene"; sceneId: string }
    | { type: "room"; room: string; command: "lights_on" | "lights_off" }
  >;
  lastFired?: string;
}

interface Automation {
  id: string;
  name: string;
  enabled: boolean;
  steps: Step[];
  createdBy: string;
}

interface SceneMeta { id: string; name: string; }

interface TimerRule {
  id: string;
  deviceId: string;
  afterMinutes: number;
  enabled: boolean;
}

interface LightDevice { id: string; label: string; room: string; }

const DAY_PRESETS: Array<{ label: string; days?: number[] }> = [
  { label: "Every day" },
  { label: "Weekdays (Mon–Fri)", days: [1, 2, 3, 4, 5] },
  { label: "Weekend (Sat–Sun)", days: [0, 6] },
];

function describeStep(s: Step): string {
  const when = s.date
    ? `once on ${s.date} at ${s.time}`
    : s.days && s.days.length
      ? `${s.days.map((d) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d]).join("/")} at ${s.time}`
      : `every day at ${s.time}`;
  const what = s.actions
    .map((a) => (a.type === "scene" ? `scene "${a.sceneId}"` : `${a.room} lights ${a.command === "lights_on" ? "on" : "off"}`))
    .join(", ");
  return `${when} → ${what}`;
}

export default function Automations() {
  const [items, setItems] = useState<Automation[]>([]);
  const [scenes, setScenes] = useState<SceneMeta[]>([]);
  const [rooms, setRooms] = useState<string[]>([]);
  const [tz, setTz] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // builder state
  const [name, setName] = useState("");
  const [steps, setSteps] = useState<Step[]>([]);
  const [time, setTime] = useState("18:00");
  const [preset, setPreset] = useState(0);
  const [date, setDate] = useState("");
  const [actKind, setActKind] = useState<"room_on" | "room_off" | "scene">("room_on");
  const [actRoom, setActRoom] = useState("");
  const [actScene, setActScene] = useState("");

  // auto-off timers
  const [timers, setTimers] = useState<TimerRule[]>([]);
  const [lights, setLights] = useState<LightDevice[]>([]);
  const [timerDevice, setTimerDevice] = useState("");
  const [timerMinutes, setTimerMinutes] = useState(20);

  const load = useCallback(async () => {
    const res = await fetch("/api/automations");
    if (!res.ok) {
      setError((await res.json()).error ?? `HTTP ${res.status}`);
      return;
    }
    const body = await res.json();
    setItems(body.automations);
    setTz(body.tz);
    const [sc, home, tm] = await Promise.all([fetch("/api/scenes"), fetch("/api/home"), fetch("/api/timers")]);
    if (sc.ok) setScenes(((await sc.json()) as { scenes: SceneMeta[] }).scenes);
    if (home.ok) {
      const devs = ((await home.json()) as {
        devices: Array<{ id: string; label: string; room: string; kind: string; category: string }>;
      }).devices;
      const lightDevs = devs.filter((d) => d.kind === "light" && d.category !== "scene_switch");
      setRooms([...new Set(lightDevs.map((d) => d.room))].sort());
      // Timers apply to lights AND underfloor heating ("never longer than 2h").
      const timeable = devs.filter(
        (d) => (d.kind === "light" && d.category !== "scene_switch") || d.kind === "heating",
      );
      setLights(
        timeable
          .map((d) => ({ id: d.id, label: d.label, room: d.room }))
          .sort((a, b) => `${a.room} ${a.label}`.localeCompare(`${b.room} ${b.label}`)),
      );
    }
    if (tm.ok) setTimers(((await tm.json()) as { timers: TimerRule[] }).timers);
    setError(null);
  }, []);

  useEffect(() => { load(); }, [load]);

  const post = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const res = await fetch("/api/automations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error ?? "failed");
      await load();
      setError(null);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const addStep = () => {
    const action =
      actKind === "scene"
        ? actScene && ({ type: "scene", sceneId: actScene } as const)
        : actRoom && ({ type: "room", room: actRoom, command: actKind === "room_on" ? "lights_on" : "lights_off" } as const);
    if (!action) return;
    const step: Step = { time, actions: [action] };
    if (date) step.date = date;
    else if (DAY_PRESETS[preset].days) step.days = DAY_PRESETS[preset].days;
    setSteps((s) => [...s, step]);
  };

  const create = async () => {
    if (!name.trim() || steps.length === 0) return;
    const ok = await post({ action: "create", spec: { name: name.trim(), steps } });
    if (ok) {
      setName("");
      setSteps([]);
    }
  };

  const timerOp = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const res = await fetch("/api/timers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error ?? "failed");
      setTimers(out.timers);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  };

  const lightById = (id: string) => lights.find((l) => l.id === id);

  return (
    <main className="shell">
      <h1 className="h-title">Automations</h1>
      <p className="h-sub">Times are {tz ? `${tz.split("/").pop()!.replace(/_/g, " ")} time` : "house time"}. One-shot automations disable themselves after firing.</p>
      {error && <div className="error-banner">{error}</div>}

      {items.map((a) => (
        <div key={a.id} className="dev" style={{ alignItems: "flex-start" }}>
          <div>
            <div className="nm">{a.name}</div>
            {a.steps.map((s, i) => (
              <div key={i} className="st">{describeStep(s)}</div>
            ))}
          </div>
          <div className="btn-row">
            <button className="mini-btn" disabled={busy} onClick={() => post({ action: "toggle", id: a.id, enabled: !a.enabled })}>
              {a.enabled ? "On" : "Off"}
            </button>
            <button
              className="mini-btn"
              disabled={busy}
              onClick={() => { if (window.confirm(`Delete "${a.name}"?`)) post({ action: "delete", id: a.id }); }}
            >
              ✕
            </button>
          </div>
        </div>
      ))}
      {items.length === 0 && <p className="h-sub">No automations yet.</p>}

      <div className="section-label">Auto-off timers</div>
      <p className="h-sub" style={{ marginTop: -2 }}>
        Whenever the device turns on — from any switch, scene, or app — it turns itself off after
        the set time.
      </p>
      {timers.map((t) => {
        const dev = lightById(t.deviceId);
        return (
          <div key={t.id} className="dev">
            <div>
              <div className="nm">{dev ? `${dev.room} — ${dev.label}` : t.deviceId}</div>
              <div className="st">off after {t.afterMinutes} min{t.enabled ? "" : " · paused"}</div>
            </div>
            <div className="btn-row">
              <button className="mini-btn" disabled={busy} onClick={() => timerOp({ action: "toggle", id: t.id, enabled: !t.enabled })}>
                {t.enabled ? "Pause" : "Resume"}
              </button>
              <button
                className="mini-btn"
                disabled={busy}
                onClick={() => {
                  if (window.confirm("Delete this auto-off timer?")) timerOp({ action: "delete", id: t.id });
                }}
              >
                Delete
              </button>
            </div>
          </div>
        );
      })}
      <div className="dev-block" style={{ padding: 14 }}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <select
            value={timerDevice}
            onChange={(e) => setTimerDevice(e.target.value)}
            style={{ flex: "1 1 220px", padding: 8, borderRadius: 10, border: "1px solid var(--card-line)", background: "var(--card)", color: "var(--ink)", fontFamily: "inherit" }}
          >
            <option value="">choose a device…</option>
            {lights.map((l) => (
              <option key={l.id} value={l.id}>{l.room} — {l.label}</option>
            ))}
          </select>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--dim)" }}>
            off after
            <input
              type="number"
              min={1}
              max={720}
              value={timerMinutes}
              onChange={(e) => setTimerMinutes(Number(e.target.value))}
              style={{ width: 64, padding: 8, borderRadius: 10, border: "1px solid var(--card-line)", background: "var(--card)", color: "var(--ink)", fontFamily: "inherit" }}
            />
            min
          </label>
          <button
            className="mini-btn"
            disabled={busy || !timerDevice || !(timerMinutes >= 1)}
            onClick={() => timerOp({ action: "create", deviceId: timerDevice, afterMinutes: timerMinutes }).then(() => setTimerDevice(""))}
          >
            + Add timer
          </button>
        </div>
      </div>

      <div className="section-label">New automation</div>
      <div className="dev-block" style={{ padding: 14 }}>
        <input
          placeholder="name (e.g. Kitchen evening lights)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{ width: "100%", padding: 9, borderRadius: 10, border: "1px solid var(--card-line)", background: "var(--card)", color: "var(--ink)", fontFamily: "inherit", marginBottom: 8 }}
        />
        {steps.map((s, i) => (
          <div key={i} className="st" style={{ marginBottom: 4 }}>
            {describeStep(s)}{" "}
            <button onClick={() => setSteps(steps.filter((_, j) => j !== i))}
              style={{ background: "none", border: "none", color: "var(--danger)", cursor: "pointer", font: "inherit" }}>✕</button>
          </div>
        ))}
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)}
            style={{ padding: 8, borderRadius: 10, border: "1px solid var(--card-line)", background: "var(--card)", color: "var(--ink)", fontFamily: "inherit" }} />
          <select value={date ? "date" : String(preset)} onChange={(e) => { if (e.target.value === "date") setDate(new Date(Date.now() + 86400000).toISOString().slice(0, 10)); else { setDate(""); setPreset(Number(e.target.value)); } }}
            style={{ padding: 8, borderRadius: 10, border: "1px solid var(--card-line)", background: "var(--card)", color: "var(--ink)", fontFamily: "inherit" }}>
            {DAY_PRESETS.map((p, i) => <option key={i} value={i}>{p.label}</option>)}
            <option value="date">Once, on a date…</option>
          </select>
          {date && (
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
              style={{ padding: 8, borderRadius: 10, border: "1px solid var(--card-line)", background: "var(--card)", color: "var(--ink)", fontFamily: "inherit" }} />
          )}
          <select value={actKind} onChange={(e) => setActKind(e.target.value as typeof actKind)}
            style={{ padding: 8, borderRadius: 10, border: "1px solid var(--card-line)", background: "var(--card)", color: "var(--ink)", fontFamily: "inherit" }}>
            <option value="room_on">Room lights ON</option>
            <option value="room_off">Room lights OFF</option>
            <option value="scene">Run scene</option>
          </select>
          {actKind === "scene" ? (
            <select value={actScene} onChange={(e) => setActScene(e.target.value)}
              style={{ padding: 8, borderRadius: 10, border: "1px solid var(--card-line)", background: "var(--card)", color: "var(--ink)", fontFamily: "inherit" }}>
              <option value="">choose scene…</option>
              {scenes.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          ) : (
            <select value={actRoom} onChange={(e) => setActRoom(e.target.value)}
              style={{ padding: 8, borderRadius: 10, border: "1px solid var(--card-line)", background: "var(--card)", color: "var(--ink)", fontFamily: "inherit" }}>
              <option value="">choose room…</option>
              {rooms.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          )}
          <button className="mini-btn" onClick={addStep}>+ Add step</button>
        </div>
        <button className="scene-pill" disabled={busy || !name.trim() || steps.length === 0} onClick={create}
          style={{ width: "100%", marginTop: 12, padding: 12 }}>
          Create automation
        </button>
      </div>
      <NavBar />
    </main>
  );
}

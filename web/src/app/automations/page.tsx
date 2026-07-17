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
    | { type: "device"; deviceId: string; command: Record<string, unknown> }
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

/** Anything schedulable: on/off-style devices across every kind. */
interface TargetDevice { id: string; label: string; room: string; kind: string; }

const DAY_CHIPS = ["S", "M", "T", "W", "T", "F", "S"]; // 0=Sunday .. 6=Saturday

const DEVICE_COMMANDS: Record<string, Array<{ value: string; label: string }>> = {
  cover: [{ value: "open", label: "Open" }, { value: "close", label: "Close" }],
  climate: [
    { value: "on_at", label: "On at °C…" },
    { value: "turn_on", label: "On" },
    { value: "turn_off", label: "Off" },
    { value: "set_temp", label: "Set °C only" },
  ],
  default: [{ value: "turn_on", label: "On" }, { value: "turn_off", label: "Off" }],
};

function describeStep(s: Step, deviceLabel: (id: string) => string): string {
  const when = s.date
    ? `once on ${s.date} at ${s.time}`
    : s.days && s.days.length
      ? `${s.days.map((d) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d]).join("/")} at ${s.time}`
      : `every day at ${s.time}`;
  const what = s.actions
    .map((a) => {
      if (a.type === "scene") return `scene "${a.sceneId}"`;
      if (a.type === "room") return `${a.room} lights ${a.command === "lights_on" ? "on" : "off"}`;
      if (a.command.command === "set_temperature") return `${deviceLabel(a.deviceId)} to ${a.command.temperature}°`;
      const verb = String(a.command.command).replace("turn_", "").replace("_", " ");
      return `${deviceLabel(a.deviceId)} ${verb}`;
    })
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
  const [days, setDays] = useState<number[]>([]); // empty = every day
  const [date, setDate] = useState("");
  const [once, setOnce] = useState(false);
  const [actKind, setActKind] = useState<
    "room_on" | "room_off" | "shades_open" | "shades_close" | "scene" | "device"
  >("room_on");
  const [actRoom, setActRoom] = useState("");
  const [actScene, setActScene] = useState("");
  const [actDevice, setActDevice] = useState("");
  const [actCommand, setActCommand] = useState("turn_on");
  const [actTemp, setActTemp] = useState(24);
  const [targets, setTargets] = useState<TargetDevice[]>([]);

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
      setTargets(
        devs
          .filter((d) => d.category !== "scene_switch")
          .map((d) => ({ id: d.id, label: d.label, room: d.room, kind: d.kind }))
          .sort((a, b) => `${a.room} ${a.label}`.localeCompare(`${b.room} ${b.label}`)),
      );
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
    let actions: Step["actions"] = [];
    if (actKind === "scene" && actScene) actions = [{ type: "scene", sceneId: actScene }];
    else if (actKind === "device" && actDevice) {
      if (actCommand === "on_at")
        // Two actions, one step: wake the zone, then set its target.
        actions = [
          { type: "device", deviceId: actDevice, command: { command: "turn_on" } },
          { type: "device", deviceId: actDevice, command: { command: "set_temperature", temperature: actTemp } },
        ];
      else if (actCommand === "set_temp")
        actions = [{ type: "device", deviceId: actDevice, command: { command: "set_temperature", temperature: actTemp } }];
      else actions = [{ type: "device", deviceId: actDevice, command: { command: actCommand } }];
    }
    else if ((actKind === "shades_open" || actKind === "shades_close") && actRoom)
      // One step, one action per shade in the room — the engine fans out.
      actions = targets
        .filter((t) => t.kind === "cover" && t.room === actRoom)
        .map((t) => ({
          type: "device" as const,
          deviceId: t.id,
          command: { command: actKind === "shades_open" ? "open" : "close" },
        }));
    else if ((actKind === "room_on" || actKind === "room_off") && actRoom)
      actions = [{ type: "room", room: actRoom, command: actKind === "room_on" ? "lights_on" : "lights_off" }];
    if (actions.length === 0) return;
    const step: Step = { time, actions };
    if (once && date) step.date = date;
    else if (days.length > 0 && days.length < 7) step.days = [...days].sort();
    setSteps((s) => [...s, step]);
  };

  const toggleDay = (d: number) =>
    setDays((cur) => (cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d]));

  const commandsFor = (deviceId: string) => {
    const kind = targets.find((t) => t.id === deviceId)?.kind;
    return DEVICE_COMMANDS[kind ?? "default"] ?? DEVICE_COMMANDS.default;
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
              <div key={i} className="st">
                {describeStep(s, (id) => targets.find((t) => t.id === id)?.label ?? id)}
              </div>
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
            {describeStep(s, (id) => targets.find((t) => t.id === id)?.label ?? id)}{" "}
            <button onClick={() => setSteps(steps.filter((_, j) => j !== i))}
              style={{ background: "none", border: "none", color: "var(--danger)", cursor: "pointer", font: "inherit" }}>✕</button>
          </div>
        ))}
        {/* When: time, weekday chips (none = every day), or a one-shot date. */}
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6, alignItems: "center" }}>
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)}
            style={{ padding: 8, borderRadius: 10, border: "1px solid var(--card-line)", background: "var(--card)", color: "var(--ink)", fontFamily: "inherit" }} />
          {!once && DAY_CHIPS.map((label, d) => (
            <button
              key={d}
              className="mini-btn"
              aria-pressed={days.includes(d)}
              aria-label={["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][d]}
              style={{
                minHeight: 36, padding: "6px 0", width: 36,
                ...(days.includes(d) ? { background: "var(--accent)", color: "var(--accent-ink)", borderColor: "var(--accent)" } : {}),
              }}
              onClick={() => toggleDay(d)}
            >
              {label}
            </button>
          ))}
          <button
            className="mini-btn"
            aria-pressed={once}
            style={once ? { background: "var(--accent)", color: "var(--accent-ink)", borderColor: "var(--accent)" } : undefined}
            onClick={() => {
              setOnce((v) => !v);
              if (!once && !date) setDate(new Date(Date.now() + 86400000).toISOString().slice(0, 10));
            }}
          >
            Once…
          </button>
          {once && (
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
              style={{ padding: 8, borderRadius: 10, border: "1px solid var(--card-line)", background: "var(--card)", color: "var(--ink)", fontFamily: "inherit" }} />
          )}
        </div>
        {!once && <p className="st" style={{ margin: "4px 0 0" }}>No days selected = every day.</p>}

        {/* What: room lights, a scene, or any single device. */}
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
          <select value={actKind} onChange={(e) => setActKind(e.target.value as typeof actKind)}
            style={{ padding: 8, borderRadius: 10, border: "1px solid var(--card-line)", background: "var(--card)", color: "var(--ink)", fontFamily: "inherit" }}>
            <option value="room_on">Room lights ON</option>
            <option value="room_off">Room lights OFF</option>
            <option value="shades_open">Room shades OPEN</option>
            <option value="shades_close">Room shades CLOSED</option>
            <option value="scene">Run scene</option>
            <option value="device">Device…</option>
          </select>
          {actKind === "scene" && (
            <select value={actScene} onChange={(e) => setActScene(e.target.value)}
              style={{ padding: 8, borderRadius: 10, border: "1px solid var(--card-line)", background: "var(--card)", color: "var(--ink)", fontFamily: "inherit" }}>
              <option value="">choose scene…</option>
              {scenes.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          )}
          {(actKind === "room_on" || actKind === "room_off" || actKind === "shades_open" || actKind === "shades_close") && (
            <select value={actRoom} onChange={(e) => setActRoom(e.target.value)}
              style={{ padding: 8, borderRadius: 10, border: "1px solid var(--card-line)", background: "var(--card)", color: "var(--ink)", fontFamily: "inherit" }}>
              <option value="">choose room…</option>
              {(actKind === "shades_open" || actKind === "shades_close"
                ? [...new Set(targets.filter((t) => t.kind === "cover").map((t) => t.room))].sort()
                : rooms
              ).map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          )}
          {actKind === "device" && (
            <>
              <select value={actDevice} onChange={(e) => { setActDevice(e.target.value); setActCommand(commandsFor(e.target.value)[0].value); }}
                style={{ flex: "1 1 200px", padding: 8, borderRadius: 10, border: "1px solid var(--card-line)", background: "var(--card)", color: "var(--ink)", fontFamily: "inherit" }}>
                <option value="">choose device…</option>
                {targets.map((t) => <option key={t.id} value={t.id}>{t.room} — {t.label}</option>)}
              </select>
              <select value={actCommand} onChange={(e) => setActCommand(e.target.value)}
                style={{ padding: 8, borderRadius: 10, border: "1px solid var(--card-line)", background: "var(--card)", color: "var(--ink)", fontFamily: "inherit" }}>
                {commandsFor(actDevice).map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
              {(actCommand === "on_at" || actCommand === "set_temp") && (
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--dim)" }}>
                  <input
                    type="number"
                    min={10}
                    max={32}
                    step={0.5}
                    value={actTemp}
                    onChange={(e) => setActTemp(Number(e.target.value))}
                    style={{ width: 70, padding: 8, borderRadius: 10, border: "1px solid var(--card-line)", background: "var(--card)", color: "var(--ink)", fontFamily: "inherit" }}
                  />
                  °C
                </label>
              )}
            </>
          )}
          <button className="mini-btn" onClick={addStep}>+ Add step</button>
        </div>
        {actKind === "device" && targets.find((t) => t.id === actDevice)?.kind === "sauna" && (
          <p className="st" style={{ margin: "4px 0 0", color: "var(--danger)" }}>
            Scheduling the sauna starts the heater unattended — the KLAFS bathing-time limit still applies.
          </p>
        )}
        <button className="scene-pill" disabled={busy || !name.trim() || steps.length === 0} onClick={create}
          style={{ width: "100%", marginTop: 12, padding: 12 }}>
          Create automation
        </button>
      </div>
      <NavBar />
    </main>
  );
}

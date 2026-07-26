"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import NavBar from "../NavBar";
import {
  fireSortKey, houseNow, nextAutomationFire, nextFireLabel, resolveStepTime,
  type NextSunIso,
} from "@/lib/nextfire";
import { automationGroup } from "@/lib/automationGroups";

/**
 * Automations screen: a room-grouped, schedule-ordered list + a room-first
 * builder.
 * Pick a room, get chips for what that room can actually do (lights, shades,
 * AC at a set-point, the sauna in the Sauna…) derived from device
 * capabilities. Richer creation (natural language) arrives with the
 * conversational layer, which produces the same automation spec.
 */

interface Step {
  time?: string;
  sun?: "sunset" | "sunrise";
  sunOffsetMinutes?: number;
  days?: number[];
  date?: string;
  actions: Array<
    | { type: "scene"; sceneId: string }
    | { type: "room"; room: string; command: "lights_on" | "lights_off" }
    | { type: "device"; deviceId: string; command: Record<string, unknown> }
  >;
  lastFired?: string;
  /** Keep this step's lights on until HH:MM — see lib/automations. */
  holdUntil?: string;
}

interface Automation {
  id: string;
  name: string;
  enabled: boolean;
  steps: Step[];
  createdBy: string;
  /** Server-decided: admins delete anything, others only their own. */
  canDelete: boolean;
  /** When it's active: absent/"always" = regardless of Away mode,
   * "home" = paused while away, "away" = runs only while away. */
  activeWhen?: "always" | "home" | "away";
}

interface SceneMeta { id: string; name: string; }

interface TimerRule {
  id: string;
  deviceId: string;
  afterMinutes: number;
  enabled: boolean;
  /** Server-decided: admins delete anything, others only their own. */
  canDelete: boolean;
}

interface LightDevice { id: string; label: string; room: string; }

/** Anything schedulable, with capabilities so the builder can offer levels. */
interface TargetDevice { id: string; label: string; room: string; kind: string; category: string; capabilities: string[] }

/** A real, controllable light (not a towel rail or vent, which ride the light domain). */
const isRoomLight = (t: TargetDevice) =>
  t.kind === "light" && (t.category === "light_switch" || t.category === "light_dimmer");

const DAY_CHIPS = ["S", "M", "T", "W", "T", "F", "S"]; // 0=Sunday .. 6=Saturday
const SCENE_TARGET = "__scene__";

type ChipKey =
  | "lights_on" | "lights_off" | "lights_each"
  | "shades_open" | "shades_close"
  | "ac_on_at" | "ac_off"
  | "sauna_on_at" | "sauna_off"
  | "heating_on" | "heating_off"
  | "noise_on" | "noise_off"
  | "device";

/** Room-level action chips, offered only when the room has the hardware. */
function chipsForRoom(roomDevs: TargetDevice[]): Array<{ key: ChipKey; label: string }> {
  const has = (k: string) => roomDevs.some((t) => t.kind === k);
  const chips: Array<{ key: ChipKey; label: string }> = [];
  if (roomDevs.some(isRoomLight)) {
    chips.push({ key: "lights_on", label: "Lights on" }, { key: "lights_off", label: "Lights off" });
    // Only worth a per-light editor when there's more than one to disagree about.
    if (roomDevs.filter(isRoomLight).length > 1) chips.push({ key: "lights_each", label: "Set each light…" });
  }
  if (has("cover")) chips.push({ key: "shades_open", label: "Shades open" }, { key: "shades_close", label: "Shades closed" });
  if (has("climate")) chips.push({ key: "ac_on_at", label: "AC on at °C" }, { key: "ac_off", label: "AC off" });
  if (has("sauna")) chips.push({ key: "sauna_on_at", label: "Sauna on at °C" }, { key: "sauna_off", label: "Sauna off" });
  if (has("heating")) chips.push({ key: "heating_on", label: "Floor heating on" }, { key: "heating_off", label: "Floor heating off" });
  if (has("noise")) chips.push({ key: "noise_on", label: "White noise on" }, { key: "noise_off", label: "White noise off" });
  chips.push({ key: "device", label: "Single device…" });
  return chips;
}

/** Mirrors the server's temperatureBounds() so the input can't propose an out-of-range set-point. */
function tempBoundsFor(kind: string | undefined) {
  return kind === "sauna"
    ? { min: 40, max: 100, step: 1, dflt: 80 }
    : { min: 10, max: 32, step: 0.5, dflt: 24 };
}

function commandOptions(t: TargetDevice | undefined): Array<{ value: string; label: string }> {
  if (t?.kind === "cover") return [{ value: "open", label: "Open" }, { value: "close", label: "Close" }];
  if (t?.kind === "bed")
    return [
      { value: "on_at_level", label: "On at warmth…" },
      { value: "turn_on", label: "On" },
      { value: "turn_off", label: "Off" },
    ];
  if (t?.kind === "climate")
    return [
      { value: "on_at", label: "On at °C…" },
      { value: "turn_on", label: "On" },
      { value: "turn_off", label: "Off" },
      { value: "set_temp", label: "Set °C only" },
    ];
  if (t?.kind === "sauna")
    return [
      { value: "on_at", label: "On at °C…" },
      { value: "turn_on", label: "On" },
      { value: "turn_off", label: "Off" },
    ];
  if (t?.capabilities.includes("brightness"))
    return [
      { value: "turn_on", label: "On" },
      { value: "on_at_pct", label: "On at %…" },
      { value: "turn_off", label: "Off" },
    ];
  return [{ value: "turn_on", label: "On" }, { value: "turn_off", label: "Off" }];
}

function whenPhrase(s: Step): string {
  const o = s.sunOffsetMinutes ?? 0;
  const at = s.sun
    ? o === 0 ? `at ${s.sun}` : `${Math.abs(o)} min ${o < 0 ? "before" : "after"} ${s.sun}`
    : `at ${s.time}`;
  if (s.date) return `once on ${s.date} ${at}`;
  if (s.days && s.days.length)
    return `${s.days.map((d) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d]).join("/")} ${at}`;
  return `every day ${at}`;
}

function describeStep(s: Step, deviceLabel: (id: string) => string): string {
  const when = whenPhrase(s);
  const parts: string[] = [];
  for (let i = 0; i < s.actions.length; i++) {
    const a = s.actions[i];
    if (a.type === "scene") { parts.push(`scene "${a.sceneId}"`); continue; }
    if (a.type === "room") { parts.push(`${a.room} lights ${a.command === "lights_on" ? "on" : "off"}`); continue; }
    const next = s.actions[i + 1];
    // A turn_on followed by a set-point on the same device is one intent.
    if (
      a.command.command === "turn_on" &&
      next?.type === "device" && next.deviceId === a.deviceId &&
      next.command.command === "set_temperature"
    ) {
      parts.push(`${deviceLabel(a.deviceId)} on at ${next.command.temperature}°`);
      i++;
      continue;
    }
    // Same for a bed side's wake + warmth pair.
    if (
      a.command.command === "turn_on" &&
      next?.type === "device" && next.deviceId === a.deviceId &&
      next.command.command === "set_bed_level"
    ) {
      const lvl = Number(next.command.level);
      parts.push(`${deviceLabel(a.deviceId)} on at warmth ${lvl > 0 ? "+" : ""}${lvl}`);
      i++;
      continue;
    }
    if (a.command.command === "set_temperature") { parts.push(`${deviceLabel(a.deviceId)} to ${a.command.temperature}°`); continue; }
    if (a.command.command === "set_bed_level") {
      const lvl = Number(a.command.level);
      parts.push(`${deviceLabel(a.deviceId)} warmth ${lvl > 0 ? "+" : ""}${lvl}`);
      continue;
    }
    if (a.command.command === "set_brightness") { parts.push(`${deviceLabel(a.deviceId)} on at ${a.command.brightnessPct}%`); continue; }
    const verb = String(a.command.command).replace("turn_", "").replace("_", " ");
    parts.push(`${deviceLabel(a.deviceId)} ${verb}`);
  }
  const hold = s.holdUntil ? ` — held on until ${s.holdUntil}` : "";
  return `${when} → ${parts.join(", ")}${hold}`;
}

const field: React.CSSProperties = {
  padding: 8, borderRadius: 10, border: "1px solid var(--card-line)",
  background: "var(--card)", color: "var(--ink)", fontFamily: "inherit",
};
const chipOn: React.CSSProperties = {
  background: "var(--accent)", color: "var(--accent-ink)", borderColor: "var(--accent)",
};

export default function Automations() {
  const [items, setItems] = useState<Automation[]>([]);
  const [scenes, setScenes] = useState<SceneMeta[]>([]);
  const [tz, setTz] = useState("");
  const [away, setAway] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // builder state
  const [builderOpen, setBuilderOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null); // set = editing an existing automation
  const [name, setName] = useState("");
  // Actions already queued for this automation. They all share the one trigger
  // time below, so the whole thing is a single step with several actions —
  // e.g. "Saturday 18:00 → gym lights off, gym AC off".
  const [draft, setDraft] = useState<Array<{ label: string; actions: Step["actions"] }>>([]);
  const [time, setTime] = useState("18:00");
  const [days, setDays] = useState<number[]>([]); // empty = every day
  const [date, setDate] = useState("");
  const [once, setOnce] = useState(false);
  const [sunMode, setSunMode] = useState(false);
  const [sunEvent, setSunEvent] = useState<"sunset" | "sunrise">("sunset");
  const [sunOffset, setSunOffset] = useState(0);
  const [holdUntil, setHoldUntil] = useState(""); // "" = no hold
  const [sunTimes, setSunTimes] = useState<NextSunIso | null>(null);
  const [target, setTarget] = useState(""); // "" | SCENE_TARGET | room name
  const [action, setAction] = useState<ChipKey | "">("lights_on");
  const [actScene, setActScene] = useState("");
  const [actDevice, setActDevice] = useState("");
  const [actCommand, setActCommand] = useState("turn_on");
  const [actTemp, setActTemp] = useState(24);
  const [actBright, setActBright] = useState(60);
  // Eight Sleep warmth, the Pod's own -100 (cool) … +100 (warm) scale.
  const [actLevel, setActLevel] = useState(30);
  const [targets, setTargets] = useState<TargetDevice[]>([]);
  // Per-light editor ("Set each light…"): what to do with each light in the room.
  // Missing / "leave" = don't touch it. Keyed by device id.
  type LightMode = "leave" | "on" | "off" | "pct";
  const [lightModes, setLightModes] = useState<Record<string, { mode: LightMode; pct: number }>>({});

  // auto-off timers
  const [timers, setTimers] = useState<TimerRule[]>([]);
  const [lights, setLights] = useState<LightDevice[]>([]);
  const [timerFormOpen, setTimerFormOpen] = useState(false);
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
    setAway(body.away === true);
    setSunTimes(body.sun ?? null);
    const [sc, home, tm] = await Promise.all([fetch("/api/scenes"), fetch("/api/home"), fetch("/api/timers")]);
    if (sc.ok) setScenes(((await sc.json()) as { scenes: SceneMeta[] }).scenes);
    if (home.ok) {
      const devs = ((await home.json()) as {
        devices: Array<{ id: string; label: string; room: string; kind: string; category: string; capabilities: string[] }>;
      }).devices;

      setTargets(
        devs
          .filter((d) => d.category !== "scene_switch")
          .map((d) => ({ id: d.id, label: d.label, room: d.room, kind: d.kind, category: d.category, capabilities: d.capabilities ?? [] }))
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

  const allRooms = useMemo(() => [...new Set(targets.map((t) => t.room))].sort(), [targets]);
  const roomDevs = useMemo(() => targets.filter((t) => t.room === target), [targets, target]);
  const chips = useMemo(() => chipsForRoom(roomDevs), [roomDevs]);
  const roomLightList = useMemo(() => roomDevs.filter(isRoomLight), [roomDevs]);

  const lightMode = (id: string) => lightModes[id] ?? { mode: "leave" as LightMode, pct: 60 };
  const setLightMode = (id: string, mode: LightMode) =>
    setLightModes((m) => ({ ...m, [id]: { ...(m[id] ?? { mode: "leave" as LightMode, pct: 60 }), mode } }));
  const setLightPct = (id: string, pct: number) =>
    setLightModes((m) => ({ ...m, [id]: { ...(m[id] ?? { mode: "leave" as LightMode, pct: 60 }), pct } }));
  const setAllLights = (mode: LightMode) =>
    setLightModes((m) =>
      Object.fromEntries(roomLightList.map((t) => [t.id, { mode, pct: (m[t.id] ?? { pct: 60 }).pct }])),
    );

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

  const pickTarget = (v: string) => {
    setTarget(v);
    setActDevice("");
    setLightModes({}); // device ids differ per room; start the per-light editor fresh
    if (v && v !== SCENE_TARGET) {
      const first = chipsForRoom(targets.filter((t) => t.room === v))[0];
      pickAction(first.key);
    }
  };

  const pickAction = (key: ChipKey) => {
    setAction(key);
    if (key === "sauna_on_at") setActTemp((t) => (t >= 40 && t <= 100 ? t : 80));
    if (key === "ac_on_at") setActTemp((t) => (t >= 10 && t <= 32 ? t : 24));
  };

  const selectedDevice = targets.find((t) => t.id === actDevice);

  const pickDevice = (id: string) => {
    setActDevice(id);
    const dev = targets.find((t) => t.id === id);
    const first = commandOptions(dev)[0].value;
    setActCommand(first);
    if (first === "on_at") {
      const b = tempBoundsFor(dev?.kind);
      setActTemp((t) => (t >= b.min && t <= b.max ? t : b.dflt));
    }
  };

  /**
   * Build the action(s) for the currently selected chip + parameters, plus a
   * short label for the queued-actions list. Null when the selection isn't a
   * complete action yet. Pure (no state writes) so it can drive "+ Add action",
   * the queued pills, and the Create button's enabled state — and let Create
   * auto-commit the current selection without a separate tap.
   */
  const currentAction = (): { label: string; actions: Step["actions"] } | null => {
    const kindDevs = (k: string) => roomDevs.filter((t) => t.kind === k);
    const cmd = (deviceId: string, command: Record<string, unknown>) =>
      ({ type: "device" as const, deviceId, command });
    // The number inputs' min/max are advisory; clamp so a typo can't store a
    // set-point the server would reject at fire time.
    const clampTemp = (kind: string | undefined) => {
      const b = tempBoundsFor(kind);
      return Math.min(b.max, Math.max(b.min, actTemp));
    };
    const bright = Math.min(100, Math.max(1, Math.round(actBright)));
    let actions: Step["actions"] = [];
    let label = "";
    if (target === SCENE_TARGET) {
      if (actScene) {
        actions = [{ type: "scene", sceneId: actScene }];
        label = `run "${scenes.find((s) => s.id === actScene)?.name ?? actScene}"`;
      }
    } else if (!action) {
      return null;
    } else if (action === "lights_each") {
      // One action per light the user set to something other than "leave".
      const parts: string[] = [];
      const built: Step["actions"] = [];
      for (const t of roomLightList) {
        const { mode, pct } = lightMode(t.id);
        if (mode === "on") {
          built.push(cmd(t.id, { command: "turn_on" }));
          parts.push(`${t.label} on`);
        } else if (mode === "off") {
          built.push(cmd(t.id, { command: "turn_off" }));
          parts.push(`${t.label} off`);
        } else if (mode === "pct" && t.capabilities.includes("brightness")) {
          const b = Math.min(100, Math.max(1, Math.round(pct)));
          built.push(cmd(t.id, { command: "set_brightness", brightnessPct: b }));
          parts.push(`${t.label} ${b}%`);
        }
      }
      actions = built;
      label = `${target}: ${parts.join(", ")}`;
    } else if (action === "lights_on" || action === "lights_off") {
      actions = [{ type: "room", room: target, command: action }];
      label = `${target} lights ${action === "lights_on" ? "on" : "off"}`;
    } else if (action === "shades_open" || action === "shades_close") {
      // One action per shade in the room — the engine fans out.
      actions = kindDevs("cover").map((t) => cmd(t.id, { command: action === "shades_open" ? "open" : "close" }));
      label = `${target} shades ${action === "shades_open" ? "open" : "closed"}`;
    } else if (action === "ac_on_at" || action === "sauna_on_at") {
      // Two actions per zone: wake it, then set its target.
      const kind = action === "ac_on_at" ? "climate" : "sauna";
      actions = kindDevs(kind).flatMap((t) => [
        cmd(t.id, { command: "turn_on" }),
        cmd(t.id, { command: "set_temperature", temperature: clampTemp(t.kind) }),
      ]);
      label = `${target} ${kind === "climate" ? "AC" : "sauna"} on at ${clampTemp(kind)}°`;
    } else if (action !== "device") {
      const kind = action.startsWith("ac") ? "climate"
        : action.startsWith("sauna") ? "sauna"
        : action.startsWith("heating") ? "heating" : "noise";
      actions = kindDevs(kind).map((t) => cmd(t.id, { command: action.endsWith("_on") ? "turn_on" : "turn_off" }));
      const noun = kind === "climate" ? "AC" : kind === "sauna" ? "sauna"
        : kind === "heating" ? "floor heating" : "white noise";
      label = `${target} ${noun} ${action.endsWith("_on") ? "on" : "off"}`;
    } else if (actDevice) {
      const dname = selectedDevice?.label ?? actDevice;
      if (actCommand === "on_at_level") {
        // Wake the side, then set its warmth — same shape as "AC on at °C".
        const lvl = Math.min(100, Math.max(-100, Math.round(actLevel)));
        actions = [
          cmd(actDevice, { command: "turn_on" }),
          cmd(actDevice, { command: "set_bed_level", level: lvl }),
        ];
        label = `${dname} on at warmth ${lvl > 0 ? "+" : ""}${lvl}`;
      } else if (actCommand === "on_at") {
        actions = [
          cmd(actDevice, { command: "turn_on" }),
          cmd(actDevice, { command: "set_temperature", temperature: clampTemp(selectedDevice?.kind) }),
        ];
        label = `${dname} on at ${clampTemp(selectedDevice?.kind)}°`;
      } else if (actCommand === "set_temp") {
        actions = [cmd(actDevice, { command: "set_temperature", temperature: clampTemp(selectedDevice?.kind) })];
        label = `${dname} to ${clampTemp(selectedDevice?.kind)}°`;
      } else if (actCommand === "on_at_pct") {
        actions = [cmd(actDevice, { command: "set_brightness", brightnessPct: bright })];
        label = `${dname} on at ${bright}%`;
      } else {
        actions = [cmd(actDevice, { command: actCommand })];
        label = `${dname} ${actCommand === "turn_off" ? "off" : actCommand === "turn_on" ? "on" : String(actCommand).replace(/_/g, " ")}`;
      }
    }
    if (actions.length === 0) return null;
    return { label, actions };
  };

  /** The one trigger shared by every action in this automation. */
  const stepWhen = (): Partial<Step> => {
    const base: Partial<Step> = sunMode
      ? { sun: sunEvent, ...(sunOffset !== 0 ? { sunOffsetMinutes: sunOffset } : {}) }
      : { time };
    if (once && date) base.date = date;
    else if (days.length > 0 && days.length < 7) base.days = [...days].sort();
    if (holdUntil) base.holdUntil = holdUntil;
    return base;
  };

  /**
   * The finished step: every queued action plus the current selection (so a
   * one-action automation needs no "+ Add action" tap). Null until at least one
   * action is complete — which is exactly when Create should enable.
   */
  const buildStep = (): Step | null => {
    const cur = currentAction();
    const entries = cur ? [...draft, cur] : draft;
    if (entries.length === 0) return null;
    return { ...stepWhen(), actions: entries.flatMap((e) => e.actions) } as Step;
  };

  /** Queue the current selection so another action can be added at the same time. */
  const addAction = () => {
    const cur = currentAction();
    if (!cur) return;
    setDraft((d) => [...d, cur]);
    setAction("");        // clear the chip row so the next action starts fresh
    setActDevice("");
    setActScene("");
  };

  const toggleDay = (d: number) =>
    setDays((cur) => (cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d]));

  const resetBuilder = () => {
    setName("");
    setDraft([]);
    setAction("lights_on");
    setActDevice("");
    setActScene("");
    setLightModes({});
    setSunMode(false);
    setOnce(false);
    setDays([]);
    setHoldUntil("");
    setEditingId(null);
  };

  const openNewBuilder = () => {
    resetBuilder();
    setBuilderOpen(true);
  };

  const closeBuilder = () => {
    setBuilderOpen(false);
    setEditingId(null);
  };

  /**
   * Load an existing automation into the builder. This builder models one
   * trigger + a list of actions, so only single-step automations are editable
   * (multi-step ones — rare, from the assistant — show Delete only). The
   * step's existing actions become one pre-filled draft entry the user can
   * keep, remove, or add to; the trigger controls are seeded from the step.
   */
  const startEdit = (a: Automation) => {
    const s = a.steps[0];
    resetBuilder();
    setEditingId(a.id);
    setName(a.name);
    if (s.sun) {
      setSunMode(true);
      setSunEvent(s.sun);
      setSunOffset(s.sunOffsetMinutes ?? 0);
    } else if (s.time) {
      setTime(s.time);
    }
    if (s.date) { setOnce(true); setDate(s.date); }
    else if (s.days && s.days.length) setDays([...s.days]);
    setHoldUntil(s.holdUntil ?? "");
    const actionsLabel = describeStep(s, label).split("→").slice(1).join("→").trim() || "current actions";
    setDraft([{ label: actionsLabel, actions: s.actions }]);
    setAction(""); // start with no new selection; the loaded actions are queued
    setExpandedId(null);
    setBuilderOpen(true);
  };

  const save = async () => {
    // One automation = one trigger time with every queued action (plus the
    // current selection, auto-committed so a single action needs no extra tap).
    const step = buildStep();
    if (!name.trim() || !step) return;
    const spec = { name: name.trim(), steps: [step] };
    const ok = await post(editingId ? { action: "update", id: editingId, spec } : { action: "create", spec });
    if (ok) {
      resetBuilder();
      setBuilderOpen(false);
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
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const lightById = (id: string) => lights.find((l) => l.id === id);
  const label = (id: string) => targets.find((t) => t.id === id)?.label ?? id;

  const now = houseNow(tz || undefined);
  // Soonest-first; enabled-but-spent (fired one-shots) next; paused last.
  // Sun steps resolve against the served next-event instants; when those are
  // unknown (HA blip) the row still names its sun trigger instead of a time.
  const sorted = items
    .map((a) => {
      const resolved = a.steps
        .map((s) => resolveStepTime(s, sunTimes, tz || undefined))
        .filter((s) => s !== null);
      return {
        a,
        nf: a.enabled ? nextAutomationFire(resolved, now) : null,
        sunFallback: a.steps.find((s) => s.sun)?.sun ?? null,
      };
    })
    .sort((x, y) => {
      const key = (w: typeof x) => (!w.a.enabled ? 2e9 : w.nf ? fireSortKey(w.nf) : 1e9);
      return key(x) - key(y) || x.a.name.localeCompare(y.a.name);
    });

  // Room-grouped so an on/off pair sits together instead of scattering through
  // the schedule order. Groups appear soonest-first (order of first member in
  // the sorted list); inside a group the schedule order reads as the room's
  // daily cycle, with its paused automations sinking to the group's end.
  const grouped: Array<{ name: string; rows: typeof sorted }> = [];
  for (const w of sorted) {
    const g = automationGroup(w.a.steps, (id) => targets.find((t) => t.id === id)?.room);
    const existing = grouped.find((x) => x.name === g);
    if (existing) existing.rows.push(w);
    else grouped.push({ name: g, rows: [w] });
  }

  const tempInput = (kind: string | undefined) => {
    const b = tempBoundsFor(kind);
    return (
      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--dim)" }}>
        <input
          type="number" min={b.min} max={b.max} step={b.step} value={actTemp}
          onChange={(e) => setActTemp(Number(e.target.value))}
          style={{ ...field, width: 70 }}
        />
        °C
      </label>
    );
  };

  const startsSauna = (a: Step["actions"][number]) =>
    a.type === "device" &&
    targets.find((t) => t.id === a.deviceId)?.kind === "sauna" &&
    a.command.command !== "turn_off";
  const saunaScheduled =
    action === "sauna_on_at" ||
    (action === "device" && selectedDevice?.kind === "sauna" && actCommand !== "turn_off") ||
    draft.some((d) => d.actions.some(startsSauna));

  return (
    <main className="shell">
      <h1 className="h-title">Automations</h1>
      <p className="h-sub">Times are {tz ? `${tz.split("/").pop()!.replace(/_/g, " ")} time` : "house time"}. One-shot automations disable themselves after firing.</p>
      {error && <div className="error-banner">{error}</div>}

      <SleepSense away={away} />
      <SaunaFollower />

      {grouped.map((g) => (
        <Fragment key={g.name}>
          {grouped.length > 1 && <div className="section-label">{g.name}</div>}
          {g.rows.map(({ a, nf, sunFallback }) => {
        const open = expandedId === a.id;
        const mode = a.activeWhen ?? "always";
        // Enabled but out of season: home-only while away, away-only while home.
        const suppressed = a.enabled && (away ? mode === "home" : mode === "away");
        return (
          // Expanded controls live in a full-width footer BELOW the text —
          // never in the right-hand column, which on a phone squeezes the
          // name to a word per line (seen in the field, 2026-07-26).
          <div key={a.id} className={`dev${a.enabled && !suppressed ? "" : " paused"}`} style={{ flexDirection: "column", alignItems: "stretch" }}>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
              <button
                aria-expanded={open}
                onClick={() => setExpandedId(open ? null : a.id)}
                style={{
                  flex: 1, minWidth: 0, background: "none", border: "none", padding: 0,
                  textAlign: "left", font: "inherit", color: "inherit", cursor: "pointer",
                }}
              >
                <div className="nm">{a.name}</div>
                <div className="st">
                  {!a.enabled ? "paused"
                    : suppressed ? (away ? "paused while away" : "waits for Away mode")
                    : nf ? `next ${nextFireLabel(nf, now)}${away && mode === "away" ? " (away only)" : ""}`
                    : sunFallback ? `next at ${sunFallback}`
                    : "nothing upcoming"}
                  {!open && mode !== "always" && !suppressed ? ` · ${mode === "home" ? "when home" : "when away"}` : ""}
                </div>
                {open
                  ? a.steps.map((s, i) => <div key={i} className="st">{describeStep(s, label)}</div>)
                  : (
                    <div className="st" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {a.steps.map((s) => describeStep(s, label)).join(" · ")}
                    </div>
                  )}
              </button>
              <button
                className="toggle"
                aria-pressed={a.enabled}
                aria-label={`${a.name} ${a.enabled ? "on" : "paused"}`}
                disabled={busy}
                onClick={() => post({ action: "toggle", id: a.id, enabled: !a.enabled })}
              />
            </div>
            {open && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", marginTop: 10 }}>
                <div className="view-toggle" role="group" aria-label={`When ${a.name} is active`}>
                  {([["always", "Always"], ["home", "When home"], ["away", "When away"]] as const).map(([v, chipLabel]) => (
                    <button
                      key={v}
                      aria-pressed={mode === v}
                      disabled={busy}
                      title="When this automation is active: always, only while someone's home, or only while Away mode is on"
                      onClick={() => { if (mode !== v) post({ action: "active_when", id: a.id, activeWhen: v }); }}
                    >
                      {chipLabel}
                    </button>
                  ))}
                </div>
                <span style={{ flex: 1 }} />
                <button
                  className="mini-btn"
                  disabled={busy}
                  title="Fire this automation's actions right now (doesn't touch its schedule)"
                  onClick={() => post({ action: "run", id: a.id })}
                >
                  Run now
                </button>
                {a.steps.length === 1 && (
                  <button className="mini-btn" disabled={busy} onClick={() => startEdit(a)}>
                    Edit
                  </button>
                )}
                {a.canDelete && (
                  <button
                    className="mini-btn"
                    disabled={busy}
                    onClick={() => { if (window.confirm(`Delete "${a.name}"?`)) post({ action: "delete", id: a.id }); }}
                  >
                    Delete
                  </button>
                )}
              </div>
            )}
          </div>
        );
          })}
        </Fragment>
      ))}
      {items.length === 0 && <p className="h-sub">No automations yet.</p>}

      {!builderOpen && (
        <button className="scene-pill" style={{ width: "100%", maxWidth: "none", padding: 12 }} onClick={openNewBuilder}>
          + New automation
        </button>
      )}
      {builderOpen && (
        <>
          <div className="section-label">{editingId ? "Edit automation" : "New automation"}</div>
          <div className="dev-block" style={{ padding: 14 }}>
            <input
              placeholder="name (e.g. Kitchen evening lights)"
              value={name}
              onChange={(e) => setName(e.target.value)}
              style={{ ...field, width: "100%", padding: 9, marginBottom: 8 }}
            />
            {/* When: a clock time or a sun event, weekday chips (none = every day), or a one-shot date. */}
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6, alignItems: "center" }}>
              {!sunMode && (
                <input type="time" value={time} onChange={(e) => setTime(e.target.value)} style={field} />
              )}
              {sunMode && (
                <>
                  <select value={sunEvent} onChange={(e) => setSunEvent(e.target.value as "sunset" | "sunrise")} style={field}>
                    <option value="sunset">Sunset</option>
                    <option value="sunrise">Sunrise</option>
                  </select>
                  <select value={sunOffset} onChange={(e) => setSunOffset(Number(e.target.value))} style={field}>
                    {[-45, -30, -15, 0, 15, 30, 45].map((o) => (
                      <option key={o} value={o}>
                        {o === 0 ? `at ${sunEvent}` : `${Math.abs(o)} min ${o < 0 ? "before" : "after"}`}
                      </option>
                    ))}
                  </select>
                </>
              )}
              {!once && DAY_CHIPS.map((chipLabel, d) => (
                <button
                  key={d}
                  className="mini-btn"
                  aria-pressed={days.includes(d)}
                  aria-label={["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][d]}
                  style={{ minHeight: 36, padding: "6px 0", width: 36, ...(days.includes(d) ? chipOn : {}) }}
                  onClick={() => toggleDay(d)}
                >
                  {chipLabel}
                </button>
              ))}
              <button
                className="mini-btn"
                aria-pressed={sunMode}
                style={sunMode ? chipOn : undefined}
                onClick={() => setSunMode((v) => !v)}
              >
                Sunset…
              </button>
              <button
                className="mini-btn"
                aria-pressed={once}
                style={once ? chipOn : undefined}
                onClick={() => {
                  setOnce((v) => !v);
                  if (!once && !date) setDate(new Date(Date.now() + 86400000).toISOString().slice(0, 10));
                }}
              >
                Once…
              </button>
              {once && (
                <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={field} />
              )}
            </div>
            {!once && <p className="st" style={{ margin: "4px 0 0" }}>No days selected = every day.</p>}
            {sunMode && (
              <p className="st" style={{ margin: "4px 0 0" }}>
                {(() => {
                  const t = resolveStepTime({ sun: sunEvent, sunOffsetMinutes: sunOffset }, sunTimes, tz || undefined)?.time;
                  return t
                    ? `Fires around ${t} right now — tracks the real ${sunEvent} through the year.`
                    : `Fires at ${sunEvent} — exact time comes from Home Assistant.`;
                })()}
              </p>
            )}

            {/* Hold: guard the lights this step turns on against outside interference. */}
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8, alignItems: "center" }}>
              <button
                className="mini-btn"
                aria-pressed={!!holdUntil}
                style={holdUntil ? chipOn : undefined}
                onClick={() => setHoldUntil(holdUntil ? "" : "02:00")}
              >
                Hold…
              </button>
              {holdUntil && (
                <input type="time" value={holdUntil} onChange={(e) => setHoldUntil(e.target.value)} style={field} />
              )}
            </div>
            {holdUntil && (
              <p className="st" style={{ margin: "4px 0 0" }}>
                Lights this turns on are kept on until {holdUntil} — anything switching them
                off earlier gets switched back on, and every save shows up in Activity.
              </p>
            )}

            {/* What: pick a room (or a scene), then an action the room supports. */}
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
              <select value={target} onChange={(e) => pickTarget(e.target.value)} style={{ ...field, flex: "1 1 200px" }}>
                <option value="">choose a room…</option>
                <option value={SCENE_TARGET}>Run a scene…</option>
                {allRooms.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
              {target === SCENE_TARGET && (
                <select value={actScene} onChange={(e) => setActScene(e.target.value)} style={field}>
                  <option value="">choose scene…</option>
                  {scenes.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              )}
            </div>
            {target && target !== SCENE_TARGET && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
                {chips.map((c) => (
                  <button
                    key={c.key}
                    className="mini-btn"
                    aria-pressed={action === c.key}
                    style={action === c.key ? chipOn : undefined}
                    onClick={() => pickAction(c.key)}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            )}
            {target && target !== SCENE_TARGET && action === "lights_each" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <button className="mini-btn" onClick={() => setAllLights("off")}>All off</button>
                  <button className="mini-btn" onClick={() => setAllLights("on")}>All on</button>
                  <button className="mini-btn" onClick={() => setAllLights("leave")}>Leave all</button>
                </div>
                {roomLightList.map((t) => {
                  const { mode, pct } = lightMode(t.id);
                  return (
                    <div key={t.id} style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                      <span style={{ flex: "1 1 140px", fontSize: 14 }}>{t.label}</span>
                      <select value={mode} onChange={(e) => setLightMode(t.id, e.target.value as LightMode)} style={field}>
                        <option value="leave">Leave</option>
                        <option value="on">On</option>
                        <option value="off">Off</option>
                        {t.capabilities.includes("brightness") && <option value="pct">On at %…</option>}
                      </select>
                      {mode === "pct" && t.capabilities.includes("brightness") && (
                        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--dim)" }}>
                          <input
                            type="number" min={1} max={100} step={1} value={pct}
                            onChange={(e) => setLightPct(t.id, Number(e.target.value))}
                            style={{ ...field, width: 70 }}
                          />
                          %
                        </label>
                      )}
                    </div>
                  );
                })}
                <p className="st" style={{ margin: 0 }}>“Leave” lights aren’t touched — they stay however they were.</p>
              </div>
            )}
            {target && target !== SCENE_TARGET && (action === "ac_on_at" || action === "sauna_on_at" || action === "device") && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8, alignItems: "center" }}>
                {action === "ac_on_at" && tempInput("climate")}
                {action === "sauna_on_at" && tempInput("sauna")}
                {action === "device" && (
                  <>
                    <select value={actDevice} onChange={(e) => pickDevice(e.target.value)} style={{ ...field, flex: "1 1 200px" }}>
                      <option value="">choose device…</option>
                      {roomDevs.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                    </select>
                    {actDevice && (
                      <select value={actCommand} onChange={(e) => {
                        setActCommand(e.target.value);
                        if (e.target.value === "on_at" || e.target.value === "set_temp") {
                          const b = tempBoundsFor(selectedDevice?.kind);
                          setActTemp((t) => (t >= b.min && t <= b.max ? t : b.dflt));
                        }
                      }} style={field}>
                        {commandOptions(selectedDevice).map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                      </select>
                    )}
                    {(actCommand === "on_at" || actCommand === "set_temp") && tempInput(selectedDevice?.kind)}
                    {actCommand === "on_at_level" && (
                      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--dim)" }}>
                        warmth
                        <input
                          type="number" min={-100} max={100} step={5} value={actLevel}
                          onChange={(e) => setActLevel(Number(e.target.value))}
                          style={{ ...field, width: 70 }}
                        />
                        (−100 cool … +100 warm)
                      </label>
                    )}
                    {actCommand === "on_at_pct" && (
                      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--dim)" }}>
                        <input
                          type="number" min={1} max={100} step={1} value={actBright}
                          onChange={(e) => setActBright(Number(e.target.value))}
                          style={{ ...field, width: 70 }}
                        />
                        %
                      </label>
                    )}
                  </>
                )}
              </div>
            )}
            {/* Queued actions: everything here fires together at the trigger above. */}
            {draft.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <p className="st" style={{ margin: "0 0 4px", fontWeight: 600 }}>Does all of this:</p>
                {draft.map((d, i) => (
                  <div key={i} className="st" style={{ marginBottom: 4 }}>
                    {d.label}{" "}
                    <button
                      aria-label={`Remove ${d.label}`}
                      onClick={() => setDraft(draft.filter((_, j) => j !== i))}
                      style={{ background: "none", border: "none", color: "var(--danger)", cursor: "pointer", font: "inherit" }}
                    >✕</button>
                  </div>
                ))}
              </div>
            )}
            {/* Queue the current selection so more actions can run at the same time. */}
            {currentAction() && (
              <div style={{ marginTop: 8 }}>
                <button className="mini-btn" onClick={addAction}>+ Add another action</button>
              </div>
            )}
            {saunaScheduled && (
              <p className="st" style={{ margin: "4px 0 0", color: "var(--danger)" }}>
                Scheduling the sauna starts the heater unattended — the KLAFS bathing-time limit still applies.
              </p>
            )}
            <div style={{ display: "flex", gap: 6, marginTop: 12 }}>
              <button className="scene-pill" disabled={busy || !name.trim() || !buildStep()} onClick={save}
                style={{ flex: 1, maxWidth: "none", padding: 12 }}>
                {editingId ? "Save changes" : "Create automation"}
              </button>
              <button className="mini-btn" onClick={closeBuilder}>Cancel</button>
            </div>
          </div>
        </>
      )}

      <div className="section-label">Auto-off timers</div>
      <p className="h-sub" style={{ marginTop: -2 }}>
        Whenever the device turns on — from any switch, scene, or app — it turns itself off after
        the set time. Timers keep working in Away mode — a light someone leaves on still goes off.
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
              {t.canDelete && (
                <button
                  className="mini-btn"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm("Delete this auto-off timer?")) timerOp({ action: "delete", id: t.id });
                  }}
                >
                  Delete
                </button>
              )}
            </div>
          </div>
        );
      })}
      {!timerFormOpen && (
        <button className="mini-btn" onClick={() => setTimerFormOpen(true)}>+ Add auto-off timer</button>
      )}
      {timerFormOpen && (
        <div className="dev-block" style={{ padding: 14 }}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <select
              value={timerDevice}
              onChange={(e) => setTimerDevice(e.target.value)}
              style={{ ...field, flex: "1 1 220px" }}
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
                style={{ ...field, width: 64 }}
              />
              min
            </label>
            <button
              className="mini-btn"
              disabled={busy || !timerDevice || !(timerMinutes >= 1)}
              onClick={async () => {
                if (await timerOp({ action: "create", deviceId: timerDevice, afterMinutes: timerMinutes })) {
                  setTimerDevice("");
                  setTimerFormOpen(false);
                }
              }}
            >
              + Add timer
            </button>
            <button className="mini-btn" onClick={() => setTimerFormOpen(false)}>Cancel</button>
          </div>
        </div>
      )}
      <NavBar />
    </main>
  );
}

/**
 * The sauna follower's card: the Sauna room's A/C runs in unison with the
 * sauna — a standing house rule triggered by the sauna's STATE, which the
 * step builder can't express. Server logic lives in lib/saunawatch; this
 * card only reads status and flips enabled.
 */
function SaunaFollower() {
  const [st, setSt] = useState<{
    enabled: boolean; available: boolean; acTemp: number; canToggle: boolean;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/saunawatch")
      .then((r) => (r.ok ? r.json() : null))
      .then(setSt)
      .catch(() => setSt(null));
  }, []);

  // Absent hardware = absent card (no sauna service or no Sauna room A/C).
  if (!st || !st.available) return null;

  const toggle = () => {
    setBusy(true);
    fetch("/api/saunawatch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !st.enabled }),
    })
      .then((r) => r.json())
      .then((out) => { if (out.ok) setSt({ ...st, enabled: out.enabled }); })
      .finally(() => setBusy(false));
  };

  return (
    <div className={`dev${st.enabled ? "" : " paused"}`} style={{ alignItems: "flex-start" }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="nm">Sauna follower — room A/C</div>
        <div className="st">
          {st.enabled
            ? `sauna on → Sauna A/C on at ${st.acTemp}° · sauna off → A/C off · however the sauna was started, app or panel · manual A/C changes mid-session are left alone`
            : "paused"}
        </div>
      </div>
      <button
        className="toggle"
        aria-pressed={st.enabled}
        aria-label={`Sauna follower ${st.enabled ? "on" : "paused"}`}
        disabled={busy || !st.canToggle}
        onClick={toggle}
      />
    </div>
  );
}

/**
 * The sleep watcher's card: a standing house rule, not a user-authored
 * automation — it triggers on the room's STATE (dark, closed, TV stowed
 * after 22:00), which the step builder can't express. Server logic lives in
 * lib/sleepwatch; this card only reads status and flips enabled.
 */
function SleepSense({ away }: { away: boolean }) {
  const [st, setSt] = useState<{
    enabled: boolean; active: boolean; configured: boolean; canToggle: boolean;
    window: { start: string; end: string };
  } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/sleepwatch")
      .then((r) => (r.ok ? r.json() : null))
      .then(setSt)
      .catch(() => setSt(null));
  }, []);

  if (!st) return null;

  const toggle = () => {
    setBusy(true);
    fetch("/api/sleepwatch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !st.enabled }),
    })
      .then((r) => r.json())
      .then((out) => { if (out.ok) setSt({ ...st, enabled: out.enabled, active: false }); })
      .finally(() => setBusy(false));
  };

  return (
    <div className={`dev${st.enabled && !away ? "" : " paused"}`} style={{ alignItems: "flex-start" }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="nm">Sleep sense — white noise</div>
        <div className="st">
          {!st.configured
            ? "white noise isn't configured yet"
            : !st.enabled
              ? "paused"
              : away
                ? "standing down while Away mode is on — arms again the night you're back"
                : st.active
                ? "noise is on — stops when a light comes on or a shade opens (no morning timer)"
                : `arms ${st.window.start}–${st.window.end} · starts when the bedroom lights are off (bedside reading lights don't count) and the TV is stowed · stops when a light comes on or a shade opens — no morning timer · plays the sound and volume the Sleep sound card is set to`}
        </div>
      </div>
      <button
        className="toggle"
        aria-pressed={st.enabled}
        aria-label={`Sleep sense ${st.enabled ? "on" : "paused"}`}
        disabled={busy || !st.configured || !st.canToggle}
        onClick={toggle}
      />
    </div>
  );
}

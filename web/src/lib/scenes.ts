import fs from "node:fs";
import path from "node:path";
import type { Device } from "./registry";
import type { HaState } from "./ha";

/**
 * App-level scenes: snapshots of device states, stored as JSON (point
 * SCENES_PATH at the persistent volume in production) and replayed through
 * the typed command layer. Deliberately app-level rather than HA-native:
 * the HA token is non-admin (least privilege), and app-level scenes are
 * role-gateable and audited like everything else.
 *
 * Captured domains: lights (on/off + brightness), covers (open/closed),
 * climate set-points. Media is excluded (transient sources make snapshots
 * misleading); the sauna is excluded by safety policy.
 */

export interface SceneState {
  deviceId: string;
  command: Record<string, unknown>;
}

export interface Scene {
  id: string;
  name: string;
  room: string | null;
  createdBy: string;
  createdAt: string;
  states: SceneState[];
}

function scenesPath(): string {
  return process.env.SCENES_PATH || path.join(process.cwd(), "scenes.json");
}

function load(): Scene[] {
  try {
    return JSON.parse(fs.readFileSync(scenesPath(), "utf8")) as Scene[];
  } catch {
    return [];
  }
}

function save(scenes: Scene[]): void {
  fs.writeFileSync(scenesPath(), JSON.stringify(scenes, null, 2));
}

export function listScenes(): Scene[] {
  return load();
}

export function getScene(id: string): Scene | undefined {
  return load().find((s) => s.id === id);
}

export function deleteScene(id: string): void {
  const scenes = load();
  if (!scenes.some((s) => s.id === id)) throw new Error("no such scene");
  save(scenes.filter((s) => s.id !== id));
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/**
 * Pure: derive the replayable command list from live device+state data.
 * Exported for tests.
 */
export function buildSceneStates(
  devices: Device[],
  states: Map<string, HaState>,
): SceneState[] {
  const out: SceneState[] = [];
  for (const d of devices) {
    if (!d.visible) continue;
    const s = states.get(d.entityId);
    if (!s || s.state === "unavailable" || s.state === "unknown") continue;
    if (d.kind === "light" && d.category !== "scene_switch") {
      if (s.state === "on") {
        const br = typeof s.attributes.brightness === "number"
          ? Math.max(1, Math.round(((s.attributes.brightness as number) / 255) * 100))
          : null;
        out.push({
          deviceId: d.id,
          command: br != null && d.capabilities.includes("brightness")
            ? { command: "set_brightness", brightnessPct: br }
            : { command: "turn_on" },
        });
      } else {
        out.push({ deviceId: d.id, command: { command: "turn_off" } });
      }
    } else if (d.kind === "cover") {
      // Covers are NOT captured from state: C4 position feedback is stuck
      // (~1%, every cover reads "open" forever), so a blinds-down capture
      // would store "open" and replay by raising them. Shades enter a scene
      // only by explicit choice at capture time (the route appends them).
      continue;
    } else if (d.kind === "climate") {
      // Capture the power state too: a scene that only sets 16° on a unit
      // that happens to be off cools nothing. Apply runs a device's
      // commands in order (turn_on, then the setpoint).
      if (s.state === "off") {
        out.push({ deviceId: d.id, command: { command: "turn_off" } });
      } else {
        out.push({ deviceId: d.id, command: { command: "turn_on" } });
        const target = s.attributes.temperature;
        if (typeof target === "number" && target >= 10 && target <= 32) {
          out.push({ deviceId: d.id, command: { command: "set_temperature", temperature: target } });
        }
      }
    }
    // media deliberately not captured (transient sources); the sauna is
    // captured by the route (its state lives at KLAFS, not in HA) and only
    // ever replays behind an explicit per-apply confirmation
  }
  return out;
}

export function createScene(
  name: string,
  room: string | null,
  createdBy: string,
  states: SceneState[],
): Scene {
  const clean = name.trim();
  if (!clean) throw new Error("scene needs a name");
  if (states.length === 0) throw new Error("nothing capturable in this room right now");
  const scenes = load();

  // Same name = same scene: capturing "Pre-workout" in the Gym and then
  // again in the Sauna composes ONE multi-room scene (new capture replaces
  // that room's devices, other rooms' states survive). room goes null once
  // it spans rooms.
  const existing = scenes.find((s) => s.name.toLowerCase() === clean.toLowerCase());
  if (existing) {
    const captured = new Set(states.map((st) => st.deviceId));
    existing.states = [...existing.states.filter((st) => !captured.has(st.deviceId)), ...states];
    if (existing.room !== room) existing.room = null;
    save(scenes);
    return existing;
  }

  let id = slug(clean) || "scene";
  let n = 2;
  while (scenes.some((s) => s.id === id)) id = `${slug(clean)}_${n++}`;
  const scene: Scene = {
    id, name: clean, room, createdBy,
    createdAt: new Date().toISOString(),
    states,
  };
  scenes.push(scene);
  save(scenes);
  return scene;
}

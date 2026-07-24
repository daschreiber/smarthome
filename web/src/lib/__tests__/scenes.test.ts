import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { buildSceneStates, createScene, deleteScene, getScene, listScenes } from "../scenes";
import type { Device } from "../registry";
import type { HaState } from "../ha";

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scenes-test-"));
  process.env.SCENES_PATH = path.join(dir, "scenes.json");
});

const dev = (over: Partial<Device>): Device => ({
  id: "x", entityId: "light.x", kind: "light", label: "X", room: "Den", floor: 5,
  group: "Lighting", category: "light_dimmer", visible: true,
  capabilities: ["on_off", "brightness"], ...over,
});

const st = (entityId: string, state: string, attributes: Record<string, unknown> = {}): [string, HaState] =>
  [entityId, { entity_id: entityId, state, attributes, last_updated: "", last_changed: "" }];

describe("buildSceneStates", () => {
  it("captures dimmer brightness, off lights, covers, and climate targets", () => {
    const devices = [
      dev({ id: "den__spots", entityId: "light.spots" }),
      dev({ id: "den__plain", entityId: "light.plain", category: "light_switch", capabilities: ["on_off"] }),
      dev({ id: "den__blinds", entityId: "cover.blinds", kind: "cover", category: "shade", capabilities: ["open_close_stop", "position"] }),
      dev({ id: "den__ac", entityId: "climate.den", kind: "climate", category: "climate_zone", capabilities: ["set_temperature", "hvac_mode"] }),
    ];
    const states = new Map([
      st("light.spots", "on", { brightness: 128 }),
      st("light.plain", "off"),
      st("cover.blinds", "closed"),
      st("climate.den", "cool", { temperature: 23 }),
    ]);
    expect(buildSceneStates(devices, states)).toEqual([
      { deviceId: "den__spots", command: { command: "set_brightness", brightnessPct: 50 } },
      { deviceId: "den__plain", command: { command: "turn_off" } },
      { deviceId: "den__blinds", command: { command: "close" } },
      // Power state AND setpoint: 16° on a sleeping unit cools nothing.
      { deviceId: "den__ac", command: { command: "turn_on" } },
      { deviceId: "den__ac", command: { command: "set_temperature", temperature: 23 } },
    ]);
  });

  it("captures an off AC as turn_off, without a setpoint", () => {
    const devices = [dev({ id: "den__ac", entityId: "climate.den", kind: "climate", category: "climate_zone", capabilities: ["set_temperature", "hvac_mode"] })];
    const states = new Map([st("climate.den", "off", { temperature: 23 })]);
    expect(buildSceneStates(devices, states)).toEqual([
      { deviceId: "den__ac", command: { command: "turn_off" } },
    ]);
  });

  it("skips unavailable devices, hidden devices, scene switches, media, and sauna", () => {
    const devices = [
      dev({ id: "a", entityId: "light.a" }),
      dev({ id: "b", entityId: "light.b", visible: false }),
      dev({ id: "c", entityId: "light.c", category: "scene_switch", capabilities: ["on_off"] }),
      dev({ id: "d", entityId: "media_player.d", kind: "media_player", category: "media", capabilities: ["on_off", "volume"] }),
      dev({ id: "e", entityId: "virtual.sauna", kind: "sauna", category: "sauna_heater", capabilities: ["on_off", "set_temperature"] }),
    ];
    const states = new Map([
      st("light.a", "unavailable"),
      st("light.b", "on"),
      st("light.c", "on"),
      st("media_player.d", "on"),
      st("virtual.sauna", "off"),
    ]);
    expect(buildSceneStates(devices, states)).toEqual([]);
  });
});

describe("scene store", () => {
  it("creates, lists, fetches, and deletes; distinct names get distinct ids", () => {
    const s1 = createScene("Cozy Den", "Den", "daniel@x.com", [{ deviceId: "a", command: { command: "turn_on" } }]);
    const s2 = createScene("Movie Den", "Den", "daniel@x.com", [{ deviceId: "b", command: { command: "turn_off" } }]);
    expect(s1.id).not.toBe(s2.id);
    expect(listScenes()).toHaveLength(2);
    expect(getScene(s1.id)?.states[0].deviceId).toBe("a");
    deleteScene(s1.id);
    expect(listScenes()).toHaveLength(1);
  });

  it("re-capturing the same name in another room composes ONE multi-room scene", () => {
    const s1 = createScene("Pre-workout", "Gym", "daniel@x.com", [{ deviceId: "gym__lights", command: { command: "turn_on" } }]);
    const s2 = createScene("pre-workout", "Sauna", "daniel@x.com", [{ deviceId: "sauna__lights", command: { command: "turn_on" } }]);
    expect(s2.id).toBe(s1.id);
    expect(listScenes()).toHaveLength(1);
    expect(getScene(s1.id)?.states.map((st) => st.deviceId).sort()).toEqual(["gym__lights", "sauna__lights"]);
    expect(getScene(s1.id)?.room).toBeNull(); // spans rooms now
  });

  it("re-capturing the same room replaces that room's states, keeping the other room's", () => {
    createScene("Pre-workout", "Gym", "d@x.com", [{ deviceId: "gym__lights", command: { command: "turn_on" } }]);
    createScene("Pre-workout", "Sauna", "d@x.com", [{ deviceId: "sauna__lights", command: { command: "turn_on" } }]);
    const s3 = createScene("Pre-workout", "Gym", "d@x.com", [{ deviceId: "gym__lights", command: { command: "set_brightness", brightnessPct: 60 } }]);
    const cmds = Object.fromEntries(s3.states.map((st) => [st.deviceId, st.command]));
    expect(cmds["gym__lights"]).toEqual({ command: "set_brightness", brightnessPct: 60 });
    expect(cmds["sauna__lights"]).toEqual({ command: "turn_on" });
  });

  it("refuses empty captures and empty names", () => {
    expect(() => createScene("Empty", "Den", "d@x.com", [])).toThrow(/nothing capturable/);
    expect(() => createScene("  ", "Den", "d@x.com", [{ deviceId: "a", command: { command: "turn_on" } }])).toThrow(/name/);
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bedCallFor, bedConfigured, bedDeviceId, bedSideForDeviceId, bedSides,
} from "../eightsleep";
import { CommandSchema, assertCommandAllowed, buildServiceCall, expectedStates } from "../commands";
import type { Device } from "../registry";

/**
 * The Eight Sleep adapter's contract: env-driven per-side config (nothing
 * exists until the integration is installed and the envs set), commands as
 * eight_sleep.* service calls pinned to an exact wire shape, and the bed
 * NEVER reaching the generic HA service builder.
 */

const ENV_KEYS = [
  "EIGHTSLEEP_LEFT_TARGET_ENTITY", "EIGHTSLEEP_LEFT_PRESENCE_ENTITY", "EIGHTSLEEP_LEFT_LABEL",
  "EIGHTSLEEP_RIGHT_TARGET_ENTITY", "EIGHTSLEEP_RIGHT_PRESENCE_ENTITY", "EIGHTSLEEP_RIGHT_LABEL",
  "EIGHTSLEEP_HEAT_DURATION_SECONDS",
];

beforeEach(() => { for (const k of ENV_KEYS) delete process.env[k]; });
afterEach(() => { for (const k of ENV_KEYS) delete process.env[k]; });

function configureLeft() {
  process.env.EIGHTSLEEP_LEFT_TARGET_ENTITY = "sensor.left_bed_temp";
  process.env.EIGHTSLEEP_LEFT_PRESENCE_ENTITY = "binary_sensor.left_bed_presence";
  process.env.EIGHTSLEEP_LEFT_LABEL = "Daniel's side";
}

describe("configuration", () => {
  it("is absent until the envs exist — no phantom bed in the registry path", () => {
    expect(bedConfigured()).toBe(false);
    expect(bedSides()).toEqual([]);
  });

  it("one side alone works (a single-sleeper setup)", () => {
    configureLeft();
    expect(bedConfigured()).toBe(true);
    expect(bedSides()).toEqual([{
      side: "left", label: "Daniel's side",
      targetEntity: "sensor.left_bed_temp",
      presenceEntity: "binary_sensor.left_bed_presence",
    }]);
  });

  it("labels default, presence is optional, device ids are stable", () => {
    process.env.EIGHTSLEEP_RIGHT_TARGET_ENTITY = "sensor.right_bed_temp";
    const [right] = bedSides();
    expect(right.label).toBe("Bed — right side");
    expect(right.presenceEntity).toBeUndefined();
    expect(bedDeviceId("right")).toBe("master_bedroom__bed_right");
    expect(bedSideForDeviceId("master_bedroom__bed_right")?.side).toBe("right");
    expect(bedSideForDeviceId("master_bedroom__bed_left")).toBeUndefined();
  });
});

describe("service call wire shape", () => {
  const side = {
    side: "left" as const, label: "L", targetEntity: "sensor.left_bed_temp",
  };

  it("side on/off and away target the side's entity", () => {
    expect(bedCallFor(side, { kind: "on" })).toEqual({
      domain: "eight_sleep", service: "side_on", data: { entity_id: "sensor.left_bed_temp" },
    });
    expect(bedCallFor(side, { kind: "off" })).toEqual({
      domain: "eight_sleep", service: "side_off", data: { entity_id: "sensor.left_bed_temp" },
    });
    expect(bedCallFor(side, { kind: "away", away: true }).service).toBe("away_mode_start");
    expect(bedCallFor(side, { kind: "away", away: false }).service).toBe("away_mode_stop");
  });

  it("warmth is heat_set on the CURRENT sleep stage, clamped to Eight Sleep's scale", () => {
    // duration is REQUIRED by the integration (services.yaml, confirmed
    // on-site 2026-07-25): how long the level holds before the Pod's own
    // schedule resumes. Default: a full night.
    expect(bedCallFor(side, { kind: "level", level: 30 })).toEqual({
      domain: "eight_sleep", service: "heat_set",
      data: { entity_id: "sensor.left_bed_temp", target: 30, duration: 28800, sleep_stage: "current" },
    });
    expect(() => bedCallFor(side, { kind: "level", level: 101 })).toThrow();
    expect(() => bedCallFor(side, { kind: "level", level: -101 })).toThrow();
  });

  it("hold duration is env-tunable, with nonsense falling back to the default", () => {
    process.env.EIGHTSLEEP_HEAT_DURATION_SECONDS = "3600";
    expect(bedCallFor(side, { kind: "level", level: 10 }).data.duration).toBe(3600);
    process.env.EIGHTSLEEP_HEAT_DURATION_SECONDS = "-5";
    expect(bedCallFor(side, { kind: "level", level: 10 }).data.duration).toBe(28800);
    process.env.EIGHTSLEEP_HEAT_DURATION_SECONDS = "not a number";
    expect(bedCallFor(side, { kind: "level", level: 10 }).data.duration).toBe(28800);
  });
});

describe("command layer", () => {
  const bedDevice: Device = {
    id: "master_bedroom__bed_left", entityId: "sensor.left_bed_temp", kind: "bed",
    label: "Daniel's side", room: "Master Bedroom", floor: 6,
    group: "Climate & Comfort", category: "bed_side", visible: true,
    capabilities: ["on_off", "bed_level"],
  };

  it("set_bed_level parses and is allowed only where bed_level exists", () => {
    expect(CommandSchema.safeParse({ command: "set_bed_level", level: -40 }).success).toBe(true);
    expect(CommandSchema.safeParse({ command: "set_bed_level", level: 150 }).success).toBe(false);
    expect(() => assertCommandAllowed(bedDevice, { command: "set_bed_level", level: 20 })).not.toThrow();
    expect(() =>
      assertCommandAllowed({ ...bedDevice, kind: "light", capabilities: ["on_off"] }, { command: "set_bed_level", level: 20 }),
    ).toThrow();
  });

  it("the bed never reaches the generic HA service builder", () => {
    expect(() => buildServiceCall(bedDevice, { command: "turn_on" })).toThrow(/Eight Sleep adapter/);
  });

  it("bed on/off honestly reports as unverifiable (the temp entity never says on/off)", () => {
    expect(expectedStates({ command: "turn_on" }, "bed")).toBeNull();
    expect(expectedStates({ command: "turn_off" }, "bed")).toBeNull();
    expect(expectedStates({ command: "turn_on" }, "light")).toEqual(["on"]);
  });
});

import { describe, expect, it, vi } from "vitest";
import { SYSTEM_COMMANDS, executeOnDevice, executeSystemCommand, roomLights, stepHoldLights, systemDevices } from "../execute";
import { registry } from "../registry";

describe("systemDevices", () => {
  it("lighting is real lights only — no scene switches, fans, vents, or towel rails", () => {
    const lights = systemDevices("lighting");
    expect(lights.length).toBeGreaterThan(50);
    for (const d of lights) {
      expect(d.kind).toBe("light");
      expect(d.group).toBe("Lighting");
      expect(d.category).not.toBe("scene_switch");
    }
  });

  it("climate is A/C zones only — never the sauna", () => {
    const zones = systemDevices("climate");
    expect(zones.length).toBeGreaterThan(5);
    for (const d of zones) expect(d.kind).toBe("climate");
    expect(zones.some((d) => d.kind === "sauna" || d.category === "sauna_heater")).toBe(false);
  });

  it("shades are all covers", () => {
    const shades = systemDevices("shades");
    expect(shades.length).toBeGreaterThan(5);
    for (const d of shades) expect(d.kind).toBe("cover");
  });
});

describe("roomLights", () => {
  it("sweeps only group Lighting — never fans, vents, towel rails, or heating", () => {
    const rooms = new Set(registry().devices.map((d) => d.room));
    for (const room of rooms) {
      for (const d of roomLights(room)) {
        expect(d.group, `${d.id} must not be in a lights fan-out`).toBe("Lighting");
        expect(d.kind).toBe("light");
      }
    }
    // Sanity: the boundary excludes real comfort devices that ride the light
    // domain (Master Bathroom has a towel rail and a vent).
    const bathSweep = roomLights("Master Bathroom").map((d) => d.category);
    expect(bathSweep).not.toContain("towel_rail");
    expect(bathSweep).not.toContain("ventilation");
    expect(bathSweep.length).toBeGreaterThan(0);
  });
});

describe("executeSystemCommand", () => {
  it("rejects commands that don't belong to the system", async () => {
    await expect(executeSystemCommand("lighting", "open")).rejects.toThrow();
    await expect(executeSystemCommand("climate", "close")).rejects.toThrow();
    await expect(executeSystemCommand("shades", "turn_off")).rejects.toThrow();
  });

  it("reports no matching devices for an unknown room instead of throwing", async () => {
    const result = await executeSystemCommand("lighting", "turn_off", ["No Such Room"]);
    expect(result.total).toBe(0);
    expect(result.failed).toHaveLength(1);
  });

  it("declares only simple, reversible commands per system", () => {
    expect(SYSTEM_COMMANDS.lighting).toEqual(["turn_on", "turn_off", "set_brightness"]);
    expect(SYSTEM_COMMANDS.climate).toEqual(["turn_on", "turn_off"]);
    expect(SYSTEM_COMMANDS.shades).toEqual(["open", "close", "stop"]);
  });

  it("set_brightness requires a value and only targets dimmable lights", async () => {
    await expect(executeSystemCommand("lighting", "set_brightness", ["Master Bedroom"])).rejects.toThrow();
    // Master Bedroom has 3 dimmers and 5 switches; the group dim must sweep
    // exactly the dimmers (network calls fail in tests, so count via failed).
    const dimmers = systemDevices("lighting").filter(
      (d) => d.room === "Master Bedroom" && d.capabilities.includes("brightness"),
    );
    expect(dimmers.length).toBeGreaterThan(0);
    const result = await executeSystemCommand("lighting", "set_brightness", ["Master Bedroom"], 40);
    expect(result.total).toBe(dimmers.length);
  });
});

describe("executeOnDevice noise routing", () => {
  // The white-noise device is virtual — virtual.white_noise doesn't exist in
  // HA, so on/off must go through lib/whitenoise's playback path (play_media
  // or select_source), NEVER buildServiceCall's light branch. This pins the
  // fix for automations/scenes firing noise at a phantom entity.
  const noiseDevice = {
    id: "master_bedroom__white_noise",
    entityId: "virtual.white_noise",
    kind: "noise",
    label: "White noise",
    room: "Master Bedroom",
    floor: 6,
    group: "Media",
    category: "noise_machine",
    visible: true,
    capabilities: ["on_off", "volume"],
  } as Parameters<typeof executeOnDevice>[0];

  it("turn_on plays the stream on the media entity, not light.turn_on on the phantom", async () => {
    process.env.WHITENOISE_BASE_URL = "https://noise.example";
    process.env.WHITENOISE_TOKEN = "tok";
    process.env.HA_BASE_URL = "http://ha.example";
    process.env.HA_TOKEN = "ha-tok";
    const calls: Array<{ url: string; body?: string }> = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body ? String(init.body) : undefined });
      return new Response("{}", { status: 200 });
    });
    try {
      await executeOnDevice(noiseDevice, { command: "turn_on" });
      const ha = calls.find((c) => c.url.includes("/api/services/"));
      expect(ha, "must call an HA media_player service").toBeDefined();
      expect(ha!.url).toContain("/api/services/media_player/play_media");
      expect(ha!.body).toContain("media_player.");
      expect(ha!.body).not.toContain("virtual.white_noise");
    } finally {
      vi.unstubAllGlobals();
      delete process.env.WHITENOISE_BASE_URL;
      delete process.env.WHITENOISE_TOKEN;
      delete process.env.HA_BASE_URL;
      delete process.env.HA_TOKEN;
    }
  });

  it("set_volume goes to the noise server, not HA", async () => {
    process.env.WHITENOISE_BASE_URL = "https://noise.example";
    process.env.WHITENOISE_TOKEN = "tok";
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string | URL) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ noise_type: "white", volume: 30, listeners: 0 }), { status: 200 });
    });
    try {
      await executeOnDevice(noiseDevice, { command: "set_volume", volumePct: 30 });
      expect(calls).toEqual(["https://noise.example/api/volume/30"]);
    } finally {
      vi.unstubAllGlobals();
      delete process.env.WHITENOISE_BASE_URL;
      delete process.env.WHITENOISE_TOKEN;
    }
  });
});

describe("executeOnDevice sauna safety bounds", () => {
  // The direct command route validates before dispatch, but scenes,
  // automations, the scheduler, and the assistant reach the heater through
  // executeOnDevice. CommandSchema's outer 5-110 range is not the safety
  // limit — the per-kind 40-100 bound must hold here too.
  const saunaDevice = {
    id: "sauna__heater",
    entityId: "climate.sauna",
    kind: "sauna",
    label: "Sauna",
    room: "Sauna",
    floor: null,
    group: "Climate",
    category: "sauna_heater",
    visible: true,
    capabilities: ["on_off", "set_temperature"],
  } as Parameters<typeof executeOnDevice>[0];

  it("rejects an out-of-range set-point and never calls upstream", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string | URL) => {
      calls.push(String(url));
      return new Response("{}", { status: 200 });
    });
    try {
      await expect(
        executeOnDevice(saunaDevice, { command: "set_temperature", temperature: 110 }),
      ).rejects.toThrow(/out of range 40-100/);
      await expect(
        executeOnDevice(saunaDevice, { command: "set_temperature", temperature: 39 }),
      ).rejects.toThrow(/out of range 40-100/);
      expect(calls, "a rejected set-point must not reach the sauna service").toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("stepHoldLights", () => {
  it("collects direct light turn-ons and room lights_on fan-outs, nothing else", () => {
    const step = {
      sun: "sunset" as const,
      actions: [
        { type: "device" as const, deviceId: "balcony_6th__balcony_plants", command: { command: "turn_on" } },
        { type: "device" as const, deviceId: "balcony_6th__balcony_wall", command: { command: "turn_off" } }, // off: not held
        { type: "device" as const, deviceId: "balcony_6th__balcony", command: { command: "turn_on" } }, // media, not a light
        { type: "scene" as const, sceneId: "cozy" }, // scenes are not expanded
      ],
    };
    expect(stepHoldLights(step).map((d) => d.id)).toEqual(["balcony_6th__balcony_plants"]);
  });
  it("room fan-out matches roomLights and dedups against direct actions", () => {
    const step = {
      time: "19:00",
      actions: [
        { type: "device" as const, deviceId: "balcony_6th__balcony_plants", command: { command: "turn_on" } },
        { type: "room" as const, room: "Balcony (6th)", command: "lights_on" as const },
      ],
    };
    const held = stepHoldLights(step).map((d) => d.id).sort();
    expect(held).toEqual(roomLights("Balcony (6th)").map((d) => d.id).sort());
    expect(held).toContain("balcony_6th__balcony_wall");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Extending one room's audio into others over the Control4 matrix. The
 * rules under test are the ones that keep the feature honest: only a named
 * source can be mirrored, the target zone's own source_list is the
 * authority, and a zone that never echoes the input back is reported as
 * "sent", not as success.
 */

const states = new Map<string, { state: string; attributes: Record<string, unknown> }>();
const serviceCalls: Array<{ domain: string; service: string; data: Record<string, unknown> }> = [];

vi.mock("../ha", () => ({
  getState: async (entityId: string) => states.get(entityId) ?? null,
  callService: async (domain: string, service: string, data: Record<string, unknown>) => {
    serviceCalls.push({ domain, service, data });
    // Selecting a source is what a real zone echoes back once it settles.
    if (service === "select_source") {
      const zone = states.get(data.entity_id as string);
      if (zone && zone.attributes.echoes !== false) {
        zone.attributes.source = data.source;
        zone.state = "playing";
      }
    }
    if (service === "turn_off") {
      const zone = states.get(data.entity_id as string);
      if (zone) zone.state = "off";
    }
  },
}));

function zone(entityId: string, attributes: Record<string, unknown>, state = "playing") {
  states.set(entityId, { state, attributes });
}

async function load() {
  vi.resetModules();
  return await import("../audio");
}

beforeEach(() => {
  states.clear();
  serviceCalls.length = 0;
  delete process.env.SPOTIFY_MIRROR_SOURCE;
  vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 1000 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("zone mapping", () => {
  it("picks the Control4 zone, not the other player sharing the room", async () => {
    const audio = await load();
    // The Terrace holds both the matrix zone and the un-cabled VSSL amp.
    expect(audio.zoneEntity("Terrace")).toBe("media_player.terrace");
    expect(audio.zoneRoomFor("media_player.terrace")).toBe("Terrace");
    expect(audio.zoneRoomFor("media_player.bbq_speaker")).toBeNull();
    // Balcony (6th) is the case where the names alone can't disambiguate.
    expect(audio.zoneEntity("Balcony (6th)")).toBe("media_player.balcony_2");
    expect(audio.zoneRoomFor("media_player.balcony")).toBeNull();
  });
});

describe("mirrorSourceFor", () => {
  it("uses the origin's named input", async () => {
    const audio = await load();
    zone("media_player.lounge", { source: "Gramophone", source_list: ["Gramophone"] });
    const origin = (await audio.readZone("Lounge"))!;
    expect(audio.mirrorSourceFor(origin).source).toBe("Gramophone");
  });

  it("explains why a Core Spotify session has nothing to mirror", async () => {
    const audio = await load();
    // The documented C4 case: a track is playing but `source` reads None,
    // because Core streaming sessions aren't in source_list.
    zone("media_player.lounge", { source: null, media_title: "Hey Jude", source_list: ["Gramophone"] });
    const origin = (await audio.readZone("Lounge"))!;
    const { source, why } = audio.mirrorSourceFor(origin);
    expect(source).toBeNull();
    expect(why).toMatch(/SPOTIFY_MIRROR_SOURCE/);
  });

  it("uses the configured mirror input once it's been identified", async () => {
    process.env.SPOTIFY_MIRROR_SOURCE = "Unknown Device - 4294966271";
    const audio = await load();
    zone("media_player.lounge", { source: null, media_title: "Hey Jude", source_list: [] });
    const origin = (await audio.readZone("Lounge"))!;
    expect(audio.mirrorSourceFor(origin).source).toBe("Unknown Device - 4294966271");
  });

  it("says nothing is playing when nothing is", async () => {
    const audio = await load();
    zone("media_player.lounge", { source: null, media_title: null, source_list: [] }, "off");
    const origin = (await audio.readZone("Lounge"))!;
    expect(audio.mirrorSourceFor(origin).why).toMatch(/isn't playing anything/);
  });
});

describe("extendAudio", () => {
  it("mirrors the input into the target and confirms it echoed back", async () => {
    const audio = await load();
    zone("media_player.lounge", { source: "Gramophone", source_list: ["Gramophone"] });
    zone("media_player.kitchen", { source: null, source_list: ["Gramophone", "Smart TV Kitchen"] }, "off");
    const origin = (await audio.readZone("Lounge"))!;

    const out = await audio.extendAudio(origin, ["Kitchen"]);
    expect(serviceCalls).toEqual([
      { domain: "media_player", service: "select_source", data: { entity_id: "media_player.kitchen", source: "Gramophone" } },
    ]);
    expect(out.results).toEqual([{ room: "Kitchen", status: "confirmed", detail: "playing Gramophone" }]);
  });

  it("refuses a zone that doesn't offer the input, and lists what it does", async () => {
    const audio = await load();
    zone("media_player.lounge", { source: "Gramophone", source_list: ["Gramophone"] });
    zone("media_player.terrace", { source: null, source_list: ["Smart TV Terrace"] }, "off");
    const origin = (await audio.readZone("Lounge"))!;

    const out = await audio.extendAudio(origin, ["Terrace"]);
    expect(serviceCalls).toHaveLength(0); // nothing sent to hardware that can't take it
    expect(out.results[0].status).toBe("failed");
    expect(out.results[0].detail).toMatch(/can't take "Gramophone".*Smart TV Terrace/);
  });

  it("reports 'sent' — not success — when the zone never echoes the input", async () => {
    const audio = await load();
    zone("media_player.lounge", { source: "Gramophone", source_list: ["Gramophone"] });
    zone("media_player.kitchen", { source: null, source_list: ["Gramophone"], echoes: false }, "off");
    const origin = (await audio.readZone("Lounge"))!;

    const out = await audio.extendAudio(origin, ["Kitchen"]);
    expect(serviceCalls).toHaveLength(1);
    expect(out.results[0].status).toBe("sent");
    expect(out.results[0].detail).toMatch(/hasn't echoed it back/);
    // Longer than vitest's default: this case deliberately waits out the
    // full read-back deadline, which is the behaviour being asserted.
  }, 15_000);

  it("handles a mix of rooms without letting one failure stop the others", async () => {
    const audio = await load();
    zone("media_player.lounge", { source: "Gramophone", source_list: ["Gramophone"] });
    zone("media_player.kitchen", { source: null, source_list: ["Gramophone"] }, "off");
    zone("media_player.terrace", { source: null, source_list: ["Smart TV Terrace"] }, "off");
    const origin = (await audio.readZone("Lounge"))!;

    const out = await audio.extendAudio(origin, ["Kitchen", "Terrace"]);
    expect(out.results.map((r) => [r.room, r.status])).toEqual([
      ["Kitchen", "confirmed"],
      ["Terrace", "failed"],
    ]);
  });

  it("fails every target, with the reason, when there's no source to mirror", async () => {
    const audio = await load();
    zone("media_player.lounge", { source: null, media_title: "Hey Jude", source_list: [] });
    zone("media_player.kitchen", { source: null, source_list: ["Gramophone"] }, "off");
    const origin = (await audio.readZone("Lounge"))!;

    const out = await audio.extendAudio(origin, ["Kitchen"]);
    expect(out.source).toBeNull();
    expect(serviceCalls).toHaveLength(0);
    expect(out.results[0]).toMatchObject({ room: "Kitchen", status: "failed" });
    expect(out.results[0].detail).toMatch(/Spotify session from the Control4 Core/);
  });
});

describe("dropRoom", () => {
  it("switches the zone off to leave the group", async () => {
    const audio = await load();
    zone("media_player.kitchen", { source: "Gramophone", source_list: ["Gramophone"] });
    await audio.dropRoom("Kitchen");
    expect(serviceCalls).toEqual([
      { domain: "media_player", service: "turn_off", data: { entity_id: "media_player.kitchen" } },
    ]);
  });

  it("refuses a room with no zone rather than guessing at an entity", async () => {
    const audio = await load();
    await expect(audio.dropRoom("Gym")).rejects.toThrow(/no Control4 zone/);
  });
});

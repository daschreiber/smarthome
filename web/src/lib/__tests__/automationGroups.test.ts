import { describe, expect, it } from "vitest";
import { automationGroup, MIXED_GROUP, OTHER_GROUP, SCENES_GROUP, WHOLE_HOUSE_ROOM } from "../automationGroups";

const roomOf = (id: string) =>
  ({ balcony_plants: "Balcony (6th)", terrace_lights: "Terrace", sauna: "Sauna", closets_strip: WHOLE_HOUSE_ROOM })[id];

describe("automationGroup", () => {
  it("groups by the one room the actions touch", () => {
    expect(
      automationGroup(
        [{ actions: [{ type: "room", room: "Balcony (6th)" }] }],
        roomOf,
      ),
    ).toBe("Balcony (6th)");
  });

  it("resolves device actions to their room, merging with room actions", () => {
    expect(
      automationGroup(
        [
          {
            actions: [
              { type: "room", room: "Balcony (6th)" },
              { type: "device", deviceId: "balcony_plants" },
            ],
          },
        ],
        roomOf,
      ),
    ).toBe("Balcony (6th)");
  });

  it("collects rooms across steps of a multi-step automation", () => {
    expect(
      automationGroup(
        [
          { actions: [{ type: "device", deviceId: "sauna" }] },
          { actions: [{ type: "device", deviceId: "sauna" }] },
        ],
        roomOf,
      ),
    ).toBe("Sauna");
  });

  it("labels genuinely multi-room automations as mixed", () => {
    expect(
      automationGroup(
        [
          {
            actions: [
              { type: "device", deviceId: "terrace_lights" },
              { type: "room", room: "Balcony (6th)" },
            ],
          },
        ],
        roomOf,
      ),
    ).toBe(MIXED_GROUP);
  });

  it("a Whole House device spans rooms by definition — mixed, never 'Whole House'", () => {
    expect(
      automationGroup([{ actions: [{ type: "device", deviceId: "closets_strip" }] }], roomOf),
    ).toBe(MIXED_GROUP);
  });

  it("a room plus a scene still counts as that room", () => {
    expect(
      automationGroup(
        [{ actions: [{ type: "scene" }, { type: "room", room: "Terrace" }] }],
        roomOf,
      ),
    ).toBe("Terrace");
  });

  it("scene-only automations group under Scenes, unresolvable ones under Other", () => {
    expect(automationGroup([{ actions: [{ type: "scene" }] }], roomOf)).toBe(SCENES_GROUP);
    expect(
      automationGroup([{ actions: [{ type: "device", deviceId: "unknown" }] }], roomOf),
    ).toBe(OTHER_GROUP);
  });
});

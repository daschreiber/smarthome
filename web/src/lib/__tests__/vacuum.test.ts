import { describe, expect, it } from "vitest";
import { parseSegments } from "../vacuum";

const resp = {
  "vacuum.floor_6": {
    maps: [
      {
        flag: 0,
        name: "Floor 6",
        rooms: { "16": "Kitchen", "17": "Lounge", "18": "Entrance" },
      },
    ],
  },
};

describe("parseSegments", () => {
  it("extracts named segments sorted by name", () => {
    expect(parseSegments(resp, "vacuum.floor_6")).toEqual({
      map: "Floor 6",
      segments: [
        { id: 18, name: "Entrance" },
        { id: 16, name: "Kitchen" },
        { id: 17, name: "Lounge" },
      ],
    });
  });

  it("returns empty for the wrong entity, malformed input, or no maps", () => {
    expect(parseSegments(resp, "vacuum.den_floor_5").segments).toEqual([]);
    expect(parseSegments(null, "vacuum.floor_6").segments).toEqual([]);
    expect(parseSegments({ "vacuum.floor_6": { maps: [] } }, "vacuum.floor_6").segments).toEqual([]);
    expect(parseSegments("nonsense", "vacuum.floor_6").segments).toEqual([]);
  });

  it("tolerates non-string room names and non-numeric ids", () => {
    const odd = {
      "vacuum.floor_6": { maps: [{ rooms: { "16": 42, abc: "Weird", "17": "Den" } }] },
    };
    expect(parseSegments(odd, "vacuum.floor_6").segments).toEqual([
      { id: 17, name: "Den" },
      { id: 16, name: "Room 16" },
    ]);
  });
});

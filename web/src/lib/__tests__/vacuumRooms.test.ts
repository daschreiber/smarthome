import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applySegmentNames, segmentNames, setSegmentName } from "../vacuumRooms";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "vacuum-rooms-"));
  process.env.VACUUM_ROOMS_PATH = path.join(dir, "vacuum_rooms.json");
});

afterEach(() => {
  delete process.env.VACUUM_ROOMS_PATH;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("setSegmentName / segmentNames", () => {
  it("persists names per vacuum and clears them with null", () => {
    setSegmentName("vacuum.floor_6", 16, "Kitchen");
    setSegmentName("vacuum.floor_6", 17, "Lounge");
    setSegmentName("vacuum.den_floor_5", 16, "Den");
    expect(segmentNames("vacuum.floor_6")).toEqual({ "16": "Kitchen", "17": "Lounge" });
    expect(segmentNames("vacuum.den_floor_5")).toEqual({ "16": "Den" });

    setSegmentName("vacuum.floor_6", 17, null);
    expect(segmentNames("vacuum.floor_6")).toEqual({ "16": "Kitchen" });
  });

  it("returns empty when the store file does not exist", () => {
    expect(segmentNames("vacuum.floor_6")).toEqual({});
  });
});

describe("applySegmentNames", () => {
  const raw = [
    { id: 16, name: "Room 16" },
    { id: 21, name: "Room 21" },
    { id: 17, name: "Room 17" },
  ];

  it("overlays app names and sorts named rooms first, the rest by id", () => {
    setSegmentName("vacuum.floor_6", 21, "Kitchen");
    setSegmentName("vacuum.floor_6", 17, "Dining");
    expect(applySegmentNames(raw, "vacuum.floor_6")).toEqual([
      { id: 17, name: "Dining", named: true },
      { id: 21, name: "Kitchen", named: true },
      { id: 16, name: "Room 16", named: false },
    ]);
  });

  it("leaves everything numbered (by id) with no stored names", () => {
    expect(applySegmentNames(raw, "vacuum.floor_6")).toEqual([
      { id: 16, name: "Room 16", named: false },
      { id: 17, name: "Room 17", named: false },
      { id: 21, name: "Room 21", named: false },
    ]);
  });

  it("treats a segment named on the robot's own map as named", () => {
    const mixed = [
      { id: 16, name: "Room 16" },
      { id: 18, name: "Entrance" },
    ];
    expect(applySegmentNames(mixed, "vacuum.floor_6")).toEqual([
      { id: 18, name: "Entrance", named: true },
      { id: 16, name: "Room 16", named: false },
    ]);
  });

  it("keeps names scoped to their own vacuum", () => {
    setSegmentName("vacuum.den_floor_5", 16, "Gym");
    expect(applySegmentNames(raw, "vacuum.floor_6")[0]).toEqual({ id: 16, name: "Room 16", named: false });
  });
});

import { describe, expect, it } from "vitest";
import { FLOOR_PLANS, PLAN_VIEWBOX } from "../floorplan";
import { registry } from "../registry";

/**
 * The schematic is hand-traced, so these tests are the safety net that keeps
 * it honest against the entity map: every block must be a real room, every
 * room with visible devices must have a block, and blocks must not overlap.
 */

describe("floor plans", () => {
  const visible = registry().devices.filter((d) => d.visible && d.room && d.room !== "Whole House");

  for (const floor of [5, 6] as const) {
    it(`floor ${floor} covers exactly the rooms that exist`, () => {
      const planRooms = new Set(FLOOR_PLANS[floor].map((r) => r.room));
      const realRooms = new Set(visible.filter((d) => d.floor === floor).map((d) => d.room));
      expect([...planRooms].sort()).toEqual([...realRooms].sort());
    });

    it(`floor ${floor} blocks stay inside the viewBox and never overlap`, () => {
      const blocks = FLOOR_PLANS[floor];
      for (const b of blocks) {
        expect(b.x, b.room).toBeGreaterThanOrEqual(0);
        expect(b.y, b.room).toBeGreaterThanOrEqual(0);
        expect(b.x + b.w, b.room).toBeLessThanOrEqual(PLAN_VIEWBOX.w);
        expect(b.y + b.h, b.room).toBeLessThanOrEqual(PLAN_VIEWBOX.h);
      }
      for (let i = 0; i < blocks.length; i++) {
        for (let j = i + 1; j < blocks.length; j++) {
          const a = blocks[i], b = blocks[j];
          const overlap =
            a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
          expect(overlap, `${a.room} overlaps ${b.room}`).toBe(false);
        }
      }
    });
  }
});

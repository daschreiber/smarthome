import { describe, expect, it } from "vitest";
import { FLOOR_GEOMETRY, blockBounds } from "../floorplan";
import { registry } from "../registry";

/**
 * The plan is hand-measured from the drawings, so these tests keep it honest
 * against the entity map: every block must be a real room, every room with
 * visible devices must have a block, blocks stay inside the viewBox, and
 * blocks of DIFFERENT rooms never overlap (a room may have several blocks).
 */

describe("floor plans", () => {
  const visible = registry().devices.filter((d) => d.visible && d.room && d.room !== "Whole House");

  for (const floor of [5, 6] as const) {
    const geo = FLOOR_GEOMETRY[floor];

    it(`floor ${floor} covers exactly the rooms that exist`, () => {
      const planRooms = new Set(geo.rooms.map((r) => r.room));
      const realRooms = new Set(visible.filter((d) => d.floor === floor).map((d) => d.room));
      expect([...planRooms].sort()).toEqual([...realRooms].sort());
    });

    it(`floor ${floor} blocks are well-formed and stay inside the viewBox`, () => {
      for (const r of geo.rooms) {
        expect(Boolean(r.rect) !== Boolean(r.poly), `${r.room} needs exactly one of rect/poly`).toBe(true);
        const b = blockBounds(r);
        expect(b.x, r.room).toBeGreaterThanOrEqual(0);
        expect(b.y, r.room).toBeGreaterThanOrEqual(0);
        expect(b.x + b.w, r.room).toBeLessThanOrEqual(geo.viewBox.w);
        expect(b.y + b.h, r.room).toBeLessThanOrEqual(geo.viewBox.h);
      }
    });

    it(`floor ${floor} blocks of different rooms never overlap`, () => {
      // Real geometry, not bounding boxes: sample interior points of each
      // block and assert none falls inside another room's shape. Handles
      // polygons that legitimately wrap around a rect (master bedroom
      // around the utility room).
      const inPoly = (px: number, py: number, poly: Array<[number, number]>) => {
        let inside = false;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
          const [xi, yi] = poly[i], [xj, yj] = poly[j];
          if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
        }
        return inside;
      };
      const shapeOf = (r: (typeof geo.rooms)[number]): Array<[number, number]> =>
        r.poly ?? [
          [r.rect!.x, r.rect!.y],
          [r.rect!.x + r.rect!.w, r.rect!.y],
          [r.rect!.x + r.rect!.w, r.rect!.y + r.rect!.h],
          [r.rect!.x, r.rect!.y + r.rect!.h],
        ];
      const samplesOf = (r: (typeof geo.rooms)[number]): Array<[number, number]> => {
        const b = blockBounds(r);
        const shape = shapeOf(r);
        const pts: Array<[number, number]> = [];
        for (let ix = 1; ix <= 8; ix++) {
          for (let iy = 1; iy <= 8; iy++) {
            const px = b.x + (b.w * ix) / 9;
            const py = b.y + (b.h * iy) / 9;
            if (inPoly(px, py, shape)) pts.push([px, py]);
          }
        }
        return pts;
      };
      for (let i = 0; i < geo.rooms.length; i++) {
        for (let j = 0; j < geo.rooms.length; j++) {
          if (i === j || geo.rooms[i].room === geo.rooms[j].room) continue;
          const shapeB = shapeOf(geo.rooms[j]);
          const hit = samplesOf(geo.rooms[i]).some(([px, py]) => inPoly(px, py, shapeB));
          expect(hit, `${geo.rooms[i].room} overlaps ${geo.rooms[j].room}`).toBe(false);
        }
      }
    });
  }
});

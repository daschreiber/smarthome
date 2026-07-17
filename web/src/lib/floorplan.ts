/**
 * Floor plans measured from the family's carpentry drawings (1:50,
 * 26.08.2022) — wall positions were taken off a measuring grid overlaid on
 * the drawings, so proportions are ~to scale. Rooms tile the building
 * footprint edge-to-edge, museum-map style; the envelope polygon is the
 * exterior wall. Coordinates are viewBox units: x is 0-100, y preserves the
 * drawing's true aspect per floor (the floors have different footprints, so
 * each has its own viewBox height).
 *
 * A room may span multiple blocks (e.g. Entrance + its WC nook): repeat the
 * room name and mark extra blocks `unlabeled`. Angled walls use `poly`.
 *
 * Room names MUST match the canonical room names in entity_map.json —
 * floorplan.test.ts enforces this both ways.
 */

export interface PlanRoom {
  room: string;
  /** Short label for small blocks; falls back to the room name. */
  label?: string;
  /** Axis-aligned block… */
  rect?: { x: number; y: number; w: number; h: number };
  /** …or a polygon for angled walls. One of rect/poly is required. */
  poly?: Array<[number, number]>;
  /** Terraces and balconies render as outdoor space (dashed, lighter). */
  outdoor?: boolean;
  /** Secondary block of a room that appears more than once — no label. */
  unlabeled?: boolean;
  /**
   * Part of a physically continuous outdoor space: no divider strokes of its
   * own — the shared outline comes from the floor's outdoorUnions.
   */
  seamless?: boolean;
}

export interface FloorGeometry {
  viewBox: { w: number; h: number };
  /** Building footprint (exterior walls), drawn behind the rooms. */
  envelope: Array<Array<[number, number]>>;
  /** Dashed outlines drawn around continuous outdoor spaces (see seamless). */
  outdoorUnions?: Array<Array<[number, number]>>;
  rooms: PlanRoom[];
}

export const FLOOR_GEOMETRY: Record<5 | 6, FloorGeometry> = {
  // ---- Floor 6 (penthouse). Wide floor: lounge west, stair core + dining
  // center, kitchen, then the master suite east — corridor along the top,
  // walk-in closet below it, bath, and the bedroom against the angled
  // facade. The utility room runs to the outer (angled) wall. One
  // continuous outdoor strip spans the whole south face: dining furniture
  // on the terrace (west), lounge furniture on the balcony (east), the
  // master's stretch at the far east — no physical divisions.
  // y = drawing-% × 0.563 (true aspect).
  6: {
    viewBox: { w: 100, h: 53 },
    envelope: [
      [
        [3, 11.3], [16, 11.3], [16, 5.6], [27, 5.6], [27, 1.1], [68, 1.1],
        [68, 5.6], [85, 5.6], [91, 32.6], [3, 32.6],
      ],
    ],
    outdoorUnions: [
      [[3, 33.4], [91.2, 33.4], [93, 51.8], [3, 51.8]],
    ],
    rooms: [
      { room: "Entrance", rect: { x: 16, y: 5.6, w: 24, h: 5.7 } },
      { room: "Entrance", rect: { x: 27, y: 1.1, w: 11, h: 4.5 }, unlabeled: true }, // guest WC nook
      { room: "Lounge", rect: { x: 3, y: 11.3, w: 18, h: 21.3 } },
      // x21-40 above dining is the stair core — footprint, not a room.
      { room: "Dining", rect: { x: 21, y: 18.6, w: 19, h: 14 } },
      { room: "Kitchen", rect: { x: 40, y: 5.6, w: 12, h: 27 } },
      { room: "Master Corridor", label: "Corridor", rect: { x: 52, y: 5.6, w: 18, h: 5.7 } },
      // The walk-in closet is its own room on the drawing (ארונות); its
      // devices live under Master Corridor in the entity map.
      { room: "Master Corridor", label: "Closet", rect: { x: 52, y: 11.3, w: 14, h: 7.3 } },
      { room: "Master Bathroom", label: "Bath", rect: { x: 52, y: 18.6, w: 14, h: 14 } },
      {
        room: "Utility Room",
        label: "Utility",
        poly: [[70, 5.6], [85, 5.6], [87.6, 17.4], [70, 17.4]],
      },
      {
        room: "Master Bedroom",
        label: "Master",
        poly: [
          [66, 11.3], [70, 11.3], [70, 17.4], [87.6, 17.4], [91, 32.6],
          [66, 32.6], [66, 18.6],
        ],
      },
      { room: "Terrace", rect: { x: 3, y: 33.4, w: 59, h: 18.4 }, outdoor: true, seamless: true },
      {
        room: "Balcony (6th)",
        label: "Balcony",
        rect: { x: 62, y: 33.4, w: 22, h: 18.4 },
        outdoor: true,
        seamless: true,
      },
      {
        room: "Master Bedroom Balcony",
        poly: [[84, 33.4], [91.2, 33.4], [93, 51.8], [84, 51.8]],
        outdoor: true,
        seamless: true,
        unlabeled: true,
      },
    ],
  },

  // ---- Floor 5. Studies and stair core north, den center, guest wing
  // west/south (Large juts out below the main body), Daniel + Medium guest
  // east, gym + sauna north-east. y = drawing-% × 0.767 (true aspect).
  5: {
    viewBox: { w: 100, h: 74 },
    envelope: [
      [
        [5, 4.6], [95, 4.6], [95, 53.7], [30, 53.7], [30, 71.3], [5, 71.3],
      ],
    ],
    rooms: [
      { room: "Daniella's Study", label: "Daniella", rect: { x: 5, y: 4.6, w: 24, h: 19.9 } },
      { room: "Stairs & Landing", label: "Stairs", rect: { x: 29, y: 4.6, w: 31, h: 20.7 } },
      { room: "Gym", rect: { x: 60, y: 4.6, w: 15, h: 18.4 } },
      { room: "Sauna", rect: { x: 75, y: 4.6, w: 20, h: 15.3 } },
      { room: "Downstairs Toilet", label: "WC", rect: { x: 81, y: 19.9, w: 14, h: 12.3 } },
      { room: "Right Corridor", label: "Corridor", rect: { x: 62, y: 23, w: 19, h: 9.2 } },
      { room: "Left Corridor", label: "Corr.", rect: { x: 24, y: 24.5, w: 5, h: 13.9 } },
      { room: "Guest Bathroom", label: "Bath", rect: { x: 5, y: 24.5, w: 19, h: 13.9 } },
      { room: "Den", rect: { x: 29, y: 25.3, w: 24, h: 28.4 } },
      { room: "Small Guest Room", label: "Guest S", rect: { x: 5, y: 38.4, w: 19, h: 15.3 } },
      { room: "Daniel's Study", label: "Daniel", rect: { x: 53, y: 32.2, w: 22, h: 21.5 } },
      { room: "Medium Guest Room", label: "Guest M", rect: { x: 75, y: 32.2, w: 20, h: 21.5 } },
      { room: "Large Guest Room", label: "Guest L", rect: { x: 5, y: 53.7, w: 25, h: 17.6 } },
      { room: "Balcony (5th)", label: "Balcony", rect: { x: 30, y: 55.2, w: 65, h: 8.4 }, outdoor: true },
    ],
  },
};

/** Bounding box of a room block, for labels and tests. */
export function blockBounds(r: PlanRoom): { x: number; y: number; w: number; h: number } {
  if (r.rect) return r.rect;
  const xs = r.poly!.map((p) => p[0]);
  const ys = r.poly!.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/**
 * Stylized floor plans traced from the family's carpentry drawings
 * (5th/6th floor plans, 26.08.2022). Deliberately schematic: proportional
 * blocks in the right arrangement, not architecture. Coordinates are in a
 * 100x62 viewBox, north up, matching the drawings' orientation.
 *
 * Room names MUST match the canonical room names in entity_map.json —
 * floorplan.test.ts enforces this both ways.
 */

export interface PlanRoom {
  room: string;
  /** Short label for small blocks; falls back to the room name. */
  label?: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export const PLAN_VIEWBOX = { w: 100, h: 62 };

export const FLOOR_PLANS: Record<5 | 6, PlanRoom[]> = {
  6: [
    { room: "Entrance", x: 2, y: 2, w: 22, h: 10 },
    { room: "Lounge", x: 2, y: 14, w: 22, h: 36 },
    { room: "Dining", x: 26, y: 20, w: 20, h: 30 },
    { room: "Kitchen", x: 48, y: 10, w: 16, h: 40 },
    { room: "Utility Room", label: "Utility", x: 66, y: 2, w: 14, h: 10 },
    { room: "Master Corridor", label: "Corridor", x: 66, y: 14, w: 12, h: 12 },
    { room: "Master Bathroom", label: "Bath", x: 66, y: 28, w: 12, h: 22 },
    { room: "Master Bedroom", label: "Master", x: 80, y: 14, w: 18, h: 28 },
    { room: "Master Bedroom Balcony", label: "Balcony", x: 80, y: 44, w: 18, h: 6 },
    { room: "Terrace", x: 2, y: 52, w: 64, h: 8 },
    { room: "Balcony (6th)", label: "Balcony", x: 68, y: 52, w: 30, h: 8 },
  ],
  5: [
    { room: "Daniella's Study", label: "Daniella", x: 2, y: 2, w: 20, h: 18 },
    { room: "Stairs & Landing", label: "Stairs", x: 24, y: 2, w: 20, h: 18 },
    { room: "Gym", x: 46, y: 2, w: 14, h: 16 },
    { room: "Sauna", x: 62, y: 2, w: 16, h: 12 },
    { room: "Downstairs Toilet", label: "WC", x: 80, y: 2, w: 16, h: 12 },
    { room: "Guest Bathroom", label: "Bath", x: 2, y: 22, w: 16, h: 12 },
    { room: "Left Corridor", label: "Corr.", x: 20, y: 22, w: 6, h: 28 },
    { room: "Den", x: 28, y: 22, w: 24, h: 24 },
    { room: "Right Corridor", label: "Corr.", x: 62, y: 16, w: 16, h: 10 },
    { room: "Daniel's Study", label: "Daniel", x: 52, y: 28, w: 18, h: 22 },
    { room: "Large Guest Room", label: "Guest L", x: 72, y: 28, w: 26, h: 22 },
    { room: "Medium Guest Room", label: "Guest M", x: 2, y: 36, w: 18, h: 14 },
    { room: "Small Guest Room", label: "Guest S", x: 20, y: 52, w: 18, h: 8 },
    { room: "Balcony (5th)", label: "Balcony", x: 40, y: 52, w: 58, h: 8 },
  ],
};

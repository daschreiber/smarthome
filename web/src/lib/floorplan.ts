/**
 * Stylized floor plans traced from the family's carpentry drawings
 * (5th/6th floor plans, 26.08.2022). Deliberately schematic: proportional
 * blocks in the right arrangement, not architecture. Coordinates are in a
 * 100x70 viewBox, north up, matching the drawings' orientation.
 *
 * Guest room placement (owner-confirmed): LARGE is the room that juts out
 * at the bottom-left below the main body, SMALL is the left-middle room,
 * MEDIUM is the bottom-right room by the right corridor.
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
  /** Terraces and balconies render as outdoor space (dashed, lighter). */
  outdoor?: boolean;
}

export const PLAN_VIEWBOX = { w: 100, h: 70 };

/** Building footprint drawn behind the rooms, so the shape reads as a floor. */
export const FLOOR_OUTLINES: Record<5 | 6, Array<{ x: number; y: number; w: number; h: number }>> = {
  6: [{ x: 0, y: 0, w: 100, h: 46 }],
  5: [
    { x: 0, y: 0, w: 100, h: 53 },
    { x: 0, y: 53, w: 30, h: 17 }, // the large guest room juts out below
  ],
};

export const FLOOR_PLANS: Record<5 | 6, PlanRoom[]> = {
  6: [
    // West wing: entrance hall over the lounge.
    { room: "Entrance", x: 2, y: 2, w: 22, h: 10 },
    { room: "Lounge", x: 2, y: 14, w: 22, h: 30 },
    // Center: stair core (top, unassigned gap), dining below it, then kitchen.
    { room: "Dining", x: 26, y: 16, w: 18, h: 28 },
    { room: "Kitchen", x: 46, y: 8, w: 16, h: 36 },
    // East wing: service room top-right, corridor + bathroom feeding the
    // master bedroom on the corner.
    { room: "Master Corridor", label: "Corridor", x: 64, y: 8, w: 12, h: 14 },
    { room: "Master Bathroom", label: "Bath", x: 64, y: 24, w: 12, h: 20 },
    { room: "Utility Room", label: "Utility", x: 78, y: 2, w: 20, h: 10 },
    { room: "Master Bedroom", label: "Master", x: 78, y: 14, w: 20, h: 30 },
    // Outdoors: the terrace runs the full south face; the master's balcony
    // and the seating balcony wrap the south-east corner.
    { room: "Master Bedroom Balcony", label: "Balcony", x: 78, y: 46, w: 20, h: 6, outdoor: true },
    { room: "Terrace", x: 2, y: 48, w: 74, h: 14, outdoor: true },
    { room: "Balcony (6th)", label: "Balcony", x: 78, y: 54, w: 20, h: 8, outdoor: true },
  ],
  5: [
    // North row: Daniella's study, stair core, gym, sauna.
    { room: "Daniella's Study", label: "Daniella", x: 2, y: 2, w: 24, h: 20 },
    { room: "Stairs & Landing", label: "Stairs", x: 36, y: 2, w: 18, h: 16 },
    { room: "Gym", x: 56, y: 2, w: 16, h: 16 },
    { room: "Sauna", x: 78, y: 2, w: 20, h: 12 },
    { room: "Downstairs Toilet", label: "WC", x: 82, y: 16, w: 16, h: 10 },
    // The long corridor from the entrance down the west side.
    { room: "Left Corridor", label: "Corr.", x: 28, y: 2, w: 6, h: 49 },
    { room: "Right Corridor", label: "Corr.", x: 56, y: 20, w: 16, h: 8 },
    // West side: guest bathroom, then the SMALL guest room.
    { room: "Guest Bathroom", label: "Bath", x: 2, y: 24, w: 14, h: 12 },
    { room: "Small Guest Room", label: "Guest S", x: 2, y: 38, w: 16, h: 13 },
    // Center and east: den, Daniel's study, MEDIUM guest room.
    { room: "Den", x: 36, y: 20, w: 18, h: 31 },
    { room: "Daniel's Study", label: "Daniel", x: 56, y: 30, w: 16, h: 21 },
    { room: "Medium Guest Room", label: "Guest M", x: 74, y: 30, w: 24, h: 21 },
    // South: the LARGE guest room juts out below the main body; the balcony
    // runs along the rest of the south face.
    { room: "Large Guest Room", label: "Guest L", x: 2, y: 53, w: 26, h: 15 },
    { room: "Balcony (5th)", label: "Balcony", x: 30, y: 53, w: 68, h: 11, outdoor: true },
  ],
};

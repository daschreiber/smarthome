import type { Command } from "./commands";
import type { Device } from "./registry";

/**
 * Client-safe command vocabulary and limits (no Node imports, types only
 * from the server modules). The server enforces these; the UI imports the
 * same values so its forms can't drift from what the API accepts.
 */

/**
 * House-wide systems (the /systems screens). Membership is intentionally
 * narrow: "lighting" is real lights only (group Lighting — fans, vents, and
 * towel rails ride the light domain but are NOT lights), "climate" is A/C
 * zones only (never the sauna), "shades" is every cover.
 */
export type SystemKey = "lighting" | "climate" | "heating" | "shades";

export const SYSTEM_COMMANDS: Record<SystemKey, Command["command"][]> = {
  lighting: ["turn_on", "turn_off", "set_brightness"],
  climate: ["turn_on", "turn_off"],
  heating: ["turn_on", "turn_off"],
  shades: ["open", "close", "stop"],
};

/** Per-kind safe set-point ranges (°C), enforced server-side. */
export function temperatureBounds(kind: Device["kind"]): { min: number; max: number } {
  switch (kind) {
    case "sauna":
      return { min: 40, max: 100 }; // matches the KLAFS app's own clamp
    default:
      return { min: 10, max: 32 };
  }
}

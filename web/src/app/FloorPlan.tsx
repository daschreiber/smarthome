"use client";

import { FLOOR_OUTLINES, FLOOR_PLANS, PLAN_VIEWBOX } from "@/lib/floorplan";

/**
 * Clickable schematic of a floor. Each block is a room: tap to open it,
 * tinted when lights are on, with a temperature note where a climate zone
 * is active. Outdoor areas (terrace, balconies) render dashed and lighter.
 * A status surface first, navigation second.
 */

export interface PlanRoomState {
  lightsOn: number;
  total: number;
  climate: { currentTemperature: number | null; state: string; available: boolean } | null;
}

export default function FloorPlan({
  floor,
  rooms,
  onOpen,
}: {
  floor: 5 | 6;
  rooms: Map<string, PlanRoomState>;
  onOpen: (room: string) => void;
}) {
  return (
    <svg
      viewBox={`0 0 ${PLAN_VIEWBOX.w} ${PLAN_VIEWBOX.h}`}
      style={{ width: "100%", height: "auto", display: "block" }}
      role="group"
      aria-label={`Floor ${floor} plan`}
    >
      {/* Building footprint behind the rooms, so the floor reads as a shape. */}
      {FLOOR_OUTLINES[floor].map((o, i) => (
        <rect
          key={i}
          x={o.x}
          y={o.y}
          width={o.w}
          height={o.h}
          rx={2.5}
          fill="var(--chip)"
          opacity={0.45}
        />
      ))}
      {FLOOR_PLANS[floor].map((r) => {
        const st = rooms.get(r.room);
        const lit = (st?.lightsOn ?? 0) > 0;
        const climateActive =
          st?.climate != null && st.climate.available && st.climate.state !== "off" && st.climate.state !== "unavailable";
        const small = r.h < 10 || r.w < 12;
        // Narrow-but-tall blocks (corridors) get a vertically rotated label.
        const rotated = r.w < 9 && r.h > r.w;
        const label = r.label ?? r.room;
        const sub = lit
          ? `${st!.lightsOn} on`
          : climateActive && st!.climate!.currentTemperature != null
            ? `${st!.climate!.currentTemperature}°`
            : null;
        return (
          <g
            key={r.room}
            role="button"
            aria-label={`${r.room}${lit ? `, ${st!.lightsOn} lights on` : ""}`}
            onClick={() => onOpen(r.room)}
            style={{ cursor: "pointer" }}
          >
            <rect
              x={r.x}
              y={r.y}
              width={r.w}
              height={r.h}
              rx={1.8}
              fill={lit ? "color-mix(in srgb, var(--active) 22%, var(--card))" : "var(--card)"}
              fillOpacity={r.outdoor && !lit ? 0.55 : 1}
              stroke={lit ? "var(--active)" : "var(--card-line)"}
              strokeWidth={0.35}
              strokeDasharray={r.outdoor ? "1.7 1.1" : undefined}
            />
            <text
              x={r.x + r.w / 2}
              y={r.y + r.h / 2 + (sub && !small ? -1.2 : 1.1)}
              textAnchor="middle"
              transform={rotated ? `rotate(90 ${r.x + r.w / 2} ${r.y + r.h / 2})` : undefined}
              style={{
                fill: r.outdoor && !lit ? "var(--dim)" : "var(--ink)",
                fontSize: small ? 2.6 : 3,
                fontWeight: 600,
                fontFamily: "var(--font)",
              }}
            >
              {label}
            </text>
            {sub && !small && (
              <text
                x={r.x + r.w / 2}
                y={r.y + r.h / 2 + 2.8}
                textAnchor="middle"
                style={{ fill: lit ? "var(--active)" : "var(--dim)", fontSize: 2.4, fontFamily: "var(--font)" }}
              >
                {sub}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

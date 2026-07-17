"use client";

import { FLOOR_GEOMETRY, blockBounds, type PlanRoom } from "@/lib/floorplan";

/**
 * Clickable floor plan, measured from the real drawings (see lib/floorplan).
 * Museum-map rendering: the envelope polygon is the exterior wall, rooms
 * tile it edge-to-edge and are separated by background-colored gaps that
 * read as walls. Lit rooms tint amber; outdoor areas render dashed.
 */

export interface PlanRoomState {
  lightsOn: number;
  total: number;
  climate: { currentTemperature: number | null; state: string; available: boolean } | null;
}

function pathOf(points: Array<[number, number]>): string {
  return `M${points.map((p) => p.join(",")).join("L")}Z`;
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
  const geo = FLOOR_GEOMETRY[floor];
  return (
    <svg
      viewBox={`0 0 ${geo.viewBox.w} ${geo.viewBox.h}`}
      style={{ width: "100%", height: "auto", display: "block" }}
      role="group"
      aria-label={`Floor ${floor} plan`}
    >
      {/* Exterior wall: footprint fill plus a heavier outline. */}
      {geo.envelope.map((poly, i) => (
        <path
          key={i}
          d={pathOf(poly)}
          fill="var(--chip)"
          opacity={0.6}
          stroke="var(--dim)"
          strokeWidth={0.7}
          strokeLinejoin="round"
        />
      ))}
      {geo.rooms.map((r, i) => (
        <Block key={`${r.room}-${i}`} r={r} st={rooms.get(r.room)} onOpen={onOpen} />
      ))}
      {/* One dashed outline around each physically continuous outdoor space. */}
      {(geo.outdoorUnions ?? []).map((poly, i) => (
        <path
          key={`union-${i}`}
          d={pathOf(poly)}
          fill="none"
          stroke="var(--card-line)"
          strokeWidth={0.5}
          strokeDasharray="1.6 1"
          strokeLinejoin="round"
          pointerEvents="none"
        />
      ))}
    </svg>
  );
}

function Block({
  r,
  st,
  onOpen,
}: {
  r: PlanRoom;
  st: PlanRoomState | undefined;
  onOpen: (room: string) => void;
}) {
  const lit = (st?.lightsOn ?? 0) > 0;
  const climateActive =
    st?.climate != null && st.climate.available && st.climate.state !== "off" && st.climate.state !== "unavailable";
  const b = blockBounds(r);
  const small = b.h < 8 || b.w < 11;
  // Narrow-but-tall blocks (corridors, the balcony wedge) rotate their label.
  const rotated = b.w < 9 && b.h > b.w;
  const label = r.label ?? r.room;
  const sub = lit
    ? `${st!.lightsOn} on`
    : climateActive && st!.climate!.currentTemperature != null
      ? `${st!.climate!.currentTemperature}°`
      : null;
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;

  // Seamless blocks are parts of one continuous space: no divider strokes,
  // the shared dashed outline is drawn by the floor's outdoorUnions.
  const stroke = r.seamless ? "none" : "var(--bg)";
  const dashes = r.outdoor && !r.seamless ? "1.6 1" : undefined;
  const fill = lit ? "color-mix(in srgb, var(--active) 24%, var(--card))" : "var(--card)";
  const shape = r.poly ? (
    <path
      d={pathOf(r.poly)}
      fill={fill}
      fillOpacity={r.outdoor && !lit ? 0.5 : 1}
      stroke={stroke}
      strokeWidth={0.7}
      strokeLinejoin="round"
      strokeDasharray={dashes}
    />
  ) : (
    <rect
      x={r.rect!.x}
      y={r.rect!.y}
      width={r.rect!.w}
      height={r.rect!.h}
      fill={fill}
      fillOpacity={r.outdoor && !lit ? 0.5 : 1}
      stroke={stroke}
      strokeWidth={0.7}
      strokeDasharray={dashes}
    />
  );

  return (
    <g
      role="button"
      aria-label={`${r.room}${lit ? `, ${st!.lightsOn} lights on` : ""}`}
      onClick={() => onOpen(r.room)}
      style={{ cursor: "pointer" }}
    >
      {shape}
      {!r.unlabeled && (
        <>
          <text
            className="plan-label"
            x={cx}
            y={cy + (sub && !small ? -1.1 : 1)}
            textAnchor="middle"
            transform={rotated ? `rotate(90 ${cx} ${cy})` : undefined}
            style={{
              fill: r.outdoor && !lit ? "var(--dim)" : "var(--ink)",
              fontSize: small ? 2.4 : 2.9,
              fontWeight: 600,
              fontFamily: "var(--font)",
            }}
          >
            {label}
          </text>
          {sub && !small && (
            <text
              className="plan-sub"
              x={cx}
              y={cy + 2.6}
              textAnchor="middle"
              style={{ fill: lit ? "var(--active)" : "var(--dim)", fontSize: 2.2, fontFamily: "var(--font)" }}
            >
              {sub}
            </text>
          )}
        </>
      )}
    </g>
  );
}

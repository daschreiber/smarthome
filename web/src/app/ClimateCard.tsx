"use client";

import { useRef, useState } from "react";

/**
 * The one climate control, shared by the room view and Systems → Climate so
 * a zone reads and drives identically everywhere: quiet room reading, a Set
 * target with −/+ steppers (visible only while the zone runs), a true On|Off
 * state segment, and the fan chips. The structural device type keeps this
 * page-agnostic — both pages' /api/home shapes satisfy it.
 */

export interface ClimateDeviceShape {
  id: string;
  label: string;
  available: boolean;
  currentTemperature: number | null;
  targetTemperature: number | null;
  hvacMode: string | null;
  fanSpeed?: string | null;
  fanSpeedList?: string[] | null;
}

export default function ClimateCard({
  d, title, hero = false, flashCls = "", busy, send, star,
}: {
  d: ClimateDeviceShape;
  /** Card heading (the room name on the Systems page); the room view omits
   *  it — there the surrounding section already names the room. */
  title?: string;
  /** Full-width primary-card styling (the room view); off in dense lists. */
  hero?: boolean;
  flashCls?: string;
  busy: boolean;
  send: (id: string, body: Record<string, unknown>) => Promise<{ ok: boolean }>;
  star?: React.ReactNode;
}) {
  const [target, setTarget] = useState<number | null>(null);
  // The KNX side doesn't reliably echo the setpoint back (reports 0), so
  // remember the last target we sent: the thermostat aligns to it, and the
  // card must keep saying so. HA's echo still wins whenever it reports one.
  const [committed, setCommitted] = useState<number | null>(null);
  const known =
    d.targetTemperature != null && d.targetTemperature >= 10 ? d.targetTemperature : null;
  // With no setpoint at all, start stepping from the room's actual temperature.
  const seed =
    d.currentTemperature != null
      ? Math.min(32, Math.max(10, Math.round(d.currentTemperature * 2) / 2))
      : 24;
  const shown = target ?? known ?? committed ?? seed;
  const hasTarget = target != null || known != null || committed != null;
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const step = (delta: number) => {
    const next = Math.min(32, Math.max(10, Math.round((shown + delta) * 2) / 2));
    setTarget(next);
    if (commitTimer.current) clearTimeout(commitTimer.current);
    commitTimer.current = setTimeout(() => {
      send(d.id, { command: "set_temperature", temperature: next }).then((r) => {
        if (r.ok) setCommitted(next);
        setTarget(null);
      });
    }, 900);
  };

  const active = d.hvacMode != null && d.hvacMode !== "off";
  const pretty = (s: string) => (s.charAt(0).toUpperCase() + s.slice(1)).replace(/_/g, " ");
  // The card answers "how warm is it / what did I ask for": both numbers are
  // labelled, and the setpoint row only exists while the zone runs — when it's
  // off the On|Off segment is the whole story, so a second "off" and a stale
  // target would just be noise.
  return (
    <div className={`climate-card ${hero ? "hero" : ""} ${active ? "on" : ""} ${flashCls} ${d.available ? "" : "unavailable"}`}>
      <div className="climate-main">
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          {star}
          <div>
            {title && <div className="nm">{title}</div>}
            {/* Owner's call: the room reading is context, not the hero —
                quiet and grey; no mode pill (the tinted card + On segment
                already say "running", and the fan row implies the mode). */}
            <div className="now-quiet">
              Room {d.currentTemperature != null ? `${d.currentTemperature}°` : "—"}
            </div>
            {!d.available && <div className="mode">unavailable</div>}
          </div>
        </div>
        <div className="climate-set">
          {active && (
            <>
              <button className="round-btn" disabled={busy || !d.available} onClick={() => step(-0.5)} aria-label={`Lower ${title ?? d.label} target`}>−</button>
              <div>
                <div className="temp-lbl" style={{ textAlign: "center" }}>Set</div>
                <div className="target">{hasTarget ? `${shown}°` : "—"}</div>
              </div>
              <button className="round-btn" disabled={busy || !d.available} onClick={() => step(0.5)} aria-label={`Raise ${title ?? d.label} target`}>+</button>
            </>
          )}
          <div className="onoff" role="group" aria-label={`${title ?? d.label} power`}>
            <button
              aria-pressed={active}
              disabled={busy || !d.available}
              onClick={() => { if (!active) send(d.id, { command: "turn_on" }); }}
            >
              On
            </button>
            <button
              aria-pressed={!active}
              disabled={busy || !d.available}
              onClick={() => { if (active) send(d.id, { command: "turn_off" }); }}
            >
              Off
            </button>
          </div>
        </div>
      </div>
      {active && d.fanSpeedList && d.fanSpeedList.length > 0 && (
        <div className="climate-fan" role="group" aria-label={`${title ?? d.label} fan strength`}>
          <span className="st">Fan</span>
          {d.fanSpeedList.map((f) => (
            <button
              key={f}
              className="fan-chip"
              aria-pressed={d.fanSpeed === f}
              disabled={busy}
              onClick={() => { if (d.fanSpeed !== f) send(d.id, { command: "set_fan_mode", fanMode: f }); }}
            >
              {pretty(f)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

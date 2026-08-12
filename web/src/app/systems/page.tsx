"use client";

import { useCallback, useEffect, useState } from "react";
import NavBar from "../NavBar";
import { appKeyHeaders } from "@/lib/appKey";
import { BlindsIcon, BulbIcon, FlameIcon, SnowIcon } from "../icons";

/** Systems index: one card per house-wide function, with live counts. */

interface UiDevice {
  kind: string;
  group: string;
  category: string;
  state: string;
  available: boolean;
}

export default function Systems() {
  const [devices, setDevices] = useState<UiDevice[]>([]);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/home", { headers: appKeyHeaders() });
      if (res.status === 401) { location.href = "/"; return; }
      if (res.ok) setDevices(((await res.json()) as { devices: UiDevice[] }).devices);
    } catch { /* next poll */ }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  const lights = devices.filter((d) => d.kind === "light" && d.group === "Lighting");
  const lightsOn = lights.filter((d) => d.state === "on").length;
  // "all off" is a claim about every light — unreachable lights break it
  // (the power-outage lesson, 2026-08-12): name them instead.
  const lightsDown = lights.filter((d) => !d.available).length;
  const lightsSub =
    lightsDown === lights.length && lights.length > 0
      ? "not responding"
      : (lightsOn > 0 ? `${lightsOn} on` : "all off") +
        (lightsDown > 0 ? ` · ${lightsDown} not responding` : "");
  const zonesOn = devices.filter(
    (d) => d.kind === "climate" && d.available && d.state !== "off" && d.state !== "unavailable",
  ).length;
  // Count only — C4 cover state is permanently "open" (broken feedback).
  const shadesTotal = devices.filter((d) => d.kind === "cover").length;
  const heatingOn = devices.filter((d) => d.kind === "heating" && d.state === "on").length;

  const cards = [
    { href: "/systems/lighting", icon: BulbIcon, title: "Lighting", sub: lightsSub, on: lightsOn > 0 },
    { href: "/systems/climate", icon: SnowIcon, title: "Climate", sub: zonesOn > 0 ? `${zonesOn} zone${zonesOn === 1 ? "" : "s"} active` : "all off", on: zonesOn > 0 },
    { href: "/systems/heating", icon: FlameIcon, title: "Underfloor heating", sub: heatingOn > 0 ? `${heatingOn} room${heatingOn === 1 ? "" : "s"} heating` : "all off", on: heatingOn > 0 },
    { href: "/systems/shades", icon: BlindsIcon, title: "Shades", sub: `${shadesTotal} shade${shadesTotal === 1 ? "" : "s"}`, on: false },
  ];

  return (
    <main className="shell">
      <h1 className="h-title">Systems</h1>
      <p className="h-sub">One function across the whole house.</p>
      <div className="dev-list">
        {cards.map((c) => (
          <a key={c.href} href={c.href} className="dev" style={{ textDecoration: "none", color: "inherit" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ color: c.on ? "var(--active)" : "var(--dim)", display: "flex" }}><c.icon size={26} /></span>
              <div>
                <div className="nm">{c.title}</div>
                <div className={`st ${c.on ? "on" : ""}`}>{c.sub}</div>
              </div>
            </div>
            <span style={{ color: "var(--dim)", fontSize: 18 }}>›</span>
          </a>
        ))}
      </div>
      <NavBar />
    </main>
  );
}

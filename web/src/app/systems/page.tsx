"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import NavBar from "../NavBar";
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
  const keyRef = useRef("");

  useEffect(() => {
    keyRef.current = localStorage.getItem("appKey") ?? "";
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/home", {
        headers: /^[\x21-\x7e]+$/.test(keyRef.current.trim()) && keyRef.current.trim() ? { "x-app-key": keyRef.current.trim() } : {},
      });
      if (res.status === 401) { location.href = "/"; return; }
      if (res.ok) setDevices(((await res.json()) as { devices: UiDevice[] }).devices);
    } catch { /* next poll */ }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  const lightsOn = devices.filter((d) => d.kind === "light" && d.group === "Lighting" && d.state === "on").length;
  const zonesOn = devices.filter(
    (d) => d.kind === "climate" && d.available && d.state !== "off" && d.state !== "unavailable",
  ).length;
  // Count only — C4 cover state is permanently "open" (broken feedback).
  const shadesTotal = devices.filter((d) => d.kind === "cover").length;
  const heatingOn = devices.filter((d) => d.kind === "heating" && d.state === "on").length;

  const cards = [
    { href: "/systems/lighting", icon: BulbIcon, title: "Lighting", sub: lightsOn > 0 ? `${lightsOn} on` : "all off", on: lightsOn > 0 },
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

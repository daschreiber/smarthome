"use client";

import NavBar from "../NavBar";
import { useEffect, useState } from "react";
import { appKeyHeaders } from "@/lib/appKey";

interface Ev {
  ts: string;
  user?: string;
  deviceId: string;
  command: string;
  args: Record<string, unknown>;
  ok: boolean;
  durationMs: number;
  error?: string;
  resultState?: string;
  /** Security-tier device (door locks) — rendered with a distinct badge. */
  security?: boolean;
}

export default function Activity() {
  const [events, setEvents] = useState<Ev[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/activity", { headers: appKeyHeaders() })
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json()).error ?? `HTTP ${r.status}`);
        return r.json();
      })
      .then((b) => setEvents(b.events))
      .catch((e) => setError(e instanceof Error ? e.message : "failed"));
  }, []);

  return (
    <main className="shell">
      <a className="h-back" href="/more">‹ More</a>
      <h1 className="h-title">Activity</h1>
      <p className="h-sub">
        Every command the app has issued, newest first. In the app, a green flash means the change
        was confirmed by the house; amber means sent and awaiting KNX feedback.
      </p>
      {error && <div className="error-banner">{error}</div>}
      {events.map((e, i) => (
        <div key={i} className="dev" style={{ alignItems: "flex-start" }}>
          <div>
            <div className="nm">
              {e.security && (
                <span style={{ color: "var(--danger)", fontWeight: 700, marginRight: 6 }}>SECURITY</span>
              )}
              {e.command.replace(/_/g, " ")} · {e.deviceId.split("__").pop()?.replace(/_/g, " ")}
            </div>
            <div className="st" style={{ fontVariantNumeric: "tabular-nums" }}>
              {new Date(e.ts).toLocaleString()} · {e.user ?? "unknown"} ·{" "}
              {(e.durationMs / 1000).toFixed(1)}s
              {e.resultState ? ` · ${e.resultState}` : ""}
              {e.error ? ` · ${e.error}` : ""}
            </div>
          </div>
          <span className="st" style={{ color: e.ok ? "var(--accent)" : "var(--danger)", fontWeight: 700 }}>
            {e.ok ? "OK" : "FAILED"}
          </span>
        </div>
      ))}
      {events.length === 0 && !error && <p className="h-sub">No commands recorded yet.</p>}
      <NavBar />
    </main>
  );
}

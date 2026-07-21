"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import NavBar from "../NavBar";
import { KeyIcon, PulseIcon, SignOutIcon, UsersIcon } from "../icons";

/** Everything that isn't day-to-day control: audit trail, users, session. */

export default function More() {
  const [role, setRole] = useState<string | null>(null);
  const [appKey, setAppKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const keyRef = useRef("");

  useEffect(() => {
    const k = localStorage.getItem("appKey") ?? "";
    setAppKey(k);
    keyRef.current = k;
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/home", {
        headers: keyRef.current ? { "x-app-key": keyRef.current } : {},
      });
      if (res.status === 401) { location.href = "/"; return; }
      if (res.ok) setRole(((await res.json()) as { role?: string }).role ?? null);
    } catch { /* non-critical */ }
  }, []);

  useEffect(() => { load(); }, [load]);

  const row = (
    icon: React.ReactNode,
    title: string,
    sub: string,
    props: React.AnchorHTMLAttributes<HTMLAnchorElement> & { onClick?: () => void },
  ) => (
    <a
      className="dev"
      style={{ textDecoration: "none", color: "inherit", cursor: "pointer" }}
      {...props}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span style={{ color: "var(--dim)", display: "flex" }}>{icon}</span>
        <div>
          <div className="nm">{title}</div>
          <div className="st">{sub}</div>
        </div>
      </div>
      <span style={{ color: "var(--dim)", fontSize: 18 }}>›</span>
    </a>
  );

  return (
    <main className="shell">
      <h1 className="h-title">More</h1>
      <p className="h-sub">History, people, and account.</p>
      <div className="dev-list">
        {role === "admin" && row(<PulseIcon size={24} />, "Activity", "Every command the app has issued", { href: "/activity" })}
        {role === "admin" && row(<UsersIcon size={24} />, "Users", "Who can sign in, and with what role", { href: "/users" })}
        {role === "admin" && row(<KeyIcon size={24} />, "App key", showKey ? "Set below" : "Only needed if APP_KEY is set", {
          onClick: (e?: unknown) => { (e as Event | undefined)?.preventDefault?.(); setShowKey((v) => !v); },
        })}
        {row(<SignOutIcon size={24} />, "Sign out", "This device only", {
          onClick: () => fetch("/api/auth/logout", { method: "POST" }).then(() => { location.href = "/"; }),
        })}
      </div>
      {showKey && (
        <div className="appkey" style={{ margin: "10px 0 0" }}>
          <input
            type="password"
            value={appKey}
            placeholder="app key"
            onChange={(e) => {
              setAppKey(e.target.value);
              localStorage.setItem("appKey", e.target.value.trim());
            }}
          />
        </div>
      )}
      <NavBar />
    </main>
  );
}

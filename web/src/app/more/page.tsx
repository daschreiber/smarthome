"use client";

import { useCallback, useEffect, useState } from "react";
import NavBar from "../NavBar";
import { appKeyHeaders } from "@/lib/appKey";
import { errorFrom, networkError } from "@/lib/fetchError";
import { KeyIcon, PulseIcon, SignOutIcon, UsersIcon } from "../icons";

/** Everything that isn't day-to-day control: audit trail, users, session. */

interface LinkStatus {
  configured: boolean;
  houseLinked: boolean;
  canLinkOwn: boolean;
  me: { linked: boolean; displayName: string | null; premium: boolean | null; linkedAt: string | null };
  others: Array<{ displayName: string }>;
  slots: { used: number; max: number };
}

export default function More() {
  const [role, setRole] = useState<string | null>(null);
  const [appKey, setAppKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [spotifyNote, setSpotifyNote] = useState<string | null>(null);
  const [links, setLinks] = useState<LinkStatus | null>(null);

  // The OAuth callback bounces back here with ?spotify=linked|linked-free|denied.
  useEffect(() => {
    const q = new URLSearchParams(location.search).get("spotify");
    if (q === "linked") setSpotifyNote("Connected — room controls now play your Spotify");
    else if (q === "linked-free")
      // Worth saying out loud: Connect control is a Premium feature, so a
      // free account links fine and then fails at the first Play.
      setSpotifyNote("Connected, but this account isn't Premium — Spotify only allows speaker control on Premium");
    else if (q === "denied") setSpotifyNote("Link cancelled on the Spotify consent page");
    if (q) history.replaceState(null, "", "/more");
  }, []);

  useEffect(() => {
    setAppKey(localStorage.getItem("appKey") ?? "");
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/home", { headers: appKeyHeaders() });
      if (res.status === 401) { location.href = "/"; return; }
      if (res.ok) setRole(((await res.json()) as { role?: string }).role ?? null);
    } catch { /* non-critical */ }
    try {
      const res = await fetch("/api/spotify/link", { headers: appKeyHeaders() });
      if (res.ok) setLinks((await res.json()) as LinkStatus);
    } catch { /* non-critical */ }
  }, []);

  useEffect(() => { load(); }, [load]);

  const disconnect = async () => {
    setSpotifyNote(null);
    try {
      const res = await fetch("/api/spotify/link", {
        method: "DELETE",
        headers: { "Content-Type": "application/json", ...appKeyHeaders() },
        body: "{}",
      });
      if (!res.ok) { setSpotifyNote(await errorFrom(res, "couldn't disconnect")); return; }
      setSpotifyNote("Disconnected — room controls fall back to the house Spotify");
      load();
    } catch (e) {
      setSpotifyNote(networkError(e, "couldn't disconnect"));
    }
  };

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

  const me = links?.me;
  const slotsFull = !!links && !me?.linked && links.slots.used >= links.slots.max;

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

      {/* Spotify gets its own section rather than a one-line row: there are
          two accounts in play (yours and the house's), each with its own
          state, and the difference between them is the whole feature. */}
      {links?.configured && (
        <>
          <h2 className="sec-title" style={{ marginTop: 18 }}>Spotify</h2>
          <div className="dev-list">
            <div className="dev">
              <div style={{ minWidth: 0 }}>
                <div className="nm">My Spotify</div>
                <div className="st">
                  {spotifyNote ??
                    (me?.linked
                      ? `${me.displayName ?? "Connected"}${me.premium === false ? " · not Premium" : ""} — room controls play your music`
                      : slotsFull
                        ? `All ${links.slots.max} Spotify slots are in use — someone has to disconnect first`
                        : "Connect it so the room controls play your music, not the house account's")}
                </div>
              </div>
              <div className="btn-row">
                {links.canLinkOwn && !slotsFull && (
                  <a className="mini-btn" href="/api/spotify/login?target=me">
                    {me?.linked ? "Reconnect" : "Connect"}
                  </a>
                )}
                {me?.linked && (
                  <button className="mini-btn" onClick={disconnect}>Disconnect</button>
                )}
              </div>
            </div>

            {role === "admin" && (
              <div className="dev">
                <div style={{ minWidth: 0 }}>
                  <div className="nm">House Spotify</div>
                  <div className="st">
                    {links.houseLinked
                      ? "Linked — the fallback for anyone who hasn't connected their own"
                      : "Not linked — without it, un-connected users can't play at all"}
                  </div>
                </div>
                <div className="btn-row">
                  <a className="mini-btn" href="/api/spotify/login?target=house">
                    {links.houseLinked ? "Relink" : "Link"}
                  </a>
                </div>
              </div>
            )}
          </div>
          {/* Spotify cut Development Mode from 25 authorised users to 5 in
              February 2026, so the ceiling is low enough to be worth showing
              before someone hits it. */}
          <p className="h-sub" style={{ marginTop: 8 }}>
            {links.slots.used} of {links.slots.max} Spotify accounts connected
            {links.others.length > 0 && ` · also ${links.others.map((o) => o.displayName).join(", ")}`}
            . Spotify allows five per app, and controlling speakers needs Premium.
          </p>
        </>
      )}
      <NavBar />
    </main>
  );
}

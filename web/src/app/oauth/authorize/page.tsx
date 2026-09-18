"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * The consent page — where an MCP client (Claude, ChatGPT, …) sends the
 * person to connect to the house as themselves (docs/MCP_SERVER.md). The
 * request in the query string is validated by `GET /api/oauth/authorize`;
 * if nobody is signed in, the sign-in form appears right here (password,
 * or Google with a return path); then one card says who is asking and
 * what they get, and Allow sends the code back to the client.
 */

interface Describe {
  ok: boolean;
  error?: string;
  description?: string;
  redirect?: string | null;
  client?: { name: string };
  user?: { email: string; role: string } | null;
  methods?: { password: boolean; google: boolean };
}

export default function Authorize() {
  const [info, setInfo] = useState<Describe | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const describe = useCallback(async () => {
    try {
      const res = await fetch(`/api/oauth/authorize${location.search}`);
      const body = (await res.json()) as Describe;
      if (!body.ok && body.redirect) {
        // The client asked for something impossible; it hears why at its
        // own registered address.
        location.href = body.redirect;
        return;
      }
      setInfo(body);
    } catch {
      setErr("Couldn't read the connection request");
    }
  }, []);

  useEffect(() => {
    // A failed Google sign-in bounces back here with ?signin=…
    const q = new URLSearchParams(location.search).get("signin");
    if (q === "not-invited") setErr("That Google account isn't on the user list — ask an admin to add your email.");
    else if (q === "failed") setErr("Google sign-in didn't complete — try again, or use your password.");
    describe();
  }, [describe]);

  const signIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? "sign-in failed");
      setPassword("");
      await describe();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "sign-in failed");
    } finally {
      setBusy(false);
    }
  };

  const decide = async (decision: "allow" | "deny") => {
    setBusy(true);
    setErr(null);
    try {
      const params = Object.fromEntries(new URLSearchParams(location.search));
      const res = await fetch("/api/oauth/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...params, decision }),
      });
      const body = (await res.json()) as { redirect?: string; error?: string; description?: string };
      if (!res.ok || !body.redirect) throw new Error(body.description ?? body.error ?? "the request failed");
      location.href = body.redirect;
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "the request failed");
      setBusy(false);
    }
  };

  const signOut = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    await describe();
  };

  const googleHref = `/api/auth/google?next=${encodeURIComponent(
    typeof location !== "undefined" ? location.pathname + location.search : "/oauth/authorize",
  )}`;

  if (!info) {
    return (
      <main className="shell">
        <div className="auth-form">
          <h1 className="h-title">Connect to the house</h1>
          {err ? <div className="error-banner">{err}</div> : <p className="h-sub">One moment…</p>}
        </div>
      </main>
    );
  }

  if (!info.ok) {
    return (
      <main className="shell">
        <div className="auth-form">
          <h1 className="h-title">Connect to the house</h1>
          <div className="error-banner">This connection request can&apos;t be honoured: {info.description ?? info.error}.</div>
          <p className="h-sub">Start the connection again from the app that asked.</p>
        </div>
      </main>
    );
  }

  if (!info.user) {
    return (
      <main className="shell">
        <form className="auth-form" onSubmit={signIn}>
          <h1 className="h-title">Connect to the house</h1>
          <p className="h-sub">
            <strong>{info.client?.name}</strong> wants to connect. Sign in first — the connection will act as you.
          </p>
          {err && <div className="error-banner">{err}</div>}
          {info.methods?.google && (
            <>
              <a
                className="scene-pill"
                href={googleHref}
                style={{ display: "block", textAlign: "center", width: "100%", padding: 12, marginBottom: 12, background: "var(--card)", color: "var(--ink)", border: "1px solid var(--card-line)", textDecoration: "none", boxSizing: "border-box" }}
              >
                Continue with Google
              </a>
              <p className="h-sub" style={{ textAlign: "center", margin: "0 0 12px" }}>or with a password</p>
            </>
          )}
          <div className="appkey" style={{ margin: 0 }}>
            <input type="email" value={email} placeholder="email" autoComplete="username" onChange={(e) => setEmail(e.target.value)} style={{ marginBottom: 8 }} />
            <input type="password" value={password} placeholder="password" autoComplete="current-password" onChange={(e) => setPassword(e.target.value)} />
          </div>
          <button className="scene-pill" disabled={busy || !email || !password} style={{ width: "100%", marginTop: 14, padding: 12 }}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </main>
    );
  }

  return (
    <main className="shell">
      <div className="auth-form">
        <h1 className="h-title">Connect to the house</h1>
        <p className="h-sub">
          <strong>{info.client?.name}</strong> wants to connect as <strong>{info.user.email}</strong> ({info.user.role}).
        </p>
        {err && <div className="error-banner">{err}</div>}
        <div className="dev-list" style={{ marginTop: 12 }}>
          <div className="dev" style={{ display: "block" }}>
            <div className="nm">It will be able to</div>
            <div className="st">See every device&apos;s state · switch lights, shades, climate and media · run scenes · create automations and auto-off timers</div>
          </div>
          <div className="dev" style={{ display: "block" }}>
            <div className="nm">It will not be able to</div>
            <div className="st">Operate the door lock · capture scenes · see the activity log · start the sauna without you confirming</div>
          </div>
        </div>
        <p className="h-sub" style={{ marginTop: 12 }}>
          Everything it does is logged under your name. Disconnect it any time from More.
        </p>
        <div className="btn-row" style={{ marginTop: 14 }}>
          <button className="scene-pill" disabled={busy} onClick={() => decide("allow")} style={{ flex: 1, padding: 12 }}>
            {busy ? "Connecting…" : "Allow"}
          </button>
          <button className="mini-btn" disabled={busy} onClick={() => decide("deny")} style={{ padding: "0 18px" }}>
            Deny
          </button>
        </div>
        <p className="h-sub" style={{ marginTop: 12 }}>
          Not you?{" "}
          <button type="button" onClick={signOut} style={{ background: "none", border: "none", color: "var(--dim)", font: "inherit", padding: 0, cursor: "pointer", textDecoration: "underline" }}>
            Sign in as someone else
          </button>
        </p>
      </div>
    </main>
  );
}

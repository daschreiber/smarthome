"use client";

import { useEffect, useState } from "react";

export default function Reset() {
  const [token, setToken] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setToken(new URLSearchParams(window.location.search).get("token"));
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirm) {
      setMsg("Passwords don't match.");
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/auth/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "reset failed");
      setDone(true);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "reset failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="shell" style={{ marginTop: "14vh" }}>
      <h1 className="h-title">Set a new password</h1>
      {done ? (
        <>
          <p className="h-sub">Done — your password is changed.</p>
          <a className="scene-pill" style={{ display: "block", textAlign: "center", padding: 12, textDecoration: "none" }} href="/">
            Sign in
          </a>
        </>
      ) : token === null ? (
        <p className="h-sub">Checking link…</p>
      ) : (
        <form onSubmit={submit}>
          {msg && <div className="error-banner">{msg}</div>}
          <div className="appkey" style={{ margin: 0 }}>
            <input
              type="password"
              placeholder="new password (min 8 characters)"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={{ marginBottom: 8 }}
            />
            <input
              type="password"
              placeholder="repeat new password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </div>
          <button className="scene-pill" disabled={busy || !token} style={{ width: "100%", marginTop: 14, padding: 12 }}>
            {busy ? "Saving…" : "Change password"}
          </button>
        </form>
      )}
    </main>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";

interface U {
  email: string;
  role: "admin" | "member";
  createdAt: string;
}

export default function Users() {
  const [users, setUsers] = useState<U[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [busy, setBusy] = useState(false);
  const [resetLink, setResetLink] = useState<{ email: string; link: string } | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/users");
    if (!res.ok) {
      setError((await res.json()).error ?? `HTTP ${res.status}`);
      return;
    }
    setUsers(((await res.json()) as { users: U[] }).users);
    setError(null);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const post = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error ?? "failed");
      if (out.users) setUsers(out.users);
      if (out.link) setResetLink({ email: String(body.email), link: out.link });
      setError(null);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="shell">
      <a className="h-back" href="/">‹ Home</a>
      <h1 className="h-title">Users</h1>
      <p className="h-sub">Who can sign in, and with what role. Admins manage users; members control the house.</p>
      {error && <div className="error-banner">{error}</div>}

      {users.map((u) => (
        <div key={u.email} className="dev">
          <div>
            <div className="nm">{u.email}</div>
            <div className="st">{u.role} · since {new Date(u.createdAt).toLocaleDateString()}</div>
          </div>
          <div className="btn-row">
            <button className="mini-btn" disabled={busy} onClick={() => post({ action: "reset-link", email: u.email })}>
              Reset link
            </button>
            <button
              className="mini-btn"
              disabled={busy}
              onClick={() => {
                if (window.confirm(`Remove ${u.email}? They will be signed out everywhere immediately.`)) {
                  post({ action: "remove", email: u.email });
                }
              }}
            >
              Remove
            </button>
          </div>
        </div>
      ))}

      {resetLink && (
        <div className="dev" style={{ alignItems: "flex-start", flexDirection: "column", gap: 6 }}>
          <div className="st">One-hour reset link for {resetLink.email} — copy and send it to them:</div>
          <div style={{ fontSize: 12, wordBreak: "break-all", userSelect: "all" }}>{resetLink.link}</div>
          <button
            className="mini-btn"
            onClick={() => navigator.clipboard?.writeText(resetLink.link).then(() => setResetLink(null))}
          >
            Copy &amp; dismiss
          </button>
        </div>
      )}

      <div className="section-label">Add user</div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          post({ email, password, role }).then((ok) => {
            if (ok) {
              setEmail("");
              setPassword("");
              setRole("member");
            }
          });
        }}
      >
        <div className="appkey" style={{ margin: 0 }}>
          <input type="email" placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} style={{ marginBottom: 8 }} />
          <input
            type="password"
            placeholder="initial password (min 8 chars)"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={{ marginBottom: 8 }}
          />
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as "member" | "admin")}
            style={{ width: "100%", padding: 9, borderRadius: 10, border: "1px solid var(--card-line)", background: "var(--card)", color: "var(--ink)", fontFamily: "inherit" }}
          >
            <option value="member">member — controls the house</option>
            <option value="admin">admin — also manages users</option>
          </select>
        </div>
        <button className="scene-pill" disabled={busy || !email || !password} style={{ width: "100%", marginTop: 12, padding: 12 }}>
          Add user
        </button>
      </form>
    </main>
  );
}

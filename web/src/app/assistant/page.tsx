"use client";

import { useCallback, useRef, useState } from "react";
import NavBar from "../NavBar";

/**
 * "Ask the house": chat that produces reviewable proposal cards.
 * Nothing runs until the user confirms a card (docs/DESIGN_DIRECTION.md —
 * chat is a supporting feature in Plaster's clothing, not a register).
 */

type Proposal =
  | { kind: "clarify"; message: string }
  | { kind: "actions"; message: string; actions: unknown[] }
  | { kind: "scene_capture"; message: string; name: string; room: string }
  | { kind: "automation"; message: string; name: string; steps: unknown[] };

interface Turn {
  role: "user" | "assistant";
  content: string;
  proposal?: Proposal;
  resolved?: "confirmed" | "cancelled" | "failed";
  resultNote?: string;
}

export default function Assistant() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  const scroll = () => setTimeout(() => bottom.current?.scrollIntoView({ behavior: "smooth" }), 50);

  const send = useCallback(async () => {
    const message = input.trim();
    if (!message || busy) return;
    setInput("");
    setBusy(true);
    setError(null);
    setTurns((t) => [...t, { role: "user", content: message }]);
    scroll();
    try {
      const history = turns
        .filter((t) => !t.proposal || t.resolved)
        .slice(-10)
        .map((t) => ({ role: t.role, content: t.content }));
      const res = await fetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, history }),
      });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error ?? "assistant failed");
      const proposal = out.proposal as Proposal;
      setTurns((t) => [
        ...t,
        {
          role: "assistant",
          content: proposal.message,
          proposal: proposal.kind === "clarify" ? undefined : proposal,
        },
      ]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "assistant failed");
    } finally {
      setBusy(false);
      scroll();
    }
  }, [input, busy, turns]);

  const resolve = useCallback(
    async (index: number, confirmed: boolean) => {
      const turn = turns[index];
      if (!turn?.proposal) return;
      if (!confirmed) {
        setTurns((t) => t.map((x, i) => (i === index ? { ...x, resolved: "cancelled" } : x)));
        return;
      }
      setBusy(true);
      try {
        const res = await fetch("/api/assistant", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "execute", proposal: turn.proposal }),
        });
        const out = await res.json();
        if (!res.ok || out.ok === false) {
          throw new Error(out.error ?? (out.failed?.length ? `some devices failed: ${out.failed.join(", ")}` : "failed"));
        }
        const note =
          turn.proposal.kind === "automation"
            ? "Automation created — see the Automations screen."
            : turn.proposal.kind === "scene_capture"
              ? "Scene saved — it's on your Home screen now."
              : "Done.";
        setTurns((t) => t.map((x, i) => (i === index ? { ...x, resolved: "confirmed", resultNote: note } : x)));
      } catch (e) {
        setTurns((t) =>
          t.map((x, i) =>
            i === index
              ? { ...x, resolved: "failed", resultNote: e instanceof Error ? e.message : "failed" }
              : x,
          ),
        );
      } finally {
        setBusy(false);
        scroll();
      }
    },
    [turns],
  );

  return (
    <main className="shell" style={{ display: "flex", flexDirection: "column", minHeight: "100vh", paddingBottom: 170 }}>
      <h1 className="h-title">Ask the house</h1>
      <p className="h-sub">Say what you want. Nothing happens until you confirm.</p>
      {error && <div className="error-banner">{error}</div>}

      {turns.length === 0 && !busy && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 12 }}>
          <div className="section-label" style={{ margin: 0 }}>Try</div>
          {[
            "Turn off all the lights",
            "Set the lounge to 22 degrees",
            "Kitchen lights on tomorrow at 16:00, off at 20:00",
          ].map((ex) => (
            <button
              key={ex}
              className="mini-btn"
              style={{ textAlign: "left", background: "var(--card)" }}
              onClick={() => setInput(ex)}
            >
              &ldquo;{ex}&rdquo;
            </button>
          ))}
        </div>
      )}

      <div style={{ flex: 1 }}>
        {turns.map((t, i) => (
          <div key={i} style={{ margin: "10px 0", textAlign: t.role === "user" ? "right" : "left" }}>
            <div
              style={{
                display: "inline-block", maxWidth: "min(85%, 560px)", textAlign: "left",
                background: t.role === "user" ? "var(--accent)" : "var(--card)",
                color: t.role === "user" ? "var(--accent-ink)" : "var(--ink)",
                border: t.role === "user" ? "none" : "1px solid var(--card-line)",
                borderRadius: 16, padding: "10px 14px", fontSize: 14.5,
              }}
            >
              {t.content}
              {t.proposal && (
                <div style={{ marginTop: 10, borderTop: "1px solid var(--card-line)", paddingTop: 10 }}>
                  <div className="st" style={{ marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.06em", fontSize: 11 }}>
                    {t.proposal.kind === "automation" ? "Proposed automation" : t.proposal.kind === "scene_capture" ? "Proposed scene" : "Proposed actions"}
                  </div>
                  {!t.resolved ? (
                    <div className="btn-row">
                      <button className="scene-pill" disabled={busy} style={{ padding: "8px 16px" }} onClick={() => resolve(i, true)}>
                        Confirm
                      </button>
                      <button className="mini-btn" disabled={busy} onClick={() => resolve(i, false)}>
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <div className="st" style={{ color: t.resolved === "failed" ? "var(--danger)" : t.resolved === "confirmed" ? "var(--accent)" : "var(--dim)" }}>
                      {t.resolved === "cancelled" ? "Cancelled." : t.resultNote}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
        {busy && <p className="h-sub">Thinking…</p>}
        <div ref={bottom} />
      </div>

      <form className="chat-bar" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <div style={{ maxWidth: "var(--shell-max)", margin: "0 auto", display: "flex", gap: 8 }}>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Tell the house what to do…"
            style={{ flex: 1, padding: 11, borderRadius: 12, border: "1px solid var(--card-line)", background: "var(--card)", color: "var(--ink)", fontFamily: "inherit", fontSize: 15 }}
          />
          <button className="scene-pill" disabled={busy || !input.trim()} style={{ padding: "0 18px" }}>
            Send
          </button>
        </div>
      </form>
      <NavBar />
    </main>
  );
}

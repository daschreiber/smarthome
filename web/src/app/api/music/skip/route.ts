import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { skip, spotifyConfigured } from "@/lib/spotify";
import { accountFor } from "@/lib/spotifyAccounts";

/** Next/previous track on the caller's own session. Device-independent: the
 *  C4 zones can't skip via HA, but the Spotify API skips whatever device
 *  holds the session. Skipping only ever touches YOUR account — nobody can
 *  skip a track out from under someone else's listening. */
export async function POST(req: NextRequest) {
  const auth = authenticate(req);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!spotifyConfigured()) {
    return NextResponse.json({ error: "Spotify isn't set up on this server yet" }, { status: 501 });
  }
  const account = accountFor(auth.user);
  if (!account) {
    return NextResponse.json({ error: "No Spotify is linked yet — connect yours in More → Spotify" }, { status: 501 });
  }
  const body = (await req.json().catch(() => null)) as { direction?: unknown } | null;
  const direction = body?.direction === "previous" ? "previous" : body?.direction === "next" ? "next" : null;
  if (!direction) return NextResponse.json({ error: "direction must be next or previous" }, { status: 400 });
  const started = Date.now();
  try {
    await skip(direction, account);
    audit({
      ts: new Date().toISOString(), user: auth.user, deviceId: "music:spotify",
      entityId: "spotify", command: `skip_${direction}`, args: { account }, ok: true,
      durationMs: Date.now() - started,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "skip failed";
    audit({
      ts: new Date().toISOString(), user: auth.user, deviceId: "music:spotify",
      entityId: "spotify", command: `skip_${direction}`, args: { account }, ok: false,
      durationMs: Date.now() - started, error: message,
    });
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { forgetAccount, spotifyConfigured, spotifyLinked } from "@/lib/spotify";
import { MAX_LINKED_USERS, getLink, listLinks, removeLink, userKey } from "@/lib/spotifyAccounts";

/** Who is linked to Spotify: mine in detail, everyone else by name only. */
export async function GET(req: NextRequest) {
  const auth = authenticate(req);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const links = listLinks();
  const mine = getLink(auth.user);
  return NextResponse.json({
    configured: spotifyConfigured(),
    houseLinked: spotifyLinked(),
    canLinkOwn: auth.user.includes("@"),
    me: mine
      ? { linked: true, displayName: mine.displayName, premium: mine.premium, linkedAt: mine.linkedAt }
      : { linked: false, displayName: null, premium: null, linkedAt: null },
    // Names only — a household roster, not other people's tokens or emails.
    others: links
      .filter((l) => l.user.toLowerCase() !== auth.user.toLowerCase())
      .map((l) => ({ displayName: l.displayName ?? l.user.split("@")[0] })),
    slots: { used: links.length, max: MAX_LINKED_USERS },
  });
}

/** Disconnect my own Spotify (or, for an admin, free someone else's slot). */
export async function DELETE(req: NextRequest) {
  const auth = authenticate(req);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { user?: unknown } | null;
  const requested = typeof body?.user === "string" ? body.user : null;
  // Unlinking someone else is a user-management act, not a music one.
  if (requested && requested.toLowerCase() !== auth.user.toLowerCase() && auth.role !== "admin") {
    return NextResponse.json({ error: "you can only disconnect your own Spotify" }, { status: 403 });
  }
  const target = requested ?? auth.user;
  const removed = removeLink(target);
  // Drop the cached access token too: without this a token minted seconds
  // ago would keep commanding an account the user just disconnected.
  forgetAccount(userKey(target));
  if (removed) {
    audit({
      ts: new Date().toISOString(), user: auth.user, deviceId: "music:spotify",
      entityId: "spotify", command: "spotify_unlink", args: { target }, ok: true, durationMs: 0,
    });
  }
  return NextResponse.json({ ok: true, removed });
}

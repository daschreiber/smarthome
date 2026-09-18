import { NextRequest, NextResponse } from "next/server";
import { audit } from "@/lib/audit";
import { authenticate } from "@/lib/auth";
import { listGrants, revokeGrant } from "@/lib/oauth";

/** Connected agents, for the More screen: yours (an admin sees everyone's). */
export async function GET(req: NextRequest) {
  const auth = authenticate(req);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ grants: listGrants(auth.user, auth.role) });
}

/** Disconnect one: `{ id }`. Your own, or anyone's as an admin. */
export async function DELETE(req: NextRequest) {
  const auth = authenticate(req);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { id?: unknown } | null;
  if (typeof body?.id !== "string") return NextResponse.json({ error: "id required" }, { status: 400 });
  if (!revokeGrant(body.id, auth.user, auth.role)) {
    return NextResponse.json({ error: "no such connected agent, or not yours to disconnect" }, { status: 404 });
  }
  audit({
    ts: new Date().toISOString(), user: auth.user, deviceId: "auth", entityId: "app.oauth",
    command: "agent_disconnect", args: { grant: body.id }, ok: true, durationMs: 0,
  });
  return NextResponse.json({ ok: true, grants: listGrants(auth.user, auth.role) });
}

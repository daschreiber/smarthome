import { NextRequest, NextResponse } from "next/server";
import { setPassword, verifyResetToken } from "@/lib/users";
import { audit } from "@/lib/audit";

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { token?: string; password?: string } | null;
  if (!body?.token || !body?.password) {
    return NextResponse.json({ error: "token and password required" }, { status: 400 });
  }
  const email = verifyResetToken(body.token);
  if (!email) {
    return NextResponse.json({ error: "this reset link is invalid, expired, or already used" }, { status: 400 });
  }
  try {
    setPassword(email, body.password);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "reset failed" }, { status: 400 });
  }
  audit({
    ts: new Date().toISOString(), user: email, deviceId: "users",
    entityId: "app.users", command: "password_reset", args: {}, ok: true, durationMs: 0,
  });
  return NextResponse.json({ ok: true });
}

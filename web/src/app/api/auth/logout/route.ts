import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";
import { audit } from "@/lib/audit";

export async function POST(req: NextRequest) {
  const auth = authenticate(req);
  if (auth.ok) {
    audit({
      ts: new Date().toISOString(), user: auth.user, deviceId: "auth", entityId: "app.auth",
      command: "signout", args: {}, ok: true, durationMs: 0,
    });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set("session", "", { httpOnly: true, maxAge: 0, path: "/" });
  return res;
}

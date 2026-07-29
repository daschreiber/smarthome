import { NextRequest, NextResponse } from "next/server";
import { checkCredentials, createSessionToken, usersConfigured } from "@/lib/session";
import { audit } from "@/lib/audit";
import { throttleStatus, recordFailure, recordSuccess, clientIp } from "@/lib/loginThrottle";

export async function POST(req: NextRequest) {
  if (!usersConfigured()) {
    return NextResponse.json({ error: "sign-in is not configured" }, { status: 501 });
  }
  const body = (await req.json().catch(() => null)) as { email?: string; password?: string } | null;
  if (!body?.email || !body?.password) {
    return NextResponse.json({ error: "email and password required" }, { status: 400 });
  }
  const email = body.email.trim().toLowerCase();
  const ip = clientIp(req);

  // Lockout takes precedence over the credential check: once an account or IP
  // has crossed its failure threshold, we neither reveal validity nor burn CPU
  // on scrypt, we just report when to try again.
  const gate = throttleStatus(email, ip);
  if (gate.locked) {
    const retryAfter = Math.ceil(gate.retryAfterMs / 1000);
    audit({
      ts: new Date().toISOString(), user: email, deviceId: "auth", entityId: "app.auth",
      command: "password_signin", args: {}, ok: false, durationMs: 0, security: true,
      error: "too many attempts — locked out",
    });
    return NextResponse.json(
      { error: "too many attempts — try again later" },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  if (!checkCredentials(body.email, body.password)) {
    recordFailure(email, ip);
    audit({
      ts: new Date().toISOString(), user: email, deviceId: "auth", entityId: "app.auth",
      command: "password_signin", args: {}, ok: false, durationMs: 0,
      error: "wrong email or password",
    });
    // Small fixed delay to blunt guessing.
    await new Promise((r) => setTimeout(r, 600));
    return NextResponse.json({ error: "wrong email or password" }, { status: 401 });
  }
  recordSuccess(email, ip);
  audit({
    ts: new Date().toISOString(), user: email, deviceId: "auth", entityId: "app.auth",
    command: "password_signin", args: {}, ok: true, durationMs: 0,
  });
  const res = NextResponse.json({ ok: true, user: email });
  res.cookies.set("session", createSessionToken(email), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 90 * 24 * 3600,
    path: "/",
  });
  return res;
}

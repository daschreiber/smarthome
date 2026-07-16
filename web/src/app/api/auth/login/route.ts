import { NextRequest, NextResponse } from "next/server";
import { checkCredentials, createSessionToken, usersConfigured } from "@/lib/session";

export async function POST(req: NextRequest) {
  if (!usersConfigured()) {
    return NextResponse.json({ error: "sign-in is not configured" }, { status: 501 });
  }
  const body = (await req.json().catch(() => null)) as { email?: string; password?: string } | null;
  if (!body?.email || !body?.password) {
    return NextResponse.json({ error: "email and password required" }, { status: 400 });
  }
  if (!checkCredentials(body.email, body.password)) {
    // Small fixed delay to blunt guessing.
    await new Promise((r) => setTimeout(r, 600));
    return NextResponse.json({ error: "wrong email or password" }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true, user: body.email.trim().toLowerCase() });
  res.cookies.set("session", createSessionToken(body.email.trim().toLowerCase()), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 90 * 24 * 3600,
    path: "/",
  });
  return res;
}

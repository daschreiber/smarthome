import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";
import { addUser, createResetToken, listUsers, removeUser } from "@/lib/users";
import { audit } from "@/lib/audit";

function admin(req: NextRequest) {
  const auth = authenticate(req);
  if (!auth.ok) return { err: NextResponse.json({ error: "unauthorized" }, { status: 401 }), auth };
  if (auth.role !== "admin") return { err: NextResponse.json({ error: "admins only" }, { status: 403 }), auth };
  return { err: null, auth };
}

export async function GET(req: NextRequest) {
  const { err } = admin(req);
  if (err) return err;
  return NextResponse.json({ users: listUsers() });
}

export async function POST(req: NextRequest) {
  const { err, auth } = admin(req);
  if (err) return err;
  const body = (await req.json().catch(() => null)) as
    | { action?: string; email?: string; password?: string; role?: "admin" | "member" }
    | null;
  if (!body?.email) return NextResponse.json({ error: "email required" }, { status: 400 });

  try {
    if (body.action === "remove") {
      removeUser(body.email);
      audit({ ts: new Date().toISOString(), user: auth.user, deviceId: "users", entityId: "app.users", command: "remove_user", args: { email: body.email }, ok: true, durationMs: 0 });
      return NextResponse.json({ ok: true, users: listUsers() });
    }
    if (body.action === "reset-link") {
      const base = process.env.APP_BASE_URL || new URL(req.url).origin;
      const link = `${base.replace(/\/+$/, "")}/reset?token=${encodeURIComponent(createResetToken(body.email))}`;
      audit({ ts: new Date().toISOString(), user: auth.user, deviceId: "users", entityId: "app.users", command: "reset_link_issued", args: { email: body.email }, ok: true, durationMs: 0 });
      return NextResponse.json({ ok: true, link });
    }
    // default: add
    if (!body.password) return NextResponse.json({ error: "password required" }, { status: 400 });
    addUser(body.email, body.password, body.role === "admin" ? "admin" : "member");
    audit({ ts: new Date().toISOString(), user: auth.user, deviceId: "users", entityId: "app.users", command: "add_user", args: { email: body.email, role: body.role ?? "member" }, ok: true, durationMs: 0 });
    return NextResponse.json({ ok: true, users: listUsers() });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 400 });
  }
}

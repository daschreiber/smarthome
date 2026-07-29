import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";
import { addUser, createResetToken, listUsers, removeUser, setRole, type Role } from "@/lib/users";
import { canManageUsers } from "@/lib/permissions";
import { audit } from "@/lib/audit";

function admin(req: NextRequest) {
  const auth = authenticate(req);
  if (!auth.ok) return { err: NextResponse.json({ error: "unauthorized" }, { status: 401 }), auth };
  if (!canManageUsers(auth.role)) return { err: NextResponse.json({ error: "admins only" }, { status: 403 }), auth };
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
    | { action?: string; email?: string; password?: string; role?: string }
    | null;
  if (!body?.email) return NextResponse.json({ error: "email required" }, { status: 400 });
  const role: Role = body.role === "admin" ? "admin" : body.role === "guest" ? "guest" : "member";

  try {
    if (body.action === "set-role") {
      setRole(body.email, role);
      audit({ ts: new Date().toISOString(), user: auth.user, deviceId: "users", entityId: "app.users", command: "set_role", args: { email: body.email, role }, ok: true, durationMs: 0 });
      return NextResponse.json({ ok: true, users: listUsers() });
    }
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
    // Empty password = Google-sign-in-only user.
    addUser(body.email, body.password?.trim() ? body.password : null, role);
    audit({ ts: new Date().toISOString(), user: auth.user, deviceId: "users", entityId: "app.users", command: "add_user", args: { email: body.email, role }, ok: true, durationMs: 0 });
    return NextResponse.json({ ok: true, users: listUsers() });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 400 });
  }
}

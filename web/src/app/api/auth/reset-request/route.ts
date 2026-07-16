import { NextRequest, NextResponse } from "next/server";
import { createResetToken, getUser } from "@/lib/users";
import { emailConfigured, sendResetEmail } from "@/lib/email";
import { audit } from "@/lib/audit";

/** Always answers generically so it can't be used to probe which emails exist. */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { email?: string } | null;
  if (!body?.email) return NextResponse.json({ error: "email required" }, { status: 400 });

  const user = getUser(body.email);
  let sent = false;
  if (user) {
    const base = process.env.APP_BASE_URL || new URL(req.url).origin;
    const link = `${base.replace(/\/+$/, "")}/reset?token=${encodeURIComponent(createResetToken(user.email))}`;
    sent = await sendResetEmail(user.email, link);
    audit({
      ts: new Date().toISOString(), user: user.email, deviceId: "users",
      entityId: "app.users", command: "reset_request", args: { emailed: sent },
      ok: true, durationMs: 0,
    });
  } else {
    await new Promise((r) => setTimeout(r, 400));
  }
  return NextResponse.json({
    ok: true,
    message: emailConfigured()
      ? "If that account exists, a reset email is on its way."
      : "Email isn't configured — ask the admin to generate a reset link from the Users screen.",
  });
}

import { NextRequest, NextResponse } from "next/server";
import { readAudit } from "@/lib/audit";
import { authenticate } from "@/lib/auth";
import { canViewActivity } from "@/lib/permissions";

export async function GET(req: NextRequest) {
  const auth = authenticate(req);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  // The audit trail names every user's actions — admins only.
  if (!canViewActivity(auth.role)) {
    return NextResponse.json({ error: "the activity log is admin-only" }, { status: 403 });
  }
  return NextResponse.json({ events: readAudit(100) });
}

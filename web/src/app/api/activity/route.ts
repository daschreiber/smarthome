import { NextRequest, NextResponse } from "next/server";
import { readAudit } from "@/lib/audit";
import { authorized } from "@/lib/auth";

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ events: readAudit(100) });
}

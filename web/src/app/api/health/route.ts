import { NextRequest, NextResponse } from "next/server";
import { haHealth } from "@/lib/ha";
import { registry } from "@/lib/registry";
import { authorized } from "@/lib/auth";

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const ha = await haHealth();
  return NextResponse.json({
    app: "ok",
    homeAssistant: ha,
    devices: registry().devices.length,
  });
}

import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";
import { getFavorites, toggleFavorite } from "@/lib/favorites";
import { getDevice } from "@/lib/registry";

export async function GET(req: NextRequest) {
  const auth = authenticate(req);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ favorites: getFavorites(auth.user) });
}

export async function POST(req: NextRequest) {
  const auth = authenticate(req);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { deviceId?: string } | null;
  if (!body?.deviceId || !getDevice(body.deviceId)) {
    return NextResponse.json({ error: "unknown device" }, { status: 400 });
  }
  return NextResponse.json({ favorites: toggleFavorite(auth.user, body.deviceId) });
}

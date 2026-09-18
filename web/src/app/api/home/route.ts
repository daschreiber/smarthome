import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";
import { homeSnapshot } from "@/lib/homeSnapshot";

/** The bulk read the UI polls (~3s): lib/homeSnapshot, behind auth. */
export async function GET(req: NextRequest) {
  const auth = authenticate(req);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    return NextResponse.json(await homeSnapshot(auth.role));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "upstream failure" },
      { status: 502 },
    );
  }
}

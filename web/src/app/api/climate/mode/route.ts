import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authenticate } from "@/lib/auth";
import { startChangeover } from "@/lib/changeover";

/**
 * Per-floor heat/cool changeover. Returns immediately with "started"; the
 * ~13s relay sequence runs server-side (lib/changeover) and completion is
 * audited there. The UI reads progress from /api/home (`floorModes`).
 */

const Body = z.object({
  floor: z.union([z.literal(5), z.literal(6)]),
  mode: z.enum(["heat", "cool"]),
});

export async function POST(req: NextRequest) {
  const auth = authenticate(req);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid request" }, { status: 400 });
  const { floor, mode } = parsed.data;

  // 409 for "one at a time", 503 for "the relay is offline" — the second is
  // the house being down, not the request being wrong.
  const result = await startChangeover(floor, mode, auth.user);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error },
      { status: result.reason === "unreachable" ? 503 : 409 },
    );
  }
  return NextResponse.json({ ok: true, status: "started" });
}

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authenticate } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { executeSystemCommand } from "@/lib/execute";

/**
 * House-wide system commands ("all lights off", "all A/C off", room subsets).
 * Fire-and-report like scenes: each device call either succeeds or is listed
 * in `failed`; the UI's normal state polling shows the resulting truth.
 */

const Body = z.object({
  system: z.enum(["lighting", "climate", "heating", "shades"]),
  command: z.enum(["turn_on", "turn_off", "open", "close", "stop"]),
  rooms: z.array(z.string()).max(50).optional(),
});

export async function POST(req: NextRequest) {
  const auth = authenticate(req);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid request" }, { status: 400 });
  const { system, command, rooms } = parsed.data;

  const started = Date.now();
  try {
    const result = await executeSystemCommand(system, command, rooms);
    audit({
      ts: new Date().toISOString(), user: auth.user, deviceId: `system:${system}`,
      entityId: `system.${system}`, command,
      args: { rooms: rooms ?? "all", targets: result.total, failed: result.failed.length },
      ok: result.failed.length === 0, durationMs: Date.now() - started,
      error: result.failed.length ? result.failed.map((f) => `${f.target}: ${f.error}`).join("; ") : undefined,
    });
    return NextResponse.json({
      ok: result.failed.length === 0,
      targets: result.total,
      failed: result.failed.map((f) => f.target),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "system command failed";
    audit({
      ts: new Date().toISOString(), user: auth.user, deviceId: `system:${system}`,
      entityId: `system.${system}`, command, args: { rooms: rooms ?? "all" },
      ok: false, durationMs: Date.now() - started, error: message,
    });
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

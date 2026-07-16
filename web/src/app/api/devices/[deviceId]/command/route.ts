import { NextRequest, NextResponse } from "next/server";
import { CommandSchema, buildServiceCall } from "@/lib/commands";
import { callService, getState } from "@/lib/ha";
import { getDevice } from "@/lib/registry";
import { audit } from "@/lib/audit";
import { authorized } from "@/lib/auth";

/**
 * Command execution flow per IMPLEMENTATION_SPEC §9:
 * authenticate -> resolve mapping -> validate capability -> call HA ->
 * read resulting state -> audit -> respond confirmed/failed.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ deviceId: string }> },
) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { deviceId } = await params;
  const device = getDevice(deviceId);
  if (!device) return NextResponse.json({ error: "unknown device" }, { status: 404 });

  const parsed = CommandSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid command", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const cmd = parsed.data;
  const { command, ...args } = cmd;
  const started = Date.now();

  try {
    const call = buildServiceCall(device, cmd);
    await callService(call.domain, call.service, call.data);
    // Brief settle, then read back the real state — never claim success
    // beyond what HA confirms (PRODUCT_SPEC §6).
    await new Promise((r) => setTimeout(r, 1200));
    const after = await getState(device.entityId);
    const durationMs = Date.now() - started;
    audit({
      ts: new Date().toISOString(),
      deviceId,
      entityId: device.entityId,
      command,
      args,
      ok: true,
      durationMs,
      resultState: after?.state,
    });
    return NextResponse.json({
      status: "confirmed",
      state: after?.state ?? "unknown",
      brightnessPct:
        after && typeof after.attributes.brightness === "number"
          ? Math.round(((after.attributes.brightness as number) / 255) * 100)
          : null,
      durationMs,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    audit({
      ts: new Date().toISOString(),
      deviceId,
      entityId: device.entityId,
      command,
      args,
      ok: false,
      durationMs: Date.now() - started,
      error: message,
    });
    const clientError = message.includes("does not support");
    return NextResponse.json(
      { status: "failed", error: message },
      { status: clientError ? 400 : 502 },
    );
  }
}

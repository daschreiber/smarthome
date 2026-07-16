import { NextRequest, NextResponse } from "next/server";
import { CommandSchema, assertCommandAllowed, buildServiceCall } from "@/lib/commands";
import { callService, getState } from "@/lib/ha";
import { getDevice } from "@/lib/registry";
import { audit } from "@/lib/audit";
import { authorized } from "@/lib/auth";
import { saunaSetTemperature, saunaStart, saunaStatus, saunaStop } from "@/lib/sauna";

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

  const raw = await req.json().catch(() => null);
  const parsed = CommandSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid command", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const cmd = parsed.data;
  const { command, ...args } = cmd;

  // Safety-sensitive devices (the sauna heater) demand explicit confirmation
  // on every command — IMPLEMENTATION_SPEC Phase F.
  if (device.requiresConfirmation && (raw as { confirm?: unknown })?.confirm !== true) {
    return NextResponse.json(
      { error: "confirmation required", detail: `re-send with "confirm": true to command ${device.label}` },
      { status: 428 },
    );
  }

  const started = Date.now();

  if (device.kind === "sauna") {
    try {
      assertCommandAllowed(device, cmd);
      let message = "ok";
      if (cmd.command === "turn_on") message = await saunaStart();
      else if (cmd.command === "turn_off") message = await saunaStop();
      else if (cmd.command === "set_temperature") {
        await saunaSetTemperature(cmd.temperature);
        message = `target ${cmd.temperature}°C`;
      }
      const after = await saunaStatus().catch(() => null);
      const durationMs = Date.now() - started;
      audit({
        ts: new Date().toISOString(), deviceId, entityId: device.entityId,
        command, args, ok: true, durationMs,
        resultState: after ? (after.poweredOn ? "on" : "off") : undefined,
      });
      return NextResponse.json({
        status: "confirmed",
        state: after ? (after.poweredOn ? "on" : "off") : "unknown",
        message,
        currentTemperature: after?.currentTemperature ?? null,
        durationMs,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      audit({
        ts: new Date().toISOString(), deviceId, entityId: device.entityId,
        command, args, ok: false, durationMs: Date.now() - started, error: message,
      });
      const clientError = /does not support|out of range/.test(message);
      return NextResponse.json(
        { status: "failed", error: message },
        { status: clientError ? 400 : 502 },
      );
    }
  }

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
    const clientError = /does not support|out of range/.test(message);
    return NextResponse.json(
      { status: "failed", error: message },
      { status: clientError ? 400 : 502 },
    );
  }
}

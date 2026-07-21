import { NextRequest, NextResponse } from "next/server";
import { CommandSchema, assertCommandAllowed, buildServiceCall, expectedStates } from "@/lib/commands";
import { callService, getState } from "@/lib/ha";
import { getDevice } from "@/lib/registry";
import { audit } from "@/lib/audit";
import { authenticate } from "@/lib/auth";
import { unitEntityIds } from "@/lib/coolmaster";
import { saunaSetTemperature, saunaStart, saunaStatus, saunaStop } from "@/lib/sauna";
import { noiseMediaEntity, noiseMediaSource, noiseStatus, noiseStreamUrl, setNoiseVolume } from "@/lib/whitenoise";

/**
 * Command execution flow per IMPLEMENTATION_SPEC §9:
 * authenticate -> resolve mapping -> validate capability -> call HA ->
 * read resulting state -> audit -> respond confirmed/failed.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ deviceId: string }> },
) {
  const auth = authenticate(req);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

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

  if (device.kind === "noise") {
    try {
      assertCommandAllowed(device, cmd);
      let message = "ok";
      let listeners: number | null = null;
      if (cmd.command === "set_volume") {
        // The stream's own volume, via the noise server.
        const s = await setNoiseVolume(cmd.volumePct);
        message = `volume ${s.volume}%`;
        listeners = s.listeners;
      } else if (cmd.command === "turn_on" || cmd.command === "turn_off") {
        // On/off drives the room's media_player. Two dialects:
        // - WHITENOISE_MEDIA_SOURCE set: Control4's matrix model — the room
        //   JOINS the named source (select_source); play_media is ignored by
        //   the Control4 integration, so URL playback can't work there.
        // - Unset: play the stream URL directly (DLNA/Sonos/Cast entities).
        // The token-bearing URL stays server-side (never sent to the browser).
        if (cmd.command === "turn_on") {
          const source = noiseMediaSource();
          if (source) {
            await callService("media_player", "select_source", {
              entity_id: noiseMediaEntity(),
              source,
            });
          } else {
            await callService("media_player", "play_media", {
              entity_id: noiseMediaEntity(),
              media_content_id: noiseStreamUrl(),
              media_content_type: "music",
            });
          }
        } else {
          await callService("media_player", "turn_off", { entity_id: noiseMediaEntity() });
        }
        // The noise server's listener count is the ground truth: poll a few
        // seconds for the zone to connect (or drop). "confirmed" only when it
        // proves the intent; otherwise "sent" (the play_media may be a no-op
        // if the Control4 integration doesn't support URL playback).
        const wantPlaying = cmd.command === "turn_on";
        const deadline = Date.now() + 8000;
        for (;;) {
          await new Promise((r) => setTimeout(r, 1000));
          listeners = (await noiseStatus().catch(() => null))?.listeners ?? listeners;
          if (listeners != null && wantPlaying === listeners > 0) break;
          if (Date.now() >= deadline) break;
        }
        message = listeners && listeners > 0 ? "playing" : "idle";
      } else {
        throw new Error(`white noise does not support ${cmd.command}`);
      }
      const verified =
        cmd.command === "set_volume" ||
        (cmd.command === "turn_on" ? (listeners ?? 0) > 0 : listeners === 0);
      const durationMs = Date.now() - started;
      audit({
        ts: new Date().toISOString(), user: auth.user, deviceId, entityId: device.entityId,
        command, args, ok: true, durationMs,
        resultState: listeners != null ? (listeners > 0 ? "on" : "off") : undefined,
      });
      return NextResponse.json({
        status: verified ? "confirmed" : "sent",
        state: listeners != null ? (listeners > 0 ? "on" : "off") : "unknown",
        message,
        durationMs,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      audit({
        ts: new Date().toISOString(), user: auth.user, deviceId, entityId: device.entityId,
        command, args, ok: false, durationMs: Date.now() - started, error: message,
      });
      const clientError = /does not support|out of range/.test(message);
      return NextResponse.json({ status: "failed", error: message }, { status: clientError ? 400 : 502 });
    }
  }

  if (device.kind === "sauna") {
    try {
      assertCommandAllowed(device, cmd);
      let message = "ok";
      let verified = true;
      let stopAt: string | null | undefined;
      if (cmd.command === "turn_on" || cmd.command === "turn_off") {
        // Start options ride outside CommandSchema (sauna-specific extras):
        // target °C and an auto-stop the sauna app schedules server-side.
        const extras = raw as { temperature?: unknown; runForMinutes?: unknown };
        const temp = typeof extras?.temperature === "number" ? extras.temperature : undefined;
        const runFor = typeof extras?.runForMinutes === "number" ? extras.runForMinutes : undefined;
        if (temp != null && (temp < 40 || temp > 100)) {
          return NextResponse.json({ error: "sauna target must be 40-100°C" }, { status: 400 });
        }
        if (runFor != null && (runFor < 15 || runFor > 480)) {
          return NextResponse.json({ error: "run time must be 15-480 minutes" }, { status: 400 });
        }
        if (cmd.command === "turn_on") {
          const result = await saunaStart({ temp, stopAfterMinutes: runFor });
          message = result.message;
          verified = result.verified;
          stopAt = result.stopAt;
        } else {
          const result = await saunaStop();
          message = result.message;
          verified = result.verified;
        }
      } else if (cmd.command === "set_temperature") {
        await saunaSetTemperature(cmd.temperature);
        message = `target ${cmd.temperature}°C`;
      }
      const after = await saunaStatus().catch(() => null);
      const durationMs = Date.now() - started;
      audit({
        ts: new Date().toISOString(), user: auth.user, deviceId, entityId: device.entityId,
        command, args, ok: true, durationMs,
        resultState: after ? (after.poweredOn ? "on" : "off") : undefined,
        error: verified ? undefined : message,
      });
      return NextResponse.json({
        // "confirmed" only when the sauna app itself verified the outcome;
        // otherwise "sent" — its watchdog continues verification server-side.
        status: verified ? "confirmed" : "sent",
        state: after ? (after.poweredOn ? "on" : "off") : "unknown",
        message,
        stopAt: stopAt ?? null,
        currentTemperature: after?.currentTemperature ?? null,
        durationMs,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      audit({
        ts: new Date().toISOString(), user: auth.user, deviceId, entityId: device.entityId,
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
    // Suction levels vary by vacuum model; the entity's fan_speed_list is
    // the authority, so reject anything it doesn't advertise.
    if (cmd.command === "set_fan_speed") {
      const s = await getState(device.entityId);
      const list = Array.isArray(s?.attributes.fan_speed_list)
        ? (s.attributes.fan_speed_list as unknown[]).filter((v) => typeof v === "string")
        : null;
      if (list && !list.includes(cmd.fanSpeed)) {
        return NextResponse.json(
          { error: `fan speed must be one of: ${list.join(", ")}` },
          { status: 400 },
        );
      }
    }
    const call = buildServiceCall(device, cmd);
    await callService(call.domain, call.service, call.data);

    // Read back until the state matches the command's intent. KNX status
    // feedback arrives via the Control4 integration's Director polling, so
    // ~4s is normal (observed 3.7s in commissioning); poll up to 8s.
    // "confirmed" is ONLY claimed when the observed state proves the command
    // (PRODUCT_SPEC §6); otherwise the command is reported as "sent".
    // Setpoints are the exception state can't prove: they verify against the
    // CoolMaster unit's reported target temperature instead.
    const wantedTemp = cmd.command === "set_temperature" ? cmd.temperature : null;
    const setpointUnits = wantedTemp != null ? unitEntityIds(device) : null;
    const readbackId = setpointUnits?.[0] ?? device.entityId;
    const setpointReached = (s: { attributes: Record<string, unknown> } | null) =>
      !!setpointUnits && !!s && s.attributes.temperature === wantedTemp;
    // Fan speed is the other attribute-verified command: state stays
    // "docked"/"cleaning", but the entity echoes the accepted fan_speed.
    const wantedFan = cmd.command === "set_fan_speed" ? cmd.fanSpeed : null;
    const fanReached = (s: { attributes: Record<string, unknown> } | null) =>
      wantedFan != null && !!s && s.attributes.fan_speed === wantedFan;
    const expected = expectedStates(cmd, device.kind);
    const deadline = Date.now() + 8000;
    let after = null;
    for (;;) {
      await new Promise((r) => setTimeout(r, 700));
      after = await getState(readbackId);
      if (setpointUnits) {
        if (setpointReached(after)) break;
        if (!after) break; // unit entity absent — integration not added yet
      } else if (wantedFan != null) {
        if (fanReached(after)) break;
      } else if (!expected) break;
      else if (after && expected.includes(after.state)) break;
      if (Date.now() >= deadline) break;
    }
    const verified = setpointUnits
      ? setpointReached(after)
      : wantedFan != null
        ? fanReached(after)
        : !!expected && !!after && expected.includes(after.state);
    const status = verified ? "confirmed" : "sent";

    const durationMs = Date.now() - started;
    audit({
      ts: new Date().toISOString(),
      user: auth.user,
      deviceId,
      entityId: device.entityId,
      command,
      args,
      ok: true,
      durationMs,
      resultState: after ? `${after.state}${verified ? "" : " (unverified)"}` : undefined,
    });
    return NextResponse.json({
      status,
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
      user: auth.user,
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

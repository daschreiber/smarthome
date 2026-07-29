import { NextRequest, NextResponse } from "next/server";
import { CommandSchema, assertCommandAllowed, buildServiceCall, expectedStates } from "@/lib/commands";
import { callService, getState } from "@/lib/ha";
import { getDevice } from "@/lib/registry";
import { audit } from "@/lib/audit";
import { authenticate } from "@/lib/auth";
import { canOperateLocks } from "@/lib/permissions";
import { getUser, verifyPassword } from "@/lib/users";
import { unitEntityIds } from "@/lib/coolmaster";
import { saunaSetTemperature, saunaStart, saunaStatus, saunaStop } from "@/lib/sauna";
import { noiseStatusFresh, noiseTurnOff, noiseTurnOn, setNoiseVolume } from "@/lib/whitenoise";
import { executeOnDevice } from "@/lib/execute";

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

  // Safety-sensitive devices (the sauna heater, door locks) demand explicit
  // confirmation on every command — IMPLEMENTATION_SPEC Phase F.
  if (device.requiresConfirmation && (raw as { confirm?: unknown })?.confirm !== true) {
    return NextResponse.json(
      { error: "confirmation required", detail: `re-send with "confirm": true to command ${device.label}` },
      { status: 428 },
    );
  }

  // Door locks: the security tier on top of the confirm above. Guests can't
  // operate locks at all, and unlocking re-verifies the caller's account
  // password — a stolen unlocked phone must not open the front door. That
  // rules out the password-less principals too (dev fallback, x-app-key).
  if (device.kind === "lock") {
    if (!canOperateLocks(auth.role)) {
      return NextResponse.json({ error: "locks are not available to guests" }, { status: 403 });
    }
    if (cmd.command === "unlock") {
      const record = getUser(auth.user);
      if (!record) {
        return NextResponse.json(
          { error: "unlocking requires a signed-in user account" },
          { status: 403 },
        );
      }
      const password = (raw as { password?: unknown })?.password;
      if (typeof password !== "string" || !verifyPassword(password, record.passwordHash)) {
        audit({
          ts: new Date().toISOString(), user: auth.user, deviceId, entityId: device.entityId,
          command, args, ok: false, durationMs: 0, security: true, error: "password check failed",
        });
        return NextResponse.json(
          { error: "unlock requires your account password", detail: `re-send with "password" to unlock ${device.label}` },
          { status: 403 },
        );
      }
    }
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
        // On/off via the shared playback path (lib/whitenoise): select_source
        // in Control4 source mode, play_media with the stream URL otherwise.
        if (cmd.command === "turn_on") await noiseTurnOn();
        else await noiseTurnOff();
        // The noise server's listener count is the ground truth: poll a few
        // seconds for the zone to connect (or drop). "confirmed" only when it
        // proves the intent; otherwise "sent" (the play_media may be a no-op
        // if the Control4 integration doesn't support URL playback).
        const wantPlaying = cmd.command === "turn_on";
        const deadline = Date.now() + 8000;
        for (;;) {
          await new Promise((r) => setTimeout(r, 1000));
          listeners = (await noiseStatusFresh().catch(() => null))?.listeners ?? listeners;
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

  // Bed sides command through the eight_sleep services (lib/eightsleep).
  // The Pod's entities can't prove a command took effect (the temp entity
  // just keeps reporting a reading), so the honest status is "sent".
  if (device.kind === "bed") {
    try {
      await executeOnDevice(device, cmd);
      const durationMs = Date.now() - started;
      const message =
        cmd.command === "set_bed_level"
          ? `warmth ${cmd.level > 0 ? "+" : ""}${cmd.level}`
          : cmd.command === "turn_on" ? "side on" : "side off";
      audit({
        ts: new Date().toISOString(), user: auth.user, deviceId, entityId: device.entityId,
        command, args, ok: true, durationMs,
      });
      return NextResponse.json({ status: "sent", state: "unknown", message, durationMs });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      audit({
        ts: new Date().toISOString(), user: auth.user, deviceId, entityId: device.entityId,
        command, args, ok: false, durationMs: Date.now() - started, error: message,
      });
      const clientError = /does not support|out of range|must be/.test(message);
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
    // Media sources vary per zone; the entity's source_list is the authority,
    // so reject anything it doesn't advertise.
    if (cmd.command === "select_source") {
      const s = await getState(device.entityId);
      const list = Array.isArray(s?.attributes.source_list)
        ? (s.attributes.source_list as unknown[]).filter((v) => typeof v === "string")
        : null;
      if (list && !list.includes(cmd.source)) {
        return NextResponse.json(
          { error: `source must be one of: ${list.join(", ")}` },
          { status: 400 },
        );
      }
    }
    // A/C fan strength: the CoolMaster unit's fan_modes is the authority
    // (the Control4 zone entity reports no fan data).
    if (cmd.command === "set_fan_mode") {
      const unitIds = unitEntityIds(device);
      const s = await getState(unitIds?.[0] ?? device.entityId).catch(() => null);
      const list = Array.isArray(s?.attributes?.fan_modes)
        ? (s.attributes.fan_modes as unknown[]).filter((v) => typeof v === "string")
        : null;
      if (list && !list.includes(cmd.fanMode)) {
        return NextResponse.json(
          { error: `fan mode must be one of: ${list.join(", ")}` },
          { status: 400 },
        );
      }
    }
    const call = buildServiceCall(device, cmd);
    await callService(call.domain, call.service, call.data);

    // HA accepted the command — answer NOW ("sent") so the UI settles
    // instantly, and verify in the background (the server is long-lived;
    // same pattern as lib/changeover). Blocking the response on read-back
    // held every tap for the ~4s the Control4 integration takes to poll KNX
    // feedback from the Director (COMMISSIONING_LOG 2026-07-16 / 2026-07-29).
    // The verified/unverified outcome still lands in the audit log: the
    // read-back polls until the state proves the command's intent, and marks
    // the result "(unverified)" when it never does.
    // CoolMaster unit's reported target temperature instead — and climate
    // on/off reads back from the unit too (the bridge reflects in ~1s; the
    // Control4 zone entity lags ~4s behind it).
    // Door locks are the one SYNCHRONOUS exception below: a security state
    // must be proven before it's reported, so the lock card waits for the
    // read-back instead of getting an instant "sent".
    const verifyReadback = async () => {
      const wantedTemp = cmd.command === "set_temperature" ? cmd.temperature : null;
      const climateUnits = unitEntityIds(device);
      const setpointUnits = wantedTemp != null ? climateUnits : null;
      // A multi-unit zone's command targets EVERY unit, so verification must
      // read them all: one unit off with another still running is not a
      // proven zone-wide off (Codex review, PR #89).
      const readbackIds = climateUnits?.length ? climateUnits : [device.entityId];
      type Read = { state: string; attributes: Record<string, unknown> } | null;
      const setpointReached = (ss: Read[]) =>
        !!setpointUnits && ss.every((s) => !!s && s.attributes.temperature === wantedTemp);
      // Fan speed and media source are the other attribute-verified commands:
      // state alone can't prove them, but the entity echoes the accepted
      // value. Both are single-entity commands (vacuum / media zone).
      const wantedFan = cmd.command === "set_fan_speed" ? cmd.fanSpeed : null;
      const fanReached = (ss: Read[]) =>
        wantedFan != null && !!ss[0] && ss[0].attributes.fan_speed === wantedFan;
      const wantedSource = cmd.command === "select_source" ? cmd.source : null;
      const sourceReached = (ss: Read[]) =>
        wantedSource != null && !!ss[0] && ss[0].attributes.source === wantedSource;
      const expected = expectedStates(cmd, device.kind);
      const stateReached = (ss: Read[]) =>
        !!expected && ss.length > 0 && ss.every((s) => !!s && expected.includes(s.state));
      const deadline = Date.now() + 8000;
      let reads: Read[] = [];
      for (;;) {
        await new Promise((r) => setTimeout(r, 700));
        reads = await Promise.all(readbackIds.map((id) => getState(id).catch(() => null)));
        if (setpointUnits) {
          if (setpointReached(reads)) break;
          if (reads.some((s) => !s)) break; // unit entity absent — integration not added yet
        } else if (wantedFan != null) {
          if (fanReached(reads)) break;
        } else if (wantedSource != null) {
          if (sourceReached(reads)) break;
        } else if (!expected) break;
        else if (stateReached(reads)) break;
        if (Date.now() >= deadline) break;
      }
      const verified = setpointUnits
        ? setpointReached(reads)
        : wantedFan != null
          ? fanReached(reads)
          : wantedSource != null
            ? sourceReached(reads)
            : stateReached(reads);
      const seen = [...new Set(reads.filter(Boolean).map((s) => s!.state))].join("/");
      audit({
        ts: new Date().toISOString(),
        user: auth.user,
        deviceId,
        entityId: device.entityId,
        command,
        args,
        ok: true,
        durationMs: Date.now() - started,
        resultState: seen ? `${seen}${verified ? "" : " (unverified)"}` : undefined,
        ...(device.kind === "lock" ? { security: true } : {}),
      });
      return { verified, seen };
    };
    if (device.kind === "lock") {
      const { verified, seen } = await verifyReadback();
      return NextResponse.json({
        status: verified ? "confirmed" : "sent",
        state: seen || "unknown",
        durationMs: Date.now() - started,
      });
    }
    void verifyReadback();
    return NextResponse.json({ status: "sent", state: "pending", durationMs: Date.now() - started });
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
      ...(device.kind === "lock" ? { security: true } : {}),
    });
    const clientError = /does not support|out of range/.test(message);
    return NextResponse.json(
      { status: "failed", error: message },
      { status: clientError ? 400 : 502 },
    );
  }
}

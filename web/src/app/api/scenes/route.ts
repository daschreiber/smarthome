import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";
import { canDeleteRecord, canProgram } from "@/lib/permissions";
import { audit } from "@/lib/audit";
import { getStates } from "@/lib/ha";
import { registry, getDevice } from "@/lib/registry";
import { applySceneById } from "@/lib/execute";
import {
  buildSceneStates, createScene, deleteScene, getScene, listScenes, updateSceneDevice,
  type SceneState,
} from "@/lib/scenes";
import { CommandSchema, assertCommandAllowed } from "@/lib/commands";
import { saunaConfigured, saunaStatus } from "@/lib/sauna";

export async function GET(req: NextRequest) {
  const auth = authenticate(req);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({
    scenes: listScenes().map(({ states, ...meta }) => ({
      ...meta,
      deviceCount: states.length,
      // The pill asks before replaying a heater: the UI needs to know.
      hasSauna: states.some((st) => getDevice(st.deviceId)?.kind === "sauna"),
      canDelete: canDeleteRecord(auth.role, auth.user, meta.createdBy),
    })),
  });
}

export async function POST(req: NextRequest) {
  const auth = authenticate(req);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as
    | {
        action?: "capture" | "apply" | "delete" | "set_device"; name?: string; room?: string; id?: string;
        confirmSauna?: boolean; shades?: "open" | "close";
        deviceId?: string; commands?: unknown[];
      }
    | null;
  if (!body?.action) return NextResponse.json({ error: "action required" }, { status: 400 });
  // Guests can apply scenes but not create, edit, or delete them.
  if ((body.action === "capture" || body.action === "delete" || body.action === "set_device") && !canProgram(auth.role)) {
    return NextResponse.json({ error: "your account can't create or delete scenes" }, { status: 403 });
  }
  const started = Date.now();

  try {
    if (body.action === "capture") {
      if (!body.name || !body.room) {
        return NextResponse.json({ error: "name and room required" }, { status: 400 });
      }
      const states = new Map((await getStates()).map((s) => [s.entity_id, s]));
      const devices = registry().devices.filter((d) => d.room === body.room);
      const sceneStates: SceneState[] = buildSceneStates(devices, states);
      // Shades can't be read (stuck C4 feedback), so they join a scene only
      // when the capturer says what they should do. Omitted = left out.
      if (body.shades === "open" || body.shades === "close") {
        for (const d of devices) {
          if (d.kind === "cover" && d.visible) {
            sceneStates.push({ deviceId: d.id, command: { command: body.shades } });
          }
        }
      }
      // The sauna's truth lives at KLAFS, not in HA — capture it here, and
      // only as it looks now: a running heater at capture time means the
      // scene includes "sauna on" (replayed strictly behind a confirm).
      const saunaDevice = devices.find((d) => d.kind === "sauna");
      if (saunaDevice && saunaConfigured()) {
        const sauna = await saunaStatus().catch(() => null);
        if (sauna?.connected && sauna.poweredOn) {
          sceneStates.push({ deviceId: saunaDevice.id, command: { command: "turn_on" } });
          // Capture the target too — replaying "on" without it fell back to
          // the sauna app's default (85°), not what the capturer had set.
          if (sauna.selectedTemperature >= 40 && sauna.selectedTemperature <= 100) {
            sceneStates.push({
              deviceId: saunaDevice.id,
              command: { command: "set_temperature", temperature: sauna.selectedTemperature },
            });
          }
        }
      }
      const scene = createScene(body.name, body.room, auth.user, sceneStates);
      audit({
        ts: new Date().toISOString(), user: auth.user, deviceId: "scenes", entityId: `scene.${scene.id}`,
        command: "capture_scene", args: { room: body.room, devices: scene.states.length, shades: body.shades ?? "skip" },
        ok: true, durationMs: Date.now() - started,
      });
      return NextResponse.json({ ok: true, scene: { ...scene, deviceCount: scene.states.length } });
    }

    // Surgical scene edit: replace one device's commands, everything else
    // untouched. Same ownership rule as delete (creator or admin), full
    // command validation — a stored command must be one the device could
    // execute today, set-point bounds included (sauna 40-100).
    if (body.action === "set_device") {
      if (!body.id || !body.deviceId || !Array.isArray(body.commands)) {
        return NextResponse.json({ error: "id, deviceId, and commands (array) required" }, { status: 400 });
      }
      const scene = getScene(body.id);
      if (!scene) return NextResponse.json({ error: "no such scene" }, { status: 404 });
      if (!canDeleteRecord(auth.role, auth.user, scene.createdBy)) {
        return NextResponse.json(
          { error: "only the person who created a scene (or an admin) can edit it" },
          { status: 403 },
        );
      }
      const device = getDevice(body.deviceId);
      if (!device) return NextResponse.json({ error: "unknown device" }, { status: 404 });
      // Locks pass capability validation (lock_unlock) but can never replay —
      // lib/execute refuses them — so storing one would create a scene that
      // fails on every apply. Refuse at the door instead (Phase F policy).
      if (device.kind === "lock") {
        return NextResponse.json({ error: "door locks can't be stored in scenes" }, { status: 400 });
      }
      const commands: Array<Record<string, unknown>> = [];
      for (const raw of body.commands) {
        const parsed = CommandSchema.safeParse(raw);
        if (!parsed.success) {
          return NextResponse.json({ error: "invalid command", detail: parsed.error.flatten() }, { status: 400 });
        }
        assertCommandAllowed(device, parsed.data); // throws → 400 below
        commands.push(parsed.data as unknown as Record<string, unknown>);
      }
      const updated = updateSceneDevice(body.id, body.deviceId, commands);
      audit({
        ts: new Date().toISOString(), user: auth.user, deviceId: "scenes", entityId: `scene.${body.id}`,
        command: "set_scene_device", args: { device: body.deviceId, commands }, ok: true,
        durationMs: Date.now() - started,
      });
      return NextResponse.json({ ok: true, scene: { ...updated, deviceCount: updated.states.length } });
    }

    if (body.action === "delete") {
      if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });
      const scene = getScene(body.id);
      if (scene && !canDeleteRecord(auth.role, auth.user, scene.createdBy)) {
        return NextResponse.json(
          { error: "only the person who created a scene (or an admin) can delete it" },
          { status: 403 },
        );
      }
      deleteScene(body.id);
      audit({
        ts: new Date().toISOString(), user: auth.user, deviceId: "scenes", entityId: `scene.${body.id}`,
        command: "delete_scene", args: {}, ok: true, durationMs: 0,
      });
      return NextResponse.json({ ok: true });
    }

    // apply — the sauna heater fires only with this request's explicit
    // confirmSauna (the pill asks); everything else applies regardless.
    if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });
    const result = await applySceneById(body.id, { includeSauna: body.confirmSauna === true });
    audit({
      ts: new Date().toISOString(), user: auth.user, deviceId: "scenes", entityId: `scene.${body.id}`,
      command: "apply_scene", args: { devices: result.total, failed: result.failed.length },
      ok: result.failed.length === 0, durationMs: Date.now() - started,
      error: result.failed.length ? result.failed.map((f) => `${f.target}: ${f.error}`).join("; ") : undefined,
    });
    return NextResponse.json({
      ok: result.failed.length === 0,
      applied: result.total - result.failed.length,
      failed: result.failed.map((f) => f.target),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "scene operation failed" },
      { status: 400 },
    );
  }
}

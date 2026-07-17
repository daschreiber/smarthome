import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { getStates } from "@/lib/ha";
import { registry } from "@/lib/registry";
import { applySceneById } from "@/lib/execute";
import { buildSceneStates, createScene, deleteScene, listScenes } from "@/lib/scenes";

export async function GET(req: NextRequest) {
  const auth = authenticate(req);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({
    scenes: listScenes().map(({ states, ...meta }) => ({ ...meta, deviceCount: states.length })),
  });
}

export async function POST(req: NextRequest) {
  const auth = authenticate(req);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as
    | { action?: "capture" | "apply" | "delete"; name?: string; room?: string; id?: string }
    | null;
  if (!body?.action) return NextResponse.json({ error: "action required" }, { status: 400 });
  const started = Date.now();

  try {
    if (body.action === "capture") {
      if (!body.name || !body.room) {
        return NextResponse.json({ error: "name and room required" }, { status: 400 });
      }
      const states = new Map((await getStates()).map((s) => [s.entity_id, s]));
      const devices = registry().devices.filter((d) => d.room === body.room);
      const scene = createScene(body.name, body.room, auth.user, buildSceneStates(devices, states));
      audit({
        ts: new Date().toISOString(), user: auth.user, deviceId: "scenes", entityId: `scene.${scene.id}`,
        command: "capture_scene", args: { room: body.room, devices: scene.states.length },
        ok: true, durationMs: Date.now() - started,
      });
      return NextResponse.json({ ok: true, scene: { ...scene, deviceCount: scene.states.length } });
    }

    if (body.action === "delete") {
      if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });
      deleteScene(body.id);
      audit({
        ts: new Date().toISOString(), user: auth.user, deviceId: "scenes", entityId: `scene.${body.id}`,
        command: "delete_scene", args: {}, ok: true, durationMs: 0,
      });
      return NextResponse.json({ ok: true });
    }

    // apply
    if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });
    const result = await applySceneById(body.id);
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

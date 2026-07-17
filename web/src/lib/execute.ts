import { CommandSchema, buildServiceCall, type Command } from "./commands";
import { callService } from "./ha";
import { getDevice, registry, type Device } from "./registry";
import { saunaSetTemperature, saunaStart, saunaStop } from "./sauna";
import { getScene } from "./scenes";
import type { Action } from "./automations";

/**
 * Shared command execution used by the API routes, scene application, and
 * the automation scheduler — one path, one set of rules, one audit story.
 * (Read-back confirmation stays in the interactive command route; batch
 * executors here are fire-and-report.)
 */

export async function executeOnDevice(device: Device, cmd: Command): Promise<void> {
  if (device.kind === "sauna") {
    if (cmd.command === "turn_on") await saunaStart();
    else if (cmd.command === "turn_off") await saunaStop();
    else if (cmd.command === "set_temperature") await saunaSetTemperature(cmd.temperature);
    else throw new Error(`sauna does not support ${cmd.command}`);
    return;
  }
  const call = buildServiceCall(device, cmd);
  await callService(call.domain, call.service, call.data);
}

export interface BatchResult {
  total: number;
  failed: Array<{ target: string; error: string }>;
}

async function runBatch(
  jobs: Array<{ target: string; run: () => Promise<void> }>,
): Promise<BatchResult> {
  const results = await Promise.allSettled(jobs.map((j) => j.run()));
  const failed = results
    .map((r, i) =>
      r.status === "rejected"
        ? { target: jobs[i].target, error: r.reason instanceof Error ? r.reason.message : String(r.reason) }
        : null,
    )
    .filter(Boolean) as BatchResult["failed"];
  return { total: jobs.length, failed };
}

export async function applySceneById(sceneId: string): Promise<BatchResult> {
  const scene = getScene(sceneId);
  if (!scene) throw new Error(`no such scene: ${sceneId}`);
  return runBatch(
    scene.states.map((st) => ({
      target: st.deviceId,
      run: async () => {
        const device = getDevice(st.deviceId);
        if (!device) throw new Error("no longer in the registry");
        const parsed = CommandSchema.safeParse(st.command);
        if (!parsed.success) throw new Error("stored command invalid");
        await executeOnDevice(device, parsed.data);
      },
    })),
  );
}

/** Room fan-out: all visible, real lights in a room (scene switches excluded). */
export function roomLights(room: string): Device[] {
  return registry().devices.filter(
    (d) => d.room === room && d.kind === "light" && d.visible && d.category !== "scene_switch",
  );
}

export async function executeAction(action: Action): Promise<BatchResult> {
  if (action.type === "scene") {
    return applySceneById(action.sceneId);
  }
  if (action.type === "room") {
    const lights = roomLights(action.room);
    if (lights.length === 0) return { total: 0, failed: [{ target: action.room, error: "no lights in room" }] };
    const cmd: Command = { command: action.command === "lights_on" ? "turn_on" : "turn_off" };
    return runBatch(lights.map((d) => ({ target: d.id, run: () => executeOnDevice(d, cmd) })));
  }
  // device
  const device = getDevice(action.deviceId);
  if (!device) return { total: 1, failed: [{ target: action.deviceId, error: "unknown device" }] };
  const parsed = CommandSchema.safeParse(action.command);
  if (!parsed.success) return { total: 1, failed: [{ target: action.deviceId, error: "invalid command" }] };
  return runBatch([{ target: device.id, run: () => executeOnDevice(device, parsed.data) }]);
}

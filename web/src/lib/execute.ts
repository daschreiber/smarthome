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

/**
 * Room fan-out: real lights only. Group "Lighting" is the boundary — fans,
 * vents, towel rails (and future switch-like devices such as a white-noise
 * trigger) ride the light domain but must NOT be swept up by "lights off".
 */
export function roomLights(room: string): Device[] {
  return registry().devices.filter(
    (d) =>
      d.room === room &&
      d.kind === "light" &&
      d.visible &&
      d.group === "Lighting" &&
      d.category !== "scene_switch",
  );
}

/**
 * House-wide systems (the /systems screens). Membership is intentionally
 * narrow: "lighting" is real lights only (group Lighting — fans, vents, and
 * towel rails ride the light domain but are NOT lights), "climate" is A/C
 * zones only (never the sauna), "shades" is every cover.
 */
export type SystemKey = "lighting" | "climate" | "heating" | "shades";

export const SYSTEM_COMMANDS: Record<SystemKey, Command["command"][]> = {
  lighting: ["turn_on", "turn_off", "set_brightness"],
  climate: ["turn_on", "turn_off"],
  heating: ["turn_on", "turn_off"],
  shades: ["open", "close", "stop"],
};

export function systemDevices(system: SystemKey): Device[] {
  const all = registry().devices.filter((d) => d.visible);
  switch (system) {
    case "lighting":
      return all.filter((d) => d.kind === "light" && d.group === "Lighting" && d.category !== "scene_switch");
    case "climate":
      return all.filter((d) => d.kind === "climate");
    case "heating":
      return all.filter((d) => d.kind === "heating");
    case "shades":
      return all.filter((d) => d.kind === "cover");
  }
}

/** Fan a simple command across a system, optionally limited to given rooms. */
export async function executeSystemCommand(
  system: SystemKey,
  command: Command["command"],
  rooms?: string[],
  brightnessPct?: number,
): Promise<BatchResult> {
  if (!SYSTEM_COMMANDS[system].includes(command)) {
    throw new Error(`${command} is not a ${system} system command`);
  }
  let targets = systemDevices(system);
  if (rooms && rooms.length > 0) targets = targets.filter((d) => rooms.includes(d.room));
  let cmd: Command = { command } as Command;
  if (command === "set_brightness") {
    if (brightnessPct == null) throw new Error("set_brightness needs brightnessPct");
    // Group dim only touches lights that can actually dim; plain switches
    // keep their current state rather than erroring.
    targets = targets.filter((d) => d.capabilities.includes("brightness"));
    cmd = { command: "set_brightness", brightnessPct };
  }
  if (targets.length === 0) return { total: 0, failed: [{ target: system, error: "no matching devices" }] };
  return runBatch(targets.map((d) => ({ target: d.id, run: () => executeOnDevice(d, cmd) })));
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

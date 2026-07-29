import { CommandSchema, assertCommandAllowed, buildServiceCall, type Command } from "./commands";
import { bedSetLevel, bedSideForDeviceId, bedSideOff, bedSideOn } from "./eightsleep";
import { callService } from "./ha";
import { getDevice, registry, type Device } from "./registry";
import { saunaSetTemperature, saunaStart, saunaStop } from "./sauna";
import { noiseTurnOff, noiseTurnOn, setNoiseVolume } from "./whitenoise";
import { getScene } from "./scenes";
import type { Action, Step } from "./automations";

/**
 * Shared command execution used by the API routes, scene application, and
 * the automation scheduler — one path, one set of rules, one audit story.
 * (Read-back confirmation stays in the interactive command route; batch
 * executors here are fire-and-report.)
 */

export async function executeOnDevice(device: Device, cmd: Command): Promise<void> {
  // Door locks are interactive-only (Phase F security tier): never driven by
  // scenes, automations, or the assistant — all of which execute through
  // here. The command route calls buildServiceCall directly after its role /
  // confirm / password checks, so this refusal costs the lock card nothing.
  if (device.kind === "lock") {
    throw new Error("door locks are operated only from the lock card, never by scenes or automations");
  }
  if (device.kind === "sauna") {
    // Enforce the per-kind safety bounds (sauna 40–100 °C) on EVERY path.
    // The direct command route validates before dispatch, but scenes,
    // automations, the scheduler, and the assistant all reach the heater
    // through here — CommandSchema's outer 5–110 range is not the safety
    // limit, so without this an automation or assistant proposal could set
    // 101–110 °C.
    assertCommandAllowed(device, cmd);
    if (cmd.command === "turn_on") await saunaStart();
    else if (cmd.command === "turn_off") await saunaStop();
    else if (cmd.command === "set_temperature") await saunaSetTemperature(cmd.temperature);
    else throw new Error(`sauna does not support ${cmd.command}`);
    return;
  }
  // White noise is a virtual device: its entity doesn't exist in HA, so it
  // must never reach buildServiceCall (which would target the phantom
  // entity). Same playback path as the interactive card — lib/whitenoise.
  if (device.kind === "noise") {
    assertCommandAllowed(device, cmd);
    if (cmd.command === "turn_on") await noiseTurnOn();
    else if (cmd.command === "turn_off") await noiseTurnOff();
    else if (cmd.command === "set_volume") await setNoiseVolume(cmd.volumePct);
    else throw new Error(`white noise does not support ${cmd.command}`);
    return;
  }
  // Bed sides are real HA entities but command through the eight_sleep
  // integration's own services — lib/eightsleep is their adapter.
  if (device.kind === "bed") {
    assertCommandAllowed(device, cmd);
    const side = bedSideForDeviceId(device.id);
    if (!side) throw new Error("bed side no longer configured");
    if (cmd.command === "turn_on") await bedSideOn(side);
    else if (cmd.command === "turn_off") await bedSideOff(side);
    else if (cmd.command === "set_bed_level") await bedSetLevel(side, cmd.level);
    else throw new Error(`bed does not support ${cmd.command}`);
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

export async function applySceneById(
  sceneId: string,
  opts: { includeSauna?: boolean } = {},
): Promise<BatchResult> {
  const scene = getScene(sceneId);
  if (!scene) throw new Error(`no such scene: ${sceneId}`);
  // The sauna heater replays ONLY behind an explicit per-apply confirmation
  // (the scenes route asks; automations and the assistant never pass it) —
  // the Phase F safety rule survives scenes.
  const states = scene.states.filter(
    (st) => opts.includeSauna || getDevice(st.deviceId)?.kind !== "sauna",
  );
  // Group by device, run each device's commands IN ORDER: climate scenes
  // are (turn_on, set_temperature) pairs, and a parallel batch would race
  // the setpoint against the wake-up.
  const byDevice = new Map<string, typeof states>();
  for (const st of states) byDevice.set(st.deviceId, [...(byDevice.get(st.deviceId) ?? []), st]);
  return runBatch(
    [...byDevice.entries()].map(([deviceId, sts]) => ({
      target: deviceId,
      run: async () => {
        const device = getDevice(deviceId);
        if (!device) throw new Error("no longer in the registry");
        for (const st of sts) {
          const parsed = CommandSchema.safeParse(st.command);
          if (!parsed.success) throw new Error("stored command invalid");
          await executeOnDevice(device, parsed.data);
        }
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

/** System vocabulary lives in lib/commandRules.ts (client-safe, shared
 *  with the /systems pages); re-exported for the routes and tests. */
export { SYSTEM_COMMANDS, type SystemKey } from "./commandRules";
import { SYSTEM_COMMANDS, type SystemKey } from "./commandRules";

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

/**
 * The lights a step switches ON — the set a holdUntil watches over. Room
 * fan-outs and direct device turn-ons count; scenes are not expanded (a
 * hold guards the lights the step names, not everything a scene touches).
 */
export function stepHoldLights(step: Step): Device[] {
  const out = new Map<string, Device>();
  for (const a of step.actions) {
    if (a.type === "room" && a.command === "lights_on") {
      for (const d of roomLights(a.room)) out.set(d.id, d);
    } else if (a.type === "device" && a.command.command === "turn_on") {
      const d = getDevice(a.deviceId);
      if (d && d.kind === "light") out.set(d.id, d);
    }
  }
  return [...out.values()];
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

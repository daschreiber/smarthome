import { CommandSchema, assertCommandAllowed, buildServiceCall, type Command } from "./commands";
import { bedSetLevel, bedSideForDeviceId, bedSideOff, bedSideOn } from "./eightsleep";
import { SLOW_SERVICE_TIMEOUT_MS, callService, getStates } from "./ha";
import {
  DUPLICATE_WINDOW_MS,
  FRAME_POLL_MS,
  FRAME_REASSERT_AFTER_MS,
  FRAME_VERIFY_MS,
  artFrameFollow,
  artFrames,
  claimFrames,
  ownsFrame,
  pressOf,
  recordPress,
  spareWatched,
  sparesWatched,
  type PressScope,
  type SensorRead,
} from "./artframes";
import { audit } from "./audit";
import { TV_ATTEMPTS, mediaAgrees, reassertCall } from "./knxLights";
import { getDevice, registry, type Device } from "./registry";
import { saunaSetTemperature, saunaStart, saunaStop } from "./sauna";
import { noiseTurnOff, noiseTurnOn, setNoiseVolume } from "./whitenoise";
import { getScene } from "./scenes";
import { houseModeById } from "./houseModes";
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
  // A Frame's off is a held power key inside HA's handler — let HA answer
  // (lib/ha SLOW_SERVICE_TIMEOUT_MS) instead of aborting at 5s.
  const opts = device.retryPower ? { timeoutMs: SLOW_SERVICE_TIMEOUT_MS } : {};
  await callService(call.domain, call.service, call.data, opts);
  // No read-back on this path (scenes, automations, the assistant), so a
  // TV whose Wake-on-LAN packet may be ignored gets its cloud wake in the
  // same breath rather than as an escalation: the interactive route
  // re-asserts and escalates (lib/knxLights), this path sends both. A
  // second "on" at a set that is already coming up costs nothing.
  if (cmd.command === "turn_on" && device.kind === "media_player" && device.wakeEntityId) {
    await callService("media_player", "turn_on", { entity_id: device.wakeEntityId }, opts).catch((err) => {
      console.warn(`[execute] ${device.id}: cloud wake via ${device.wakeEntityId} failed:`, err);
    });
  }
}

/**
 * The picture Frames follow a press of the Night or Morning scene switch
 * (lib/artframes): fan the matching power command across every flagged
 * Frame and write one audit line for the sweep. Fire-and-forget by design —
 * the caller has already answered for the press itself. Called from the
 * interactive command route and from executeOnDevice's batch callers alike,
 * so an automation step that presses Night at 23:00 darkens the Frames too.
 */
export async function followArtFrames(device: Device, cmd: Command, user: string, scope: PressScope = {}): Promise<void> {
  const follow = artFrameFollow(device, cmd);
  if (!follow) return;
  const press = pressOf(follow);
  const frames = artFrames(scope.floor, press);
  if (frames.length === 0) return;
  const started = Date.now();
  // One press, one sweep, whichever roads it arrives by (lib/artframes
  // `recordPress`): a repeat inside the window is logged and dropped.
  if (recordPress(press, started, scope.floor)) {
    audit({
      ts: new Date(started).toISOString(),
      user,
      deviceId: "system:artframes",
      entityId: device.entityId,
      command: "frames_duplicate",
      args: { after: device.id, press, ...(scope.floor ? { floor: scope.floor } : {}), windowMs: DUPLICATE_WINDOW_MS },
      ok: true,
      durationMs: 0,
    });
    return;
  }
  // A Night press spares a set that is showing television (lib/artframes).
  // One bulk read; a failed read spares nothing — only positive evidence,
  // and only fresh evidence: the reading's `last_changed` travels with it,
  // because the sensor sticks for days. The door buttons ask for no
  // sparing at all (`scope.spare === false`), and Exit never spares: the
  // house is being left.
  const states = follow.command === "turn_off" && scope.spare !== false && sparesWatched(device)
    ? new Map(
        (await getStates().catch(() => [])).map((s) => [
          s.entity_id,
          { state: s.state, lastChanged: s.last_changed } satisfies SensorRead,
        ]),
      )
    : new Map<string, SensorRead>();
  const { targets, spared } = spareWatched(frames, follow, (id) => states.get(id));
  const token = claimFrames(targets.map((f) => f.id));
  const result = targets.length ? await executeOnDevices(targets, follow) : { total: 0, failed: [] };
  audit({
    ts: new Date().toISOString(),
    user,
    deviceId: "system:artframes",
    entityId: device.entityId,
    command: `frames_${follow.command}`,
    args: {
      after: device.id,
      ...(scope.floor ? { floor: scope.floor } : {}),
      targets: targets.map((f) => f.id),
      ...(spared.length ? { spared: spared.map((f) => f.id) } : {}),
      failed: result.failed,
    },
    ok: result.failed.length === 0,
    durationMs: Date.now() - started,
    error: result.failed.length ? result.failed.map((f) => `${f.target}: ${f.error}`).join("; ") : undefined,
  });
  // The line above says what was sent. Whether the sets obeyed is read back
  // in the background — the caller has long since answered.
  void verifyFrameSweep(targets, follow, user, token, scope);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Read a Frame sweep back and chase the sets that did not obey (lib/artframes
 * FRAME_VERIFY_MS). Only a positive contradiction is re-sent: a set reading
 * unavailable or unknown is waited out — nothing sent at it would land — and
 * re-commanded the moment it comes back still wrong. A set that has once
 * agreed is done, so someone switching the Den TV on a minute after Night is
 * not fought. Writes a line only when there is something to say.
 */
export async function verifyFrameSweep(
  targets: Device[],
  cmd: Command,
  user: string,
  token: number,
  scope: PressScope = {},
): Promise<void> {
  if (targets.length === 0) return;
  const started = Date.now();
  const deadline = started + FRAME_VERIFY_MS;
  const attempts = new Map(targets.map((d) => [d.id, 1]));
  const lastSent = new Map(targets.map((d) => [d.id, started]));
  const lastSeen = new Map<string, string>();
  let waiting = [...targets];

  for (;;) {
    await sleep(FRAME_POLL_MS);
    const states = new Map((await getStates().catch(() => [])).map((s) => [s.entity_id, s.state]));
    waiting = waiting.filter((d) => {
      if (!ownsFrame(d.id, token)) return false;
      const seen = states.get(d.entityId);
      if (seen != null) lastSeen.set(d.id, seen);
      return seen == null || !mediaAgrees(cmd, seen);
    });
    if (waiting.length === 0 || Date.now() >= deadline) break;
    for (const d of waiting) {
      const seen = states.get(d.entityId);
      if (seen == null || seen === "unavailable" || seen === "unknown") continue;
      const n = attempts.get(d.id)!;
      if (n >= TV_ATTEMPTS || Date.now() - lastSent.get(d.id)! < FRAME_REASSERT_AFTER_MS) continue;
      const call = reassertCall(d, cmd, n);
      await callService(call.domain, call.service, call.data, { timeoutMs: SLOW_SERVICE_TIMEOUT_MS }).catch(() => {});
      attempts.set(d.id, n + 1);
      lastSent.set(d.id, Date.now());
    }
  }

  const stuck = waiting.filter((d) => ownsFrame(d.id, token));
  const retried = [...attempts.entries()].filter(([, n]) => n > 1);
  if (stuck.length === 0 && retried.length === 0) return;
  audit({
    ts: new Date().toISOString(),
    user,
    deviceId: "system:artframes",
    entityId: "system.artframes",
    command: `frames_${cmd.command}_verify`,
    args: {
      ...(scope.floor ? { floor: scope.floor } : {}),
      targets: targets.map((f) => f.id),
      reasserted: Object.fromEntries(retried.map(([id, n]) => [id, n - 1])),
      unverified: Object.fromEntries(stuck.map((f) => [f.id, lastSeen.get(f.id) ?? "unread"])),
    },
    ok: stuck.length === 0,
    durationMs: Date.now() - started,
    error: stuck.length
      ? `never obeyed ${cmd.command}: ${stuck.map((f) => `${f.label} (${lastSeen.get(f.id) ?? "unread"})`).join(", ")}`
      : undefined,
  });
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
  opts: { includeSauna?: boolean; user?: string } = {},
): Promise<BatchResult> {
  const scene = getScene(sceneId);
  if (!scene) {
    // A house mode (lib/houseModes: Night, Morning, Exit, Welcome, Main) is
    // a scene id too. Applying it is a press of its KNX scene switch — the
    // one turn_on control_device would send — and the picture Frames follow
    // the press as they do for a scheduled device step below. The saved
    // store is asked first, as lib/mcp resolveSceneRef asks it first, so a
    // stored scene is never shadowed by a mode of the same id (createScene
    // reserves the mode ids; this keeps the precedence for any older
    // record — Codex review, PR #142).
    const mode = houseModeById(sceneId);
    const device = mode ? getDevice(mode.deviceId) : undefined;
    if (!device) throw new Error(`no such scene: ${sceneId}`);
    const cmd: Command = { command: "turn_on" };
    const result = await runBatch([{ target: device.id, run: () => executeOnDevice(device, cmd) }]);
    if (result.failed.length === 0) void followArtFrames(device, cmd, opts.user ?? "automation");
    return result;
  }
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

/**
 * Exactly what a system fan-out will command, without commanding it — the
 * membership rules live here once, so the caller's background verification
 * (lib/knxLights) watches the same set the sweep actually touched.
 */
export function systemTargets(
  system: SystemKey,
  command: Command["command"],
  rooms?: string[],
): Device[] {
  let targets = systemDevices(system);
  if (rooms && rooms.length > 0) targets = targets.filter((d) => rooms.includes(d.room));
  // Group dim only touches lights that can actually dim; plain switches
  // keep their current state rather than erroring.
  if (command === "set_brightness") targets = targets.filter((d) => d.capabilities.includes("brightness"));
  return targets;
}

/** Fan one command across an explicit device list — the callers that first
 *  filter a sweep (the systems route drops unreachable devices) need to
 *  command exactly the set they decided on, not a recomputed one. */
export async function executeOnDevices(targets: Device[], cmd: Command): Promise<BatchResult> {
  return runBatch(targets.map((d) => ({ target: d.id, run: () => executeOnDevice(d, cmd) })));
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
  const targets = systemTargets(system, command, rooms);
  let cmd: Command = { command } as Command;
  if (command === "set_brightness") {
    if (brightnessPct == null) throw new Error("set_brightness needs brightnessPct");
    cmd = { command: "set_brightness", brightnessPct };
  }
  if (targets.length === 0) return { total: 0, failed: [{ target: system, error: "no matching devices" }] };
  return executeOnDevices(targets, cmd);
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
  const result = await runBatch([{ target: device.id, run: () => executeOnDevice(device, parsed.data) }]);
  // A step that presses Night or Morning takes the picture Frames with it.
  if (result.failed.length === 0) void followArtFrames(device, parsed.data, "automation");
  return result;
}

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getDevice, registry, type Device } from "./registry";
import type { HaState } from "./ha";

/**
 * Auto-off timers: "whenever this device turns on, turn it off after N
 * minutes." The trigger is device state, not the clock — the scheduler
 * checks HA's last_changed on every tick, so the countdown starts from the
 * real switch-on moment (wall switch, app, scene, anything) and survives
 * server restarts. If a turn-off command is lost, the rule simply fires
 * again on the next tick until the device is truly off.
 */

export interface TimerRule {
  id: string;
  deviceId: string;
  afterMinutes: number;
  enabled: boolean;
  createdBy: string;
  createdAt: string;
}

function timersPath(): string {
  return process.env.TIMERS_PATH || path.join(process.cwd(), "timers.json");
}

function load(): TimerRule[] {
  try {
    return JSON.parse(fs.readFileSync(timersPath(), "utf8")) as TimerRule[];
  } catch {
    return [];
  }
}

function save(rules: TimerRule[]): void {
  fs.writeFileSync(timersPath(), JSON.stringify(rules, null, 2));
}

export function listTimers(): TimerRule[] {
  return load();
}

export function createTimer(deviceId: string, afterMinutes: number, user: string): TimerRule {
  const device = getDevice(deviceId);
  if (!device || !device.visible) throw new Error("unknown device");
  if (device.kind === "sauna") throw new Error("the sauna manages its own runtime");
  // A bed side's entity is a temperature reading — it's never "on", so an
  // auto-off rule would silently do nothing. Refuse instead of pretending.
  if (device.kind === "bed") throw new Error("the bed manages its own schedule");
  if (!device.capabilities.includes("on_off")) throw new Error("device has no on/off to time out");
  if (!Number.isFinite(afterMinutes) || afterMinutes < 1 || afterMinutes > 720) {
    throw new Error("afterMinutes must be between 1 and 720");
  }
  const rules = load();
  if (rules.some((r) => r.deviceId === deviceId)) {
    throw new Error("this device already has a timer — delete it first");
  }
  const rule: TimerRule = {
    id: crypto.randomBytes(5).toString("hex"),
    deviceId,
    afterMinutes: Math.round(afterMinutes),
    enabled: true,
    createdBy: user,
    createdAt: new Date().toISOString(),
  };
  save([...rules, rule]);
  return rule;
}

export function deleteTimer(id: string): void {
  const rules = load();
  if (!rules.some((r) => r.id === id)) throw new Error("no such timer");
  save(rules.filter((r) => r.id !== id));
}

export function setTimerEnabled(id: string, enabled: boolean): void {
  const rules = load();
  const rule = rules.find((r) => r.id === id);
  if (!rule) throw new Error("no such timer");
  rule.enabled = enabled;
  save(rules);
}

/** Pure: which rules are due to fire, given the current HA states. */
export function dueTimers(
  rules: TimerRule[],
  states: Map<string, HaState>,
  nowMs: number,
): Array<{ rule: TimerRule; device: Device }> {
  const due: Array<{ rule: TimerRule; device: Device }> = [];
  for (const rule of rules) {
    if (!rule.enabled) continue;
    const device = registry().byId.get(rule.deviceId);
    if (!device) continue;
    const st = states.get(device.entityId);
    if (!st || st.state !== "on") continue;
    const changed = Date.parse(st.last_changed);
    if (!Number.isFinite(changed)) continue;
    if (nowMs - changed >= rule.afterMinutes * 60_000) due.push({ rule, device });
  }
  return due;
}

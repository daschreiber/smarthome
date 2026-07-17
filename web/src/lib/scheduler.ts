import { dueSteps, listAutomations, markFired, nowParts } from "./automations";
import { executeAction, executeOnDevice } from "./execute";
import { dueTimers, listTimers } from "./timers";
import { getStates } from "./ha";
import { audit } from "./audit";

/**
 * In-process scheduler: ticks every 30s, fires due automation steps once
 * per minute-key. Started from src/instrumentation.ts in the long-running
 * server. A global guard prevents double-starts under dev HMR.
 */

const GUARD = Symbol.for("smarthome.scheduler");

type GlobalWithGuard = typeof globalThis & { [GUARD]?: boolean };

export function startScheduler(): void {
  const g = globalThis as GlobalWithGuard;
  if (g[GUARD]) return;
  g[GUARD] = true;
  console.log(`[scheduler] started (tz=${process.env.APP_TZ ?? "system"})`);
  setInterval(tick, 30_000).unref?.();
}

export async function tick(): Promise<void> {
  let due: ReturnType<typeof dueSteps>;
  const now = nowParts();
  try {
    due = dueSteps(listAutomations(), now);
  } catch (err) {
    console.error("[scheduler] tick failed:", err);
    return;
  }
  for (const { automation, stepIndex } of due) {
    // Mark first so a slow action can't double-fire on the next tick.
    markFired(automation.id, stepIndex, now);
    const step = automation.steps[stepIndex];
    const started = Date.now();
    const failures: string[] = [];
    let total = 0;
    for (const action of step.actions) {
      try {
        const r = await executeAction(action);
        total += r.total;
        failures.push(...r.failed.map((f) => `${f.target}: ${f.error}`));
      } catch (err) {
        failures.push(err instanceof Error ? err.message : String(err));
      }
    }
    audit({
      ts: new Date().toISOString(),
      user: `automation:${automation.id}`,
      deviceId: "automations",
      entityId: `automation.${automation.id}`,
      command: `fire_step_${stepIndex}`,
      args: { at: step.time, targets: total },
      ok: failures.length === 0,
      durationMs: Date.now() - started,
      error: failures.length ? failures.join("; ") : undefined,
    });
    console.log(
      `[scheduler] ${automation.name} step ${stepIndex} fired at ${now.hhmm}` +
      (failures.length ? ` with ${failures.length} failure(s)` : ""),
    );
  }

  await tickTimers();
}

/**
 * Auto-off timers: turn devices off once they've been on longer than their
 * rule allows. No fired-state to track — once the device is off it stops
 * being due, and if a command is lost the rule retries next tick.
 */
async function tickTimers(): Promise<void> {
  let rules: ReturnType<typeof listTimers>;
  try {
    rules = listTimers().filter((r) => r.enabled);
  } catch (err) {
    console.error("[scheduler] timers load failed:", err);
    return;
  }
  if (rules.length === 0) return; // don't poll HA for nothing
  try {
    const states = new Map((await getStates()).map((s) => [s.entity_id, s]));
    for (const { rule, device } of dueTimers(rules, states, Date.now())) {
      const started = Date.now();
      try {
        await executeOnDevice(device, { command: "turn_off" });
        audit({
          ts: new Date().toISOString(), user: `timer:${rule.id}`, deviceId: device.id,
          entityId: device.entityId, command: "auto_off",
          args: { afterMinutes: rule.afterMinutes }, ok: true, durationMs: Date.now() - started,
        });
        console.log(`[scheduler] auto-off: ${device.id} after ${rule.afterMinutes}min`);
      } catch (err) {
        audit({
          ts: new Date().toISOString(), user: `timer:${rule.id}`, deviceId: device.id,
          entityId: device.entityId, command: "auto_off",
          args: { afterMinutes: rule.afterMinutes }, ok: false, durationMs: Date.now() - started,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    console.error("[scheduler] timers tick failed:", err);
  }
}

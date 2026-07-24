import {
  dueSteps, listAutomations, markFired, nowParts, recordHoldReasserts, stepHoldActive,
  type Step, type SunEvents,
} from "./automations";
import { executeAction, executeOnDevice, stepHoldLights } from "./execute";
import { dueTimers, listTimers } from "./timers";
import { tickSleepwatch } from "./sleepwatch";
import { getStates } from "./ha";
import { sunEvents } from "./sun";
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
    const items = listAutomations();
    // Only consult HA's sun entity when a sun-triggered step could fire.
    let sun: SunEvents | undefined;
    if (items.some((a) => a.enabled && a.steps.some((s) => s.sun))) {
      sun = await sunEvents();
    }
    due = dueSteps(items, now, sun);
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
      args: { at: step.time ?? `${step.sun}${step.sunOffsetMinutes ? `${step.sunOffsetMinutes > 0 ? "+" : ""}${step.sunOffsetMinutes}` : ""}`, targets: total },
      ok: failures.length === 0,
      durationMs: Date.now() - started,
      error: failures.length ? failures.join("; ") : undefined,
    });
    console.log(
      `[scheduler] ${automation.name} step ${stepIndex} fired at ${now.hhmm}` +
      (failures.length ? ` with ${failures.length} failure(s)` : ""),
    );
  }

  await tickHolds(now);
  await tickTimers();
  await tickSleepwatch();
}

/**
 * A hold never wars forever: after this many re-asserts in one firing it
 * logs a single give-up entry and stands down — so a determined external
 * system (or a human at a wall switch) wins within a few minutes, with the
 * whole fight timestamped in the audit log.
 */
export const HOLD_MAX_REASSERTS = 8;

/**
 * holdUntil enforcement: while a fired step's hold window is open, any of
 * its lights reporting "off" gets switched back on. Only positive evidence
 * counts — an entity going unavailable is not a reason to re-command.
 */
async function tickHolds(now: ReturnType<typeof nowParts>): Promise<void> {
  let holds: Array<{ id: string; name: string; stepIndex: number; step: Step }>;
  try {
    holds = [];
    for (const a of listAutomations()) {
      if (!a.enabled) continue;
      a.steps.forEach((step, stepIndex) => {
        if (stepHoldActive(step, now)) holds.push({ id: a.id, name: a.name, stepIndex, step });
      });
    }
  } catch (err) {
    console.error("[scheduler] holds load failed:", err);
    return;
  }
  if (holds.length === 0) return; // don't poll HA for nothing
  try {
    const states = new Map((await getStates()).map((s) => [s.entity_id, s]));
    for (const h of holds) {
      const off = stepHoldLights(h.step).filter((d) => states.get(d.entityId)?.state === "off");
      if (off.length === 0) continue;
      const used = h.step.holdReasserts ?? 0;
      if (used >= HOLD_MAX_REASSERTS) {
        if (used === HOLD_MAX_REASSERTS) {
          // Bump past the cap so the surrender is audited exactly once.
          recordHoldReasserts(h.id, h.stepIndex, used + 1);
          audit({
            ts: new Date().toISOString(), user: `automation:${h.id}`, deviceId: "automations",
            entityId: `automation.${h.id}`, command: `hold_gave_up_step_${h.stepIndex}`,
            args: { after: HOLD_MAX_REASSERTS, stillOff: off.map((d) => d.id) },
            ok: false, durationMs: 0,
            error: `something keeps turning these off — stood down after ${HOLD_MAX_REASSERTS} re-asserts`,
          });
          console.log(`[scheduler] hold: ${h.name} gave up after ${HOLD_MAX_REASSERTS} re-asserts`);
        }
        continue;
      }
      // Count first so a crash mid-command can't reset the budget.
      recordHoldReasserts(h.id, h.stepIndex, used + 1);
      const started = Date.now();
      const failures: string[] = [];
      for (const d of off) {
        try {
          await executeOnDevice(d, { command: "turn_on" });
        } catch (err) {
          failures.push(`${d.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      audit({
        ts: new Date().toISOString(), user: `automation:${h.id}`, deviceId: "automations",
        entityId: `automation.${h.id}`, command: `hold_reassert_step_${h.stepIndex}`,
        args: { relit: off.map((d) => d.id), holdUntil: h.step.holdUntil, attempt: used + 1 },
        ok: failures.length === 0, durationMs: Date.now() - started,
        error: failures.length ? failures.join("; ") : undefined,
      });
      console.log(
        `[scheduler] hold: ${h.name} re-lit ${off.length} light(s), attempt ${used + 1}/${HOLD_MAX_REASSERTS}`,
      );
    }
  } catch (err) {
    console.error("[scheduler] holds tick failed:", err);
  }
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

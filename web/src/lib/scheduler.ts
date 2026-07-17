import { dueSteps, listAutomations, markFired, nowParts } from "./automations";
import { executeAction } from "./execute";
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
}

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

/**
 * App-level automations: time-triggered steps executed by the in-process
 * scheduler (lib/scheduler.ts) in the always-on deployment. The Zod schema
 * is the contract — the Automations UI and the future conversational layer
 * both produce this exact shape.
 *
 * Triggers are clock-based (time + days, or a one-shot date) or sun-based
 * (sunset/sunrise with an optional offset, resolved from Home Assistant's
 * sun.sun entity — see lib/sun.ts). Presence comes later. Missed firings
 * (deploy/restart at the exact minute) are skipped, not replayed —
 * documented behavior.
 */

export const ActionSchema = z.union([
  z.object({ type: z.literal("scene"), sceneId: z.string().min(1) }),
  z.object({
    type: z.literal("room"),
    room: z.string().min(1),
    command: z.enum(["lights_on", "lights_off"]),
  }),
  z.object({
    type: z.literal("device"),
    deviceId: z.string().min(1),
    command: z.record(z.string(), z.unknown()), // validated against CommandSchema at execution
  }),
]);

export const StepSchema = z
  .object({
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "time must be HH:MM").optional(),
    sun: z.enum(["sunset", "sunrise"]).optional(),
    /** Minutes relative to the sun event; negative = before. */
    sunOffsetMinutes: z.number().int().min(-120).max(120).optional(),
    days: z.array(z.number().int().min(0).max(6)).optional(), // 0=Sunday
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), // one-shot
    actions: z.array(ActionSchema).min(1),
    lastFired: z.string().optional(),
    /**
     * Keep the step's lights ON until this house-clock time (may cross
     * midnight). While the hold is active, any of those lights found off is
     * switched back on and the re-assert is audited — so an outside system
     * (a KNX staircase timer, Control4 programming, a wall switch) that
     * fights the automation both loses and leaves a timestamped trail.
     */
    holdUntil: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "holdUntil must be HH:MM").optional(),
    /** Re-asserts spent this firing; reset by markFired. Internal state. */
    holdReasserts: z.number().int().min(0).optional(),
  })
  .refine((s) => (s.time !== undefined) !== (s.sun !== undefined), {
    message: "step needs exactly one of time or sun",
  })
  .refine((s) => s.sunOffsetMinutes === undefined || s.sun !== undefined, {
    message: "sunOffsetMinutes requires sun",
  });

export const AutomationSpecSchema = z.object({
  name: z.string().min(1).max(80),
  steps: z.array(StepSchema).min(1).max(12),
});

export type Action = z.infer<typeof ActionSchema>;
export type Step = z.infer<typeof StepSchema>;
export type AutomationSpec = z.infer<typeof AutomationSpecSchema>;

export interface Automation extends AutomationSpec {
  id: string;
  enabled: boolean;
  createdBy: string;
  createdAt: string;
  /**
   * What Away mode does to this automation. Absent = "pause" (the default
   * the mode exists for); "run" marks the exceptions that should keep firing
   * in an empty house, like evening presence lighting. See lib/away.ts.
   */
  awayBehavior?: "pause" | "run";
}

function storePath(): string {
  return process.env.AUTOMATIONS_PATH || path.join(process.cwd(), "automations.json");
}

function load(): Automation[] {
  try {
    return JSON.parse(fs.readFileSync(storePath(), "utf8")) as Automation[];
  } catch {
    return [];
  }
}

function save(items: Automation[]): void {
  fs.writeFileSync(storePath(), JSON.stringify(items, null, 2));
}

export function listAutomations(): Automation[] {
  return load();
}

export function createAutomation(spec: AutomationSpec, createdBy: string): Automation {
  const items = load();
  const base = spec.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "automation";
  let id = base;
  let n = 2;
  while (items.some((a) => a.id === id)) id = `${base}_${n++}`;
  const auto: Automation = { ...spec, id, enabled: true, createdBy, createdAt: new Date().toISOString() };
  items.push(auto);
  save(items);
  return auto;
}

export function deleteAutomation(id: string): void {
  const items = load();
  if (!items.some((a) => a.id === id)) throw new Error("no such automation");
  save(items.filter((a) => a.id !== id));
}

export function setEnabled(id: string, enabled: boolean): void {
  const items = load();
  const a = items.find((x) => x.id === id);
  if (!a) throw new Error("no such automation");
  a.enabled = enabled;
  save(items);
}

/** Mark whether this automation keeps firing while Away mode is on. */
export function setAwayBehavior(id: string, behavior: "pause" | "run"): void {
  const items = load();
  const a = items.find((x) => x.id === id);
  if (!a) throw new Error("no such automation");
  a.awayBehavior = behavior;
  save(items);
}

/**
 * Replace an automation's name and steps in place, keeping its id, enabled
 * state, and creator. New steps carry no lastFired, so editing resets the
 * firing state — an edited step fires again at its next due minute.
 */
export function updateAutomation(id: string, spec: AutomationSpec): Automation {
  const items = load();
  const a = items.find((x) => x.id === id);
  if (!a) throw new Error("no such automation");
  a.name = spec.name;
  a.steps = spec.steps;
  save(items);
  return a;
}

/** Local wall-clock parts in the app's timezone. */
export function nowParts(d = new Date(), tz = process.env.APP_TZ): {
  hhmm: string; day: number; date: string;
} {
  const timeZone = tz || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone, hour: "2-digit", minute: "2-digit", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  // en-GB can render midnight as "24:00"; normalize.
  const hour = get("hour") === "24" ? "00" : get("hour");
  return {
    hhmm: `${hour}:${get("minute")}`,
    day: days.indexOf(get("weekday")),
    date: `${get("year")}-${get("month")}-${get("day")}`,
  };
}

/** Recent sun event instants (epoch ms), oldest first — see lib/sun.ts. */
export interface SunEvents { sunrise: number[]; sunset: number[] }

export function stepIsDue(
  step: Step,
  now: ReturnType<typeof nowParts>,
  sun?: SunEvents,
): boolean {
  if (step.sun) {
    // Due when any known event instant, shifted by the offset, lands on this
    // exact house-clock minute. Multiple instants are checked because after
    // the event passes HA's next_* flips to tomorrow, while a positive
    // offset still has to fire against today's (cached) instant.
    const events = sun?.[step.sun] ?? [];
    const offsetMs = (step.sunOffsetMinutes ?? 0) * 60_000;
    const hit = events.some((t) => {
      const p = nowParts(new Date(t + offsetMs));
      return p.date === now.date && p.hhmm === now.hhmm;
    });
    if (!hit) return false;
  } else if (step.time !== now.hhmm) return false;
  if (step.date && step.date !== now.date) return false;
  if (step.days && step.days.length > 0 && !step.days.includes(now.day)) return false;
  const fireKey = `${now.date}T${now.hhmm}`;
  if (step.lastFired === fireKey) return false; // already fired this minute
  return true;
}

/** Returns due (automation, stepIndex) pairs without mutating anything. */
export function dueSteps(
  items: Automation[],
  now: ReturnType<typeof nowParts>,
  sun?: SunEvents,
): Array<{ automation: Automation; stepIndex: number }> {
  const due: Array<{ automation: Automation; stepIndex: number }> = [];
  for (const a of items) {
    if (!a.enabled) continue;
    a.steps.forEach((s, i) => {
      if (stepIsDue(s, now, sun)) due.push({ automation: a, stepIndex: i });
    });
  }
  return due;
}

/**
 * Record a firing; one-shot automations (every step dated) disable
 * themselves once every step has fired.
 */
export function markFired(id: string, stepIndex: number, now: ReturnType<typeof nowParts>): void {
  const items = load();
  const a = items.find((x) => x.id === id);
  if (!a || !a.steps[stepIndex]) return;
  a.steps[stepIndex].lastFired = `${now.date}T${now.hhmm}`;
  a.steps[stepIndex].holdReasserts = 0; // each firing gets a fresh hold budget
  const allOneShot = a.steps.every((s) => s.date);
  if (allOneShot && a.steps.every((s) => s.lastFired)) a.enabled = false;
  save(items);
}

function nextDate(date: string): string {
  // Date-only strings parse as UTC midnight, so +24h is exact.
  return new Date(Date.parse(date) + 86_400_000).toISOString().slice(0, 10);
}

/**
 * Is this step's holdUntil window open right now? The window runs from the
 * minute AFTER the step fired (the firing minute already ran the actions)
 * until holdUntil, rolling past midnight when holdUntil is earlier on the
 * clock than the firing time. `YYYY-MM-DDTHH:MM` keys compare lexically.
 */
export function stepHoldActive(step: Step, now: ReturnType<typeof nowParts>): boolean {
  if (!step.holdUntil || !step.lastFired) return false;
  const [firedDate, firedHhmm] = step.lastFired.split("T");
  if (!firedDate || !firedHhmm) return false;
  const end = step.holdUntil > firedHhmm
    ? `${firedDate}T${step.holdUntil}`
    : `${nextDate(firedDate)}T${step.holdUntil}`;
  const key = `${now.date}T${now.hhmm}`;
  return key > step.lastFired && key < end;
}

/** Persist the hold's re-assert count (see scheduler.tickHolds). */
export function recordHoldReasserts(id: string, stepIndex: number, count: number): void {
  const items = load();
  const s = items.find((x) => x.id === id)?.steps[stepIndex];
  if (!s) return;
  s.holdReasserts = count;
  save(items);
}

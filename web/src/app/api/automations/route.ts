import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";
import { canDeleteRecord, canProgram } from "@/lib/permissions";
import { audit } from "@/lib/audit";
import {
  AutomationSpecSchema, createAutomation, deleteAutomation, listAutomations, setActiveWhen,
  setEnabled, updateAutomation,
} from "@/lib/automations";
import { ACTIVE_WHEN_VALUES, isAway, type ActiveWhen } from "@/lib/away";
import { executeAction } from "@/lib/execute";
import { nextSun } from "@/lib/sun";

export async function GET(req: NextRequest) {
  const auth = authenticate(req);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  // nextSun is TTL-cached and swallows HA failures (nulls), so listing
  // automations never breaks on a flaky upstream.
  return NextResponse.json({
    automations: listAutomations().map((a) => ({
      ...a,
      canDelete: canDeleteRecord(auth.role, auth.user, a.createdBy),
    })),
    tz: process.env.APP_TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    sun: await nextSun(),
    away: isAway(),
  });
}

export async function POST(req: NextRequest) {
  const auth = authenticate(req);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as
    | {
        action?: "create" | "update" | "delete" | "toggle" | "active_when" | "run";
        id?: string; enabled?: boolean; activeWhen?: string; spec?: unknown;
      }
    | null;
  if (!body?.action) return NextResponse.json({ error: "action required" }, { status: 400 });
  // "Run now" operates devices rather than programming automations — the
  // same commands any signed-in user can issue from the room screens — so
  // it skips the programmer gate that protects the mutations below.
  if (!canProgram(auth.role) && body.action !== "run") {
    return NextResponse.json({ error: "your account can't change automations" }, { status: 403 });
  }

  try {
    if (body.action === "create") {
      const parsed = AutomationSpecSchema.safeParse(body.spec);
      if (!parsed.success) {
        return NextResponse.json({ error: "invalid automation", detail: parsed.error.flatten() }, { status: 400 });
      }
      const auto = createAutomation(parsed.data, auth.user);
      audit({
        ts: new Date().toISOString(), user: auth.user, deviceId: "automations",
        entityId: `automation.${auto.id}`, command: "create_automation",
        args: { steps: auto.steps.length }, ok: true, durationMs: 0,
      });
      return NextResponse.json({ ok: true, automation: auto });
    }
    if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });
    if (body.action === "run") {
      const target = listAutomations().find((a) => a.id === body.id);
      if (!target) return NextResponse.json({ error: "unknown automation" }, { status: 404 });
      // Fire every step's actions immediately, in order — the scheduler's
      // loop, minus markFired: a manual run must not eat today's scheduled
      // firing or touch lastFired.
      const started = Date.now();
      const failures: string[] = [];
      let total = 0;
      for (const step of target.steps) {
        for (const action of step.actions) {
          try {
            const r = await executeAction(action);
            total += r.total;
            failures.push(...r.failed.map((f) => `${f.target}: ${f.error}`));
          } catch (err) {
            failures.push(err instanceof Error ? err.message : String(err));
          }
        }
      }
      audit({
        ts: new Date().toISOString(), user: auth.user, deviceId: "automations",
        entityId: `automation.${target.id}`, command: "run_automation",
        args: { targets: total }, ok: failures.length === 0,
        durationMs: Date.now() - started,
        error: failures.length ? failures.join("; ") : undefined,
      });
      if (failures.length) {
        return NextResponse.json(
          { error: `ran with ${failures.length} failure(s): ${failures.join("; ")}` },
          { status: 502 },
        );
      }
      return NextResponse.json({ ok: true, targets: total });
    }
    if (body.action === "update") {
      const parsed = AutomationSpecSchema.safeParse(body.spec);
      if (!parsed.success) {
        return NextResponse.json({ error: "invalid automation", detail: parsed.error.flatten() }, { status: 400 });
      }
      const auto = updateAutomation(body.id, parsed.data);
      audit({
        ts: new Date().toISOString(), user: auth.user, deviceId: "automations",
        entityId: `automation.${auto.id}`, command: "update_automation",
        args: { steps: auto.steps.length }, ok: true, durationMs: 0,
      });
      return NextResponse.json({ ok: true, automation: auto });
    }
    if (body.action === "delete") {
      const target = listAutomations().find((a) => a.id === body.id);
      if (target && !canDeleteRecord(auth.role, auth.user, target.createdBy)) {
        return NextResponse.json(
          { error: "only the person who created an automation (or an admin) can delete it" },
          { status: 403 },
        );
      }
      deleteAutomation(body.id);
      audit({
        ts: new Date().toISOString(), user: auth.user, deviceId: "automations",
        entityId: `automation.${body.id}`, command: "delete_automation", args: {}, ok: true, durationMs: 0,
      });
      return NextResponse.json({ ok: true });
    }
    if (body.action === "active_when") {
      if (!ACTIVE_WHEN_VALUES.includes(body.activeWhen as ActiveWhen)) {
        return NextResponse.json({ error: "activeWhen must be always, home, or away" }, { status: 400 });
      }
      setActiveWhen(body.id, body.activeWhen as ActiveWhen);
      audit({
        ts: new Date().toISOString(), user: auth.user, deviceId: "automations",
        entityId: `automation.${body.id}`, command: "set_active_when",
        args: { activeWhen: body.activeWhen }, ok: true, durationMs: 0,
      });
      return NextResponse.json({ ok: true });
    }
    // toggle
    setEnabled(body.id, body.enabled !== false);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "failed" }, { status: 400 });
  }
}

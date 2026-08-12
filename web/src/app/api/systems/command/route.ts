import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authenticate } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { executeOnDevices, systemTargets } from "@/lib/execute";
import { SYSTEM_COMMANDS } from "@/lib/commandRules";
import { getStates } from "@/lib/ha";
import { claimLight, verifyLightSweep } from "@/lib/knxLights";
import { deviceUnreachable } from "@/lib/reachability";
import type { Command } from "@/lib/commands";

/**
 * House-wide system commands ("all lights off", "all A/C off", room subsets).
 * Fire-and-report like scenes: each device call either succeeds or is listed
 * in `failed`; the UI's normal state polling shows the resulting truth.
 */

const Body = z.object({
  system: z.enum(["lighting", "climate", "heating", "shades"]),
  command: z.enum(["turn_on", "turn_off", "open", "close", "stop", "set_brightness"]),
  rooms: z.array(z.string()).max(50).optional(),
  brightnessPct: z.number().int().min(1).max(100).optional(),
  confirm: z.boolean().optional(),
});

export async function POST(req: NextRequest) {
  const auth = authenticate(req);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid request" }, { status: 400 });
  const { system, command, rooms, brightnessPct, confirm } = parsed.data;
  if (!SYSTEM_COMMANDS[system].includes(command)) {
    return NextResponse.json({ error: `${command} is not a ${system} system command` }, { status: 400 });
  }
  // Whole-house scope is disruptive; the UI's two-tap confirm must be enforced
  // here, or a direct request bypasses it. Room-scoped subsets are ordinary
  // quick controls and don't require confirmation.
  const wholeHouse = !rooms || rooms.length === 0;
  if (wholeHouse && confirm !== true) {
    return NextResponse.json(
      { error: "confirmation required", detail: `whole-house ${system} commands must re-send with "confirm": true` },
      { status: 428 },
    );
  }
  if (command === "set_brightness" && brightnessPct == null) {
    return NextResponse.json({ error: "set_brightness needs brightnessPct" }, { status: 400 });
  }

  const started = Date.now();
  try {
    const targets = systemTargets(system, command, rooms);
    if (targets.length === 0) {
      return NextResponse.json({ error: "no matching devices" }, { status: 400 });
    }
    const cmd = (command === "set_brightness"
      ? { command, brightnessPct: brightnessPct! }
      : { command }) as Command;

    // Drop the devices Home Assistant reports unreachable BEFORE the fan-out:
    // a service call at an "unavailable" entity returns 200 and does nothing
    // (the Control4 outage, 2026-08-12), so commanding them would report a
    // sweep as sent while half the house ignores it. Only positive evidence
    // excludes (lib/reachability) — and if the bulk read itself fails, the
    // sweep proceeds blind rather than refusing on our own hiccup.
    const states = await getStates()
      .then((ss) => new Map(ss.map((s) => [s.entity_id, s])))
      .catch(() => null);
    const unreachable = states ? targets.filter((d) => deviceUnreachable(d, (id) => states.get(id) ?? null)) : [];
    const reachable = targets.filter((d) => !unreachable.includes(d));
    if (reachable.length === 0) {
      const message = `none of the ${targets.length} ${system} device${targets.length === 1 ? " is" : "s are"} responding — Home Assistant reports them unavailable (its integration may be down)`;
      audit({
        ts: new Date().toISOString(), user: auth.user, deviceId: `system:${system}`,
        entityId: `system.${system}`, command, args: { rooms: rooms ?? "all", targets: targets.length },
        ok: false, durationMs: Date.now() - started, error: message,
      });
      return NextResponse.json({ error: message }, { status: 503 });
    }

    // "Room lights on" is one request but many KNX telegrams, and each can go
    // missing on its own — the room that came up half-lit is the same defect
    // a single tap hits. So the sweep claims every fixture it's about to
    // touch (standing down any verifier still running on them), fans the
    // command out, then verifies and re-asserts in the background — the
    // response stays instant. Only the reachable set is claimed and watched:
    // an unreachable light was never commanded, so the verifier must not
    // spend 16s waiting on it and then blame it for disobeying.
    const lights = system === "lighting" ? reachable : [];
    const tokens = new Map(lights.map((d) => [d.id, claimLight(d.id)]));
    const result = await executeOnDevices(reachable, cmd);
    if (lights.length) {
      void verifyLightSweep(lights, cmd, auth.user, rooms?.length === 1 ? rooms[0] : null, tokens);
    }
    // Skipped-unreachable devices ride the failed list: the sweep did NOT
    // reach them, and "ok" must not claim the whole house obeyed.
    const failed = [
      ...result.failed.map((f) => f.target),
      ...unreachable.map((d) => d.id),
    ];
    audit({
      ts: new Date().toISOString(), user: auth.user, deviceId: `system:${system}`,
      entityId: `system.${system}`, command,
      args: {
        rooms: rooms ?? "all", targets: targets.length, failed: failed.length,
        ...(unreachable.length ? { unreachable: unreachable.map((d) => d.id) } : {}),
      },
      ok: failed.length === 0, durationMs: Date.now() - started,
      error: [
        ...result.failed.map((f) => `${f.target}: ${f.error}`),
        ...unreachable.map((d) => `${d.id}: unavailable in Home Assistant`),
      ].join("; ") || undefined,
    });
    return NextResponse.json({
      ok: failed.length === 0,
      targets: targets.length,
      failed,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "system command failed";
    audit({
      ts: new Date().toISOString(), user: auth.user, deviceId: `system:${system}`,
      entityId: `system.${system}`, command, args: { rooms: rooms ?? "all" },
      ok: false, durationMs: Date.now() - started, error: message,
    });
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

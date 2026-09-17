import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";
import { canProgram } from "@/lib/permissions";
import { followArtFrames } from "@/lib/execute";
import { duplicatePress } from "@/lib/artframes";
import { hookConfigured, hookKeyMatches, parsePress, parseScope, pressUser, sceneSwitchFor } from "@/lib/artframesHook";

/**
 * A press of Night or Morning that did not come through the app — the wall
 * keypad (a KNX bus event) or Alexa / Siri / the HA dashboard (a service
 * call), relayed by a Home Assistant automation (ha/artframes_keypad.yaml).
 * Runs the same Frame follower a card tap runs (lib/artframes, lib/execute
 * `followArtFrames`).
 *
 * Since 2026-09-17 the three buttons by the front door come the same way:
 * "Lights 6" / "Lights 5" as night (off) or morning (on) with `floor`, and
 * "Exit" as night for the whole house — all with `spare: false`.
 *
 * Callers: Home Assistant with `x-hook-key: <HA_HOOK_KEY>`, or a signed-in
 * account that may program automations (a hand test from the browser).
 * Answers as soon as the sweep is started — HA's rest_command has a short
 * timeout and a Frame's held power key alone takes ~8 s.
 */
export async function POST(req: NextRequest) {
  const viaHook = hookKeyMatches(req.headers.get("x-hook-key"));
  if (!viaHook) {
    const auth = authenticate(req);
    if (!auth.ok || !canProgram(auth.role)) {
      // Say why when the hook is simply not set up yet, so the HA side
      // sees a message it can act on rather than a bare 401.
      if (!hookConfigured() && !auth.ok) {
        return NextResponse.json({ error: "HA_HOOK_KEY is not set" }, { status: 503 });
      }
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }
  const body = (await req.json().catch(() => null)) as
    | { press?: unknown; source?: unknown; floor?: unknown; spare?: unknown }
    | null;
  const press = parsePress(body?.press);
  if (!press) {
    return NextResponse.json({ error: 'press must be "night" or "morning"' }, { status: 400 });
  }
  // The buttons by the front door reach one floor's Frames, and spare
  // nothing (lib/artframes `PressScope`).
  const scope = parseScope(body);
  if (!scope) {
    return NextResponse.json({ error: "floor must be 5 or 6 when given" }, { status: 400 });
  }
  const device = sceneSwitchFor(press);
  if (!device) {
    return NextResponse.json({ error: `the ${press} scene switch is not in the entity map` }, { status: 500 });
  }
  // The follower itself drops a repeat (and audits it); this peek only
  // lets HA's trace say so — the app's own press relayed back a second
  // later is the everyday case.
  if (duplicatePress(press, Date.now(), scope.floor)) {
    return NextResponse.json({ status: "duplicate", press, ...scope });
  }
  const user = viaHook ? pressUser(body?.source) : authenticate(req).user;
  // Fire-and-forget, like the command route: the press has happened
  // already; the sweep audits itself (`system:artframes`).
  void followArtFrames(device, { command: "turn_on" }, user, scope);
  return NextResponse.json({ status: "accepted", press, ...scope }, { status: 202 });
}

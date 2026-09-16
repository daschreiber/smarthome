import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";
import { canProgram } from "@/lib/permissions";
import { followArtFrames } from "@/lib/execute";
import {
  duplicatePress,
  hookConfigured,
  hookKeyMatches,
  parsePress,
  pressUser,
  sceneSwitchFor,
} from "@/lib/artframesHook";

/**
 * A press of Night or Morning that did not come through the app — the wall
 * keypad, relayed by a Home Assistant automation on the KNX bus event
 * (ha/artframes_keypad.yaml). Runs the same Frame follower a card tap runs
 * (lib/artframes, lib/execute `followArtFrames`).
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
  const body = (await req.json().catch(() => null)) as { press?: unknown; source?: unknown } | null;
  const press = parsePress(body?.press);
  if (!press) {
    return NextResponse.json({ error: 'press must be "night" or "morning"' }, { status: 400 });
  }
  const device = sceneSwitchFor(press);
  if (!device) {
    return NextResponse.json({ error: `the ${press} scene switch is not in the entity map` }, { status: 500 });
  }
  if (duplicatePress(press)) {
    return NextResponse.json({ status: "duplicate", press });
  }
  const user = viaHook ? pressUser(body?.source) : authenticate(req).user;
  // Fire-and-forget, like the command route: the press has happened on the
  // wall already; the sweep audits itself (`system:artframes`).
  void followArtFrames(device, { command: "turn_on" }, user);
  return NextResponse.json({ status: "accepted", press }, { status: 202 });
}

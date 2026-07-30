import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { audioRooms, dropRoom, extendAudio, readZone } from "@/lib/audio";

/** The read-back loop in extendAudio waits on Control4's ~4s feedback lag. */
export const maxDuration = 30;

/**
 * "Play this in the Kitchen too": mirror one room's input into others over
 * the Control4 matrix (lib/audio explains why this is a matrix job and not
 * a Spotify one), and drop rooms back out again.
 *
 * Every outcome is reported per room and read back from the zone, because
 * the honest answer here is sometimes "asked, but the zone never echoed
 * it". A green tick the hardware didn't earn would be worse than useless in
 * a house where the owner is standing in the room listening.
 */
export async function POST(req: NextRequest) {
  const auth = authenticate(req);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as
    | { from?: unknown; add?: unknown; remove?: unknown }
    | null;
  const from = typeof body?.from === "string" ? body.from : null;
  const rooms = audioRooms();
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  const add = strings(body?.add).filter((r) => r !== from);
  const remove = strings(body?.remove).filter((r) => r !== from);

  if (!from || !rooms.includes(from)) {
    return NextResponse.json({ error: `${from ?? "that room"} has no Control4 audio zone` }, { status: 400 });
  }
  const unknown = [...add, ...remove].find((r) => !rooms.includes(r));
  if (unknown) return NextResponse.json({ error: `${unknown} has no Control4 audio zone` }, { status: 400 });
  if (!add.length && !remove.length) {
    return NextResponse.json({ error: "name at least one room to add or remove" }, { status: 400 });
  }

  const started = Date.now();
  try {
    const origin = await readZone(from);
    if (!origin) {
      return NextResponse.json({ error: `the ${from} zone isn't reachable right now` }, { status: 502 });
    }

    const { source, results } = add.length
      ? await extendAudio(origin, add)
      : { source: origin.source, results: [] };

    const dropped: Array<{ room: string; ok: boolean; detail: string }> = [];
    for (const room of remove) {
      try {
        await dropRoom(room);
        dropped.push({ room, ok: true, detail: "switched off" });
      } catch (err) {
        dropped.push({ room, ok: false, detail: err instanceof Error ? err.message : "could not switch off" });
      }
    }

    const failed = results.filter((r) => r.status === "failed");
    audit({
      ts: new Date().toISOString(), user: auth.user, deviceId: `music:${from}`,
      entityId: origin.entityId, command: "audio_extend",
      args: { from, add, remove, source },
      ok: failed.length === 0,
      durationMs: Date.now() - started,
      resultState: results.map((r) => `${r.room}:${r.status}`).join(" ") || undefined,
      error: failed.length ? failed.map((r) => `${r.room}: ${r.detail}`).join("; ") : undefined,
    });

    return NextResponse.json({ ok: true, source, results, dropped });
  } catch (err) {
    const message = err instanceof Error ? err.message : "extend failed";
    audit({
      ts: new Date().toISOString(), user: auth.user, deviceId: `music:${from}`,
      entityId: from, command: "audio_extend", args: { from, add, remove },
      ok: false, durationMs: Date.now() - started, error: message,
    });
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

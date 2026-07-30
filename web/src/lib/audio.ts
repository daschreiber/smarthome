import { callService, getState } from "./ha";

/**
 * Multi-room audio: putting what one room is playing into other rooms too.
 *
 * The mechanism is the Control4 matrix, not Spotify. Spotify Connect cannot
 * do this at all — one account has exactly one playback session, so
 * targeting a second "Spotify C4 <Room>" endpoint MOVES the music rather
 * than copying it (that is the behaviour the owner was unhappy with). The
 * matrix, on the other hand, exists to fan one source out to many zones:
 * selecting the same input on the Kitchen as the Lounge is already playing
 * gives both rooms the same audio, which is what "extend" means here.
 *
 * Two consequences worth knowing before reading the code:
 *
 * 1. Only a NAMED source can be mirrored. A zone reports the input it is on
 *    in `source`, and the target must list that same name in its
 *    `source_list` — verified against the live entity, never assumed.
 * 2. The Core's own Spotify sessions are the awkward case. When a
 *    "Spotify C4 <Room>" session plays, the zone reports the track in
 *    `media_title` but `source` reads None — the session is not in
 *    `source_list` (docs/AUDIO_SYSTEM.md). There is nothing to name, so
 *    there is nothing to mirror, UNLESS the Core's streamer also appears as
 *    a matrix input. It probably does: the unidentified
 *    "Unknown Device - 42949662xx" inputs are most likely exactly that.
 *    Once one is identified by ear, naming it in SPOTIFY_MIRROR_SOURCE
 *    turns extend on for Spotify too. Until then this says so plainly
 *    instead of pretending the command worked.
 *
 * Zone grouping (HA `media_player.join`) is deliberately not attempted: the
 * Control4 zones don't advertise the GROUPING feature (supported_features
 * 23821), so a join call could only ever fail.
 */

/**
 * Room -> its Control4 matrix zone entity. Explicit because a room can hold
 * more than one media_player and the names don't disambiguate: Balcony
 * (6th) has both the C4 zone (`media_player.balcony_2`) and the un-cabled
 * VSSL amp (`media_player.balcony`), and picking the wrong one sends the
 * command into a dead streamer. Mirrors the table in docs/AUDIO_SYSTEM.md.
 */
const ROOM_ZONE: Record<string, string> = {
  "Den": "media_player.den",
  "Lounge": "media_player.lounge",
  "Kitchen": "media_player.kitchen",
  "Terrace": "media_player.terrace",
  "Balcony (6th)": "media_player.balcony_2",
  "Master Bedroom": "media_player.master_bedroom",
  "Master Bathroom": "media_player.master_bathroom",
  "Master Bedroom Balcony": "media_player.master_bedroom_balcony",
};

export function zoneEntity(room: string): string | null {
  return ROOM_ZONE[room] ?? null;
}

/**
 * Reverse of ROOM_ZONE: the audio room an entity is the matrix zone for.
 * The room view uses it to tell the real zone apart from the other media
 * players sharing a room, so "extend" offers the speakers that can actually
 * take a matrix source and not, say, the dead VSSL amp on the Terrace.
 */
export function zoneRoomFor(entityId: string): string | null {
  const hit = Object.entries(ROOM_ZONE).find(([, id]) => id === entityId);
  return hit ? hit[0] : null;
}

/** Rooms that can take part in extend, in the order the UI should list them. */
export function audioRooms(): string[] {
  return Object.keys(ROOM_ZONE);
}

export interface ZoneReading {
  room: string;
  entityId: string;
  state: string;
  source: string | null;
  sourceList: string[];
  mediaTitle: string | null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

export async function readZone(room: string): Promise<ZoneReading | null> {
  const entityId = ROOM_ZONE[room];
  if (!entityId) return null;
  const s = await getState(entityId).catch(() => null);
  if (!s) return null;
  return {
    room,
    entityId,
    state: s.state,
    source: str(s.attributes.source),
    sourceList: Array.isArray(s.attributes.source_list)
      ? (s.attributes.source_list as unknown[]).filter((v): v is string => typeof v === "string")
      : [],
    mediaTitle: str(s.attributes.media_title),
  };
}

export type ExtendStatus = "confirmed" | "sent" | "failed";

export interface ExtendResult {
  room: string;
  status: ExtendStatus;
  detail: string;
}

/**
 * What the origin room is playing, as something a target zone can be told
 * to select. Returns the source name, or an explanation of why there isn't
 * one — which the caller shows verbatim rather than inventing a failure.
 */
export function mirrorSourceFor(origin: ZoneReading): { source: string | null; why: string } {
  if (origin.source) return { source: origin.source, why: "" };
  const configured = process.env.SPOTIFY_MIRROR_SOURCE;
  if (origin.mediaTitle && configured) return { source: configured, why: "" };
  if (origin.mediaTitle) {
    return {
      source: null,
      why:
        `the ${origin.room} is playing a Spotify session from the Control4 Core, which the matrix ` +
        `doesn't expose as a named input — set SPOTIFY_MIRROR_SOURCE to the matrix input that ` +
        `carries the Core's streamer to extend it (docs/AUDIO_SYSTEM.md)`,
    };
  }
  return { source: null, why: `the ${origin.room} isn't playing anything to extend` };
}

/**
 * Mirror the origin room's input into each target zone, then read back to
 * see whether it actually landed. The verify loop is the point: the whole
 * feature rests on a matrix behaviour that has never been exercised from
 * this app, so a target that silently ignores select_source must report
 * "sent", not success.
 */
export async function extendAudio(
  origin: ZoneReading,
  targets: string[],
): Promise<{ source: string | null; results: ExtendResult[] }> {
  const { source, why } = mirrorSourceFor(origin);
  if (!source) {
    return { source: null, results: targets.map((room) => ({ room, status: "failed", detail: why })) };
  }

  const results: ExtendResult[] = [];
  const pending: ZoneReading[] = [];

  for (const room of targets) {
    const zone = await readZone(room);
    if (!zone) {
      results.push({ room, status: "failed", detail: "no Control4 zone mapped for this room" });
      continue;
    }
    // The zone's own source_list is the authority — same rule the single
    // device command route enforces. A zone that can't take this input says
    // so precisely, listing what it can take.
    if (!zone.sourceList.includes(source)) {
      results.push({
        room,
        status: "failed",
        detail: `the ${room} can't take "${source}" — it offers ${zone.sourceList.join(", ") || "no inputs"}`,
      });
      continue;
    }
    try {
      await callService("media_player", "select_source", { entity_id: zone.entityId, source });
      pending.push(zone);
    } catch (err) {
      results.push({
        room,
        status: "failed",
        detail: err instanceof Error ? err.message : "the command was refused",
      });
    }
  }

  // Read back: Control4 feedback lags ~4s behind reality (COMMISSIONING_LOG),
  // so poll rather than sample once, and stop as soon as every zone echoes.
  if (pending.length) {
    const deadline = Date.now() + 6000;
    const confirmed = new Set<string>();
    for (;;) {
      await new Promise((r) => setTimeout(r, 700));
      for (const zone of pending) {
        if (confirmed.has(zone.room)) continue;
        const after = await readZone(zone.room);
        if (after?.source === source) confirmed.add(zone.room);
      }
      if (confirmed.size === pending.length || Date.now() >= deadline) break;
    }
    for (const zone of pending) {
      results.push(
        confirmed.has(zone.room)
          ? { room: zone.room, status: "confirmed", detail: `playing ${source}` }
          : { room: zone.room, status: "sent", detail: `asked for ${source} — the zone hasn't echoed it back yet` },
      );
    }
  }

  // Keep the caller's room order so the UI lists them the way it asked.
  results.sort((a, b) => targets.indexOf(a.room) - targets.indexOf(b.room));
  return { source, results };
}

/** Drop a room from the group: a matrix zone leaves by switching off. */
export async function dropRoom(room: string): Promise<void> {
  const entityId = ROOM_ZONE[room];
  if (!entityId) throw new Error(`no Control4 zone mapped for ${room}`);
  await callService("media_player", "turn_off", { entity_id: entityId });
}

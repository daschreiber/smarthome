import { NextRequest, NextResponse } from "next/server";
import { getStates, type HaState } from "@/lib/ha";
import { registry } from "@/lib/registry";
import { authenticate } from "@/lib/auth";
import { canOperateLocks } from "@/lib/permissions";
import { coolmasterEntityId } from "@/lib/coolmaster";
import { changeoverStatus, modeFromRelayState, relayEntityId } from "@/lib/changeover";
import { saunaConfigured, saunaScheduleStatus, saunaStatus } from "@/lib/sauna";
import { noiseConfigured, noiseStatus } from "@/lib/whitenoise";
import { bedConfigured, bedSideForDeviceId } from "@/lib/eightsleep";
import { zoneRoomFor } from "@/lib/audio";
import { unverifiedFor } from "@/lib/knxLights";

/**
 * Full visible-device snapshot joined with live HA state.
 * One bulk /api/states call, not N per-entity reads.
 */

const strAttr = (v: unknown): string | null => (typeof v === "string" ? v : null);
const strListAttr = (v: unknown): string[] | null =>
  Array.isArray(v) ? (v as unknown[]).filter((x): x is string => typeof x === "string") : null;

/**
 * A light command that was sent, re-asserted, and still never showed up in
 * the light's own state (lib/knxLights). The card uses this to retire its
 * optimistic "on" and say the light didn't answer — without it the next tap
 * sends turn_off into an already-dark room, which is what "I tried a few
 * times and nothing happened" actually looks like from the sofa.
 */
function unverifiedPatch(deviceId: string, liveState?: string): { unverifiedAt?: string } {
  const u = unverifiedFor(deviceId, liveState);
  return u ? { unverifiedAt: u.ts } : {};
}

export async function GET(req: NextRequest) {
  const auth = authenticate(req);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    // HA bulk states and sauna status in parallel; sauna failure must not
    // break the rest of the home view — but the REASON travels to the card.
    let saunaNote: string | null = saunaConfigured() ? null : "not configured";
    let noiseNote: string | null = null;
    const [haStates, sauna, saunaSchedule, noise] = await Promise.all([
      getStates(),
      saunaConfigured()
        ? saunaStatus().catch((err: unknown) => {
            saunaNote = err instanceof Error ? err.message : String(err);
            return null;
          })
        : Promise.resolve(null),
      saunaConfigured() ? saunaScheduleStatus() : Promise.resolve({ stopAt: null }),
      noiseConfigured()
        ? noiseStatus().catch((err: unknown) => {
            noiseNote = err instanceof Error ? err.message : String(err);
            return null;
          })
        : Promise.resolve(null),
    ]);
    const states = new Map(haStates.map((s) => [s.entity_id, s]));
    const devices = registry()
      .devices.filter((d) => d.visible)
      .map((d) => {
        if (d.kind === "sauna") {
          return {
            id: d.id,
            label: d.label,
            room: d.room,
            floor: d.floor,
            group: d.group,
            kind: d.kind,
            category: d.category,
            capabilities: d.capabilities,
            requiresConfirmation: true,
            state: sauna ? (sauna.poweredOn ? "on" : "off") : "unknown",
            available: !!sauna && sauna.connected,
            currentTemperature: sauna?.currentTemperature ?? null,
            targetTemperature: sauna?.selectedTemperature ?? null,
            hvacMode: null,
            brightnessPct: null,
            lastUpdated: null,
            note: sauna && !sauna.connected ? "sauna is offline at KLAFS" : saunaNote,
            stopAt: sauna?.poweredOn ? saunaSchedule.stopAt : null,
          };
        }
        if (d.kind === "noise") {
          return {
            id: d.id,
            label: d.label,
            room: d.room,
            floor: d.floor,
            group: d.group,
            kind: d.kind,
            category: d.category,
            capabilities: d.capabilities,
            requiresConfirmation: false,
            // "on" means something is genuinely playing the stream.
            state: noise ? (noise.listeners > 0 ? "on" : "off") : "unknown",
            available: !!noise,
            brightnessPct: null,
            currentTemperature: null,
            targetTemperature: null,
            hvacMode: null,
            lastUpdated: null,
            note: noiseNote,
            noiseType: noise?.noiseType ?? null,
            volumePct: noise?.volume ?? null,
          };
        }
        if (d.kind === "bed") {
          const s = states.get(d.entityId);
          const side = bedSideForDeviceId(d.id);
          const pres = side?.presenceEntity ? states.get(side.presenceEntity) : undefined;
          const reading = s ? Number(s.state) : NaN;
          return {
            id: d.id,
            label: d.label,
            room: d.room,
            floor: d.floor,
            group: d.group,
            kind: d.kind,
            category: d.category,
            capabilities: d.capabilities,
            requiresConfirmation: false,
            state: s?.state ?? "unknown",
            available: !!s && s.state !== "unavailable" && s.state !== "unknown",
            // The side's temp entity reading (Eight Sleep reports bed temp
            // here); shown as context, never claimed as the setpoint.
            currentTemperature: Number.isFinite(reading) ? reading : null,
            targetTemperature: null,
            hvacMode: null,
            brightnessPct: null,
            lastUpdated: s?.last_updated ?? null,
            note: null as string | null,
            bedPresence: pres ? (pres.state === "on" ? true : pres.state === "off" ? false : null) : null,
            // When the presence sensor last CHANGED. Eight Sleep derives
            // presence from cloud-processed heart-rate trends (field-tested
            // 2026-07-25: read "off" for 5+ min with someone in the bed), so
            // the card must show how old the reading is, not present it as
            // live truth.
            bedPresenceSince: pres?.last_changed ?? null,
          };
        }
        const s = states.get(d.entityId);
        const attr = (k: string) =>
          s && typeof s.attributes[k] === "number" ? (s.attributes[k] as number) : null;
        // The Control4 zone entity never carries a real setpoint; the zone's
        // first CoolMaster unit does, once the coolmaster integration exists.
        const unit = d.coolmasterUnits?.length
          ? states.get(coolmasterEntityId(d.coolmasterUnits[0]))
          : undefined;
        // Yale reports battery via a separate sensor entity, not as a lock
        // attribute; the map associates it (battery_entity). Fall back to a
        // battery_level attribute for locks that do carry one.
        const lockBatterySensor =
          d.kind === "lock" && d.batteryEntity ? states.get(d.batteryEntity) : undefined;
        const lockBattery =
          lockBatterySensor && Number.isFinite(Number(lockBatterySensor.state))
            ? Number(lockBatterySensor.state)
            : null;
        const unitTarget =
          unit && typeof unit.attributes.temperature === "number"
            ? (unit.attributes.temperature as number)
            : null;
        // A/C on/off state reads from the CoolMaster units too: the bridge is
        // what actually commands the units and reflects within ~1s, while the
        // Control4 zone entity mirrors it only after ~4s (lib/coolmaster) —
        // that lag made the app show "off" for seconds after the A/C was
        // already running. A multi-unit zone is on if any unit runs. But
        // "off" is a claim about EVERY unit, so it's only made when every
        // mapped unit reported a usable state — a partial read with the
        // missing unit running would otherwise show the zone off while the
        // Control4 entity correctly says on (Codex review, PR #89). Any
        // shortfall falls back to the Control4 zone entity.
        const unitReads = (d.coolmasterUnits ?? []).map((u) =>
          states.get(coolmasterEntityId(u)),
        );
        const unitStates = unitReads.filter(
          (u): u is HaState => !!u && u.state !== "unavailable" && u.state !== "unknown",
        );
        const running = unitStates.find((u) => u.state !== "off");
        const climateState =
          d.kind === "climate" && unitStates.length
            ? running?.state ?? (unitStates.length === unitReads.length ? "off" : null)
            : null;
        return {
          id: d.id,
          label: d.label,
          room: d.room,
          floor: d.floor,
          group: d.group,
          kind: d.kind,
          category: d.category,
          capabilities: d.capabilities,
          requiresConfirmation: !!d.requiresConfirmation,
          state: climateState ?? s?.state ?? "unknown",
          available:
            climateState != null || (!!s && s.state !== "unavailable" && s.state !== "unknown"),
          brightnessPct:
            attr("brightness") != null ? Math.round((attr("brightness")! / 255) * 100) : null,
          currentTemperature: attr("current_temperature"),
          targetTemperature: unitTarget ?? attr("temperature"),
          hvacMode: d.kind === "climate" ? climateState ?? s?.state ?? null : null,
          batteryPct:
            d.kind === "vacuum" ? attr("battery_level")
            : d.kind === "lock" ? lockBattery ?? attr("battery_level")
            : null,
          // Fan strength: vacuums report their own; climate zones read the
          // CoolMaster unit (the Control4 proxy reports no fan data), falling
          // back to the zone entity if the unit isn't available.
          fanSpeed:
            d.kind === "vacuum" && typeof s?.attributes.fan_speed === "string"
              ? (s.attributes.fan_speed as string)
              : d.kind === "climate"
                ? strAttr(unit?.attributes.fan_mode) ?? strAttr(s?.attributes.fan_mode)
                : null,
          fanSpeedList:
            d.kind === "vacuum" && Array.isArray(s?.attributes.fan_speed_list)
              ? (s.attributes.fan_speed_list as unknown[]).filter(
                  (v): v is string => typeof v === "string",
                )
              : d.kind === "climate"
                ? strListAttr(unit?.attributes.fan_modes) ?? strListAttr(s?.attributes.fan_modes)
                : null,
          // Media zones: current source + source list drive the room
          // MediaCard. canTurnOn separates streaming players (Cast,
          // MusicCast) from Control4 matrix zones, which lack turn_on
          // (supported_features bit 128) and wake by source selection.
          source: d.kind === "media_player" ? strAttr(s?.attributes.source) : null,
          sourceList: d.kind === "media_player" ? strListAttr(s?.attributes.source_list) : null,
          // Now playing: C4 zones report the track (or the streaming-session
          // name) here whenever a Core Spotify session or source feeds them.
          mediaTitle: d.kind === "media_player" ? strAttr(s?.attributes.media_title) : null,
          volumePct:
            d.kind === "media_player" && typeof s?.attributes.volume_level === "number"
              ? Math.round(Math.min(1, Math.max(0, s.attributes.volume_level as number)) * 100)
              : null,
          canTurnOn:
            d.kind !== "media_player" || ((attr("supported_features") ?? 0) & 128) !== 0,
          // The room's Control4 matrix zone, named (lib/audio). Only these
          // can mirror one room's input into another, so the Music card
          // needs to know which player in the room is the real zone.
          audioZone: d.kind === "media_player" ? zoneRoomFor(d.entityId) : null,
          lastUpdated: s?.last_updated ?? null,
          note: null as string | null,
          // The security tier travels with the device: guests see the lock's
          // state but get no controls. Enforcement lives in the command
          // route (lib/permissions); this only drives the UI.
          ...(d.kind === "lock" ? { lockAllowed: canOperateLocks(auth.role) } : {}),
          ...(d.pinned ? { pinned: true } : {}),
          ...unverifiedPatch(d.id, s?.state),
        };
      });
    // White noise is hidden from the registry (and thus the command,
    // automation, and assistant layers) until it's configured. But hiding it
    // outright reads as "the feature is missing," so the home view surfaces a
    // display-only, unavailable card that names what's absent. It becomes the
    // real card the moment the white-noise envs are set (see lib/whitenoise).
    if (!noiseConfigured()) {
      devices.push({
        id: "master_bedroom__white_noise",
        label: "White noise",
        room: "Master Bedroom",
        floor: 6,
        group: "Media",
        kind: "noise",
        category: "noise_machine",
        capabilities: [],
        requiresConfirmation: false,
        state: "unknown",
        available: false,
        brightnessPct: null,
        currentTemperature: null,
        targetTemperature: null,
        hvacMode: null,
        lastUpdated: null,
        note: "not configured — set WHITENOISE_VIA_HA=1 (HA add-on) or WHITENOISE_BASE_URL + WHITENOISE_TOKEN",
        noiseType: null,
        volumePct: null,
      });
    }

    // Same pattern for the Eight Sleep bed: a display-only card in the
    // Master Bedroom until the integration lands on the Green and the
    // EIGHTSLEEP_* envs are set (docs/EIGHT_SLEEP_SETUP.md).
    if (!bedConfigured()) {
      devices.push({
        id: "master_bedroom__bed",
        label: "Eight Sleep bed",
        room: "Master Bedroom",
        floor: 6,
        group: "Climate & Comfort",
        kind: "bed",
        category: "bed_side",
        capabilities: [],
        requiresConfirmation: false,
        state: "unknown",
        available: false,
        brightnessPct: null,
        currentTemperature: null,
        targetTemperature: null,
        hvacMode: null,
        lastUpdated: null,
        note: "waiting for the Eight Sleep integration in Home Assistant",
        bedPresence: null,
        bedPresenceSince: null,
      });
    }

    // Same pattern for the Roborocks: until the Roborock integration is added
    // on the Green and the entity map re-exported, show display-only cards in
    // their rooms so the feature reads as "coming", not missing. They become
    // real vacuum devices the moment vacuum.* rows land in the entity map.
    if (!registry().devices.some((d) => d.kind === "vacuum")) {
      for (const v of [
        { id: "lounge__robot_vacuum", room: "Lounge", floor: 6 as const },
        { id: "den__robot_vacuum", room: "Den", floor: 5 as const },
      ]) {
        devices.push({
          id: v.id,
          label: "Robot vacuum",
          room: v.room,
          floor: v.floor,
          group: "Appliances",
          kind: "vacuum",
          category: "vacuum",
          capabilities: [],
          requiresConfirmation: false,
          state: "unknown",
          available: false,
          brightnessPct: null,
          currentTemperature: null,
          targetTemperature: null,
          hvacMode: null,
          batteryPct: null,
          fanSpeed: null,
          fanSpeedList: null,
          source: null,
          sourceList: null,
          mediaTitle: null,
          volumePct: null,
          canTurnOn: true,
          audioZone: null,
          lastUpdated: null,
          note: "waiting for the Roborock integration in Home Assistant",
        });
      }
    }

    // Same pattern for the Yale front-door lock: a display-only card at the
    // Entrance until the Yale Home integration lands on the Green and the
    // entity map is re-exported (docs/YALE_LOCK_SETUP.md). It becomes the
    // real lock card the moment a lock.* row lands in the entity map.
    if (!registry().devices.some((d) => d.kind === "lock")) {
      devices.push({
        id: "entrance__front_door_lock",
        label: "Front door",
        room: "Entrance",
        floor: 6,
        group: "Security",
        kind: "lock",
        category: "door_lock",
        capabilities: [],
        requiresConfirmation: true,
        state: "unknown",
        available: false,
        brightnessPct: null,
        currentTemperature: null,
        targetTemperature: null,
        hvacMode: null,
        batteryPct: null,
        fanSpeed: null,
        fanSpeedList: null,
        source: null,
        sourceList: null,
        mediaTitle: null,
        volumePct: null,
        canTurnOn: true,
        audioZone: null,
        lastUpdated: null,
        note: "waiting for the Yale Home integration in Home Assistant",
        lockAllowed: false,
      });
    }

    // The underfloor-heating valve relays are hidden as CONTROLS (plumbing,
    // per the entity map), but their state makes an honest read-only
    // indicator: which rooms have warm floors right now.
    const floorHeatingRooms = [
      ...new Set(
        registry()
          .devices.filter((d) => d.category === "floor_heating" && d.room)
          .filter((d) => states.get(d.entityId)?.state === "on")
          .map((d) => d.room),
      ),
    ];

    // Per-floor heat/cool mode, read straight off the hidden KNX changeover
    // relays (on = heating) plus any changeover currently running.
    const floorModes = Object.fromEntries(
      ([5, 6] as const).map((f) => {
        const status = changeoverStatus(f);
        return [
          f,
          {
            mode: modeFromRelayState(states.get(relayEntityId(f))?.state),
            pending: status.pending,
            error: status.lastError,
          },
        ];
      }),
    );

    // The role rides along so the UI can hide programming affordances for
    // guests; enforcement lives in the API routes, never in the browser.
    // coverStateTrusted: C4 shade position feedback is currently fiction
    // (stuck ~1%), so cover state is hidden everywhere. Set
    // COVER_STATE_TRUSTED=1 once the Control4 feedback is fixed and the
    // open/closed indicators light back up without a code change.
    return NextResponse.json({
      devices, role: auth.role, floorHeatingRooms, floorModes,
      coverStateTrusted: process.env.COVER_STATE_TRUSTED === "1",
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "upstream failure" },
      { status: 502 },
    );
  }
}

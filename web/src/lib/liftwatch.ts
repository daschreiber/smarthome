import fs from "node:fs";
import { writeJsonFile } from "./store";
import path from "node:path";
import { audit } from "./audit";
import { executeOnDevice } from "./execute";
import { getState, getStates, type HaState } from "./ha";
import { registry, type Device } from "./registry";
import { TV_LIFT_ENTITY, liftSleepState } from "./sleepwatch";

/**
 * TV follower: the Master Bedroom TV runs in unison with its ceiling lift
 * (owner request 2026-08-29 — the house has always worked this way; the
 * original link was Control4-side programming that stopped working and
 * is not held in this stack). Whenever the lift comes DOWN — keypad,
 * app, or Control4 — the TV turns on; whenever it goes back UP, the TV
 * turns off. Working since 2026-09-04.
 *
 * A standing house rule like Sleep sense and the Sauna follower, NOT a
 * user-authored automation: the trigger is the lift relay's STATE, which
 * the step builder can't express. Evaluated on the scheduler's 30s tick
 * (before Sleep sense, so a bedtime off lands before the noise starts).
 *
 * THE TWO TV ENTITIES — the fact that took five field rounds to learn
 * (COMMISSIONING_LOG 2026-08-30 … 2026-09-04):
 * - `media_player.55_qled` is the TV's Google CAST receiver. Its "on"
 *   launches the receiver and HDMI-CEC wakes the TV onto the Home
 *   Assistant Cast screen (the household likes landing there) — so it is
 *   the ON target. Its "off" merely quits the cast and cannot power a TV
 *   down; it is never the off target once the real one is known.
 * - The Samsung TV integration's own media_player ("Master Bedroom Lift
 *   TV", added 2026-09-04) is the real power control and the power TRUTH.
 *   The follower DISCOVERS it among HA's states (discoverTvPowerCandidates:
 *   a media_player named for this TV with turn_off + select_source, never
 *   the Cast receiver or a Control4 zone), remembers it in its state file,
 *   and offers a choice on the Automations card if several match — the
 *   house has two 55" QLEDs. LIFTWATCH_TV_ENTITY pins one explicitly;
 *   LIFTWATCH_OFF_ENTITY redirects only the off.
 *
 * Deliberate semantics, same philosophy as the rest of the house:
 * - The ON side is an EDGE, never a level: the TV comes on exactly once
 *   per lowering. Someone who turns it off by remote with the lift still
 *   down is a human making a choice — the follower never relights it.
 * - The OFF side is the edge plus a bounded budget per stow (default ONE
 *   command, LIFTWATCH_OFF_ATTEMPTS up to MAX_OFF_ATTEMPTS): a power key
 *   is a toggle, so the follower never retries blind; with a budget above
 *   one it re-sends only while the TV affirmatively reads "on" — a TV ON
 *   inside the ceiling is never a human's choice. The budget is tied to
 *   the entity it was spent on (offVia), so a change of target starts
 *   fresh. A stranded-on TV found after a restart gets its one off.
 * - A CIRCUIT BREAKER: BREAKER_EDGES lift edges inside BREAKER_WINDOW_MS
 *   means something is fighting (the 2026-08-30 lift oscillation, which
 *   was Control4's own doing, not this rule's) — the follower stops
 *   commanding for BREAKER_COOLDOWN_MS, audits the trip once, and keeps
 *   tracking the baseline. A human never moves a ceiling lift six times
 *   in five minutes.
 * - Unknown is not "up": an unreadable lift state holds the last known
 *   baseline instead of inventing an edge. Same after a restart: the first
 *   readable state only sets the baseline, it never acts — a deploy
 *   mid-movie must not power-cycle the TV. Unknown TV state never triggers
 *   the enforcement. The state file lives on the /data volume by default
 *   so a deploy does not wipe the baseline.
 *
 * Polarity rides the same knob as Sleep sense: SLEEPWATCH_LIFT_STATE names
 * the relay state that means "stowed" (default "off" — proven nightly by
 * the sleep watcher arming), and "down" is the other one. One knob, so the
 * two rules can never disagree about which way the TV went.
 */

/** The TV's Google Cast receiver (NOT the Samsung's TV control — see the
 *  header). Hidden from the room's cards since 2026-07-22. It is the ON
 *  command's target: launching the receiver wakes the TV over HDMI-CEC
 *  onto the Home Assistant Cast screen. It is the power truth and the
 *  off target only until the Samsung entity is discovered or pinned. */
export const TV_ENTITY = "media_player.55_qled";

/** The Samsung TV integration's own media_player for this TV, once it is
 *  configured in HA: LIFTWATCH_TV_ENTITY, else the one the follower
 *  DISCOVERED (see discoverTvPowerEntity) and remembered in its state.
 *  Real power control and real power truth — the Cast entity has
 *  neither. Empty until then. */
export function tvPowerEntity(): string {
  return process.env.LIFTWATCH_TV_ENTITY || loadLiftwatch().tvPower || "";
}

/** How the TV's own entity is recognized among HA's states once the
 *  Samsung TV integration is added: a media_player that is not the Cast
 *  receiver, is named for this TV (the Cast receiver is "55\" QLED"; the
 *  Samsung integration names its entity after the same TV, after the
 *  model code — QE55Q70DATXSQ — or after whatever the owner typed at
 *  "Name and assign": "Master Bedroom Lift TV", 2026-09-04), and
 *  advertises turn_off AND select_source — the Cast receiver has no
 *  source selection, the Control4 zones are not named for the TV. */
const TV_NAME =
  /\b55\b[\s\S]*qled|qled[\s\S]*\b55\b|\b(?:qe|qn|ue|gq)55|\blift\b|master\s*bedroom[\s\S]*\btv\b/i;
const FEATURE_TURN_OFF = 256;
const FEATURE_SELECT_SOURCE = 2048;

export interface TvCandidate {
  entityId: string;
  name: string;
}

/** Every media_player that could be this TV's own entity. The house has
 *  more than one 55" QLED (2026-09-04: two Samsung Smart TVs discovered,
 *  both named "55\" QLED"), so this is a LIST — one match is adopted,
 *  several are offered to the owner on the Automations card, never
 *  guessed: the wrong pick would switch off a TV in another room. */
export function discoverTvPowerCandidates(states: HaState[]): TvCandidate[] {
  return states
    .filter((s) => s.entity_id.startsWith("media_player."))
    .filter((s) => s.entity_id !== TV_ENTITY && s.entity_id !== C4_ROOM_ENTITY)
    .filter((s) => TV_NAME.test(String(s.attributes.friendly_name ?? "")))
    .filter((s) => {
      const f = Number(s.attributes.supported_features ?? 0);
      return (f & FEATURE_TURN_OFF) !== 0 && (f & FEATURE_SELECT_SOURCE) !== 0;
    })
    .map((s) => ({ entityId: s.entity_id, name: String(s.attributes.friendly_name ?? s.entity_id) }))
    .sort((a, b) => a.entityId.localeCompare(b.entityId));
}

/** The one unambiguous match, or null (none, or more than one). */
export function discoverTvPowerEntity(states: HaState[]): string | null {
  const hits = discoverTvPowerCandidates(states);
  return hits.length === 1 ? hits[0].entityId : null;
}

/** The owner's pick among several candidates (Automations card). Only a
 *  candidate the last scan actually saw is accepted. */
export function pickTvPower(entityId: string): boolean {
  const st = loadLiftwatch();
  if (!(st.tvPowerCandidates ?? []).some((c) => c.entityId === entityId)) return false;
  saveLiftwatch({ ...st, tvPower: entityId });
  return true;
}

/** Discovery runs on the tick only while nothing names the TV's entity,
 *  at most this often — one bulk states read every few minutes is cheap,
 *  and the moment the integration is added the follower switches over
 *  by itself (no Railway variable, no entity map edit). */
export const TV_POWER_SCAN_MS = 5 * 60_000;

async function maybeDiscoverTvPower(nowMs: number): Promise<void> {
  if (process.env.LIFTWATCH_TV_ENTITY) return;
  const st = loadLiftwatch();
  if (st.tvPower) return;
  if (nowMs - (st.tvPowerScanMs ?? 0) < TV_POWER_SCAN_MS) return;
  let states: unknown;
  try {
    states = await getStates();
  } catch {
    return; // HA unreachable: try again next scan window
  }
  if (!Array.isArray(states)) return;
  const candidates = discoverTvPowerCandidates(states as HaState[]);
  const found = candidates.length === 1 ? candidates[0].entityId : null;
  // Re-read after the await (a toggle may have rewritten the file).
  const fresh = loadLiftwatch();
  saveLiftwatch({
    ...fresh,
    tvPowerScanMs: nowMs,
    tvPowerCandidates: candidates,
    ...(found ? { tvPower: found } : {}),
  });
  if (candidates.length > 1 && JSON.stringify(fresh.tvPowerCandidates) !== JSON.stringify(candidates)) {
    console.log(`[liftwatch] ${candidates.length} TVs match — the owner picks on the Automations card:`, candidates);
  }
  if (found) {
    audit({
      ts: new Date().toISOString(), user: "liftwatch", deviceId: "automations",
      entityId: "liftwatch", command: "lift_tv_power_found", args: { entity: found },
      ok: true, durationMs: 0,
    });
    console.log(`[liftwatch] found the TV's own entity: ${found} — off and power truth move to it`);
  }
}

/** Whose state answers "does the panel read on?": the Samsung entity when
 *  configured, else the Cast receiver (which only knows whether it is
 *  casting). */
export function tvTruthEntity(): string {
  return tvPowerEntity() || TV_ENTITY;
}

/** The Control4 zone for the room: `turn_off` is Control4's Room Off —
 *  the way the house's original lift programming powered the TV down. */
export const C4_ROOM_ENTITY = "media_player.master_bedroom";

export interface LiftwatchState {
  enabled: boolean;
  /** Last KNOWN lift position (true = down); null = no baseline yet
   *  (fresh install or restart before the first readable state). */
  lastDown: boolean | null;
  /** turn_off attempts spent this stow (lift-up) episode; reset whenever
   *  the lift is down. Bounds the off-enforcement. */
  offAttempts?: number;
  /** The entity the current stow's off attempts were spent on. A change
   *  of off target (env or a new build) resets the count — a budget spent
   *  on Room Off must not block the first Samsung off (Codex review,
   *  2026-09-04). */
  offVia?: string;
  /** Recent lift edges (ms epoch), pruned to BREAKER_WINDOW_MS — the
   *  breaker's evidence. */
  edges?: number[];
  /** While now < this (ms epoch) the breaker is open: no commands. */
  breakerUntil?: number;
  /** The TV's own (Samsung TV integration) media_player, as discovered
   *  among HA's states — see discoverTvPowerEntity. */
  tvPower?: string;
  /** When discovery last scanned (ms epoch). */
  tvPowerScanMs?: number;
  /** What the last scan saw; more than one = the owner picks. */
  tvPowerCandidates?: TvCandidate[];
}

const DEFAULT_STATE: LiftwatchState = { enabled: true, lastDown: null };

/** Ceiling on off commands per stow episode; the live budget is
 *  offAttemptsAllowed() (LIFTWATCH_OFF_ATTEMPTS). The up-edge spends the
 *  first; the enforcement spends the rest while the TV still reads "on". */
export const MAX_OFF_ATTEMPTS = 3;

/** Off commands per stow. Default 1 (2026-09-04): a power key is a toggle,
 *  so a retry against a lagging "on" can relight the panel — one command
 *  per stow until the TV is proven to honor a single off. Raise to 2–3 to
 *  bring back the enforcement (the restart-hole cover) once it is. */
export function offAttemptsAllowed(): number {
  const raw = Number(process.env.LIFTWATCH_OFF_ATTEMPTS);
  const n = Number.isFinite(raw) ? Math.floor(raw) : 1;
  return Math.min(MAX_OFF_ATTEMPTS, Math.max(1, n));
}

/** Lift edges inside the window that mean "something is fighting". A
 *  human testing open/close twice is four; the 2026-08-30 oscillation
 *  was dozens. */
export const BREAKER_EDGES = 6;
export const BREAKER_WINDOW_MS = 5 * 60_000;
export const BREAKER_COOLDOWN_MS = 10 * 60_000;

/** The state file: LIFTWATCH_PATH, else the Railway volume when it is
 *  mounted (a deploy must not wipe the baseline — 2026-09-04, when every
 *  test came minutes after a deploy), else the working directory. */
function storePath(): string {
  if (process.env.LIFTWATCH_PATH) return process.env.LIFTWATCH_PATH;
  if (fs.existsSync("/data")) return "/data/liftwatch.json";
  return path.join(process.cwd(), "liftwatch.json");
}

export function loadLiftwatch(): LiftwatchState {
  try {
    const raw = JSON.parse(fs.readFileSync(storePath(), "utf8")) as Partial<LiftwatchState>;
    return { ...DEFAULT_STATE, ...raw };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function saveLiftwatch(st: LiftwatchState): void {
  writeJsonFile(storePath(), st);
}

/** The TV the lift carries, from the registry (visible:false there — the
 *  follower drives it even though the room shows no card for it). */
export function tvDevice(): Device | null {
  return registry().devices.find((d) => d.entityId === TV_ENTITY) ?? null;
}

/** A device for the Samsung power entity: the registry row if the entity
 *  map carries it, else a minimal synthetic media_player — the env names
 *  a server-side entity, the same trust as WHITENOISE_MEDIA_ENTITY, and
 *  the typed command layer still gates what can be sent to it. */
export function tvPowerDevice(): Device | null {
  const id = tvPowerEntity();
  if (!id) return null;
  const mapped = registry().devices.find((d) => d.entityId === id);
  if (mapped) return mapped;
  return {
    id: "master_bedroom__tv_power",
    entityId: id,
    kind: "media_player",
    label: "TV (power)",
    room: "Master Bedroom",
    floor: 6,
    group: "Media",
    category: "media",
    visible: false,
    capabilities: ["on_off"],
  };
}

/** Where the OFF goes: LIFTWATCH_OFF_ENTITY if set (e.g. the Control4
 *  zone for Room Off), else the Samsung power entity when configured,
 *  else the Cast receiver (which can only quit the cast). */
export function offEntity(): string {
  return process.env.LIFTWATCH_OFF_ENTITY || tvTruthEntity();
}

export function offDevice(): Device | null {
  const id = offEntity();
  const power = tvPowerDevice();
  if (power && power.entityId === id) return power;
  return registry().devices.find((d) => d.entityId === id) ?? tvDevice();
}

/** The follower exists once the TV is in the entity map. */
export function liftwatchAvailable(): boolean {
  return tvDevice() !== null;
}

/** Relay state → lift position. Only the two real relay states count:
 *  unavailable/unknown (integration restart, Director unreachable) is
 *  null, never a position — a flap must not fake a movement. */
export function liftDownFromState(state: string | undefined | null): boolean | null {
  if (state !== "on" && state !== "off") return null;
  return state !== liftSleepState();
}

/** TV power from the media_player's state. Anything a powered TV reports
 *  counts as on; "off"/"standby" is off; unavailable/unknown is null —
 *  the enforcement only ever acts on an affirmative "on". */
export function tvOnFromState(state: string | undefined | null): boolean | null {
  if (state == null) return null;
  if (["on", "playing", "paused", "idle", "buffering"].includes(state)) return true;
  if (state === "off" || state === "standby") return false;
  return null;
}

export type TvFollowAction = "tv_on" | "tv_off" | "breaker_trip" | null;

/**
 * Pure decision function — all I/O stays in tickLiftwatch. `down` is the
 * lift's position and `tvOn` the TV's power, each null when unreadable.
 * "breaker_trip" is not a command: it's the one audited moment the
 * follower takes itself out of a fight.
 */
export function evaluateTvFollow(
  down: boolean | null,
  tvOn: boolean | null,
  st: LiftwatchState,
  nowMs: number = Date.now(),
): { action: TvFollowAction; next: LiftwatchState } {
  if (down === null) return { action: null, next: st }; // hold on missing data
  if (st.lastDown === null) {
    // First readable state: baseline only, never an action. With the lift
    // down that protects a TV someone already turned off; with it up, a
    // stranded-on TV is caught by the enforcement on the NEXT tick — one
    // readable lift state as baseline keeps a flapping relay from acting.
    return { action: null, next: { ...st, lastDown: down, offAttempts: 0 } };
  }

  const edge = down !== st.lastDown;
  let edges = (st.edges ?? []).filter((t) => nowMs - t < BREAKER_WINDOW_MS);
  if (edge) edges = [...edges, nowMs].slice(-BREAKER_EDGES);
  const tracked: LiftwatchState = {
    ...st,
    lastDown: down,
    edges,
    // A lowering starts a fresh stow budget either way.
    ...(down ? { offAttempts: 0 } : {}),
  };

  // Breaker open: track, never command. It closes by time alone.
  if (st.breakerUntil !== undefined && nowMs < st.breakerUntil) {
    return { action: null, next: tracked };
  }
  // Trip on the edge that completes the pattern — and only on an edge, so
  // a tripped breaker is audited exactly once.
  if (edge && edges.length >= BREAKER_EDGES) {
    return {
      action: "breaker_trip",
      next: { ...tracked, breakerUntil: nowMs + BREAKER_COOLDOWN_MS },
    };
  }

  if (down) {
    // Down: the up→down edge turns the TV on, once.
    return { action: edge ? "tv_on" : null, next: tracked };
  }
  // Up: the down→up edge spends the first off attempt; while the TV still
  // affirmatively reads "on" (never on unknown), the enforcement spends
  // the rest — a TV inside the ceiling is never meant to be on.
  const via = offEntity();
  const attempts = st.offVia === via ? (st.offAttempts ?? 0) : 0;
  if (edge || (tvOn === true && attempts < offAttemptsAllowed())) {
    return { action: "tv_off", next: { ...tracked, offAttempts: attempts + 1, offVia: via } };
  }
  return { action: null, next: tracked };
}

/** Scheduler hook — called every 30s tick. Cheap when the TV isn't in the
 *  registry or the rule is paused. */
export async function tickLiftwatch(): Promise<void> {
  if (!loadLiftwatch().enabled || !liftwatchAvailable()) return;
  await maybeDiscoverTvPower(Date.now());

  // Each read fails alone: a TV briefly unreachable must not blind the
  // lift edge, and vice versa.
  const [liftRes, tvRes] = await Promise.allSettled([
    getState(TV_LIFT_ENTITY),
    getState(tvTruthEntity()),
  ]);
  const down =
    liftRes.status === "fulfilled" ? liftDownFromState(liftRes.value?.state) : null;
  const tvOn = tvRes.status === "fulfilled" ? tvOnFromState(tvRes.value?.state) : null;

  // Re-read AFTER the awaits: a pause flipped while the HA requests were
  // in flight must win — evaluating (and saving) the pre-request state
  // would silently undo the pause and command the TV on a tick the admin
  // already stopped (Codex review, 2026-08-29).
  let st = loadLiftwatch();
  if (!st.enabled) return;
  // A discovered entity that HA no longer has (integration removed) is
  // forgotten, so discovery runs again and the Cast receiver is the
  // fallback meanwhile. An env-named entity is the operator's call.
  if (
    !process.env.LIFTWATCH_TV_ENTITY && st.tvPower &&
    tvRes.status === "fulfilled" && tvRes.value === null
  ) {
    const { tvPower: _gone, ...rest } = st;
    void _gone;
    st = rest;
    saveLiftwatch(st);
  }
  const { action, next } = evaluateTvFollow(down, tvOn, st);
  // Persist the baseline AND the spent attempt BEFORE acting: a crash
  // mid-command must not replay the edge (and double-audit) on the next
  // tick, and the attempt budget must burn down even through crashes.
  if (JSON.stringify(next) !== JSON.stringify(st)) saveLiftwatch(next);
  if (!action) return;

  if (action === "breaker_trip") {
    audit({
      ts: new Date().toISOString(), user: "liftwatch", deviceId: "automations",
      entityId: "liftwatch", command: "lift_breaker_trip",
      args: { edges: next.edges?.length ?? 0, windowMinutes: BREAKER_WINDOW_MS / 60_000, cooldownMinutes: BREAKER_COOLDOWN_MS / 60_000 },
      ok: true, durationMs: 0,
    });
    console.error(
      `[liftwatch] BREAKER: lift moved ${next.edges?.length} times in ${BREAKER_WINDOW_MS / 60_000} min — standing down for ${BREAKER_COOLDOWN_MS / 60_000} min`,
    );
    return;
  }

  const attempt = next.offAttempts ?? 0;
  const dev = action === "tv_on" ? tvDevice()! : offDevice()!;
  const started = Date.now();
  let error: string | undefined;
  try {
    await executeOnDevice(dev, { command: action === "tv_on" ? "turn_on" : "turn_off" });
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  audit({
    ts: new Date().toISOString(), user: "liftwatch", deviceId: "automations",
    entityId: "liftwatch", command: action === "tv_on" ? "lift_tv_on" : "lift_tv_off",
    args: action === "tv_on" ? { lift: "down", via: dev.entityId } : { lift: "up", attempt, via: dev.entityId },
    ok: !error, durationMs: Date.now() - started, error,
  });
  console.log(
    `[liftwatch] lift ${action === "tv_on" ? "down → TV on" : `up → TV off (attempt ${attempt}/${offAttemptsAllowed()})`} via ${dev.entityId}` +
    (error ? ` FAILED: ${error}` : ""),
  );
}

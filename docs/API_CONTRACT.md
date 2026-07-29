# Application API Contract

What the web/PWA client can actually call, as implemented (rewritten from
the route handlers 2026-07-26; the previous version of this file was the
pre-build design and had drifted badly). The contract's founding rule still
holds everywhere: **no endpoint accepts raw Home Assistant domains,
services, or entity ids** — clients speak in app device ids and typed
commands; entity mapping is server-controlled (`data/entity_map.json`).

## Conventions

- JSON in/out. Success is `{ ok: true, ... }` or a plain data object;
  errors are `{ error: string }` (sometimes `+ detail` with Zod issues).
- **Auth**: every route requires a signed-in caller except `/api/auth/*`
  and `/api/spotify/callback`. Two mechanisms, checked in order:
  1. `session` cookie (httpOnly, 90 days) — issued by password or Google
     sign-in against the server-side user store.
  2. `x-app-key` header equal to the `APP_KEY` env — transition/dev gate,
     acts as admin.
  With neither configured, dev is open and production fails closed.
- **Roles**: `admin | member | guest`. "canProgram" (admin+member) gates
  everything that changes programming: automations, scenes
  capture/delete, timers, Away, the standing-rule toggles. Guests can
  still command devices and run things. Admin-only: activity log, user
  management, Spotify account linking.
- **Status codes**: 400 invalid request, 401 unauthenticated,
  403 role/ownership, 404 unknown id, 409 already running, 428
  confirmation required, 501 feature not configured, 502 upstream
  (HA/cloud) failure.
- Every state-changing call lands in the append-only audit log.

## Snapshot & telemetry

### `GET /api/home`
The one bulk read the UI polls (~3s). Returns:
`{ devices[], role, floorHeatingRooms[], floorModes, coverStateTrusted }`
- `devices[]`: every **visible** device joined with live HA state —
  id/label/room/floor/group/kind/category/capabilities, `state`,
  `available`, plus kind-specific fields (brightnessPct, current/target
  temperature, hvacMode, fanSpeed(+List), batteryPct, media source(+List)/
  mediaTitle/volumePct/canTurnOn, bedPresence(+Since), noiseType, stopAt,
  requiresConfirmation, note). Unconfigured features (bed, noise, vacuum)
  appear as display-only unavailable cards rather than vanishing.
- `floorModes`: `{ "5"|"6": { mode: "heat"|"cool"|null, pending, error } }`
  — read off the KNX changeover relays (on = heating).
- 502 when HA is unreachable.

### `GET /api/health`
`{ app, homeAssistant, sauna, whiteNoise, devices }` — per-component
`configured`/`ok`/`message`, no secrets.

### `GET /api/activity` (admin)
`{ events: [...] }` — last 100 audit records.

## Devices

### `POST /api/devices/:deviceId/command`
The typed command channel. Body is a discriminated union on `command`,
validated per-device against its capabilities (`UNSUPPORTED_COMMAND` → 400):

| command | args |
|---|---|
| `turn_on` / `turn_off` | — (sauna: optional `temperature` 40–100, `runForMinutes` 15–480) |
| `set_brightness` | `brightnessPct` int 0–100 |
| `open` / `close` / `stop` | — |
| `set_position` | `positionPct` int 0–100 |
| `set_temperature` | `temperature` (climate clamped 10–32, sauna 40–100) |
| `set_volume` | `volumePct` int 0–100 |
| `select_source` | `source` (validated against the entity's source list) |
| `play` / `pause` | — |
| `start_cleaning` | `segments?` int[], `repeat?` 1–3 |
| `pause_cleaning` / `return_to_dock` | — |
| `set_fan_speed` | `fanSpeed` (validated against the vacuum's list) |
| `set_fan_mode` | `fanMode` (validated against the CoolMaster unit's modes) |
| `set_bed_level` | `level` int −100…+100 (Eight Sleep warmth scale) |

Devices flagged `requiresConfirmation` (the sauna heater) demand
`confirm: true` or the call fails with **428**.

Response: `{ status: "confirmed" | "sent", state, ... }`. HA-backed devices
answer *sent* the moment Home Assistant accepts the service call; read-back
verification runs in the background and its verdict lands in the audit log
(`(unverified)` marks a read-back that never proved the command). The sauna
and white noise still verify inline — safety tier and listener ground-truth
respectively — and are the two paths that can answer *confirmed*. Failures
return `{ status: "failed", error }` with 400 (rejected) or 502 (upstream).

### `GET | PATCH /api/devices/:deviceId/vacuum`
GET: `{ segments, map, roomOptions, canRename, cached }` (room map;
degrades to empty with an `error` note rather than failing). PATCH
(canProgram): `{ segment, name? }` renames a map segment app-side.

## Rooms & house-wide

### `POST /api/systems/command`
Fan-out: `{ system: lighting|climate|heating|shades, command: turn_on|
turn_off|open|close|stop|set_brightness, rooms?: string[], brightnessPct? }`.
Fire-and-report: `{ ok, targets, failed[] }` — the UI's polling shows the
resulting truth.

### `POST /api/climate/mode`
Per-floor heat/cool changeover: `{ floor: 5|6, mode: "heat"|"cool" }`.
Returns `{ ok, status: "started" }` immediately; the ~13s Control4-derived
relay sequence runs server-side (one per floor at a time — 409 if already
switching). Progress/result read from `/api/home` `floorModes`.

### `GET | POST /api/favorites`
Per-user favorite device ids. POST `{ deviceId }` toggles; both return
`{ favorites: string[] }`.

## Scenes

### `GET | POST /api/scenes`
GET: `{ scenes[] }` with `deviceCount`, `hasSauna`, `canDelete`.
POST `action`:
- `capture` (canProgram): `{ name, room, shades? }` — snapshots the room's
  current states (sauna joins only if it's actually running).
- `set_device` (canProgram + ownership): `{ id, deviceId, commands[] }` —
  surgical edit of one device's stored commands (each re-validated).
- `apply`: `{ id, confirmSauna? }` — sauna fires only with explicit
  `confirmSauna: true`; returns `{ ok, applied, failed[] }`.
- `delete` (canProgram + ownership): `{ id }`.

## Automations & standing rules

### `GET | POST /api/automations`
GET: `{ automations[], tz, sun, away }`. POST `action`:
`create`/`update` (spec validated), `delete` (ownership), `toggle`,
`active_when` (`always|home|away` — the Away-mode gate), and `run`
(fire now; the only action guests may call).

### `GET | POST /api/away`
The house-wide Away switch. GET: `{ away, since, setBy, homeOnlyCount,
awayOnlyCount, canToggle }`. POST (canProgram): `{ away: boolean }` —
also best-effort flips Eight Sleep's own away mode on both sides and
reports it back as `bed: { synced, detail? }` (a cloud hiccup never
blocks the house flag).

### `GET | POST /api/timers`
Auto-off timers (lights + underfloor heating; keep working in Away).
POST `action`: `create` `{ deviceId, afterMinutes }`, `toggle`, `delete`
(ownership). All return `{ timers[] }`.

### `GET | POST /api/saunawatch`
Sauna follower (room A/C mirrors the sauna's power edges). GET:
`{ enabled, available, acTemp, acFan, acZones, canToggle }`. POST
(canProgram): `{ enabled }` — re-enabling resets the baseline so it never
acts on a stale edge.

### `GET | POST /api/sleepwatch`
Sleep sense (white noise; home-only by design — stands down while Away).
GET: `{ enabled, active, away, configured, room, window, watchedLights,
readingLights, closetLights, canToggle }`. POST (canProgram): `{ enabled }`.

## Sauna, music, noise

### `POST /api/sauna/timer`
`{ minutes: 15–480 }` → `{ ok, stopAt }`. 501 until the sauna app is
configured.

### `GET /api/music/now`
The household Spotify session; degrades to `{ playing: false, ... }`
rather than erroring when unlinked.

### `POST /api/music/play` / `POST /api/music/skip`
`{ room }` starts Spotify on the room's mapped Connect device;
`{ direction: "next"|"previous" }` skips. 501 unlinked, 502 on Spotify
failure.

### `GET /api/spotify/login` (admin) / `GET /api/spotify/callback`
OAuth link of the household Spotify account (one-time; nonce-protected).

### `POST /api/noise`
White noise: `{ noiseType?: "white"|"brown"|"pink", volumePct?: 0–100 }`
(at least one). 501 until configured.

## Assistant

### `POST /api/assistant` (`maxDuration` 120s)
Two shapes:
- Chat: `{ message, history? }` → `{ proposal }` — the model returns a
  typed proposal (`actions` | `scene_capture` | `automation` | `clarify`),
  never executes directly. 501 without an Anthropic key.
- Execute: `{ action: "execute", proposal }` — runs a previously returned
  proposal after the user confirms in the UI. Guests may execute only
  `actions` proposals (403 otherwise).

## Auth & users

### `GET /api/auth/methods` → `{ password, google }` (pre-auth).
### `POST /api/auth/login` → sets `session` cookie; 401 on bad
credentials (with a delay), 501 until users are configured.
### `POST /api/auth/logout` → clears the cookie.
### `GET /api/auth/google` + `/callback` → OAuth sign-in; only emails
already in the user store are admitted (`/?error=not-invited`).
### `POST /api/auth/reset-request` / `POST /api/auth/reset`
Password reset by emailed link; the request endpoint answers generically
whether or not the email exists.
### `GET | POST /api/users` (admin)
List/add/`set-role`/`remove`/`reset-link`. Adding with an empty password
creates a Google-only user.

## Safety rules (unchanged in spirit, enforced in code)

- No generic HA service passthrough exists; `lib/commands.ts` is the only
  translation layer and rejects anything off-schema.
- Role enforcement lives in the API routes, never only in the browser.
- The sauna heater never starts without an explicit human confirmation
  (`confirm: true`, scene `confirmSauna: true`) — automations and scenes
  don't bypass it.
- Free-text inputs that reach HA (source names, fan modes) are validated
  against the entity's own advertised lists first.

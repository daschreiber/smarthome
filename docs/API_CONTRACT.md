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
  Two deviations to be aware of: device commands report failures as
  `{ status: "failed", error }`, and the vacuum segment read returns 200
  with an `error` field when the map fetch degrades.
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
- `unverifiedAt` (lights, only when it applies): ISO time of a command that
  was sent, re-asserted, and still never proved itself in the light's state
  (lib/knxLights). The card drops its optimistic overlay and says the light
  didn't answer. Retires itself once the light reaches the wanted state or
  after 90s.
- `unreachable` (every HA-backed device): every entity the device's command
  would target reads `unavailable`, or is gone from HA entirely — so a
  command cannot land (lib/reachability). Distinct from `!available`, which
  also covers the transient `unknown` after an HA restart: that stays
  commandable. The outage UI keys on this, and it matches exactly what the
  command routes refuse.
- `floorModes`: `{ "5"|"6": { mode: "heat"|"cool"|null, pending, error,
  unreachable } }` — read off the KNX changeover relays (on = heating).
  `unreachable` separates "the relay reported something unexpected" from
  "the relay went down with Control4"; only the second disables the toggle.
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
switching). **503** when the floor's changeover relay is unreachable: with
Control4 down the sequence would still cycle the sacrificial CoolMaster unit,
flip nothing, and report success. Progress/result read from `/api/home`
`floorModes`.

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
GET: `{ automations[], tz, sun, away, holidays }`. `holidays` is
`{ rows[], holy[] }`: the coming year's Jewish holidays (Israel's
calendar, one day each) as `{ date, name, enabled, manual }`, and the
holy dates within the next 31 days that the next-fire hints need (their scan looks 28 days ahead). POST
`action`: `create`/`update` (spec validated), `delete` (ownership),
`toggle`, `active_when` (`always|home|away` — the Away-mode gate),
`holiday` (`{ date, enabled }` — follow a date as a holy day or stop; a
calendar Yom Tov is switched, any other date is added or removed by
hand; Saturdays and past dates are refused), and `run` (fire now; the
only action guests may call).

Holidays follow Shabbat by weekday substitution (`lib/yomtov.ts`): on a
holy day the scheduler matches `days` as Saturday, on the day before as
Friday, flipping to Friday an hour before sunset when one holy day leads
into another. Ordinary weeks are unchanged. State: `holidays.json` on the
volume (`HOLIDAYS_PATH` to override).

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

### `GET | POST /api/liftwatch`
TV follower (the Master Bedroom TV mirrors its ceiling lift: lift down →
TV on on the edge; lift up → TV off, one command per stow by default
(`LIFTWATCH_OFF_ATTEMPTS` re-enables the still-reads-on enforcement); a
circuit breaker stands the rule down for 10 min if the lift moves six
times in five). The down edge also turns the room's wall Frame off when
it reads on (audited as `lift_wall_tv_off`; never turned back on). GET: `{ enabled, available, tvPower, tvCandidates,
canToggle }` — `tvPower` is the TV's own (Samsung TV integration)
entity, discovered or env-named, null until the integration exists;
`tvCandidates[]` (`{ entityId, name }`) lists the TVs the last scan found
when more than one matched. POST (canProgram): `{ enabled }` —
re-enabling resets the baseline so it never acts on a stale edge; or
`{ tvPower }` — the owner's pick, accepted only from `tvCandidates`.

### `GET | POST /api/sleepwatch`
Sleep sense (white noise; home-only by design — stands down while Away).
GET: `{ enabled, active, away, configured, room, window, watchedLights,
readingLights, closetLights, canToggle }`. POST (canProgram): `{ enabled }`.

### `POST /api/artframes`
A press of Night or Morning that did not come through the app — the wall
keypad (a KNX bus event) or Alexa / Siri / the HA dashboard (a service
call on the switch), relayed by one Home Assistant automation
(`ha/artframes_keypad.yaml`). Body `{ press: "night" | "morning",
source?, floor?, spare? }` (`floor`: `5` or `6` — only that floor's
Frames, for the "Lights 5" / "Lights 6" buttons by the front door, which
send "night" for off and "morning" for on; absent = every Frame. `spare:
false`: darken a set even if its sensor says it is being watched — the
door buttons and Exit send it, Night does not. `source`: the keypad's KNX address or `voice-or-ui`, written
into the audit line as user `ha:<source>`; anything but a short token
reads as `ha:keypad`). Auth: the `x-hook-key` header equal to `HA_HOOK_KEY` — a
secret separate from `APP_KEY`, good for this one endpoint — or a
signed-in account with canProgram. Runs the same Frame follower a press
in the app runs (`lib/artframes`, `followArtFrames`: every flagged Frame
off on Night, sparing a Den or Lounge set that is showing television; all
on as art on Morning) and answers `202 { status: "accepted", press }` as
soon as the sweep is started — the sweep audits itself as
`system:artframes`. One press is one sweep whichever roads it arrives by
(the app's own press comes back on the service road a second later): the
follower drops a repeat of the same press (and the same `floor`) within 10 s and logs it as
`frames_duplicate`; the endpoint answers such a repeat `200
{ status: "duplicate" }` so HA's trace says so. `503` when `HA_HOOK_KEY` is not
set (and the caller is not signed in), `401` on a wrong key, `400` on any
other `press` or a `floor` that is not 5 or 6.

## Sauna, music, noise

### `POST /api/sauna/timer`
`{ minutes: 15–480 }` → `{ ok, stopAt }`. 501 until the sauna app is
configured.

### `GET /api/music/now`
Spotify from the caller's point of view: `{ configured, linked, usingHouse,
premium, mine, rooms[] }`. `mine` is the session on the account this user
plays as; `rooms[]` is every room with a session across ALL linked accounts
(`{ room, track, artist, artUrl, playing, who, mine }`), which is how a card
can say "Ruth's Spotify is playing here". Degrades to empty rather than
erroring when unlinked.

### `POST /api/music/play` / `POST /api/music/skip`
`{ room }` starts the caller's own Spotify (their link if they have one,
else the house account) on the room's mapped Connect device, answering
`{ ok, device, who, usingHouse }`; `{ direction: "next"|"previous" }` skips
— always on the caller's own session, never someone else's. 501 unlinked,
502 on Spotify failure.

### `POST /api/music/handoff`
`{ room }` points the caller's OWN Spotify at that room's Connect endpoint
and returns `{ transferred, device, url, hint }`. The client navigates to
`url` in the same tap, so the phone lands in the Spotify app already
attached to the room — Spotify publishes no deep link that selects a
device, so the API does that half. Un-linked callers get
`transferred: false` plus the manual instruction instead.

### `POST /api/music/extend` (`maxDuration` 30s)
`{ from, add?: string[], remove?: string[] }` mirrors one room's matrix
input into others (and switches rooms back off). Answers
`{ source, results[], dropped[] }` where each result is
`{ room, status: "confirmed"|"sent"|"failed", detail }` — `confirmed` only
when the target zone echoed the input back, `sent` when it accepted but
hasn't, `failed` with the reason (including "this zone can't take that
input", listing the ones it can). This is a Control4 matrix operation, not
a Spotify one: see `lib/audio.ts`.

### `GET /api/spotify/login` / `GET /api/spotify/callback`
OAuth link. `?target=me` (default) links the signed-in user's own Spotify;
`?target=house` (admin only) links the shared fallback account. The signed
state carries which of the two the callback is completing, so it can't be
redirected at someone else's link.

### `GET /api/spotify/link` / `DELETE /api/spotify/link`
Who is connected: `{ configured, houseLinked, canLinkOwn, me, others[],
slots: { used, max } }` — `others` is display names only. DELETE
disconnects your own account (admins may pass `{ user }` to free someone
else's slot).

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

## Agents

### `POST /api/mcp`
The house as an MCP server (Model Context Protocol, Streamable HTTP,
stateless, JSON responses) — `docs/MCP_SERVER.md`. Not a JSON API of its
own: the body is JSON-RPC and the `Accept` header must list both
`application/json` and `text/event-stream` (406 otherwise). Auth:
`Authorization: Bearer <OAuth access token>` → the person who consented,
with their role; `Bearer <MCP_TOKEN>` (optional legacy) → the guest
principal `mcp`; any other bearer is refused (401 with the
`WWW-Authenticate` discovery pointer, never falls through); no bearer →
the ordinary session cookie / `x-app-key`, acting as that caller. Tools:
`list_rooms`, `get_home_state`, `list_scenes`, `list_automations`,
`list_timers` (reads); `control_device`, `set_room_lights`,
`activate_scene` (the assistant's device vocabulary, through
`lib/execute`); `create_automation`, `update_automation`,
`set_automation_enabled`, `delete_automation`, `create_timer`,
`delete_timer` (the same stores as `/api/automations` and `/api/timers`;
recurring automations are admin-only, everyone else schedules one-offs;
timers are open to all; edit/delete under the ownership rule). Door locks are absent
from it entirely; the sauna needs `confirm: true` and is never schedulable;
every action is audited with `via: "mcp"`. `GET` and `DELETE` answer 405.

### OAuth (the app as authorization server for `/api/mcp`)
`docs/MCP_SERVER.md` has the table. `GET /.well-known/oauth-protected-resource`
(+ `/api/mcp` suffix) and `GET /.well-known/oauth-authorization-server`
are public discovery documents built from `APP_BASE_URL`.
`POST /api/oauth/register` (pre-auth, RFC 7591) registers a public client:
`{ client_name?, redirect_uris[] }` → 201 client information, 400 on a
disallowed redirect URI or a request for a client secret. `/oauth/authorize`
is the consent page; its backend `GET /api/oauth/authorize?<oauth params>`
validates and describes (`{ ok, client, user|null, methods }`, or
`{ ok:false, error, redirect|null }`), and `POST` `{ …params, decision:
"allow"|"deny" }` (session cookie of a real account) answers
`{ redirect }` with the code or `access_denied`. `POST /api/oauth/token`
(form or JSON): `authorization_code` + PKCE, or `refresh_token`; a client
configured in `OAUTH_CLIENTS` also presents its secret (body or Basic
header) and may omit PKCE; errors in RFC 6749 §5.2 form. `POST /api/oauth/revoke` `{ token }` → 200 always.
`GET | DELETE /api/oauth/grants` (signed in): `{ grants[] }` of the caller
(admin: all); DELETE `{ id }` disconnects one. Every consent and disconnect
is audited (`agent_consent`, `agent_disconnect`).

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

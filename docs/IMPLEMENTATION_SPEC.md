# Implementation Specification

## 1. Recommended architecture

```text
Phone / browser PWA
        |
        | HTTPS + application session
        v
Smart-home application backend
        |
        | Home Assistant REST API
        v
Home Assistant Green
        |
        | Local Control4 integration
        v
Control4 Core 3
        |
        v
Lights, shades, climate, media, scenes
```

For the MVP, the backend should use Home Assistant's REST API for commands and state reads. Polling every 2–5 seconds while a control screen is open is sufficient initially. A WebSocket state stream can be added later.

Note on end-to-end staleness: the Control4 integration itself polls the Director (default every 5 seconds, configurable down to 1). App polling stacks on top of that, so worst-case observed staleness is app interval + integration interval. If the 5-second confirmed-state target is missed during commissioning, lower the integration scan interval before redesigning the app.

## 2. Why this architecture

- No Control4 credential is stored in the browser.
- No Home Assistant long-lived token is stored in the browser.
- The web app can run on iPhone, iPad, desktop, or Android.
- Home Assistant normalizes Control4 devices into standard domains.
- The app remains independent of Control4's undocumented cloud relay.
- The Home Assistant layer allows future non-Control4 devices to appear in the same app.

## 3. Proposed technology stack

### Application

- TypeScript
- Next.js
- React
- PWA manifest and service worker
- Server-side API routes for all Home Assistant calls
- Zod or equivalent runtime validation
- SQLite for local development; managed Postgres for deployment if audit history and multiple users are retained

### Hosting

MVP options, in preference order:

1. A conventional Node host that supports an always-on process, suitable for later WebSocket support.
2. A serverless host using REST polling only. Note: SQLite is not usable on serverless hosts; this option requires the managed Postgres path from day one.
3. Local hosting on Home Assistant Green only if remote access is unnecessary.

### Remote route to Home Assistant

Preferred initial route: Home Assistant Cloud remote URL. Alternatives are a VPN or an outbound tunnel. The application must never expose port 8123 directly to the public internet.

## 4. Home Assistant integration steps

1. Connect Home Assistant Green by Ethernet.
2. Complete Home Assistant onboarding.
3. Install/configure the official Control4 integration.
4. Enter the Control4 controller IP and homeowner credentials.
5. Verify entities under the domains the official Control4 integration actually creates:
   - `light`
   - `cover`
   - `climate`
   - `media_player` (room-based media)

   The official integration does **not** create `scene`, `switch`, `script`, or `lock` entities from Control4. Control4 lighting scenes and programming are not exposed. Any `scene` or `script` entities in this project are created inside Home Assistant (step 8) and act on the four exposed domains. If relays, contact sensors, locks, or the alarm panel are needed later, the community `lawtancool/hass-control4` custom integration is the fallback (with its stability caveats), or dealer work.
6. Assign entities to Home Assistant Areas.
7. Rename unclear entities in Home Assistant.
8. Create Home Assistant scenes/scripts for compound actions.
9. Create a dedicated Home Assistant user for the application.
10. Generate a long-lived access token for that dedicated user.

## 5. Application configuration

Environment variables:

```text
HA_BASE_URL=https://example.ui.nabu.casa
HA_TOKEN=<server-side secret>
APP_SESSION_SECRET=<random secret>
DATABASE_URL=<database connection>
ALLOWED_USER_EMAILS=<comma-separated allow-list>
```

Secrets must exist only in the backend environment and must never be committed.

## 6. Entity discovery and mapping

At first connection, the backend calls:

- `GET /api/` to verify connectivity
- `GET /api/config` to record Home Assistant version and location
- `GET /api/states` to enumerate entities
- `GET /api/services` to enumerate callable services

The backend filters entities to an allow-list of supported domains and creates a candidate inventory. A human then approves entities and maps them to:

```json
{
  "id": "living_room_main_lights",
  "entityId": "light.living_room_main",
  "kind": "light",
  "room": "Living Room",
  "label": "Main Lights",
  "favorite": true,
  "capabilities": ["on_off", "brightness"]
}
```

The public application uses the stable application `id`, never the raw Home Assistant `entityId`.

## 7. Supported command mapping

### Lights

- on: `light.turn_on`
- off: `light.turn_off`
- brightness: `light.turn_on` with `brightness_pct`

### Covers

- open: `cover.open_cover`
- close: `cover.close_cover`
- stop: `cover.stop_cover`
- position: `cover.set_cover_position`

### Climate

- set temperature: `climate.set_temperature`
- HVAC mode: `climate.set_hvac_mode`, only if explicitly allowed

### Scenes and scripts

- scene: `scene.turn_on`
- script: `script.turn_on`

### Media

- power: `media_player.turn_on` / `turn_off`
- volume: `media_player.volume_set`
- transport commands only after capability detection

All service calls use `POST /api/services/<domain>/<service>`. Setting `/api/states/<entity_id>` must not be used to control a real device because that only changes Home Assistant's representation.

## 8. Backend endpoints

```text
GET  /api/health
GET  /api/home
GET  /api/rooms
GET  /api/rooms/:roomId
GET  /api/devices/:deviceId
POST /api/devices/:deviceId/command
POST /api/scenes/:sceneId/run
GET  /api/activity
POST /api/admin/discover
POST /api/admin/mappings
```

The backend accepts only typed, pre-approved commands. It must not provide a generic Home Assistant service-call endpoint to the browser.

## 9. Command execution flow

1. Browser sends a typed command using the stable application device ID.
2. Backend authenticates the user.
3. Backend resolves the approved entity mapping.
4. Backend checks command capability and safety policy.
5. Backend calls the corresponding Home Assistant service.
6. Backend reads the resulting state or waits briefly for confirmation.
7. Backend records success/failure in the audit log.
8. Browser receives a confirmed result and refreshed state.

## 10. Resilience

- Understand the Control4 authentication chain: the Home Assistant integration first authenticates against the Control4 **cloud** with the homeowner credentials to obtain an account bearer token, then exchanges it for a local Director token. Commands and state reads are local, but initial setup and token refresh require Control4 cloud reachability. A prolonged Control4 cloud outage or a homeowner password change can break re-authentication even while local control still works on the current token.
- 5-second upstream timeout
- One retry only for idempotent reads, not blind retries for commands
- Explicit `unavailable` and `unknown` UI states
- Circuit breaker after repeated Home Assistant failures
- Health endpoint showing app, Home Assistant, and Control4 entity availability
- Do not optimistically display success beyond a short pending indicator

## 11. Phased implementation

### Phase A — installation and inventory

Home Assistant Green, Control4 integration, entity export, room assignment.

### Phase B — local proof

Backend connects to Home Assistant and successfully controls one light, one shade, and one scene.

### Phase C — MVP app

Dashboard, rooms, favorites, controls, sign-in, audit log, PWA.

### Phase D — remote access

Home Assistant Cloud or equivalent secure route; deploy backend; verify away from home.

### Phase E — refinements

Real-time WebSocket state, Siri shortcut, voice input, richer automations. If Control4 functions are missing from the four exposed domains, evaluate the `lawtancool/hass-control4` custom integration or dealer work — note that dealer-created Control4 scenes and virtual switches will still not appear through the official integration.

### Phase F — non-Control4 devices (post-MVP)

Fold in devices that bypass Control4 entirely, each via its own Home Assistant integration:

- **Sauna**: currently controlled by the manufacturer's own app. Integrate via that brand's Home Assistant integration if one exists (confirm brand/model first). Treat heater control as safety-sensitive: confirmation required, server-side temperature and duration bounds, and never included in broad scenes like All Off/Away without explicit design.
- **Yale door locks**: excluded from MVP by policy. Hardware identified from photos: a Yale **Linus** retrofit cylinder lock (Yale Home ecosystem), a Yale Smart Keypad, and a Yale Smart Video Doorbell. These are not on the Control4 Zigbee mesh, so a clean Home Assistant path exists independently of Control4:
  - Primary path: the official **Yale Home** integration (`yale`, cloud push). It needs a Yale Connect Bridge *or* a Yale doorbell as the bridge — the Smart Video Doorbell on site satisfies this. It exposes the lock, lock door-sensor state where available, doorbell camera snapshots, and doorbell/motion event entities. The keypad is a lock accessory and needs no separate integration.
  - Alternative if the lock is a **Linus L2**: Matter (over Thread) is supported via firmware, giving local control — but that requires a Thread border router, which Home Assistant Green lacks without an add-on radio (e.g. Connect ZBT-1). Check the model in the Yale Home app before choosing; the cloud integration is the lower-effort first step either way.
  - App-side requirements before exposure: a separate permission tier, per-action confirmation, distinct audit treatment, and exclusion from all scenes.

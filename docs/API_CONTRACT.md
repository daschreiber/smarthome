# Application API Contract

This contract defines the narrow API exposed to the web/mobile client. It deliberately hides raw Home Assistant credentials, entity IDs, and unrestricted service calls.

## Conventions

- JSON only
- HTTPS only outside local development
- Authenticated requests only, except `/api/health`
- Times are ISO 8601 UTC
- Stable application IDs are used in client-visible payloads

## `GET /api/health`

Response:

```json
{
  "status": "ok",
  "app": "ok",
  "homeAssistant": "ok",
  "control4": "ok",
  "checkedAt": "2026-07-10T12:00:00Z"
}
```

Possible component values: `ok`, `degraded`, `offline`, `unknown`.

## `GET /api/home`

Returns favorites, scenes, rooms, and global connectivity state.

```json
{
  "favorites": [
    {
      "id": "living_room_main_lights",
      "kind": "light",
      "label": "Living Room",
      "room": "Living Room",
      "state": {"power": "on", "brightnessPct": 65},
      "available": true
    }
  ],
  "scenes": [
    {"id": "good_night", "label": "Good Night", "confirmation": true}
  ],
  "rooms": [
    {"id": "living-room", "label": "Living Room", "activeCount": 3}
  ]
}
```

## `GET /api/rooms/:roomId`

Returns approved controls for one room.

## `POST /api/devices/:deviceId/command`

Request examples:

```json
{"command": "turn_on"}
```

```json
{"command": "set_brightness", "brightnessPct": 40}
```

```json
{"command": "set_position", "positionPct": 75}
```

```json
{"command": "set_temperature", "temperature": 22}
```

Success response:

```json
{
  "commandId": "cmd_01J...",
  "status": "confirmed",
  "device": {
    "id": "living_room_main_lights",
    "state": {"power": "on", "brightnessPct": 40},
    "available": true
  },
  "completedAt": "2026-07-10T12:00:02Z"
}
```

Failure response:

```json
{
  "commandId": "cmd_01J...",
  "status": "failed",
  "error": {
    "code": "UPSTREAM_UNAVAILABLE",
    "message": "Home Assistant could not be reached."
  }
}
```

## `POST /api/scenes/:sceneId/run`

Request:

```json
{"confirmed": true}
```

The backend rejects the request when the scene requires confirmation and `confirmed` is not true.

## `POST /api/admin/discover`

Admin-only. Reads Home Assistant states and services and returns candidate entities without automatically publishing them.

## `POST /api/admin/mappings`

Admin-only. Publishes a validated mapping document.

## Error codes

- `UNAUTHENTICATED`
- `FORBIDDEN`
- `NOT_FOUND`
- `UNSUPPORTED_COMMAND`
- `CONFIRMATION_REQUIRED`
- `INVALID_ARGUMENT`
- `DEVICE_UNAVAILABLE`
- `UPSTREAM_TIMEOUT`
- `UPSTREAM_UNAVAILABLE`
- `UPSTREAM_REJECTED`
- `STATE_NOT_CONFIRMED`
- `INTERNAL_ERROR`

## Safety rules

- No browser endpoint accepts arbitrary Home Assistant domains, services, or entity IDs.
- Entity mappings are server-controlled.
- Commands are checked against per-device capabilities.
- Security-sensitive domains remain disabled until separately designed.
- Broad scenes can require explicit confirmation.

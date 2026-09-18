# The house as an MCP server

Landed 2026-09-18. The app exposes its own command layer to outside AI
agents through the Model Context Protocol (MCP): `POST /api/mcp`, Streamable
HTTP, stateless. Claude Code, Claude Desktop, and anything else that speaks
MCP can read the house's state and command it — through the app, never
around it.

Why this and not Google's Home MCP (announced 2026-09-16): that one reaches
only devices in a Google Home graph, needs a Premium subscription and a US
account, and would see the house as generic bulbs. Ours is the same typed
command layer the UI and the in-app assistant use, with the house's own
rules in it: room synonyms, the sauna's confirmation, the security tier
kept out, an audit line per action.

## What an agent gets

Code: `web/src/lib/mcp.ts` (the server and its tools), `web/src/app/api/mcp/route.ts`
(transport and auth), tests in `web/src/lib/__tests__/mcp.test.ts`.

| Tool | Does | Notes |
| --- | --- | --- |
| `list_rooms` | rooms by floor, device kinds per room, the owner's synonyms | read-only; the vocabulary |
| `get_home_state` | every device's live state (`room?` filter, synonyms accepted) plus warm floors and each floor's heat/cool mode | read-only; same snapshot as `GET /api/home` (`lib/homeSnapshot`) |
| `list_scenes` | saved scenes with ids | read-only |
| `control_device` | one typed command to one device: `turn_on`, `turn_off`, `set_brightness`, `open`, `close`, `stop`, `set_position`, `set_temperature`, `set_volume`, `start_cleaning`, `pause_cleaning`, `return_to_dock`, `set_bed_level`, with `value` for the set_* commands | the assistant's exact vocabulary (`lib/assistant` `DEVICE_COMMANDS` → `toCommand`), validated by `lib/commands`, executed by `lib/execute` |
| `set_room_lights` | a room's real lights on or off | group Lighting only, as everywhere else |
| `activate_scene` | apply a scene by id | the sauna never replays from here |
| `list_automations` | every scheduled rule with its steps, enabled/active state, creator, and whether this connection may edit it; plus the house time | read-only |
| `create_automation` | schedule steps under a name: clock time or sunrise/sunset (± offset), weekdays or a one-shot date, actions on devices / rooms / scenes | the assistant's step shape (`LlmStepSchema`, trigger fields optional) → `toAutomationSpec` → `AutomationSpecSchema`; the sauna is never schedulable |
| `update_automation` | replace name and steps of one this connection created | ownership: `canDeleteRecord` as a guest |
| `set_automation_enabled` | pause / resume any automation | as the app: anyone who may program can toggle |
| `delete_automation` | remove one this connection created | ownership |
| `list_timers` / `create_timer` / `delete_timer` | auto-off rules: a device turns off N minutes (1–720) after it turns on | `lib/timers` rules (no sauna, no bed, one per device); delete needs ownership |

Device ids are the app's ids (`lounge__lounge_cove`), never Home Assistant
entity ids — the API contract's founding rule holds. Commands answer
`"sent"` when Home Assistant accepts them, like the UI's instant taps; the
agent reads `get_home_state` a few seconds later for the truth.

The server's `instructions` (what an MCP client shows its model on connect)
carry the house rules: only returned ids are valid, the units, what
`set_room_lights` sweeps, when the sauna may be commanded, that locks are
not here, that everything is audited.

## Trust model

An agent holding the MCP token is a **guest of the house**
(`lib/permissions`: `guest`) **plus scheduling** (owner decision,
2026-09-18). Concretely:

- It can read state, command devices, and run scenes.
- It can create automations and auto-off timers, and pause or resume any
  automation. It may edit or delete only what it created (the app's
  ownership rule, `canDeleteRecord`, applied as a guest): to stop someone
  else's rule it pauses it. Records it creates carry `createdBy: "mcp"`,
  so the Automations screen shows which ones the agent made.
- It cannot capture or delete scenes, flip Away, follow holidays, or read
  the activity log.
- Door locks do not exist for it: not in `get_home_state`, not accepted by
  `control_device`. Alarm, gates and garage stay excluded by policy as they
  are everywhere.
- The sauna heater is refused until the call carries `confirm: true`. The
  tool's description and the server instructions tell the agent to pass it
  only after the person explicitly agreed — the same "human says go" rule
  as the app's press-and-confirm, relayed through the agent. It can never
  be put in an automation from here: a heater that starts unattended on a
  schedule an agent wrote is not a guest's call.
- A device Home Assistant reports `unavailable` is refused loudly
  (`lib/reachability`), not reported "sent" — the outage lesson.
- Every action lands in the audit log as user `mcp` with `via: "mcp"` in
  its args, so the Activity screen shows what the agent did.

Auth, in `authenticateMcp`:

1. `Authorization: Bearer <MCP_TOKEN>` — the agent road. A bearer that
   doesn't match, or a bearer with no `MCP_TOKEN` configured, is refused and
   never falls through to the cookie. Constant-time compare.
2. No bearer: the app's ordinary auth (`lib/auth`) — a signed-in session
   cookie or `x-app-key`. Such a caller acts as itself, with its own role.

`MCP_TOKEN` is its own secret, like `HA_HOOK_KEY`: it buys guest-level
control plus scheduling through MCP and nothing else. Rotate it by changing the variable on
Railway; every connected client then needs the new value.

## Transport

Streamable HTTP in stateless mode: each `POST /api/mcp` is one JSON-RPC
exchange handled by a fresh `McpServer` + `WebStandardStreamableHTTPServerTransport`
(`@modelcontextprotocol/sdk`), answered as JSON rather than a server-sent
event stream. No session ids, nothing held open across requests — a
Railway redeploy under a connected client costs it nothing. `GET` and
`DELETE` answer 405 (no standalone stream, no sessions), as the spec allows.

## Connecting

Set `MCP_TOKEN` on Railway (`openssl rand -hex 32`) and redeploy. Then:

**Claude Code** (direct, HTTP transport with a header):

```bash
claude mcp add --transport http house https://<your-app>.up.railway.app/api/mcp \
  --header "Authorization: Bearer <MCP_TOKEN>"
```

Then in a session: "what's on in the lounge?", "close the study blinds",
"set the den to 23", "kitchen lights on at 7 tomorrow and off at 9",
"switch the terrace lights off 20 minutes after they come on". The
`instructions` do the rest.

**Claude Desktop / claude.ai custom connectors** take a URL and expect
OAuth for authentication; they have no field for a static header. Until
the OAuth follow-up below lands, bridge through `mcp-remote` (a stdio
adapter that forwards to a remote server with a header), in
`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "house": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://<your-app>.up.railway.app/api/mcp",
               "--header", "Authorization:${HOUSE_AUTH}"],
      "env": { "HOUSE_AUTH": "Bearer <MCP_TOKEN>" }
    }
  }
}
```

(The env-var indirection is mcp-remote's recommended form: Claude Desktop
splits an argument on spaces, so `"Authorization: Bearer x"` inline breaks.)

**Smoke test with curl** — the three calls any client makes:

```bash
URL=https://<your-app>.up.railway.app/api/mcp
H=(-H "Authorization: Bearer $MCP_TOKEN" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream')
curl -s -X POST $URL "${H[@]}" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
curl -s -X POST $URL "${H[@]}" -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
curl -s -X POST $URL "${H[@]}" -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_home_state","arguments":{"room":"lounge"}}}'
```

Without the token: `401` with `WWW-Authenticate: Bearer`. The `Accept`
header must list both types — the SDK enforces the spec and answers `406`
otherwise.

## What it deliberately does not do yet

- **OAuth.** Native claude.ai / Claude Desktop connectors want an OAuth 2.1
  authorization server (dynamic client registration, PKCE, a token
  endpoint) advertised from `/.well-known/oauth-protected-resource`. The
  app already has the login screen and the user store an authorization
  endpoint would sit on; the SDK ships the server-side pieces
  (`@modelcontextprotocol/sdk/server/auth`). That is the natural next
  step, and it would give **per-user identity**: the audit line would say
  who connected the agent, and a member's agent could program while a
  guest's could not. Until then, one shared token, one principal, guest
  tier.
- **Scene capture.** Automations and timers are in (2026-09-18); scenes
  are still captured from the app, where the person sees the room they
  are snapshotting. `activate_scene` runs them.
- **The rest of the command vocabulary.** `select_source`, `play`/`pause`,
  `set_fan_speed`, `set_fan_mode`, and the sauna's start options
  (`temperature`, `runForMinutes`) are in `lib/commands` but not offered,
  because the interactive route validates their free-text values against
  the entity's live lists and the batch executor does not. Add them with
  that validation, not without.
- **Music.** Spotify play/skip/handoff is per-account (whose Spotify?) and
  stays in the app.
- **Read-back.** Commands report "sent". The interactive route's
  verification loop (re-asserting KNX lights, reading setpoints back) runs
  only for the app's own taps; the agent's honest move is to read state
  again, which the instructions tell it to.

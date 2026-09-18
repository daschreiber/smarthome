# The house as an MCP server

Landed 2026-09-18. The app exposes its own command layer to outside AI
agents through the Model Context Protocol (MCP): `POST /api/mcp`, Streamable
HTTP, stateless, with the app as its own OAuth authorization server so an
agent connects *as a person*. Claude Code, Claude Desktop, claude.ai,
ChatGPT, and anything else that speaks MCP can read the house's state and
command it — through the app, never around it.

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

An agent connected through OAuth **is the person who consented**, with
that person's role (`lib/permissions`); an agent holding the legacy shared
`MCP_TOKEN` is a **guest of the house** (`guest`) named `mcp`. Either way
the tool surface is the same, and it is narrower than the app:

- It can read state, command devices, and run scenes.
- It can create automations and auto-off timers, and pause or resume any
  automation. It may edit or delete only what its person may (the app's
  ownership rule, `canDeleteRecord`: your own, or anything as an admin).
  Records carry `createdBy: <your email>`, so the Automations screen shows
  which ones came through an agent as yours.
- It cannot capture or delete scenes, flip Away, follow holidays, or read
  the activity log — those stay in the app, whatever the role.
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
- Every action lands in the audit log under the person (or `mcp` for the
  shared token) with `via: "mcp"` in its args, so the Activity screen
  shows what the agent did and for whom.

### Who the agent is

Since 2026-09-18 the normal road is **OAuth: the agent connects as a
person.** The app is its own OAuth 2.1 authorization server (`lib/oauth`):
the client discovers it from the endpoint's 401, registers itself, sends
you to the consent page (`/oauth/authorize` — sign in there if you aren't,
password or Google), and exchanges the code for tokens bound to *your*
account. From then on every MCP action audits under your email, with your
role at the time of the call: a member's agent may program (automations,
timers) and delete its own records; a guest's agent gets the guest tier.
The user list stays the allow-list — removing someone ends their agents at
the next request, exactly as it ends their cookie.

`authenticateMcp`, in order:

1. `Authorization: Bearer <access token>` — an OAuth access token issued by
   the app. Answers as the person who consented.
2. `Authorization: Bearer <MCP_TOKEN>` — the optional shared token from the
   first version, still honoured when the variable is set: answers as the
   guest principal `mcp`. Leave it unset once every agent has moved to
   OAuth.
3. A bearer that is neither is refused and never falls through to the
   cookie (constant-time compare on the shared token; hashed lookup for
   access tokens). The 401 carries
   `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource"`,
   which is what starts a client's discovery.
4. No bearer: the app's ordinary auth (`lib/auth`) — a signed-in session
   cookie or `x-app-key`. Such a caller acts as itself.

### The OAuth server, in one table

| Endpoint | Standard | What it does |
| --- | --- | --- |
| `GET /.well-known/oauth-protected-resource` (and `…/api/mcp`) | RFC 9728 | names the resource (`/api/mcp`) and its authorization server (this app) |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 | the endpoints below, `code` + PKCE `S256`, public clients only |
| `POST /api/oauth/register` | RFC 7591 | dynamic client registration: a name and redirect URIs (https, loopback http, or a native scheme); no client secrets — PKCE is the proof |
| `GET /oauth/authorize` | RFC 6749 §4.1 | the consent page; validation first (`GET /api/oauth/authorize`), then sign-in if needed, then Allow / Deny (`POST /api/oauth/authorize`) |
| `POST /api/oauth/token` | RFC 6749 §3.2, RFC 7636, RFC 8707 | `authorization_code` (single-use, 10 min, verifier checked) and `refresh_token` (rotated, 2-min grace for a lost response); `resource` must be `/api/mcp` |
| `POST /api/oauth/revoke` | RFC 7009 | either token ends the grant |
| `GET` / `DELETE /api/oauth/grants` | app | the person's connected agents (an admin sees everyone's); the More screen's **Connected agents** |

Lifetimes: access token 1 hour, refresh token 90 days (the session cookie's
length) — after that the agent asks you to sign in again. The store is one
JSON file on the volume (`OAUTH_PATH`, default `/data/oauth.json`); it
holds SHA-256 hashes of codes and tokens, never the tokens.

## Transport

Streamable HTTP in stateless mode: each `POST /api/mcp` is one JSON-RPC
exchange handled by a fresh `McpServer` + `WebStandardStreamableHTTPServerTransport`
(`@modelcontextprotocol/sdk`), answered as JSON rather than a server-sent
event stream. No session ids, nothing held open across requests — a
Railway redeploy under a connected client costs it nothing. `GET` and
`DELETE` answer 405 (no standalone stream, no sessions), as the spec allows.

## Connecting

Nothing to configure on the server beyond what is already there:
`APP_BASE_URL` (the public URL, which the discovery documents are built
from) and the user list. Give any client the one URL
`https://<your-app>.up.railway.app/api/mcp`; it discovers the rest, opens
the consent page in your browser, and you sign in as yourself.

- **claude.ai / Claude Desktop** — Settings → Connectors → Add custom
  connector → paste the URL. Sign in on the consent page, Allow.
- **ChatGPT** — the same MCP authorization flow (Connectors / developer
  mode, wherever your plan surfaces custom MCP servers): paste the URL,
  sign in, Allow.
- **Claude Code**:

  ```bash
  claude mcp add --transport http house https://<your-app>.up.railway.app/api/mcp
  ```

  then `/mcp` in a session to sign in (a browser opens on the consent
  page). Then: "what's on in the lounge?", "close the study blinds", "set
  the den to 23", "kitchen lights on at 7 tomorrow and off at 9", "switch
  the terrace lights off 20 minutes after they come on". The
  `instructions` do the rest.

Each connection shows up under **More → Connected agents** with its name,
when it connected, and when it was last used; **Disconnect** revokes it on
the spot. An admin sees everyone's.

**Smoke test with curl** — an access token in hand (or the legacy
`MCP_TOKEN`), the three calls any client makes:

```bash
URL=https://<your-app>.up.railway.app/api/mcp
H=(-H "Authorization: Bearer $MCP_TOKEN" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream')
curl -s -X POST $URL "${H[@]}" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
curl -s -X POST $URL "${H[@]}" -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
curl -s -X POST $URL "${H[@]}" -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_home_state","arguments":{"room":"lounge"}}}'
```

Without a token: `401` with the `WWW-Authenticate` pointer above. The
`Accept` header must list both types — the SDK enforces the spec and
answers `406` otherwise.

The whole OAuth dance by hand, for the curious (a registered client, a
browser session for the consent step):

```bash
curl -s -X POST $BASE/api/oauth/register -H 'Content-Type: application/json' \
  -d '{"client_name":"curl","redirect_uris":["http://localhost:9/cb"]}'   # → client_id
# open $BASE/oauth/authorize?client_id=…&redirect_uri=http://localhost:9/cb&response_type=code
#   &code_challenge=<base64url(sha256(verifier))>&code_challenge_method=S256&state=s
#   in a browser, sign in, Allow → the browser is sent to localhost:9/cb?code=…&state=s
curl -s -X POST $BASE/api/oauth/token -d grant_type=authorization_code -d code=… \
  -d client_id=… -d redirect_uri=http://localhost:9/cb -d code_verifier=<verifier>   # → tokens
```

## What it deliberately does not do yet

- **Scopes.** One scope (`house`), one meaning: act as the person. Finer
  grants ("read-only", "no scheduling") would be a consent-page choice
  stored on the grant and checked per tool; the plumbing is there, the
  need isn't yet.
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

# Smart Home Control Project

## Objective

Build a private, phone-friendly web application that controls the existing Control4 smart-home system through Home Assistant Green.

## Confirmed environment

- Control4 controller: Core 3
- Control4 OS: 3.4.3.727848-res
- Existing interfaces: Control4 app and Alexa
- Homeowner Control4 credentials work with Control4 cloud authentication
- Home Assistant Green selected as the local bridge

## What has been established

### Local control path

The open-source `pyControl4` library and Home Assistant's Control4 integration use the Control4 controller's built-in local REST API. Ordinary homeowner credentials are sufficient to obtain the required Control4 authentication; dealer or Composer Pro credentials are not required for normal supported-device control.

Two verified constraints (from the Home Assistant core source):

1. The official Control4 integration exposes exactly four platforms: `light`, `cover`, `climate`, and `media_player` (room media). Control4 scenes, switches, locks, and alarm functions are **not** exposed. Household scenes will be recreated as Home Assistant scenes/scripts acting on those four domains.
2. Authentication is cloud-then-local: homeowner credentials go to the Control4 cloud for an account token, which is exchanged for a local Director token. Day-to-day control is local, but setup and token refresh need Control4 cloud reachability.

Architecture (as built):

```text
Phone / browser PWA  ·  Apple Home  ·  Alexa
        |                  (via HA exposure)
        v
Private application backend (Railway)
        |
        v
Home Assistant Green
        |
        +--> Control4 Core 3 local API --> lights, media, scenes
        |
        +--> KNX bus (native HA integration, 10.0.0.70) --> the 13 shades
        |
        +--> CoolMaster bridge (10.0.0.90) --> all A/C commands
        |
        +--> own integrations --> Yamaha receivers, Roborocks, Eight Sleep,
                                  white-noise add-on, sauna (own cloud API)
```

Two deliberate exceptions to the Control4 path:

- **Climate.** The Control4→CoolAutomation proxy silently drops setpoint
  reads and writes, so every A/C zone is mapped to its CoolMaster indoor
  unit(s) (`coolmaster_units` in `data/entity_map.json`) and all climate
  commands — on/off and setpoints — go through Home Assistant's native
  `coolmaster` integration straight to the bridge. Zone state is still read
  from the Control4 entities, which mirror the bridge within ~4s. Full
  investigation: `docs/COMMISSIONING_LOG.md` (2026-07-17).
- **Shades.** The Control4 cover entities had frozen position feedback and
  dropped position writes, so the 13 shades were rebuilt as native HA KNX
  covers driving the bus directly (2026-07-26), with real position state
  (`COVER_STATE_TRUSTED=1`). The app, Apple Home, and the wall keypads now
  agree. Full story: `knx/README.md`.

### Cloud-only investigation

Several tests were run against Control4's cloud APIs. They exposed controller identity, OS version, registration status, 4Sight licence, account users, dealer metadata, and Director authorization capability.

They did not expose a reusable remote controller hostname, relay URL, proxy address, WebSocket endpoint, tunnel information, or public cloud command API. The cloud channel used by Alexa and the official Control4 application appears to be private. The practical route is therefore Home Assistant Green on the home network, or a dealer-installed custom Control4 driver.

## Implementation decision

The MVP will use Home Assistant as the only direct Control4 client. A custom backend will expose a deliberately narrow API to a responsive progressive web app. The Home Assistant token and Control4 credentials will never be stored in browser code.

Initial remote access should use Home Assistant Cloud or another outbound secure route, never direct router port-forwarding to Home Assistant.

## What the app does today

Deployed on Railway (branch `main` auto-deploys), installed as a PWA:

- **Rooms & devices** — lights and dimmers, the 13 KNX shades with real
  position sliders, per-zone climate (multi-unit zones write all units),
  room media, per-room underfloor heating, per-floor A/C heat/cool
  changeover. Instant optimistic taps with background verification.
- **Scenes** — captured and applied server-side, with surgical per-device
  editing.
- **Automations & timers** — "If → then" rules and time switches, with a
  minute scheduler; sauna follower and Sleep sense standing rules.
- **Extras beyond Control4** — sauna (timer, watcher), Eight Sleep bed,
  white-noise/"Sleep sound" streaming with a sleep watcher, two Roborocks
  with per-room cleaning, Spotify on the Yamaha receivers, Away mode.
- **Assistant** — "Ask the house" conversational control (Anthropic API),
  which only proposes typed actions the command layer validates.
- **Accounts & audit** — password + Google sign-in, `admin/member/guest`
  roles, append-only audit log, password reset by email or admin link.
- **Voice/ecosystem** — the same HA entities are exposed to Apple Home
  (HomeKit Bridge + Apple TV hub) and Alexa (HA Cloud).

- **Security tier** — the Yale front-door lock (landed 2026-07-29):
  honest-state Front door card, press-and-hold plus explicit confirm on
  every command, account-password re-verification on unlock, flagged
  audit; excluded from scenes, automations, and the assistant.
  Commissioning: [the Yale lock runbook](docs/YALE_LOCK_SETUP.md).

Other security-sensitive controls (alarm, gates, garage) remain excluded
by policy.

## Documentation

Current references:

- [Application API contract](docs/API_CONTRACT.md) — the real API surface
- [Commissioning log](docs/COMMISSIONING_LOG.md) — the running as-built record
- [Power-outage recovery](docs/OUTAGE_RECOVERY.md) — when Control4 comes back
  last: how to recognise it, and `tools/c4_recover.py` to fix it
  ([prompt for a computer-control session](docs/OUTAGE_RECOVERY_PROMPT.md))
- [Home Assistant side](ha/README.md) — the files that live on the Green
- [Deploy to Railway](docs/DEPLOY_RAILWAY.md) — deployment + the env var table
- [KNX shades](knx/README.md) — the shade migration, GA map, monitor tooling
- [Yale front-door lock — on-site setup](docs/YALE_LOCK_SETUP.md)
- [Security and operations](docs/SECURITY_AND_OPERATIONS.md)
- [Test plan](docs/TEST_PLAN.md)
- [Apple Home setup](docs/APPLE_HOME_SETUP.md)
- [Audio system & Spotify](docs/AUDIO_SYSTEM.md)
- [Alexa "Sleep sound"](docs/ALEXA_WHITE_NOISE.md)
- [Eight Sleep bed — on-site setup](docs/EIGHT_SLEEP_SETUP.md)
- [Conversational layer & expansion](docs/CONVERSATIONAL_LAYER_AND_EXPANSION.md)

Design-era records (kept as history; see their status banners):

- [Product specification](docs/PRODUCT_SPEC.md) ·
  [Implementation specification](docs/IMPLEMENTATION_SPEC.md) ·
  [Plan review](docs/PLAN_REVIEW.md) ·
  [Design direction](docs/DESIGN_DIRECTION.md) ·
  [Design and delivery loop](docs/DESIGN_AND_DELIVERY_LOOP.md) ·
  [Installation runbook](docs/INSTALLATION_RUNBOOK.md) (completed) ·
  [inventory/](inventory/SUMMARY.md) (frozen snapshot) ·
  [docs/archive/](docs/archive/README.md) (executed one-shot runbooks)

## Where things live

- `web/` — the Next.js app (UI, API routes, `lib/` domain layer, tests)
- `data/entity_map.json` — the hand-maintained device registry (append new
  devices at the end; keep the `web/data/` copy identical — a test enforces
  this)
- `knx/` — shade GA map and the KNX bus monitor/diagnostic scripts
- `ha/` — config blocks installed on the Green (the HK cover wrappers are
  deprecated)
- `tools/` — commissioning-era generators (`build_entity_map.py` is fenced
  off; the map is hand-maintained now)

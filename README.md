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
Phone / browser PWA
        |
        v
Private application backend
        |
        v
Home Assistant Green
        |
        +--> Control4 Core 3 local API --> lights, shades, media, scenes
        |
        +--> CoolMaster bridge (10.0.0.90) --> all A/C commands
```

**Climate is the exception to the Control4 path.** The Control4→CoolAutomation
proxy silently drops setpoint reads and writes, so every A/C zone is mapped to
its CoolMaster indoor unit(s) (`coolmaster_units` in `data/entity_map.json`)
and all climate commands — on/off and setpoints — go through Home Assistant's
native `coolmaster` integration straight to the bridge. Zone state is still
read from the Control4 entities, which mirror the bridge within ~4s. Full
investigation and unit mapping: `docs/COMMISSIONING_LOG.md` (2026-07-17).

### Cloud-only investigation

Several tests were run against Control4's cloud APIs. They exposed controller identity, OS version, registration status, 4Sight licence, account users, dealer metadata, and Director authorization capability.

They did not expose a reusable remote controller hostname, relay URL, proxy address, WebSocket endpoint, tunnel information, or public cloud command API. The cloud channel used by Alexa and the official Control4 application appears to be private. The practical route is therefore Home Assistant Green on the home network, or a dealer-installed custom Control4 driver.

## Implementation decision

The MVP will use Home Assistant as the only direct Control4 client. A custom backend will expose a deliberately narrow API to a responsive progressive web app. The Home Assistant token and Control4 credentials will never be stored in browser code.

Initial remote access should use Home Assistant Cloud or another outbound secure route, never direct router port-forwarding to Home Assistant.

## Documentation

- [Product specification](docs/PRODUCT_SPEC.md)
- [Implementation specification](docs/IMPLEMENTATION_SPEC.md)
- [Application API contract](docs/API_CONTRACT.md)
- [Installation and commissioning runbook](docs/INSTALLATION_RUNBOOK.md)
- [Apple Home via HomeKit Bridge and Apple TV hub](docs/APPLE_HOME_SETUP.md)
- [Design and delivery loop](docs/DESIGN_AND_DELIVERY_LOOP.md)
- [Test plan](docs/TEST_PLAN.md)
- [Security and operations](docs/SECURITY_AND_OPERATIONS.md)
- [Plan review and corrections](docs/PLAN_REVIEW.md)

## Likely MVP capabilities

- Lights and dimmers
- Shades/covers
- Climate set-points
- Home Assistant scenes and scripts
- Basic room media where reliably exposed
- Favorites and rooms
- Secure sign-in
- Command confirmation and audit history
- Installable iPhone/web PWA

Security-sensitive controls such as alarms, locks, gates, and garage doors are excluded from the initial release.

Post-MVP, non-Control4 devices join through their own Home Assistant integrations: the sauna (currently on its manufacturer's app) and the Yale door locks. See the implementation specification, Phase F.

## Exact next step when Home Assistant Green arrives

Follow [the installation runbook](docs/INSTALLATION_RUNBOOK.md). The first technical objective is a complete vertical slice:

```text
One browser button
→ application backend
→ Home Assistant REST API
→ Control4
→ one physical light
→ confirmed state in the browser
```

Once that works locally and remotely, export the entity inventory, approve mappings, and generate the full MVP dashboard.

## Resume prompt for another chat

> Open `daschreiber/smarthome`, read the README and all files under `docs/`, and continue from the installation runbook. The goal is a private PWA controlling Control4 through Home Assistant Green. Do not expose Home Assistant or Control4 credentials in browser code or GitHub.

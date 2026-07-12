# Plan Review — Control4 System (2026-07-11)

A deep review of the plan before any code is written. Verdict: **the architecture is sound and should be kept as-is** — Home Assistant Green as the only Control4 client, a narrow typed backend API, no secrets in the browser, no port-forwarding. Two factual errors and several sharpenable assumptions were found and corrected in the specs. Nothing requires a redesign.

## 1. What was verified as correct

- **Local control path.** The official Home Assistant Control4 integration talks to the controller's local Director API using ordinary homeowner credentials. No dealer or Composer Pro access is needed. Requires Control4 OS 3.0+ (the Core 3 on 3.4.3 qualifies) and local network reachability; 4Sight remote access is not usable by the integration.
- **Cloud conclusion.** Treating Control4's cloud/relay channel as private and unusable is correct; Home Assistant on the LAN is the practical route.
- **Security posture.** Backend-only secrets, typed command allow-list, no generic service-call endpoint, no exposure of port 8123 — all consistent with how these systems are actually attacked and misconfigured.
- **Delivery approach.** Vertical slice first, evidence-based loops, reversible-device commissioning tests — no changes needed.

## 2. Corrections applied (previously wrong or over-optimistic)

### 2.1 Entity coverage was overstated — the biggest correction

The implementation spec instructed verifying entities under `light`, `cover`, `climate`, `media_player`, `scene`, `switch`, and `script`. Verified against the Home Assistant core source (`homeassistant/components/control4/__init__.py`): the integration loads **exactly four platforms — `climate`, `cover`, `light`, `media_player`** — and nothing else.

Consequences, now reflected in the specs:

- Control4 lighting scenes, Experience buttons, and programming are invisible to Home Assistant. Household scenes (Good Night, All Off, Movie) must be **recreated as Home Assistant scenes/scripts** composed from the exposed light/cover/climate entities. This was already the plan's step 8, but it was positioned as optional ("compound actions not exposed cleanly") rather than the only way scenes exist at all.
- Dealer-created virtual switches or relays will **not** help through the official integration (there is no `switch` platform), so that lever, mentioned in Phase E and Loop 8, was qualified.
- If relays, contact sensors, fans, locks, or the alarm panel are ever needed from Control4, the fallback is the community `lawtancool/hass-control4` custom integration (supports those, with a relay-based-locks-only limitation and explicit stability caveats), or moving those devices onto non-Control4 integrations.

### 2.2 "Local" authentication has a cloud dependency

The plan described the path as purely local. In fact the integration authenticates in two steps: homeowner credentials → Control4 **cloud** account bearer token → local Director bearer token. Commands and state reads are local, but initial setup and token refresh require Control4 cloud reachability. Practical implications, now documented in the implementation spec and test plan:

- A prolonged Control4 cloud outage or a homeowner password change can break re-authentication (e.g., after a Home Assistant restart) even while current-token local control still works.
- This does not change the architecture — every alternative has the same or worse dependency — but the failure mode should be recognized during commissioning rather than discovered in production.

## 3. Assumptions sharpened

- **Home Assistant user permissions.** "Least privilege" for the app's Home Assistant user is weaker than it sounds: Home Assistant has no per-entity or per-service ACLs for regular users, so the long-lived token can call services on any entity. The backend allow-list is the real boundary; the security doc now says so explicitly.
- **State staleness math.** The Control4 integration polls the Director every 5 seconds by default (configurable to 1); app polling stacks on top. Worst-case staleness ≈ app interval + integration interval, which can brush against the 5-second confirmed-state target. The knob to turn first is the integration scan interval, noted in the implementation spec.
- **Hosting option 2 (serverless) conflicts with SQLite.** If serverless is chosen, Postgres is required from day one. Noted inline. The stated preference (conventional Node host) avoids this entirely and remains the right first choice.
- **Media expectations.** Control4 media in Home Assistant is room-based and coarse (power, volume, source). The plan's "basic media where reliably exposed" hedge is appropriate — keep expectations there.

## 4. Future scope recorded: sauna and Yale locks

Both are deliberately out of MVP and both bypass Control4, joining later through their own Home Assistant integrations (this is exactly the payoff of putting Home Assistant in the middle). A new Phase F in the implementation spec covers them:

- **Sauna** — stays on the manufacturer's app for now. To design the later phase, the brand/model and app name are needed to identify the matching Home Assistant integration (several sauna controllers have official or community integrations; some have none). When integrated, heater control must be treated as safety-sensitive: confirmation required, server-side temperature/duration bounds, and excluded from broad scenes such as All Off/Away unless explicitly designed in.
- **Yale door locks** — identified from homeowner photos: a Yale **Linus** retrofit cylinder lock with a Yale Smart Keypad and a Yale Smart Video Doorbell. This is the Yale Home ecosystem, not Control4 Zigbee, so the earlier worst case (no Home Assistant path) does not apply:
  - Primary path: the official **Yale Home** integration (`yale`, cloud push), which requires a Yale Connect Bridge *or* a Yale doorbell as bridge — the doorbell on site satisfies this. It exposes the lock plus doorbell camera snapshots and doorbell/motion events. The keypad works through the lock and needs nothing extra.
  - Confirmed Linus **L2** with Matter enabled by the homeowner. Matter over Thread offers local control, but Home Assistant Green has no Thread radio or Bluetooth: commissioning needs a Thread border router (dongle or credentials shared from an existing Apple/Google one) and the companion app on a phone. Cloud integration first, Matter later if local control matters. The Matter setup code stays in the homeowner's password manager, never in this repository.
  - Locks get their own permission tier, confirmation flow, and audit treatment before any exposure in the app, and stay out of all scenes.

## 5. Open items for the homeowner

1. Sauna brand/model and the name of its app (needed to scope Phase F).
2. ~~Yale lock model and connection type~~ Resolved: Yale Linus L2 (Matter enabled) + Smart Keypad + Smart Video Doorbell, Yale Home ecosystem.
3. During commissioning, an inventory of which household scenes exist today in Control4/Alexa, so equivalents can be rebuilt as Home Assistant scenes.

## 6. Sources

- Home Assistant core, Control4 integration source (platform list, cloud-then-local token flow): `homeassistant/components/control4/__init__.py`, `const.py` (dev branch, checked 2026-07-11)
- Official integration docs: https://www.home-assistant.io/integrations/control4/
- Community custom integration and its caveats: https://github.com/lawtancool/hass-control4

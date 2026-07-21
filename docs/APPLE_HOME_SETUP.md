# Apple Home via HomeKit Bridge and Apple TV Hub

Goal: control the house from Apple's Home app (iPhone, Watch, Siri, CarPlay) —
including away from home — using the Apple TV already on the LAN as the home
hub. This complements the PWA; it does not replace it, and it does not replace
runbook Stage 7 (the PWA backend still needs Home Assistant Cloud or an
equivalent secure route — an Apple home hub only relays the Home app, not the
Home Assistant API).

## How it works

Apple Home cannot talk to Control4. The chain is:

```text
Home app (anywhere)
        |
        v  (Apple iCloud relay, end-to-end encrypted)
Apple TV = home hub (on the home LAN)
        |
        v  (HomeKit Accessory Protocol, local)
Home Assistant Green — "HomeKit Bridge" integration
        |
        +--> Control4 Core 3 --> lights, shades
        +--> CoolMaster bridge --> climate
```

No port-forwarding, no Home Assistant Cloud subscription, nothing exposed on
the router. Remote traffic rides Apple's relay; on the LAN the Home app talks
straight to the Green.

## Prerequisites

- Apple TV: 4K model recommended, signed into the **same Apple ID** as the
  owner's iPhone, with iCloud enabled. tvOS keeps home-hub role automatically
  under the current Home architecture.
- The Apple TV and the Green must see each other's **mDNS** (Bonjour).
  ⚠️ Site-specific: the Green lives on a router LAN port because the UCY
  switch showed port-isolation behavior (see COMMISSIONING_LOG 2026-07-16).
  If the Apple TV is wired to the UCY switch and pairing or the hub shows
  "Not Connected", suspect the switch first — move the Apple TV to Wi-Fi or a
  router port to test.
- Owner login to Home Assistant (the HomeKit Bridge integration is added by
  an admin; the non-admin `smarthome-app` token cannot do this).

## What to expose — decisions that matter

**HomeKit allows at most ~150 accessories per bridge** and Home Assistant
warns as you approach it. The entity map currently has 156 visible
controllable entities, so "expose everything" will not fit. Recommended
first bridge, ~130 accessories:

| Domain | Expose | Notes |
| --- | --- | --- |
| `light` | Yes (the ~97 Lighting-group entities) | Exclude the KNX relays grouped under Utilities/Appliances and everything `visible:false` in `data/entity_map.json`. |
| `cover` | Yes (13 shades) | Work end-to-end (proven in Stage 3). |
| `climate` | **Only the CoolMaster units `climate.l1_101`–`l1_202`** | See below. |
| Scenes | Yes (the 6 KNX scene group-switches) | They arrive as switch-like entities; Morning/Night/Exit/Welcome become tappable in Home and Siri-able. |
| `media_player` | Not on the first bridge | HomeKit requires TVs in accessory mode (one pairing each), and media is the flakiest domain. Add later as separate accessories if wanted. |
| `vacuum` | Optional (2) | Fine if room remains under the limit. |

### Climate: never expose the Control4 zone entities

The Control4→CoolAutomation proxy **silently drops setpoint reads and
writes** (root cause verified 2026-07-17, COMMISSIONING_LOG). A HomeKit
thermostat backed by a `climate.<control4 zone>` entity would show a bogus
target temperature and ignore changes — with HTTP 200s all the way down.

Expose the **CoolMaster unit entities** instead (`climate.l1_101` …
`climate.l1_202`): real setpoint read/write, on/off verified safe against
KNX re-assertion. Consequences to accept:

- Multi-unit rooms appear as multiple thermostats in Home: Kitchen = 3
  (L1.111/114/115), Lounge = 2 (L1.201/202). Group them in the same Home
  room and rename ("Kitchen AC 1/2/3").
- **Exclude L1.109 (rack cooling)** and consider excluding L1.110 (Utility
  Room) — same reasoning as their `visible:false` status in the app.

### Policy exclusions carry over

Locks, alarm, gates, garage, and the sauna stay out of Apple Home, same as
the PWA MVP. The Home app has no per-action confirmation or audit trail, so
nothing safety-tiered gets exposed. Commands issued via Apple Home also
bypass the app's audit history entirely — worth remembering when reading
logs.

## Setup steps

1. **Home Assistant** (owner login, desktop browser is easiest):
   Settings → Devices & Services → **Add Integration → "HomeKit Bridge"**.
   - In the options flow select **domains**: light, cover, climate (plus
     switch if the scene group-switches surface there).
   - Then switch the integration's mode to *include entities* and select the
     specific list per the table above. Iterating later is safe — entities
     can be added/removed without re-pairing.
2. A persistent notification appears in HA with a **QR code / pairing code**.
3. **iPhone Home app** (on the home Wi-Fi): Add Accessory → scan the QR code
   from the HA notification → assign the bridge to the home.
4. Assign accessories to rooms. HA passes its Area names as suggested rooms;
   the 25 areas from the Stage 5 normalization should map over cleanly.
5. **Verify the hub**: Home app → ⋯ → Home Settings → Home Hubs & Bridges →
   the Apple TV should show **Connected**. (On the Apple TV itself:
   Settings → AirPlay and HomeKit.)
6. **Verify remote**: take the iPhone off Wi-Fi (cellular), toggle one light
   and one shade, change one AC setpoint and confirm on the wall panel.

The pairing code is a secret: password manager, never this repository.

## Bonus: Thread border router for the Yale lock

An Apple TV 4K (2nd gen onward, wired or Wi-Fi) is a **Thread border
router**. The Yale Linus L2 Matter plan (PLAN_REVIEW, IMPLEMENTATION_SPEC
Phase F) needs exactly that — the Green has no Thread radio. When the lock
is commissioned over Matter, the Apple TV can provide the Thread network
instead of buying a Connect ZBT-1 dongle. This does *not* put the lock in
Apple Home via HA; it can be commissioned to Apple Home directly and/or to
HA's Matter server via multi-admin — a Phase F decision.

## Failure modes seen elsewhere / to expect here

- **Pairing fails or bridge shows "No Response"**: mDNS blocked between
  iPhone/Apple TV and the Green — check which network segment each is on
  (UCY switch isolation, guest Wi-Fi, VLANs).
- **Hub "Not Connected"**: Apple TV asleep-on-ethernet or signed into a
  different Apple ID/home.
- **Accessories unresponsive after HA restart**: normal for ~30s while the
  bridge re-announces.
- **State lag up to ~5s** on Control4-sourced entities (Director poll
  interval) — same as the PWA; setpoint changes via CoolMaster show in ~3s.

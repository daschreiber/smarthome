# Commissioning Log

Running record of the physical installation and commissioning of the Home Assistant Green. Companion to the [installation runbook](INSTALLATION_RUNBOOK.md).

## 2026-07-16 — Green brought online (runbook Stage 1)

### Outcome

Home Assistant Green is online at `http://10.0.0.69:8123`. Owner account created via the iOS companion app. Onboarding completed; auto-discovered media devices (Apple TV, Google Cast, Sonos, Samsung TV, MusicCast, DLNA, IPP) were intentionally skipped — media integrations come after the Control4 core per the product plan.

### Network findings (important for future work)

- Home network is `10.0.0.x`; router at `10.0.0.138` (unusual gateway address, dealer-installed network).
- Rack contains: 24-port patch panel, UCY 24-port PoE switch, fiber termination box, and a white router with antennas (DSL-labeled uplink port, numbered LAN ports).
- **Wall jack failed**: the first RJ45 jack tried gave link lights but no connectivity. Likely unpatched or on an isolated segment.
- **UCY switch port also failed**: with the Green on a free switch port, it never appeared on the network (subnet scan of `10.0.0.1-254` on port 8123 found nothing, mDNS silent). The switch has VLAN/Extend DIP switches; port isolation is the leading suspect. Not yet investigated.
- **Router LAN port 2 worked immediately**: Green was discovered by the companion app within minutes of moving it there and power-cycling.
- Control4 hardware is on the same network — Fing scan shows multiple devices with MAC prefix `00:0F:FF` (Control4's OUI). One of these is the Core 3; exact IP not yet identified.

### Decisions

- The Green's permanent home is a LAN port directly on the router, not the UCY switch, until the switch's isolation behavior is understood.
- Remote access deliberately NOT enabled yet (runbook Stage 7 does this via Home Assistant Cloud later).

### Follow-ups

- [ ] Get a DHCP reservation for the Green at `10.0.0.69` (may require dealer, who manages the router).
- [ ] Identify the Core 3's IP among the `00:0F:FF` devices for the Control4 integration.
- [ ] Optional, later: investigate UCY switch VLAN DIP configuration if the Green should move to the switch.

### Next runbook stage

Stage 2 — connect Control4: install pending Home Assistant updates, then add the Control4 integration with the Core 3 local IP and homeowner credentials. Record the entity count by domain.

## 2026-07-16 — Control4 integration connected (runbook Stage 2)

### Controller identification

Three Control4 devices on the network (Fing, MAC OUI `00:0F:FF`):

| IP | Hostname | Role |
| --- | --- | --- |
| `10.0.0.29` | `000FFF9F3B44-CO` | **Core 3 — primary Director** (`control4_core3_000FFF9F3B44`) |
| `10.0.0.36` | `000FFF9F3B0E-CO` | Core-series satellite (rejects Director token) |
| `10.0.0.6` | `000FFF972A54-EA` | EA-series satellite (rejects Director token) |

All three answer HTTP 200 on port 443, so port-probing cannot identify the Director; only the cloud-issued token (or the account's `controllerCommonName`) can.

### Setup failure and resolution

Initial attempts against `10.0.0.29` failed with `aiohttp ServerDisconnectedError` during the **cloud** call to `apis.control4.com/authentication/v1/rest/authorization` (the Director-token grant in `pyControl4.account.getDirectorBearerToken`). Credentials were never the problem — the same flow reached the local-rejection stage on the satellite IPs minutes apart, so the cloud endpoint was dropping connections intermittently, most likely rate-limiting after several rapid auth attempts.

**Fix:** restart Home Assistant (clears the shared aiohttp connection pool), wait ~20–30 minutes, then attempt setup once. Worked on the first try. Lesson for future re-auth events: avoid rapid-fire setup retries against the Control4 cloud.

### Notable hardware finding

Climate is not native Control4: multiple **CoolAutomation "HVAC + UFH Zone"** bridge devices (AC + underfloor heating) are proxied through Control4 and appear in Home Assistant. Several share the default name "AC - Heating" — renaming required in the Stage 5 normalization pass.

### Integration result

**179 devices / 178 entities** created by the Control4 integration. Per-domain breakdown deferred to the Stage 4 inventory export (to be done from a desktop browser).

## 2026-07-16 — First control verified (runbook Stage 3, partial)

**Cover control works end-to-end**: study blinds lowered and raised from the Home Assistant iOS app. Chain proven: phone → Home Assistant Green (`10.0.0.69`) → Core 3 Director (`10.0.0.29`) → physical device, all local. This is the vertical slice the architecture depends on.

### Follow-ups

- [x] Stage 4: full entity inventory export with per-domain counts.
- [x] Stage 5: rename entities, assign Areas.
- [ ] Finish Stage 3 safe tests: one light/dimmer, one thermostat read (verify displayed state matches reality before touching set-points).
- [ ] DHCP reservations for the Green (`10.0.0.69`) and Core 3 (`10.0.0.29`).

## 2026-07-16 — Inventory, mapping, and normalization (runbook Stages 4-5)

### Stage 4 — inventory

Exported via Claude Cowork on the LAN (this cloud session cannot reach the Green): 239 entities, of which 184 controllable (144 light / 26 sensor / 14 media_player / 13 climate / 13 cover / ...). Raw data in `inventory/entities.json`, counts in `inventory/SUMMARY.md`.

**Architecture finding:** the Control4 project fronts a **KNX bus**. Many KNX relay channels arrive as `light` entities but are actually fans, vents, towel rails, floor-heating valves, appliance sockets, scene group-switches, boiler relays (defunct — boilers removed from the house), a pump, and a TV lift. Whole-house scene switches (Morning/Night/Exit/Welcome) exist as KNX group switches, giving scene control despite the integration not exposing Control4 scenes.

### Mapping decisions (owner-approved)

- Nothing is excluded; entities get an app **group** (Lighting 97 / Climate & Comfort 39 / Media 14 / Shades 13 / Utilities 8 / Appliances 7 / Scenes 6).
- 30 behind-the-scenes entities are **hidden** (floor-heating valve relays, appliance sockets, defunct boiler relays, pump, HVAC master cutoffs, rack cooling): present in the map with `visible:false`.
- Owner-confirmed floor plan encoded: **Floor 5** and **Floor 6** (penthouse), 25 real areas + virtual "Whole House". Dining split from Lounge; Hall folded into Entrance; Stairs+Landing merged; separate balconies per floor plus Master Bedroom Balcony.
- Source of truth: `data/entity_map.json`, generated by `tools/build_entity_map.py`.

### Stage 5 — normalization applied

Applied by Claude Cowork via the HA WebSocket registry API (backup `74aa5f38` first): 2 floors + 25 areas created/aligned, 184/184 entities assigned, renamed, and visibility-set, zero failures. Full report: `inventory/NORMALIZATION_REPORT.md`.

Notable: `media_player.balcony` ("Balcony Speakers 1") is a VSSL A3x via Google Cast, not Control4; its true location (5th vs 6th balcony) is still to be confirmed by ear, then renamed.

### Next

- Stage 6: dedicated HA user + long-lived token for the app (owner task).
- Stage 7: remote access via Home Assistant Cloud.
- Then: application backend + PWA against `data/entity_map.json`.

## 2026-07-16 — Stage 6 done; vertical slice proven (Loop 2)

- Dedicated `smarthome-app` HA user created (non-admin, local-network-only)
  with a long-lived token, stored in the owner's password manager and in
  `web/.env.local` on the development Mac only.
- Vertical slice verified end-to-end on the LAN (via Claude Cowork):
  health OK, 154 visible devices with live state, and
  `light.knx_dimmer_daniel_study_lights` physically switched on and off from
  the backend. Round trips ~3.7-4.0s, inside the 5s budget. HA history
  confirmed the physical transitions.
- **Finding:** KNX state feedback takes ~3.7s to reach HA (Control4
  integration polls the Director on a 5s interval), so the original fixed
  1.2s read-back returned stale state while the response claimed
  "confirmed". Fixed: the backend now polls read-back up to 8s and returns
  "confirmed" only when the observed state proves the command's intent;
  otherwise it returns "sent" with the observed state. If latency ever needs
  to shrink: lower the Control4 integration scan interval, then consider the
  HA WebSocket stream (Phase E).
- KLAFS sauna integrated as a virtual device via the existing sauna service
  (safety tier: confirm-required, 40-100°C bounds). Committed follow-up:
  promote the sauna to HA entities so automations/scenes can target it.
- Owner requirement recorded: room synonyms for natural language
  (`data/room_aliases.json`).

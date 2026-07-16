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

- [ ] Finish Stage 3 safe tests: one light/dimmer, one thermostat read (verify displayed state matches reality before touching set-points).
- [ ] Stage 4: full entity inventory export with per-domain counts.
- [ ] Stage 5: rename duplicate CoolAutomation "AC - Heating" zones, assign Areas.
- [ ] Enable Home Assistant backups.
- [ ] DHCP reservations for the Green (`10.0.0.69`) and Core 3 (`10.0.0.29`).

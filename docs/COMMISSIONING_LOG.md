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

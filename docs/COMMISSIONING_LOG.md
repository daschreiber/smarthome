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

## 2026-07-17 — Climate setpoints: root cause found, CoolMaster bridge mapped

Owner symptom: the app turned the gym A/C on/off fine, but showed a wrong
setpoint (placeholder 24) and +/- changed nothing — the unit woke at its last
wall-panel setpoint (16°C).

### Root cause (verified live)

The Control4→CoolAutomation proxy neither reports nor applies setpoints:

- Every one of the 13 `climate.*` zone entities reports `temperature: null`
  when off and a bogus `0` when running — HA never receives a real setpoint,
  house-wide. (`supported_features` still claims target-temperature support,
  so nothing errors.)
- A direct `climate.set_temperature` to the gym zone returned HTTP 200 and
  was silently dropped: the entity's attributes and `last_updated` never
  moved, and the wall unit stayed at 16°C. On/off (hvac-mode) commands do
  propagate — which is why only setpoints looked broken.

### CoolMaster bridge found and mapped

The CoolAutomation bridge the zones hang off is a **CoolMaster, S/N 05116051,
firmware 1.2.2, at `10.0.0.90:10102`** (ASCII protocol; found by a LAN sweep
for the CoolMasterNet port). Its `ls` console reads and writes every unit's
real setpoint — including the gym's stranded 16°C.

Room→unit mapping established by (a) instant-of-time temperature correlation
between HA zone entities and the bridge console, then (b) confirming the
ambiguous ones by toggling zones via HA while watching the console live:

| Unit(s) | Zone |
|---|---|
| L1.101 | Den |
| L1.102 | Medium Guest Room |
| L1.103 | Sauna |
| L1.104 | Daniel's Study (confirmed by toggle) |
| L1.105 | Daniella's Study |
| L1.106 | Gym (setpoint 16 = owner's test) |
| L1.107 | Small Guest Room |
| L1.108 | Large Guest Room |
| L1.109 | Rack cooling (name "Rack UNIT 109") |
| L1.110 | Utility Room |
| L1.111 + L1.114 + L1.115 | Kitchen (confirmed by toggle; open plan, 3 units) |
| L1.112 | Master Bedroom |
| L1.201 + L1.202 | Lounge (confirmed by toggle) |

The mapping lives in `tools/build_entity_map.py` (`COOLMASTER_UNITS`) and
flows into `data/entity_map.json` as `coolmaster_units` per climate row.

### Fix shape

Home Assistant's native **`coolmaster` integration** talks to the bridge
directly and gets working on/off and setpoint read/write per unit. The app
routes **all climate commands** to a zone's unit entities (one service call
fans out to every unit; kitchen sets 3 at once). Zone state and current
temperature are still read from the Control4 entity, which mirrors the bridge
within ~4s and keeps multi-unit zones grouped; the target temperature is read
from the zone's first unit. Zones with no mapped units — and any install
where the coolmaster integration is missing — degrade to the old behavior.

### Owner action (done same day, see next entry)

The `smarthome-app` token is deliberately non-admin, so the integration had
to be added with an owner login: HA → Settings → Devices & Services → Add
Integration → "CoolMasterNet" → host `10.0.0.90`. (Attempted via browser
automation from the dev Mac first — blocked by macOS's per-app Local Network
permission, worth granting to Chrome one day.)

## 2026-07-17 — CoolMaster integration live; climate verified end-to-end

- Owner added the CoolMasterNet integration (host `10.0.0.90`, all modes,
  no swing). All 16 unit entities appeared with the exact predicted ids
  (`climate.l1_101` … `climate.l1_202`), each reporting a real target
  temperature — including the gym's stranded 16°C from the owner's test.
- Write path verified live: `climate.set_temperature` on `climate.l1_106`
  to 22.5° changed the physical bridge setpoint within ~3s (bridge console
  read back 22°); restored to 24°. Note: wall units display whole degrees,
  so half-degree setpoints round on the physical display.
- Owner decision: route climate **on/off** through the CoolMaster units as
  well, not just setpoints — Control4 is now fully out of the A/C command
  path (it remains the state/telemetry source for zone cards).
- Security note recorded (SECURITY_AND_OPERATIONS §7): the bridge's port
  10102 console is unauthenticated on the LAN.

## 2026-07-17 — Owner-verified two-way climate sync; deployment gotcha found

### Live verification with the owner (Daniel's Study, L1.104)

- App **+/−** → CoolMaster bridge: setpoint landed within seconds, every time.
- App **Off** → unit off instantly; watched the bridge for 3½ minutes —
  **no re-assert from Control4/KNX**. Bypassing Control4 for on/off is safe.
- App setpoint → **KNX wall panel display followed** (via
  CoolAutomation→Control4 state sync).
- **Wall panel +/−** → bridge, HA, and app all followed within seconds. The
  panel→zone path was never broken — only Home Assistant's write path
  through the Control4 climate entity was.
- Net result: the CoolMaster bridge is the single source of truth; app, wall
  panels, HA, and the bridge console stay in agreement in both directions.
- CoolMaster console screen (electricity cupboard) refreshes its display
  lazily — up to ~a minute behind. Cosmetic only.

### Deployment gotcha: Railway does not deploy `main`

Why the fix "didn't work" at first: the Railway service builds the
**`claude/home-assistant-setup-sskcuf` branch**, not `main`. The climate fix
sat merged on main while the phone kept getting the stale branch build (the
service had also been crash-looping 06:52–12:15 and serving its last healthy
deploy; resolved by the branch's own 698818b deploy at 14:50). Fixed by
merging main into the branch (`c4e860a`, deployed SUCCESS, then merged back
as PR #19).

**Resolved same day:** the owner pointed the Railway service at `main`
(first main deploy `de3837f`, SUCCESS) — "merged to main" and "deployed"
now mean the same thing.

## 2026-07-17 (later) — Sauna live in the app

The sauna card's "unavailable"/"Command failed" saga ended as a token
mismatch: the Sauna app's `/api/quick/*` endpoints authenticate against its
`API_TOKEN` env var (fail-closed — an UNSET token also answers
"Invalid token"), and Railway's `SAUNA_API_TOKEN` didn't match it. Owner
aligned the two; card reports live cabin state and hold-to-start works.

Two related fixes shipped on the way to the diagnosis:
- Gateway timeouts during `/api/quick/start` are reported as "sent —
  watchdog verifying" (amber), not failure: the Sauna app verifies real
  heating for up to ~2 minutes, longer than its serverless platform
  allows, and arms a watchdog cron BEFORE verifying — the start
  survives the killed HTTP call by design.
- Error surfacing: the card now shows the server's actual reason
  (`unavailable — Invalid token` is what cracked the case) instead of a
  mute label. Diagnosability is a feature.

## 2026-07-22/23 — Media capability: from dead cards to whole-home Spotify

Full topology survey and findings in **docs/AUDIO_SYSTEM.md**. Summary:

- Room media cards were dead because Control4 matrix zones support no
  `turn_on`/`play_media` — a zone wakes by source selection. App now has
  select_source/play/pause commands and a real MediaCard (PRs #58/#59).
- Owner's live test (Lounge): source selection audibly switches the matrix.
  TuneIn/My Music/Digital Media are unconfigured C4 apps → hidden.
- Physical survey: Den cabinet = VSSL A.1x (sauna audio, healthy) + Yamaha
  RX-V4A; Lounge cabinet = VSSL A.3x (outdoor zones; powered but NO
  ethernet — its streaming has been dead since install) + Core 3 + Yamaha
  RX-V6A. 5th-floor KNX "Controlled Socket" tested (5 min on, restored
  off): not the amps' feed.
- Den & Lounge Yamahas were on the LAN, never in HA — integrated
  2026-07-23, in-app as "Receiver" cards with Spotify/AirPlay/Bluetooth/TV
  chips (PR #60). Den's C4 audio routes through the RX-V4A (HDMI2).
- **Discovery that reshaped the plan: the Core 3 has native per-zone
  Spotify Connect ("Spotify C4 <Room>" in the Spotify picker) — indoor +
  outdoor Spotify with zero new hardware.** Verified live: Kitchen zone
  reported the playing track's title in `media_title`.

## 2026-07-26 — Per-floor heat/cool changeover in the app; Eight Sleep confirmed done

The house's one HVAC truth the app never knew: each floor has ONE central
VRF unit, so rooms on a floor cannot mix heating and cooling — the MBR
can't heat while any 6th-floor zone cools. The changeover is a KNX relay
per floor (`light.knx_switch_ac_heat_5th/6th`, **on = heating,
off = cooling**), which also gives free read-back of a floor's mode.

The installer's Control4 "AC 5th / Heating 5th" macros (owner screenshots)
decode to: command a sacrificial unit to the OPPOSITE of the target mode,
3s, flip the relay, 7s, flip it again (KNX reliability), 3s, unit off —
~13s. Sacrificial units: 5th = Rack UNIT 109 (`climate.l1_109`),
6th = Utility Room (`climate.l1_110`). The opposite-mode step looks wrong
but is field-tested dealer programming — replicated verbatim, not
second-guessed (`web/src/lib/changeover.ts`, 7 tests pin the sequence).
App surface: `POST /api/climate/mode {floor, mode}` (fire-and-forget,
one per floor at a time, audited), `floorModes` in `/api/home`, and a
confirm-guarded Cool|Heat toggle under the Home floor tabs. The Home
"Heating" system card became "Underfloor heating" — with Climate now
covering both directions, the old name read as a second way to heat air.

Eight Sleep: confirmed fully live in production (all `EIGHTSLEEP_*` envs
set on Railway; away-mode sync ships with `/api/away` → `bed_away_on/off`
in Activity). The owner's "greyed-out test" was the leftover DISABLED
`eight_sleep_rollout_test` automation from the 2026-07-25 field test —
deleted from `/data/automations.json` via `railway ssh` (backup:
`automations.json.bak-20260726`). Owner scope decision: away sync is the
ONLY Eight Sleep wiring wanted; no further bed features.

Smaller strokes, same day:
- Sauna follower: A/C at 18° (was 20) and fan "high" — the CoolMaster
  unit's max (modes checked live: low/medium/high/auto). Overridable via
  SAUNA_AC_TEMP / SAUNA_AC_FAN.
- Automations page split into **"If → then"** (Sleep sense, Sauna
  follower, auto-off timers — moved up from the bottom) and **"Time
  switches"** (the scheduled list), matching how the owner reads the
  rules. Sleep sense's card now states it is home-only by design — the
  owner went looking for a "When home" selector it never needed.
- Whole House devices (the all-rooms closet strip, a `scene_switch`)
  group under "Several rooms" with real labels — display lookups now
  resolve every device, not just the builder's filtered target list.

## 2026-07-29 — Perceived latency: instant taps, CoolMaster-truth A/C state

Owner symptom: "the app takes a while to respond" — both the UI (cards
spinning/reverting for seconds) and reality (A/C apparently slow to react).
Diagnosis: three stacked lags, none of them the devices themselves.

1. The command route blocked its HTTP response on read-back polling (up to
   8s; ~4s typical, since the Control4 integration polls the Director on a
   5s interval). Every tap held a spinner for that long. Fixed: the route
   answers `sent` the moment HA accepts the service call and runs the same
   read-back loop in the background (`void`, like lib/changeover); the
   verified/`(unverified)` verdict still lands in the audit log. API
   contract updated — `confirmed` in a response now only comes from the
   sauna and white-noise paths, which verify inline on purpose.
2. Cards showed no optimistic state: a toggle looked ignored until
   `/api/home` (3s poll) caught up with the ~4s Control4 mirror. Fixed:
   `page.tsx` overlays the expected result at tap time (per-command
   patches; 12s hold so a stale poll can't flip the card back; dropped the
   moment the server proves the state, rolled back if the command fails).
   Room fan-outs get the same treatment. Sauna, noise, and bed cards stay
   non-optimistic deliberately (safety tier / listener ground-truth).
3. A/C on/off state displayed from the Control4 zone entity, which lags
   the CoolMaster bridge by ~4s — the A/C was often already running while
   the app said off. Fixed: `/api/home` derives climate state from the
   zone's CoolMaster unit entities (on if any unit runs; Control4 entity
   remains the fallback when units are absent), matching how setpoint and
   fan already read. Background read-back for climate also targets the
   unit entity now.

Also: `/api/home` awaited the white-noise status serially after the
parallel block — moved into the `Promise.all`, shaving its round trip off
every poll. Still open if latency needs to shrink further: lower the
Control4 integration scan interval, then the HA WebSocket stream (both
flagged 2026-07-16).

## 2026-07-30 — Light commands re-assert: KNX drops turn-ons, silently

Owner symptom (Daniel's Study): "despite trying a couple of times, the spots
and strip aren't coming on. If I try a few times the strip comes on but the
spots still don't." And the decisive detail: **once they're on (from the wall
switch) they obey off and dim reliably** — it is the on-from-cold that gets
lost. The room's plain KNX *switch* channels (desk light, closet LED) were
never affected; only the dimmer channels.

Two failures were stacked, and the second is what made the first feel random.

1. **The telegram goes missing.** Nothing new about this bus: the installer's
   own changeover macro flips its relay twice "for KNX reliability"
   (2026-07-26), and `holdUntil` exists because automation lights come back
   off. The interactive path had no such belt — one telegram, one hope. Fixed:
   a light command is now an intent, not a telegram (`web/src/lib/knxLights.ts`).
   The command route sends, watches the read-back, and re-sends while the
   light disagrees — up to 3 attempts, ~4.2s apart (longer than the ~3.7s
   Control4 feedback lag, or every command would re-assert against its own
   stale read), then stands down. The retry **escalates** for dimmers: a bare
   `light.turn_on` reaches these Control4-fronted KNX dimmers as an unnamed
   ramp to full, so attempt 2+ names `brightness_pct: 100` instead — the same
   shape the slider sends, and the slider is the control the owner reports as
   reliable. Same treatment for the "Room lights" fan-out, which is one
   request but many telegrams (`verifyLightSweep`, background, per-fixture).
2. **The card lied about it.** The optimistic overlay flipped the toggle to
   "on" at tap time and the route answered `sent` immediately; the background
   read-back knew the light never came on but told only the audit log. So the
   card showed a lit light over a dark room — and the owner's *next* tap sent
   `turn_off`. That is precisely the "I tried a few times, sometimes it works"
   pattern: alternate taps were switching off a light that was already off.
   Fixed: a command that is re-asserted and still never proven is remembered
   (in-memory, 90s TTL, same single-service assumption as `changeoverStatus`),
   published per device as `unverifiedAt` in `/api/home`. The card retires its
   overlay the moment the server refutes it and says **"off · didn't answer —
   try again"** rather than showing a state nobody asked for.

Only positive evidence acts, in both directions (the hold loop's rule): a
light reading `unavailable` is never re-commanded, and never counted as
proof that the command landed.

Two rules the re-assert loop needs to be safe rather than merely persistent
(both from the Codex review on PR #97):

- **A newer command wins.** A verifier runs for up to 16s in the background,
  which is ample time to change your mind — and a loop re-asserting a
  superseded intent doesn't waste a telegram, it *undoes* the newer command
  (tap on, tap off, and the stale `turn_on` verifier reads "off" as a
  contradiction and relights the room). Every light command now claims the
  device before it goes out; each re-assert and each verdict is gated on
  still holding that claim, single-device and room-sweep alike.
- **"On" is not proof of a dim.** A fixture already alight satisfies a state
  check the instant a `set_brightness` is sent, so a dropped level telegram
  would have counted as success and never been re-asserted. Verification
  reads the brightness attribute back too (±2% for HA's 0-255 round trip),
  and a light that reports no level at all is still taken at its word on
  state — better than re-asserting forever at an integration that simply
  doesn't echo levels.

Still open — the real fix is upstream of the app. These dimmers are Control4
proxies of KNX dimming actuators; the app can only re-send what Control4 will
carry. If the on-from-cold keeps needing three tries, the questions for the
integrator are (a) whether the dimming actuator is parameterised to switch on
when it receives a brightness value while off, and (b) whether native HA `knx`
light entities on the dimmers' own switch + brightness GAs would bypass the
Control4 driver entirely — the tunnel and the pattern already exist for the
shades (`knx/README.md`), and light actuators here *do* transmit status
(cmd `2/0/14` → status `7/1/84`), which the shades never did.

## 2026-08-12 — Control4 down after power outage; controller IP changed

### Symptom

A power outage (owner away from home) left every Control4-backed entity
`unavailable` — all lights and the Control4 climate entities — while KNX
covers, CoolMaster climate, and media players kept working. So the fault was
isolated to Home Assistant's Control4 integration, not the controller (the
native Control4 app worked throughout). Fixed entirely remotely via the Nabu
Casa UI and the File editor add-on.

### Two faults in sequence

1. **Boot-before-internet.** The first log (09:42) showed setup crashing
   inside `pyControl4.account._send_account_auth_request` — the cloud auth call
   died mid-request and left the entry in a dead `setup_error` state with no
   retry. This is the same cloud-auth fragility recorded on 2026-07-16, but
   this time it hard-failed rather than retried. A single **reload** of the
   config entry got past auth (internet was back by then)…

2. **…which exposed an IP change.** The reload then failed with
   `Timeout connecting to Control4 controller at 10.0.0.29`. The Core 3 had
   taken a new DHCP lease during the outage — the exact failure the still-open
   reservation follow-up was meant to prevent. **The Core 3 is now at
   `10.0.0.33`** (MAC unchanged, `00:0f:ff:9f:3b:44`).

### Finding the new IP remotely

No device on the LAN self-announces the Core 3, there is no router integration
in HA, and `/hassio` (add-on store) 404s on this install — so no terminal to
scan from. Used the **Nmap Tracker** integration instead (UI-only setup, scan
range `10.0.0.0/24`, ARP ping): it created a `device_tracker` per host with the
`mac` attribute, and the one matching `00:0f:ff:9f:3b:44` reported
`ip: 10.0.0.33`. Integration removed afterward.

### The repoint (no Control4 password needed)

HA stores the controller host **and** the homeowner credentials inside the
config entry (`.storage/core.config_entries`). Only the `host` was stale, so a
delete-and-re-add (which would have needed the Control4 account password and
destroyed all the Stage 5 renames/Area assignments) was avoided. Instead a
throwaway `command_line` sensor ran a Python one-liner that rewrote the
Control4 entry's `host` from `10.0.0.29` → `10.0.0.33` atomically, then two
restarts (the first runs the rewrite; config entries are only read from
`.storage` at boot, so the second boot picks up the corrected file). Verified:
integration back with 179 devices / 178 entities, and a KNX-proxied dimmer
("Restroom Spots") toggled off→on end-to-end from HA. Temp sensor removed.

### Guardrail added — `sensor.c4_ip_watch` + "Control4 IP drift alert"

A permanent, low-risk **detector** now lives in `configuration.yaml` (validated
clean, loaded via reload — no restart). Daily and at each HA start it ARP-scans
for `00:0f:ff:9f:3b:44` and reports the IP; an automation fires a persistent
notification **and** an iPhone push if the IP is ever anything other than
`10.0.0.33`. It only detects and alerts — a human still applies the repoint —
so no auto-rewrite/auto-restart machinery runs unattended. Currently reads
`10.0.0.33`, silent.

### Follow-ups

- [ ] **DHCP reservation for the Core 3 at `10.0.0.33`** (router at
  `10.0.0.138`, reachable only from on-site; may need the dealer). This removes
  the failure mode entirely and makes the drift monitor a quiet backstop. This
  supersedes the 2026-07-16 reservation follow-up, whose `10.0.0.29` is now
  stale.
- [ ] Revoke the long-lived access token that was shared to seed this session
  (Profile → Security → Long-lived access tokens).
- [ ] Post-outage, the Eight Sleep and Alexa integrations were logging
  connection errors; expected to self-heal after the restarts — check
  Settings → Logs if either misbehaves.

## 2026-08-21 — Second power outage, same fault; recovery made one command

### Symptom

The same signature as 2026-08-12, nine days later: the app reported **139
devices not responding**, the header read "lights not responding", every
underfloor-heating valve and both KNX changeover relays were `unavailable`,
while the CoolMaster A/C ("4 zones active"), the native KNX shades and the
media players carried on. Owner's message: "a power outage again left the
system not working... you did a fix last time, do it again."

The cause is not in doubt and never was: the **DHCP reservation follow-up for
the Core 3 was still open**, so a power cut can hand the controller a new
lease while Home Assistant's Control4 entry keeps dialling the old address.
The 2026-08-12 entry predicted this failure in the sentence that opened the
follow-up.

### Live repair was not possible from this session

The cloud session's egress proxy refuses `*.ui.nabu.casa` outright (policy
denial, HTTP 403 to CONNECT), so the owner-supplied Nabu Casa URL and admin
token could not be used from here — unlike 2026-08-12, when the session could
reach the Green. Nothing was routed around; the token was reported as needing
revocation instead. **The repair therefore has to run from a machine that can
see the house** — the dev Mac on the LAN, or anywhere the Nabu Casa URL
resolves.

So the deliverable became the thing that makes "do it again" not need a
session at all.

### `tools/c4_recover.py` — the whole 2026-08-12 investigation, as one command

```
export HA_URL=http://10.0.0.69:8123   # or the Nabu Casa URL
export HA_TOKEN=<admin long-lived token>
python3 tools/c4_recover.py diagnose      # read-only
python3 tools/c4_recover.py recover --yes
```

It walks the same two faults in the same order — reload the config entry
(boot-before-internet kills the Control4 cloud auth and leaves the entry in
`setup_error`), then repoint the host if the reload times out — and refuses
to guess: with no observed IP it says so and points at Nmap Tracker; with the
configured host already matching where the controller answers, it says this
is not a drift and to check the Core 3 itself. Writes need `--yes`;
`diagnose` touches nothing. 30 stdlib tests (`tools/test_c4_recover.py`)
drive the whole tree against a fake Home Assistant on localhost, including
the write-clobbered-by-a-save case that made the manual fix need two boots.

The host rewrite stays surgical for the same reason as last time: the config
entry holds the Control4 credentials and, through the entity registry, all
184 Stage 5 renames and Area assignments. `ha/c4_repoint.py` changes the one
`host` field, atomically, after a timestamped backup, and refuses anything it
does not recognise — never a delete-and-re-add.

### Guardrail rebuilt to survive its own fix

The 2026-08-12 drift alert compared the scanned IP to a **hardcoded
`10.0.0.33`** — correct until the first repoint, after which it cries wolf
forever or needs hand-editing mid-outage. Replaced (`ha/c4_recovery.yaml`) by
a pair of sensors and a template binary sensor that compare **where the
controller answers ARP** (`sensor.c4_ip_watch`) against **the host inside the
config entry** (`sensor.c4_configured_host`), so a repoint re-baselines the
alert by itself. Still detect-only: nothing rewrites or restarts unattended.
`ha/c4_scan.py` does the MAC lookup with a UDP sweep plus `/proc/net/arp` —
no root, no nmap, no add-on store (which 404s on this install).

Install is one paste-and-reload, `ha/README.md`. Until it is installed the
recovery tool still diagnoses fully — it reads the stale host out of the
integration's own "Timeout connecting to Control4 controller at ..." error —
and prints the File-editor procedure with the addresses filled in.

### Two app lies the outage exposed

Both visible in the owner's screenshot, both the same class as the ones fixed
on 2026-08-12, both in surfaces that pass had not reached:

- **"Underfloor heating — all off"** while all 14 valve relays were
  unreachable. `lib/systemSummary.ts` now owns the tile line for Lighting,
  Climate and Underfloor heating on both the Home view and the Systems index,
  so a system that cannot answer says **"not responding"** and a partial
  outage is named alongside the live count. One helper, six call sites, six
  tests — the three tiles can no longer disagree about the same house.
- **The A/C mode toggle still took taps** with its changeover relay dead
  ("floor 6 mode unknown", Cool | Heat live). That is not a harmless no-op:
  HA answers 200 for an unavailable entity, so the 13-second installer
  sequence would still command the sacrificial CoolMaster unit (alive on its
  own bridge), flip nothing, and audit `ok: true`. `startChangeover` now
  reads the relay first and refuses (503, not 409, when it is an outage
  rather than a busy floor); `/api/home` publishes
  `floorModes[n].unreachable`; the card says "floor 6 mode not responding"
  and disables both buttons. The refusal keeps the reachability rule — only
  positive evidence blocks, so a failed read or a transient `unknown` after a
  restart still commands.

### Two fixes from the Codex review (PR #101)

- **The repoint service was a shell.** `shell_command: c4_repoint: "python3
  /config/c4_repoint.py {{ ip }}"` looked like a parameter and was not: Home
  Assistant renders service data into a `shell_command` and runs the result
  through a shell, so `{"ip": "10.0.0.42; …"}` was arbitrary command execution
  in the HA container — reachable by anything that can call a service,
  including the non-admin `smarthome-app` token that lives in an
  internet-facing app's environment. The script's own IP validation was
  downstream of the split and never saw it. Fixed by removing the template
  entirely: the service is a fixed argv, `--mac 00:0f:ff:9f:3b:44`, and
  `c4_repoint.py` resolves the address from the ARP table itself. It now takes
  no caller input at all, so the worst it can do is point the entry at the
  machine owning that MAC — and it is a no-op when that is already the host.
  Repointing somewhere the scan cannot see is a deliberate by-hand act. Rule
  recorded in SECURITY_AND_OPERATIONS §7, and a test asserts the YAML never
  regrows a `{{`.

- **`recover` acted behind its own advice.** `diagnose` said "a partial fault,
  not the whole integration — look at those devices before touching the
  entry", and then `recover --yes` reloaded the entry anyway, because it only
  stopped for a fully healthy house. Both now share one `outage_verdict`:
  healthy / house-wide / partial, with house-wide at 80%+ of the Control4
  lights down rather than every last one (the entity map can carry a row the
  integration no longer owns, and one stale light must not block a real
  recovery). A partial fault is refused unless `--force`.

Also from re-reading the diff: the changeover's new reachability read is an
`await`, which opened a window where two taps could both start a sequence on
one floor — the claim is now taken before the read. And `c4_scan.py` derives
the subnet from the Green's own address instead of assuming `10.0.0`.

### Follow-ups

- [ ] **DHCP reservation for the Core 3** at the router (`10.0.0.138`,
  dealer-managed, on-site only). Third time asking. Everything above is a
  workaround for not having it.
- [ ] Install the HA-side bundle (`ha/README.md`) and delete the old
  "Control4 IP drift alert" automation, or the house alerts twice.
- [ ] **Revoke the long-lived token shared into this session** — it went into
  a chat transcript and was never usable from here (Profile → Security →
  Long-lived access tokens).
- [ ] Run `python3 tools/c4_recover.py recover --yes` from the Mac and record
  the outcome here — including the Core 3's new address, so the next reader
  knows where it landed.

## 2026-08-23 — The house recovered, and was taught to recover itself

### Closing out 2026-08-21: where the Core 3 landed

The repair ran on the evening of 2026-08-21 from the Mac, and this entry is the
record the previous follow-up asked for. Both faults were present, in the
predicted order: the reload cleared the boot-before-internet cloud-auth
timeout, which exposed the drift underneath it. **The Core 3 is now at
`10.0.0.38`** (was `10.0.0.33`, before that `10.0.0.29`; MAC unchanged at
`00:0f:ff:9f:3b:44`). Repointed via `shell_command.c4_repoint`, one restart.
Verified: 179 devices / 178 entities, 0 of 168 lights unavailable,
`sensor.c4_ip_watch` and `sensor.c4_configured_host` in agreement,
`binary_sensor.c4_ip_drift` off. The HA-side bundle is installed on the Green
and the old hardcoded drift automation is gone from `configuration.yaml`.

It could not use `tools/c4_recover.py`. macOS grants computer-use Terminal in
click-only mode, and the device shell is sandboxed away from both the LAN and
GitHub, so the whole repair went through the Home Assistant frontend —
`hass.callService` / `callWS` / `callApi` for the reload, repoint and restart,
and the File editor add-on's own ingress API for byte-exact writes into
`/config`. That route, and the traps in it, are written down in
`docs/OUTAGE_RECOVERY_RUNBOOK.md`.

### Self-heal — the automations now act, not just alert

Three occurrences of the same two faults, each needing the same two hands-on
repairs, while the one permanent fix stayed an unticked checkbox behind a
dealer visit. So `ha/c4_recovery.yaml` gained two automations that mirror the
two faults (details and the full condition table: `ha/README.md`):

- **`c4_reload_after_boot`** — on `homeassistant.start`, wait three minutes for
  the boot to settle, force a refresh of both address sensors, then reload the
  Control4 config entry up to three times at eight-minute spacing. That spacing
  is the 2026-07-16 rule, not padding: `apis.control4.com` rate-limits fast
  retries and then drops connections in a way that looks exactly like wrong
  credentials. It notifies only when all three attempts failed — a reload that
  fixed the house at 04:51 is not worth waking anyone for.

- **`c4_auto_repoint`** — drift on for thirty minutes, **and** 80%+ of the
  Control4 entities `unavailable`, **and** both address sensors reading real
  IPv4 that disagree, **and** no auto-repoint in the last six hours. Then
  rewrite the host and restart.

The interesting part is the conditions, because this rewrites a config entry
and restarts the house unattended:

- **Thirty minutes, not five.** The reload automation needs twenty-seven to
  exhaust its attempts. Overlapping them would restart the house in the middle
  of a recovery that was about to work on its own.
- **The six-hour brake survives the restart it causes.**
  `input_datetime.c4_last_auto_repoint` is stamped *before* the rewrite, so a
  repoint that dies half way still burns the window. Without it, a controller
  answering ARP at an address it cannot actually be reached on would
  rewrite-and-reboot forever.
- **The same 80% line `tools/c4_recover.py` refuses below.** One dead KNX
  channel plus a stale scan must never be able to restart the house.
- **`input_boolean.c4_self_heal`** switches both off from the phone. Turn it
  off before deliberate maintenance that makes the house look like an outage.

Eight tests were added (51 total). They assert the properties rather than the
text: the kill switch gates both, the repoint refuses a partial fault, the
brake exists and is stamped first, the repoint's hold exceeds the reload's
budget, the restart only happens on a zero exit code, and the reload cannot
index an empty entity list on a rebuilt Green.

Also corrected: the repo copy of the drift alert still said
`notify.mobile_app_iphone`, a placeholder the installed copy on the Green never
had. It now names the house's real service, `notify.mobile_app_daniel_iphone_17`.

### This is insurance, not the fix

Self-heal that runs on every outage is a fire alarm that keeps going off, not a
building that stopped catching fire. The permanent fix is still the router: a
DHCP reservation for every device this stack reaches at a fixed address, all
seven of them, listed in `docs/OUTAGE_RECOVERY.md`.

### Follow-ups

- [ ] **DHCP reservations at the router** (`10.0.0.138`) for all seven devices
  this stack reaches at a fixed address — the Core 3
  (`00:0f:ff:9f:3b:44` → `10.0.0.38`), the Green (`10.0.0.69`), the KNX IP
  interface (`10.0.0.70`), the CoolMaster bridge (`10.0.0.90`) and the three
  Yamahas (`10.0.0.35`, `10.0.0.14`, `10.0.0.76`) — plus owner-level admin
  access to that router. Fourth time asking. The router being dealer-managed
  and on-site-only is the reason a five-minute change has cost three outages —
  treat the access request as the real deliverable. *2026-09-03: one of seven
  done (the Core 3); the Green's was made for a wrong MAC; the two RX-V6As
  are not where this list says. See that day's entry.*
- [ ] **UPS on the comms cabinet** — ONT, router, switch, Green. Ends fault 1
  for any cut shorter than its runtime, and it is the only fix that also covers
  the collateral: the 2026-08-21 boot left 28 Alexa entities, 6 Cast players
  and Eight Sleep broken, none of which is Control4 or fixed by any of the
  above.
- [x] **Install this bundle update on the Green** and turn
  `input_boolean.c4_self_heal` on — it defaults to off, and a reload is not
  enough this time because the helpers are only created at boot. *Done
  2026-09-03 from a laptop on the LAN; see that day's entry.*
- [ ] **Revoke the long-lived token shared into the 2026-08-21 session.** Still
  open, still in a chat transcript (Profile → Security → Long-lived access
  tokens). *2026-09-03: revoke the `laptop-claude` token from that day's
  install too — it was passed inline to shell commands, so it sits in that
  local session's transcript.*

### Amendment, same day — the notifications lied about their own success

Codex caught it on review, and it was real: the repoint automation sent
"Control4 repointed automatically" **before** running `c4_repoint.py`. On a
non-zero exit the house was still down while the phone said it had been fixed
— and the runbook had just been written to send a reader to exactly that
notification to decide whether they were done.

Following it up exposed a second one underneath. Persistent notifications live
in memory and do not survive a restart, so on the path where the repoint
*worked* that message was erased seconds after it was created. The runbook was
pointing at something that could only ever be visible when it was wrong.

The fix is structural rather than a reordering, because
`homeassistant.restart` ends that script and never returns — there is no point
inside it where success can honestly be reported:

- The repoint now sends `Control4 — repointing now`, an attempt, not a result.
- Failure replaces it with `Control4 auto-repoint failed`, carrying the exit
  code, on both the dashboard and the phone. The phone needed its own
  correction: a persistent notification can be replaced by id, a push cannot,
  so all four messages now share one push `tag` and the latest replaces the
  last rather than stacking under it.
- Success is reported on the way back up, by `c4_reload_after_boot`, which
  reads `input_datetime.c4_last_auto_repoint` to recognise that this boot was
  the repoint's own restart. That reading has to happen before the retry loop
  — twenty-seven minutes later it would be outside its own fifteen-minute
  window.
- The reload automation's health check became a `choose` to make room for it,
  which is also how a healthy routine restart still stays silent.

The runbook now carries a table of the four messages and what each one means,
including the one that says a repoint had just been applied and did not help —
which is the signal that the address is not the problem. Three tests added
(56 total), both new guards mutation-checked.

## 2026-08-29 — TV follower: the MBR TV mirrors its ceiling lift again

### Owner report

The master-bedroom TV has always come on when its ceiling lift lowered and
gone off when the lift went back up. It now does neither.

### Findings

- The old link never lived in this stack: no HA automation, no app rule,
  nothing in the repo implements it. It was evidently Control4-side
  programming (like the retired shade automations), and whatever broke it
  is not visible from here — the repo can't say whether it was the August
  outage, a Director change, or a dealer edit.
- Everything needed to own the rule ourselves is already proven in
  production: the lift relay is `light.knx_switch_mbr_tv_lift`, whose state
  Sleep sense has armed on nightly since July (so the Control4 integration
  reports it regardless of what moved the lift — keypad, app, or C4
  programming, ~3.7s feedback lag). The TV is `media_player.55_qled`
  (Samsung), which advertises `turn_on`/`turn_off`
  (supported_features 152461).

### Fix

**`lib/liftwatch.ts` — "TV follower — bedroom lift"**, a standing house
rule on the scheduler's 30s tick, modeled on the Sauna follower: edges
only (lift up→down commands `media_player.turn_on`, down→up `turn_off`),
unknown relay state holds instead of inventing an edge, the first readable
state after a restart is a baseline and never an action, and a human's
remote-control choice mid-session is never fought. Card + toggle on the
Automations page ("If → then"), switchboard at `/api/liftwatch`, state in
`liftwatch.json` (`LIFTWATCH_PATH`). Relay polarity rides the same
`SLEEPWATCH_LIFT_STATE` knob as Sleep sense — one knob, the two rules
can't disagree.

### Verify on site (can't be proven from this cloud session)

- [ ] Lower the lift: TV should be on within ~35s of the relay flipping
  (30s tick + feedback lag). Raise it: TV off the same way. Activity logs
  `lift_tv_on` / `lift_tv_off` either way, with the error if the command
  failed.
- [ ] If the TV does NOT wake: the 2026-07-22 note that hid the MBR media
  cards ("zone rejects turn_on") was about the Control4 zone, but the
  Samsung's own network wake (Wake-on-LAN from the `samsungtv`
  integration) is unverified — check the audit row and the TV's network
  standby setting.

## 2026-08-30 — TV follower field test: off side hardened

### Owner report (first live cycle after PR #103 deployed)

Lowering the lift turns the TV on. Raising it does NOT turn the TV off —
not while rising, and apparently not once stowed either: on the next
lowering the TV "seems to have just come on", i.e. it had been playing
inside the ceiling the whole time.

### Diagnosis

The off side was edge-only, so it acted exactly once, on the transition
it happened to observe — and there were two ways to lose that one shot,
either sufficient to explain the report:

- **The deploy raced the test.** The merge itself triggered a Railway
  deploy right around the live test, and a restart mid-episode re-learns
  the baseline: first readable state is "baseline only, never an action",
  so a relay already reading "off" when the app came back stranded the TV
  on with no edge ever to fire. (Without `LIFTWATCH_PATH` on the volume,
  every deploy also wipes the baseline.)
- **A single failed/ignored `media_player.turn_off`** spent the edge with
  no retry.

What the report also establishes, usefully: the relay LATCHES while the
lift is down (had it rested "off" mid-viewing, our own next tick would
have read an on→off edge and killed the TV a minute after lowering —
never observed), so "relay off" genuinely means the lift is up or on its
way up. That makes level semantics safe for the off direction.

### Fix (asymmetric semantics)

- ON stays an edge: exactly once per lowering; a remote-control off with
  the lift down is never fought.
- OFF is the edge PLUS bounded enforcement: while the lift is up and the
  TV still affirmatively reads "on", the follower keeps commanding
  turn_off — MAX_OFF_ATTEMPTS (3) per stow episode, one per tick, every
  attempt audited with its number, then it stands down until the next
  lowering resets the budget. Rationale: a TV that is ON inside the
  ceiling is never a human's choice, so re-asserting fights a failure,
  not a person. This also closes the restart hole (a baseline re-learned
  as "up" no longer strands a playing TV) and out-stubborns a dropped
  network command.
- The tick now reads both entities (`Promise.allSettled` — each read
  fails alone); the enforcement never acts on an unknown TV state.

### Verify on site

- [ ] Raise the lift with the TV playing: it should switch off within
  ~35s of the relay flipping (Activity: `lift_tv_off`, `attempt: 1`).
- [ ] If attempts 1–3 all show errors in Activity, the Samsung is
  refusing network `turn_off` — that becomes an integration question
  (KEY_POWER handling / network standby), and the audit rows are the
  evidence to bring.
- [ ] `LIFTWATCH_PATH=/data/liftwatch.json` on Railway (runbook table) —
  still worth setting so baselines and a paused toggle survive deploys.

## 2026-08-30 — REVERTED: the held-power-press escalation (PR #105)

Owner report after #105 deployed: on OPENING, the lift itself oscillated —
partially closing and reopening repeatedly for ~4–5 minutes before
settling — and the off-on-close problem was still not solved. Owner
called for the build to be undone; #105 is reverted (PR #106), returning
the follower to the #104 behavior (plain `media_player.turn_off`,
edge + bounded enforcement).

Note for the next attempt: nothing in the reverted code commands the lift
relay — the follower only ever addresses `media_player.55_qled` /
`remote.55_qled`. The leading theory is INDIRECT: the held power press
made the TV emit power/HDMI-CEC events that Control4 — which may still
carry its own old TV↔lift coupling programming — reacted to by driving
the lift. If true, (a) the "dead" C4 lift programming is not dead, just
one-directional or broken, and the REAL fix may be repairing it C4-side
(or removing it and keeping the app rule); (b) any TV power path that C4
observes can feed back into the lift, so future off-mechanism changes
need the lift watched during the test. Before any further change: pull
the Activity rows (`lift_tv_off` attempt/method/error) from the failed
test, and establish in C4 Composer what lift/TV programming still exists.

## 2026-09-03 — Self-heal live on the Green; Bezeq's reservations checked from inside the house

PR #102 merged (`de8b6d2`) and, the same morning, installed on the Green and
armed. The install and the network checks ran from a Claude Code session on
a laptop on the home wifi, because the cloud session cannot reach `10.0.0.x`
at all.

### The install

`configuration.yaml` on the Green (14351 bytes) was backed up, then rebuilt as
a pure function of the backup: the 2026-08-23 `automation manual_c4:` block
replaced by the current one, and `input_boolean:`, `input_datetime:` and
`automation manual_c4_selfheal:` appended — repo lines 79–400 verbatim. The
diff was two hunks, both expected; `shell_command` byte-identical, no `{{`;
the house's own additions under `command_line:` and `template:` untouched.
Written through the File editor add-on's API, read back byte-exact (28365
bytes), `check_config` valid, one restart. API back in 31 s, `homeassistant
started` at +165 s once all 77 config entries had loaded.

After the restart: the three automations present exactly once each and on
(`c4_ip_drift_alert`, `c4_reload_after_boot`, `c4_auto_repoint`); both
helpers created; `sensor.c4_ip_watch` = `sensor.c4_configured_host` =
`10.0.0.38`, drift off; 0 of 178 Control4 entities unavailable, same as
before. `c4_reload_after_boot` fired on that start, sat out its 3-minute
settle and exited without reloading — the designed no-op on a healthy house.
`input_boolean.c4_self_heal` on at 11:38:26Z. **Fault 1 now has an
unattended fix in place.**

Route note: `POST /api/hassio/ingress/session` over REST returns an empty
401 even for an owner token; the same call over the websocket
(`supervisor/api`) works. Written into `OUTAGE_RECOVERY_RUNBOOK.md` §5.

### Bezeq's reply, checked against the ARP table

Bezeq manage the router. It is a **FortiGate** — login page at
`https://10.0.0.138`, and we hold no credentials. They reported two
reservations made and "port 80 opened". On-site:

- `10.0.0.38` → `00:0f:ff:9f:3b:44`. Correct: the Core 3 is reserved.
- `10.0.0.69` → the Green really is `20:f8:3b:03:d4:19` (Nabu Casa OUI,
  answers the HA API). Bezeq reserved `f8:3b:03:d4:19:20` — the same six
  octets rotated by one. No device has that MAC, so **the Green is not
  reserved**; it has simply kept its lease. Must be corrected.
- Port 80 redirects to the HTTPS login page, as it always did. Nothing was
  gained; admin access is still the ask.

The five-device remainder of the 2026-08-23 table was also wrong in two
rows. `10.0.0.35` holds a Sonos (`c4:38:75:1d:1c:d0`) and `10.0.0.14` a
Control4 device (`00:0f:ff:97:2a:54`) — not the two RX-V6As documented
there since 2026-07-23. Either the receivers took new leases (the exact
fault this whole effort exists for) or the audio table was never right;
they have to be found before Bezeq can be asked. Confirmed: CoolMaster
`28:3b:96:11:60:51` at `.90`; RX-V4A `4c:22:f3:72:54:e3` at `.76`, its YXC
API answering. At `.70`, `00:1e:06:4b:80:08` serving a "Maestro Controller"
page — plausibly the KNX interface, not proven.

Unrelated but noted: all 13 KNX blind covers went `unavailable` at
11:12:28Z, before anything was touched. 222 non-Control4 entities were
unavailable after the restart; of 34 sampled, 33 already were before it
(Alexa, Roborock, iPhone sensors, Cast — the usual collateral).

### Follow-ups

- [x] **Find the two RX-V6As** (LAN sweep for YXC responders) and confirm
  what `.70` is. *Done later the same day; see the next entry.*
- [ ] **One message to Bezeq**: correct the Green's MAC, add the other five,
  and ask again for admin access to the FortiGate. Draft ready.
- [x] **Check the KNX shades** — 13 covers unavailable since 11:12:28Z.
  *Cause found the same day, and it is not the network; see the next entry.*
- [ ] **Revoke the `laptop-claude` token** used for the install.

## 2026-09-03 (later) — Receivers found; the shades broke on an HA update, not the network

A second read-only pass from the laptop, an hour after the install.

### The two RX-V6As had moved, and Home Assistant followed them

A LAN sweep for Yamaha's YXC API found all three receivers:

| Receiver | Now | When added (2026-07-23) | MAC |
| --- | --- | --- | --- |
| RX-V6A, master bedroom | `10.0.0.7` | `10.0.0.35` | `c0:d7:aa:8e:5d:b0` |
| RX-V6A, lounge | `10.0.0.4` | `10.0.0.14` | `4c:22:f3:a4:9e:9c` |
| RX-V4A, den | `10.0.0.76` | `10.0.0.76` | `4c:22:f3:72:54:e3` |

The config entries are still titled with the addresses they were added at,
which is how we know the receivers moved rather than the audio table being
wrong. Nobody noticed because the MusicCast integration rediscovers by SSDP
and updated its own host: all three entries loaded, players polling. So the
house has had at least two silent DHCP moves besides the Core 3's three.
Integrations that dial a stored address (Control4, KNX, CoolMaster) do not
get this for free.

### `.70` is the KNX gateway, confirmed

It answers a KNXnet/IP search request as individual address `1.1.127`, MAC
`00:1e:06:4b:80:08` — a CDInnovation "Maestro Controller" gateway (web UI on
port 80), not a Weinzierl or Gira box. HA's tunnel to it was up (established
11:37:01Z after the restart, 0 errors). Because it answers search, HA's
"automatic" connection mode is available for it, which would make its
address stop mattering.

### The 13 shades: an HA core update, not the outage work

All 13 KNX covers have been `unavailable` since 11:12:28Z. The cause is in
HA's own log. Core went from `2026.8.1` to `2026.9.0` at about 11:09–11:15Z
(pre-update backup 11:08:48Z, stop 11:12:27Z, started 11:15:17Z — before the
laptop session began; whether by hand or by auto-update is not recorded).
2026.9.0's KNX cover schema no longer accepts `device_class` under `entity`,
and every one of the 13 UI-created covers carries `device_class: shade`
there, so none were set up: repair issue `entity_validation_error_cover` at
11:14:24Z, not auto-fixable; the entities still visible are restored
registry orphans. The tunnel, the gateway and the network are fine.

Fix: open each of the 13 covers in Settings → Devices & services → KNX →
entities and re-save; the form drops the stale key. Or wait for a 2026.9.x
KNX patch. Until then the shades still work through the Control4 covers and
the `cover.*_shades` groups. Worth deciding separately whether an unattended
core update is something this house should do to itself: today it took the
shades down while nobody was watching, and it is a fault class none of the
outage tooling covers.

### Follow-ups

- [x] **Re-save the 13 KNX covers** (or take the 2026.9.x patch) and confirm
  they come back. *Done the same night — by delete/create, since re-saving
  throws on 2026.9.0; see the night entry.*
- [x] **Decide on core auto-update.** *It was never on: the morning's update
  was a manual click. Nothing to change.*
- [ ] **Bezeq message** with all seven MACs; draft ready.

## 2026-09-03 (evening) — Living without Bezeq: CoolMaster self-heal, KNX to automatic

Bezeq managed one correct reservation out of two, the router is a FortiGate
we cannot log in to, and the owner does not expect more from them. So the
question became: which integrations actually break when a box takes a new
lease, and can each of those be made to follow the box instead?

| Integration | Follows a move? | Plan |
| --- | --- | --- |
| Control4 | No | Repoint self-heal — done 2026-08-23, live since this morning |
| CoolMaster | No | Repoint self-heal — **this entry** |
| KNX | No, but the gateway answers KNXnet/IP search | Switch the connection to Automatic — in progress from the laptop |
| MusicCast (3 Yamahas) | Yes, SSDP | Nothing; it already moved twice unnoticed |
| The Green itself | n/a | Nothing: the app and remote access go through Nabu Casa, only humans dial its address |

Reservations at the router stay the tidy answer where Bezeq will do them
(the short message asks for the correction, `.70` and `.90`), but nothing
above depends on it. Device-side static addresses were considered and
rejected: without router access we do not know the DHCP pool, and a static
address inside it is a collision waiting for the next lease.

### CoolMaster repoint (`ha/c4_recovery.yaml`)

`c4_repoint.py` already took `--domain`, so the bridge gets the same
machinery with no script change: `shell_command.cm_repoint` (fixed argv,
`--domain coolmaster --mac 28:3b:96:11:60:51`), `sensor.cm_ip_watch`,
`sensor.cm_configured_host`, `binary_sensor.cm_ip_drift`,
`input_datetime.cm_last_auto_repoint`, and `automation manual_cm_selfheal:`
with `cm_ip_drift_alert`, `cm_auto_repoint` and `cm_after_boot`. Two
differences from the Control4 set, both about the two repoints sharing one
house: the CoolMaster hold is 35 minutes, longer than the Control4 repoint's
30 and the reload's 27, and it stands down while `binary_sensor.c4_ip_drift`
is on. So when both boxes move on the same boot the Control4 one restarts
the house first and the CoolMaster one fires on the boot that follows —
never two rewrites racing to restart. `cm_after_boot` also forces both
sensors three minutes into every boot, the 2026-08-21 lesson applied to the
second device. Same kill switch.

Tests: `tools/test_c4_recover.py` now checks both services for templates,
both repoints for the kill switch, the 80% line, the six-hour brake, the
hold, restart-only-on-success and honest notifications, plus the ordering
guarantee between them. 6 automation ids.

Not yet on the Green: this needs a merge into the existing
`command_line:` / `template:` / `shell_command:` / `input_datetime:` keys
plus one appended block, then a restart. Next laptop session.

### Follow-ups

- [x] **Install the CoolMaster self-heal on the Green** (merge, check_config,
  restart, verify `binary_sensor.cm_ip_drift` off and both CM sensors reading
  `10.0.0.90`). *Done the same night; see the night entry.*
- [x] **KNX to Automatic** — *done the same night; see the night entry.*
- [ ] **UPS on the comms cabinet.** Still the only fix for the boot-timing
  collateral (Alexa, Cast, Eight Sleep) and now the biggest remaining item.

### Codex review on #109, addressed the same evening

Two findings, both real. (1) `cm_ip_drift_alert` had no kill-switch gate
while the block's header claimed all three automations did. Kept the alert
always-on — detection is not maintenance, and Control4's alert works the
same way — and fixed the claim; the alert's message now says whether
self-heal is on instead of promising a repoint that may be switched off.
(2) A drift that begins while the switch is off fires the timed trigger
once, into a closed switch, and is then lost; turning the switch back on
never re-evaluated it. That gap was in `c4_auto_repoint` too, since
2026-08-23. Both repoints now also trigger on the switch coming back on,
with the hold moved onto a `for:` state condition so the wait is the same
on either path. On the Green, the Control4 block installed this morning
keeps the gap until the next install replaces
`automation manual_c4_selfheal:`; the laptop hand-over now does that.

## 2026-09-03 (night) — Shades back, KNX on Automatic, CoolMaster self-heal live

All from the laptop session, in Manual permission mode after its auto mode
had refused the write step: that mode decides silently instead of asking,
so "I will approve the prompts" never got a prompt.

### The 13 shades

`knx/update_entity` — the command the entity editor itself uses — throws
`KeyError` on 2026.9.0 for an entity that failed setup: it removes the
entity before saving, and there is nothing to remove. So "re-save each
cover" was never going to work here. What did: for each cover,
`knx/delete_entity` then `knx/create_entity` from the backed-up stored
config minus `entity.device_class`, one cover proven before the other
twelve. Every re-read diffed to exactly that one key removed. All 13
reclaimed their entity_id slugs, so the `cover.*_shades` groups, the app's
entity map and recorder history are untouched; unique_ids changed
(`knx_es_01M1…`); Google / Alexa / Assist expose flags re-applied. The
repair issue `entity_validation_error_cover` still lists the old unique_ids
and does not retract itself — dismiss it in the UI. Shade test: the study
blind moved on command, twice, the KNX telegram counter advancing each
time.

### KNX connection → Automatic

Reconfigure ran through the API: flow start → connection-type menu →
`automatic`. The flow offered Automatic at all, which is the Green finding
the gateway by search. Tunnel re-established one second after submit,
`1.1.127` via Tunnel UDP, 0 of 13 covers unavailable. From now on a DHCP
move of the gateway does not matter; the `10.0.0.70` reservation Bezeq say
they made is belt-and-braces.

### CoolMaster self-heal installed

Same route as the morning: backup (byte-identical to the morning's write,
so nothing had drifted in between), five insertions plus one appended
block, 271 lines added and none removed, every one verbatim from the repo
at `53a082a`, PyYAML assertions, read-back exact (40531 bytes),
`check_config` valid, one restart, API back in 31 s. After: `sensor.cm_ip_watch`
= `sensor.cm_configured_host` = `10.0.0.90`, drift off, all six automations
present once and on, `cm_after_boot` fired on that start and ended
silently, 0 of 16 coolmaster climate entities unavailable, Control4 0 of
178, KNX 0 of 13, kill switch still on.

Installed from `53a082a`, which predates the Codex fix in `f25550a`: both
repoints on the Green still lose a drift that began while the kill switch
was off. Part 3b of the laptop hand-over replaces both automation blocks;
one more restart.

Core updates, settled: Core and OS auto-update are off, only the Supervisor
updates itself. This morning's 2026.8.1 → 2026.9.0 was a manual click.

### Where this leaves the house

| Box | Follows a DHCP move? | Since |
| --- | --- | --- |
| Control4 Core 3 | Yes — repoint self-heal, plus Bezeq's reservation | 2026-09-03 morning |
| CoolMaster bridge | Yes — repoint self-heal | 2026-09-03 evening |
| KNX gateway | Yes — HA finds it by search | 2026-09-03 evening |
| Yamahas | Yes — MusicCast rediscovers by SSDP | always |
| The Green | Address does not matter; app and remote access use Nabu Casa | — |

None of it depends on Bezeq. The boot-timing collateral (Alexa, Cast, Eight
Sleep) is untouched by any of this; the UPS is what covers that.

### Follow-ups

- [x] **Part 3b** — replace both automation blocks from `f25550a` (or main
  once #110 merges), restart, verify. Closes the kill-switch gap on the Green.
  *Written, config-checked and restarted the same afternoon; the
  post-restart verification is the owner's — see below.*
- [x] **Part 4** — DHCP DISCOVER check of Bezeq's reservations. The line that
  matters is what the router offers the wrong MAC `f8:3b:03:d4:19:20`.
  *Done: it offers `.51`. The bad entry is gone. See below.*
- [ ] **Verify Part 3b from the app**: Settings → Automations shows six
  entries, all on; `input_boolean.c4_self_heal` on; no "did not come back"
  notification on the phone.
- [ ] **Dismiss the stale KNX repair issue.**
- [ ] **Check the 13 covers' area and name assignments** survived the
  delete/create — the report confirmed expose flags, not areas.
- [ ] **Revoke the `laptop-claude` token** once Part 3b is done.
- [ ] **UPS on the comms cabinet.** Now the only item on this list that
  changes what the house does in a power cut.

### Part 3b and Part 4, later the same afternoon

**Part 3b.** Both automation blocks replaced on the Green from `f25550a`.
The diff was six hunks, all inside the two blocks, and the new file was
exactly the Green's first 442 lines (the house's own `command_line:` and
`template:` additions included) followed by repo lines 194–699 verbatim.
Read-back matched, `check_config` valid, restart issued. The laptop session
was on an overloaded API by then and its post-restart verification never
arrived, so that check is the owner's: six automations on, kill switch on,
no "did not come back" notification. Nothing about the write itself is in
doubt — every gate before the restart passed.

**Part 4.** Six DHCP DISCOVERs from the laptop (`en8`), one per MAC, no
REQUEST ever sent, all answered by `10.0.0.138`:

| Probe | MAC | Offered |
| --- | --- | --- |
| RANDOM (never seen) | `02:00:5e:aa:bb:01` | `10.0.0.44` |
| BOGUS (Bezeq's first, wrong entry) | `f8:3b:03:d4:19:20` | `10.0.0.51` |
| Green | `20:f8:3b:03:d4:19` | `10.0.0.69` |
| KNX gateway | `00:1e:06:4b:80:08` | `10.0.0.70` |
| CoolMaster | `28:3b:96:11:60:51` | `10.0.0.90` |
| Core 3 | `00:0f:ff:9f:3b:44` | `10.0.0.38` |

The wrong entry is gone: the bogus MAC gets an ordinary pool address, not
`.69`. The four real devices are offered exactly their addresses, which is
what reservations would do and also what their existing leases would do —
consistent with Bezeq's claim, not proof of it; proof is a lease turnover
or a screenshot of their table. The pool hands new devices `.44` and `.51`,
in among the fixed addresses, which is why pinning addresses on the
devices themselves was rejected.

### Day's end

Three outages taught the house two faults; today it learned to fix both
without a person, for every box that cannot follow a DHCP move, and the
one dependency on the ISP that remained was checked from inside. What a
power cut does now: the Core 3 and the CoolMaster come back on their own
addresses or get repointed; the shades' gateway is found by search; the
Yamahas follow themselves. Still true: none of this covers the boot-timing
collateral (Alexa, Cast, Eight Sleep), and the next real outage is the
test that counts.

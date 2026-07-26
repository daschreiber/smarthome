# KNX direct access — shade position feedback project

Why this exists: the Control4 shade entities' position is fiction (stuck ~1%).
Diagnosed 2026-07-24, plan "B" implemented 2026-07-26. Full history below.

## Root cause (2026-07-24, physically verified)

- The 13 `cover.*` C4 shades come from the built-in `control4` integration,
  which republishes the C4 driver's `Level` variable verbatim. That variable
  only ever holds -1/0/1/2 — echoes of C4's own commands, never a position.
- Shade keypads are **native KNX devices** writing straight to the bus —
  Control4 never sees keypad presses at all.
- The KNX shade actuators **transmit no status/position telegrams** (status
  objects never parameterized in ETS). Nothing in the house knows true shade
  position. Light actuators DO report status (cmd `2/0/14` → status `7/1/84`
  etc.) — the wiring for feedback exists, the shades just weren't configured.
- Plan A (the real fix, integrator/ETS): enable position-status objects +
  status GAs on the shade actuators. Only this yields measured truth.
- Plan B (done): HA `knx` covers that listen to the same command GAs and
  dead-reckon position via travel time.

## Infrastructure facts

- KNXnet/IP gateway **10.0.0.70:3671** (addr 1.1.127, tunnelling only, no KNX
  Secure). Had ≥1 spare tunnel slot; HA now holds one permanently.
- HA: KNX integration added 2026-07-26 via config flow (entry
  `01KYEC9TYPNN76GH8QY1Y4B1ME`, "Tunneling @ 1.1.127 @ 10.0.0.70:3671").
  Rollback = delete that integration.
- 13 cover entities created via the WS API `knx/create_entity` (platform
  cover, `ga_up_down` write + `ga_stop` write; travel 120s except the MBR
  trio at 50s, both per the Composer backup's driver config):
  `cover.<room>_blinds_knx`. Group addresses in `shade_ga_map.json`.
  Medium Guest Room's GAs came from the Composer backup (`Schreiber.c4p`,
  owner-provided 2026-07-26) and were live-verified; the backup's
  `project.xml` also confirmed every bus-captured GA and proved the GT blind
  driver has no status/position GA at all.
- Keypads and the C4 app write the SAME GAs (move `3/x/x` DPT1.008 0=up
  1=down; stop `4/x/x`), except the open-space GROUP buttons which write
  their own GAs (`3/0/13` = all four Kitchen+Lounge, `3/0/8` = MBR trio) —
  both now passive addresses on those 7 covers. C4 auto-stops every travel
  at its configured moving time — which is why app-closes sometimes stopped
  "shy" on blinds whose true travel is longer. HA's direct commands have no
  such cutoff.

## THE BLIND SPOT (verified live 2026-07-26)

Commands originating **inside Control4** (C4 app, C4 scenes/automations like
the goodnight sweep or morning lift) reach other tunnel clients only as
L_DATA_CON "confirmation" frames from 1.1.127, which xknx/HA silently drops.
HA's KNX covers therefore track: physical keypads ✔, HA/web-app/HomeKit/Alexa
commands ✔ — but NOT C4-originated moves ✘ (drift until the next full travel
from a visible source). Owner's decision 2026-07-26: retire C4-side shade
automations (morning lift etc.) and drive shades only via keypads + app + HA.
My standalone monitor (below) DOES capture the CON frames if this ever needs
debugging.

## Scripts (pip3 install --target pylibs websockets xknx; PYTHONPATH=pylibs)

- `knx_search.py` — KNXnet/IP multicast gateway discovery.
- `knx_tunnel_probe.py` — connect+release probe for spare tunnel slots.
- `knx_monitor.py` — raw bus monitor via own tunnel (`KNX_LOG=<file>`).
  This gateway delivers bus traffic as L_DATA_CON frames — only the DEBUG
  raw-frame log is complete; parse with `parse_knx.py`.
- `parse_knx.py <log>` — decode raw frames: time, IND/CON, source, GA, value.
- HA-side live tap (no extra tunnel): WS `knx/subscribe_telegrams`; recent
  buffer via `knx/group_monitor_info`. Sees only what HA sees (no C4 CONs).

## Status / next steps (updated 2026-07-26 midday)

1. [x] KNX integration + 13 covers live (Medium Guest filled from the
       Composer backup by a parallel session; MBR travel times fixed to 50s).
       Keypad tracking verified live (Daniel's study).
2. [x] Web app repointed: entity map swaps the 12→13 shades to
       `*_blinds_knx`; deviceIds unchanged so scenes/automations survived.
3. [x] C4 "Blinds Up (open spaces)" schedule deleted by owner; ported to the
       app as a sunrise automation (Lounge x2, Kitchen x2, Den, Guest Bath)
       and fired once via the new Run-now button — those six covers
       calibrated to a true open/100. Sunrise firing doubles as daily
       re-calibration. "Master Bedroom Blinds Saturday" self-calibrates the
       MBR trio weekly.
4. [x] Owner confirms no remaining dependence on the C4 app for blinds.
5. [x] Button-verification walk DONE (2026-07-26 afternoon, owner walk with
       live telegram recorder): every keypad is native KNX. Per-room buttons
       write the per-blind GAs (Daniella 3/1/1 kp 1.1.42, Large Guest 3/0/10
       kp 1.1.37, Den 3/1/8 kp 1.1.43, Medium Guest 3/1/16 kp 1.1.35,
       Daniel's study 3/1/13 kp 1.1.36). The open spaces use GROUP buttons:
       one button for all four Kitchen+Lounge blinds (3/0/13, kp 1.1.24) and
       one for the MBR trio (3/0/8, kp 1.1.31). Those group GAs are now
       PASSIVE addresses on the 7 covers (move 3/0/x + inferred stop 4/0/x),
       so group-button presses track in HA. Guest Bathroom has no button by
       design (always open). Keypad quirk: direction memory means a press
       can need a second press to go the intended way (first press emits the
       opposite direction value, second the real one).
6. [x] First-travel calibration DONE: all 13 covers at a true open/100
       (sunrise automation covered the open spaces; owner "open all" +
       guided walk covered studies, Large Guest, Medium Guest, MBR trio).
       Note: a bare open_cover during mid-close did NOT reverse the Medium
       Guest blind — send stop_cover first when interrupting a move
       (automation-relevant; unclear if actuator or dropped telegram).
7. [x] C4 automation audit DONE (2026-07-26, from the Composer backup's
       project.xml — no need to scroll the C4 app): the ONLY blind-touching
       programming in the whole project was scheduler event 8 "Blinds Up
       (open spaces)" (6 opens at sunrise; owner already deleted it and it
       lives in the app now). There is NO goodnight sweep and no
       blind-closing programming anywhere in C4. Other schedules (warming
       drawer, Gym AC Shabbat, dim switches) don't touch blinds.
8. [ ] Flip `COVER_STATE_TRUSTED=1` on Railway once HA's positions have
       stayed correct for a few days. Plainly: the web app currently treats
       shade position as untrustworthy (buttons only, no position shown/
       used) because the old C4 feedback was garbage. The new HA covers
       track everything that moves a blind (app, HomeKit, keypads incl.
       group buttons), so after a few clean days we tell the app "you can
       believe and display positions now". True *measured* position (vs.
       well-tracked estimates) still needs plan A: the integrator enabling
       the actuators' position-status objects in ETS.
9. [ ] HomeKit swap: the Apple Home app currently uses 13 `hk_*` wrapper
       covers that only know "last command sent" (built when C4 feedback
       was broken; they drift whenever a wall button is used). Plainly:
       remove the wrappers from the HomeKit bridge and expose the
       `*_blinds_knx` covers instead — Apple Home then shows real state,
       tracks keypad presses, and gains slider (position) control.
       One-time settings change on the Green; re-pair nothing.

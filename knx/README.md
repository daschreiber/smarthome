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
- 12 cover entities created via the WS API `knx/create_entity` (platform
  cover, `ga_up_down` write + `ga_stop` write, travel 120s both ways):
  `cover.<room>_blinds_knx`. Group addresses in `shade_ga_map.json`.
  Medium Guest Room still missing (was asleep during discovery) — capture is
  one app/keypad nudge while a monitor runs, then one more `knx/create_entity`.
- Keypads and the C4 app write the SAME GAs (move `3/x/x` DPT1.008 0=up
  1=down; stop `4/x/x`). C4 auto-stops every travel at exactly 120 s — which
  is why app-closes sometimes stop "shy" on blinds whose true travel is
  longer. HA's direct commands have no such cutoff.

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

## Status / next steps

1. [x] KNX integration + 12 covers live; keypad tracking verified (Daniel's
       study followed a physical keypad close in real time).
2. [ ] Calibration sweep: with all blinds physically up, `cover.open_cover`
       on all 12 KNX covers → all read open/100 after ~2 min. Then one
       keypad-close spot check.
3. [ ] Add Medium Guest Room (capture GAs, create entity 13).
4. [ ] Repoint web app (and later HomeKit) from the C4 cover entities /
       hk_* wrappers to the `*_blinds_knx` entities.
5. [ ] Retire C4-side shade automations (owner, in Composer/C4 app).
6. [ ] COVER_STATE_TRUSTED on Railway: defensible after a few days of clean
       tracking (dead-reckoning caveats accepted by owner); measured truth
       still requires plan A (integrator email — group addresses in
       shade_ga_map.json make the ETS job concrete).

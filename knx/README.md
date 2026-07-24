# KNX direct-access tooling (shade position feedback project)

Diagnosis 2026-07-24 (see `~/.claude/.../memory/shade-feedback-diagnosis.md` and
this session's findings): the C4 shade entities' position is fiction because the
KNX shade actuators never transmit status telegrams and Control4 never sees the
native-KNX keypad commands. Plan "B" in progress: HA `knx` covers with
travel-time position estimation, listening to the same move GAs the keypads use.

## Facts established

- KNXnet/IP gateway: **10.0.0.70:3671** (KNX addr 1.1.127, tunnelling only, no
  KNX Secure, has at least one spare tunnel slot — probed and released cleanly).
- Shade keypads are native KNX devices writing directly to the bus.
  Daniel's study keypad = `1.1.36`, move GA = **3/1/13** (DPT 1.008: 0=up,
  1=down). Stop GA not yet captured (needs a short-press during a capture).
- Shade actuators transmit **nothing** — no position/status telegrams during or
  after a full travel (verified over a complete closed→open cycle). Absolute
  position needs the integrator to enable status objects in ETS.
- Light actuators DO report status (e.g. cmd `2/0/14` → status `7/1/84`,
  `8/1/84` from 1.1.54/1.1.55) — useful sanity signal that the tunnel sees
  everything.
- Control4 broadcasts DPT9 temperatures on `10/x/x` every ~2 s (log noise).
- Daniel's study blind travel time ≈ 120 s (from HA history blip timing).

## Scripts (need `pip3 install --target pylibs websockets xknx`; run with
`PYTHONPATH=pylibs`)

- `knx_search.py` — KNXnet/IP multicast discovery (finds the gateway).
- `knx_tunnel_probe.py` — connect+release probe for a spare tunnel slot.
- `knx_monitor.py` — bus monitor via tunnel; set `KNX_LOG=<file>`. NOTE: this
  gateway delivers bus traffic as L_DATA_CON frames, so only the DEBUG
  raw-frame log is trustworthy — parse it with `parse_knx.py`, do not rely on
  the xknx telegram callback.
- `parse_knx.py <logfile>` — decodes the raw frames: timestamp, IND/CON,
  source individual address, GA, READ/RESP/WRITE, value (with DPT9 + percent
  guesses).

## Next session (the discovery walk, ~15 min)

1. Start `knx_monitor.py`, then walk the 13 keypads in a fixed order
   (Daniel study, Daniella study, Den, Guest bath, Kitchen L/R, Large guest,
   Lounge L/R, Master balcony L/R, Master window, Medium guest):
   long-press DOWN until motion starts, then short-press to stop, ~10 s gap.
2. Parse the log → per-blind move GA + stop GA map.
3. Measure/confirm travel times (stopwatch one or two; default 120 s).
4. Then (owner OK required, show exact config first): add HA `knx` integration
   (tunnelling to 10.0.0.70) + 13 YAML covers with
   `move_long_address`/`stop_address`/`travelling_time_*` — HA then tracks all
   command sources incl. keypads by dead-reckoning, re-syncing at endpoints.
5. Verify two rooms physically; repoint web app/HomeKit; COVER_STATE_TRUSTED
   stays unset until the integrator enables real position feedback (plan "A").

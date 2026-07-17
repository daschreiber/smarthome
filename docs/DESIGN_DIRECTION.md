# Design Direction — decided 2026-07-16

Owner reviewed three interactive mockups (Ember / Plaster / Ledger) built
from the real entity map. Verdict: **Plaster preferred, Ember liked,
Ledger liked least.**

## The direction

- **Foundation: Plaster** — light, warm, domestic. Rooms-by-floor is the
  primary structure (Floor 6 / Floor 5 tabs, room cards with summary state).
  Guest-usable without explanation.
- **Dark theme: Ember** — not a separate design; the same layout re-skinned
  as the dark night panel with glowing active devices. Follows system
  theme/time of day.
- **Ledger: rejected as an aesthetic.** Its typographic register look and
  "what's on" home screen are out. Two of its *functions* survive in
  Plaster's clothing, demoted to supporting roles:
  - The conversational input (a spec requirement regardless) — styled
    warm/rounded, placed unobtrusively; propose → review card → confirm
    flow unchanged.
  - "What's on now" — at most a small summary line on Home (e.g.
    "14 lights on"), not a register screen. Expand later only if asked.
- Sauna keeps the hold-to-confirm interaction (validated in mockup B).

## Climate is first-class (owner confirmed expectation)

Every room with a CoolAutomation zone gets a full climate card: current
temperature, target set-point (+/-), HVAC mode. Backed by the existing
`set_temperature` / `hvac_mode` capabilities and 10-32°C server bounds;
commands execute against the zone's CoolMaster units, not Control4 (see
IMPLEMENTATION_SPEC §7 Climate). When no setpoint is readable the +/- anchors
at the room's current temperature. Floor-heating toggles join the Climate &
Comfort group when unhidden. The sauna is the confirm-required outlier
(40-100°C).

## Resolves

PRODUCT_SPEC §9 open questions "Preferred visual style" and (partially)
"Which actions merit confirmation" (sauna: hold-to-confirm; whole-house
scenes: single confirm dialog; ordinary devices: none).

Mockups artifact: "Smarthome App — Three Design Directions"
(first-three-directions), also delivered as design-directions.html.

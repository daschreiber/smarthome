# Conversational Layer and Device Expansion — Spec Addendum

Owner direction (2026-07-16): the app is not only a remote control. It should
support conversational programming ("turn on all the lights in the kitchen
tomorrow at 4:00 and off at 8:00"), user-created scenes and automations, and —
over time — devices beyond the Control4/KNX estate: Samsung Smart TVs, Yale
Linus lock, the sauna (custom app already exists), and two Roborock vacuums
(one per floor).

This addendum extends `PRODUCT_SPEC.md`; it does not change the MVP build
order in `DESIGN_AND_DELIVERY_LOOP.md`.

## Three-layer model

1. **Control** — live state + direct commands (the current MVP).
2. **Composition** — scenes (state snapshots) and automations
   (trigger/condition/action rules). Both are first-class Home Assistant
   objects created via its API; the app manages them, it does not reimplement
   scheduling or rules.
3. **Conversation** — an LLM translates natural language into a structured,
   human-reviewable proposal (scene/automation/command batch). It is applied
   only after explicit user confirmation in the UI.

## Conversational layer principles

- The LLM proposes; it never executes. Output is a typed JSON proposal the
  backend validates against the entity map before anything is applied.
- Proposals are rendered as readable cards (what, when, which rooms/devices)
  with Create/Cancel. Applied proposals become ordinary HA
  scenes/automations — visible, editable, deletable in the app afterward.
- The LLM's vocabulary IS `data/entity_map.json`: rooms, floors, groups,
  display names. Entities with `visible: false` are excluded from its tool
  schema entirely.
- **Room synonyms** (owner requirement, 2026-07-16): rooms have canonical
  names plus an owner-editable alias list in `data/room_aliases.json`
  ("living room" -> Lounge, "MBR" -> Master Bedroom). The conversational
  layer resolves aliases before acting and asks for clarification on
  ambiguity instead of guessing. Aliases the owner uses naturally in chat
  should be suggested as additions over time.
- Security-tier actions (locks, later) are never creatable conversationally
  in the first iteration.
- The LLM API key is a backend secret beside the HA token; nothing
  LLM-related runs in the browser. Every conversational creation is audit-
  logged with the original utterance.

## Consequences for the backend design (apply NOW)

The command layer will have two callers: the UI and the LLM. Therefore
commands are semantic and room-oriented, not entity passthroughs:

- `lights_on(room | floor | whole_house)`, `set_dimmer(entity, level)`
- `set_cover(entity | room, position)`
- `set_climate(room, target, mode)`
- `activate_scene(scene_id)`
- `create_scene(name, captured_states | explicit_states)`
- `create_automation(spec)` / `list/enable/disable/delete_automation`
- Validation + authorization + audit at this layer, once, for both callers.

## Device expansion path (extends Phase F)

Every future device arrives the same way: HA integration → entities appear →
rows added to the entity map → app inherits them. New capability types to
model when they land:

| Device | Integration route | New capabilities |
| --- | --- | --- |
| Samsung Smart TVs | Samsung TV / SmartThings (55" QLED already discovered) | power, volume, source |
| Yale Linus lock | Yale Home cloud or Matter (see Phase F prerequisites) | lock/unlock — security tier: PIN + confirm + audit, excluded from conversation initially |
| Sauna | **integrated 2026-07-16** as a virtual device in the app backend, consuming the existing sauna service's `/api/quick/*` endpoints (all KLAFS session/watchdog logic stays in that service). **Committed next step (owner decision):** promote to Home Assistant entities (switch + temperature sensors wrapping the same endpoints) so HA automations and scenes can target it; the backend then reads it via HA like every other device. | on/off, target temp (40-100°C server-side bounds), `confirm:true` required on every command |
| Roborock ×2 | official Roborock integration | **app support landed 2026-07-21** (see below) — start/pause/dock; per-room (segment) cleaning deferred until the integration exposes the map segments |

### Roborock commissioning steps (the app side is ready)

The app models a `vacuum` kind end to end: registry, typed commands
(`start_cleaning` / `pause_cleaning` / `return_to_dock` → HA `vacuum.start` /
`pause` / `return_to_base`, verified by read-back against
cleaning/paused/returning/docked), a room card with Clean/Pause/Dock and
battery, and the assistant vocabulary ("clean the lounge" resolves to that
floor's vacuum). Until vacuum entities exist, the Lounge and Den show
display-only "not connected" cards.

To bring the two Roborocks live:

1. Put both vacuums on the same network as Home Assistant Green and add the
   official **Roborock** integration (sign in with the Roborock account;
   day-to-day commands are local, the cloud login fetches maps).
2. Name the devices **"Lounge Roborock"** and **"Den Roborock"** (in the
   Roborock app or HA) so room inference lands them in Lounge (floor 6) and
   Den (floor 5) — or pin their entity IDs in `ROOM_OVERRIDES` in
   `tools/build_entity_map.py`.
3. Re-run `tools/export_inventory.py`, then `tools/build_entity_map.py`, and
   redeploy. The placeholder cards are replaced by the real devices.
4. Later, per-room cleaning: name the map segments in the Roborock app, then
   extend the command layer with a segment-clean command (Roborock exposes
   segment IDs via the integration).

## UI consequences (for the design brainstorm)

- Information architecture gains: an **Automations** section (list, toggle,
  edit, history) and a **command input** (text now, voice later) that returns
  proposal cards.
- Scenes become user-creatable ("capture this room as a scene"), not just
  the six inherited KNX scene switches.
- The Settings > audit log distinguishes manual, scheduled, and
  conversational origins.

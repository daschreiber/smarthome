# Prompt: assign Apple Home accessories to rooms

Copy everything below the line into a computer-use agent (e.g. ChatGPT with
computer control) running on a Mac that is signed into the home owner's Apple
ID, with the **Home** app available. Attach
`data/homekit_room_assignments.csv` alongside it.

Prerequisite (human, 2 minutes, do this first): in the Home app remove the
dead old bridge — Home Settings → Home Hubs & Bridges → "Entrance HASS
Bridge 3B4F4E" → Remove — so its orphaned "No Response" accessories vanish
and every remaining accessory is live and unambiguous.

---

You are operating the Apple **Home** app on macOS to organize a freshly
paired HomeKit bridge. All accessories from the bridge "HASS Bridge AK"
currently sit in the room **"Default Room"**. The attached CSV says where
each one belongs and what to rename it to.

CSV columns:

- `room` — target room. All rooms should already exist. If one is missing,
  create it (Home Settings → Rooms → Add Room) with exactly that name.
  Rows whose room is `Default Room (leave here)` are whole-house scene
  switches: do NOT move or rename them, skip them.
- `accessory` — the accessory's current name in the Home app, exactly as
  paired. Two blinds have genuinely doubled names ("Daniel's Study Daniel
  Study Blinds") — that is not a typo.
- `suggested_name` — the new name to give it. Short names are intentional:
  Siri composes "room + name", so "Desk light" in room "Daniel's Study" is
  correct.
- `type` — light / cover / climate / scene switch (context only).
- `entity_id` — Home Assistant id, for the report only; not visible in the
  Home app.

For each CSV row except the `Default Room (leave here)` ones:

1. Find the accessory by its `accessory` name (the Home app search, or the
   Default Room grid).
2. Open its settings (right-click → Settings, or the gear in its detail
   view).
3. Set **Room** to the CSV `room`.
4. Change its **name** to `suggested_name`.
5. Close the settings pane.

Rules:

- Never remove, delete, or re-pair any accessory, and never change anything
  under Home Settings except creating a missing room.
- Do not touch scenes, automations, or the bridge accessory itself.
- If an accessory shows "No Response", skip it and list it in the report
  (it is a leftover orphan, handled separately).
- If a name from the CSV cannot be found, or two accessories share the
  name, do not guess — skip and report it.
- Work room by room in CSV order and keep a running count.

When finished, report: accessories moved per room, total renamed, and the
exact rows skipped (with reason). The CSV has 136 rows to process plus 6
scene switches to leave alone; the end state is an empty Default Room
except those 6.

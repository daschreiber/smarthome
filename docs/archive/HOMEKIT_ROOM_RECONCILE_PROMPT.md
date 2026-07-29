# Prompt: reconcile Apple Home rooms against the manifest

Copy everything below the line into a computer-use agent operating the Apple
**Home** app on macOS (signed into the home owner's Apple ID). Attach
`data/homekit_room_manifest.csv`.

Context for the human: the first assignment run was done against a bridge
that was silently capping accessories; when the cap lifted, the late
arrivals were dumped into the **Gym** room (the bridge's own room), and some
accessories that should have been excluded on the Home Assistant side may
still be present. This pass verifies every room instead of chasing names.

---

You are operating the Apple Home app on macOS. Earlier automation left
accessories in wrong rooms. The attached CSV is the complete, authoritative
manifest of this home: every accessory that should exist, its final name,
and the room it belongs in. Your job is to make every room contain exactly
its manifest rows — nothing missing, nothing extra.

CSV columns:

- `room` — where the accessory belongs. The row value
  `Housewide (or Default Room)` means whichever of the rooms "Housewide" /
  "Default Room" exists in this home.
- `final_name` — the name the accessory must end up with.
- `also_known_as` — the name it had when originally paired. Any given
  accessory currently carries either `final_name` or `also_known_as`.
  Treat curly (’) and straight (') apostrophes as identical when matching.
- `type` / `entity_id` — context and reporting only.

Procedure — go room by room through every room in the CSV, plus any other
room that visibly contains accessories:

1. List the room's current accessories (lights, blinds/covers, thermostats,
   switches — ignore cameras, speakers, TVs and the bridge accessory
   itself).
2. For each accessory that matches a manifest row for THIS room (by
   `final_name` or `also_known_as`): keep it here, and rename it to
   `final_name` if its current name differs.
3. For each accessory that instead matches a manifest row of ANOTHER room
   (matching either name column, uniquely): move it to that room and rename
   it to that row's `final_name`.
4. For each accessory matching NO manifest row: leave it exactly as is and
   record it in the report. Expected examples of this: anything named
   "… A-C & Heating", and "L1.109" — these are queued for removal on the
   Home Assistant side; do not move, rename, or delete them.
5. If a name matches more than one manifest row and the right one cannot be
   determined from the room context, skip it and report it — never guess.

Rules:

- Never delete, remove, or re-pair anything; never change Home Settings,
  scenes, or automations. Create a room only if the manifest names one that
  does not exist.
- The six rows for "Housewide (or Default Room)" are whole-house scene
  switches; they belong in that room with their original names unchanged.
- The manifest has 142 rows across 25 rooms. Within a room every
  `final_name` is unique, so after step 2 there is no ambiguity inside a
  room.

Final report: for every room, the count of accessories kept, renamed, moved
in, and moved out; the list of unmatched accessories left in place (name +
room); and any manifest row for which no accessory was found anywhere
(name + expected room). The target end state: each room's accessory set
equals its manifest rows exactly, with only the reported unmatched
leftovers awaiting Home Assistant-side cleanup.

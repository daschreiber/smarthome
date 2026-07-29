# Prompt: set up Alexa groups (rooms) to match the manifest

Copy everything below the line into a computer-use agent (e.g. ChatGPT with
computer control) running on the Mac, with the iPhone mirrored via **iPhone
Mirroring** and the **Amazon Alexa** app available on the phone. Attach
`data/alexa_room_manifest.csv`.

Context for the human — do these before running:

1. **Expose the entities in Home Assistant first.** As of the white-noise
   runbook only `switch.white_noise` is exposed to Alexa
   (Settings → Voice assistants → Alexa). Alexa can only group what it can
   see: expose the 142 manifest entities (every `entity_id` in the CSV),
   then say "Alexa, discover devices" and wait for it to finish. If you
   skip this, the run below still works but will report almost every row
   as "not found — not exposed yet".
2. Open **iPhone Mirroring** on the Mac, connected and signed in, and give
   the agent control of that window. The phone must stay nearby and locked
   (that's how iPhone Mirroring works); if the phone is picked up or asks
   to re-authenticate, the session pauses until you put it back.
3. The Alexa app on the phone must be signed into the household Amazon
   account, with the Home Assistant skill linked (Nabu Casa account — see
   `docs/ALEXA_WHITE_NOISE.md` Part 2).
4. The old Control4 Alexa skill may still be linked. If Alexa shows
   Control4-sourced duplicates of the same loads, the agent will leave them
   alone and report them; deciding whether to unlink that skill is a human
   call for afterwards.

Naming note: unlike Apple Home (short names + room, Siri composes them),
Alexa device names in the CSV are full house-unique names ("Daniel Study
lights", "Kitchen Strip 1") — that's what you say to Alexa from anywhere.
Group membership is what makes room-level commands ("Alexa, turn off the
lights") work on the Echo standing in that room.

---

You are operating the **Amazon Alexa** app on an iPhone through the
**iPhone Mirroring** window on this Mac. Everything happens by clicking,
scrolling, and typing inside that window — Cmd+1 goes to the Home Screen
and Cmd+3 opens Search if you need to launch the app. If the phone locks
you out, a notification covers the screen, or anything asks for Face ID or
a passcode, stop and ask the human — never try to enter credentials.

The attached CSV is the complete, authoritative manifest of this home's
smart-home devices in Alexa: every device that should exist, the name it
must end up with, and the Alexa **group** (Alexa's version of a room) it
belongs in. Your job is to make every group contain exactly its manifest
rows — nothing missing, nothing extra — and every device carry its
manifest name.

CSV columns:

- `group` — the Alexa group the device belongs in. The value
  `(none — leave ungrouped)` marks six whole-house scene switches that
  must stay out of every group (a room-level "turn everything off" must
  never fire "All House Exit").
- `alexa_name` — the name the device must end up with. House-unique by
  design.
- `likely_current_name` — the name the device most probably carries right
  now (its Home Assistant name at discovery time). Any given device
  matches a row by `alexa_name` or by `likely_current_name`. When
  matching, ignore case, extra/doubled spaces, curly vs straight
  apostrophes ('), and the prefixes "KNX Switch", "KNX Dimmer", "HK".
- `type` / `entity_id` — context and reporting only. `entity_id` is not
  visible in Alexa; quote it in the report so the human can fix exposure
  on the Home Assistant side.

Procedure:

1. **Inventory.** Devices tab. List every existing group and, under
   All Devices, every device. Only lights, blinds/covers, thermostats
   (A/C), and switches are in scope. Echo devices and Alexa-enabled
   speakers matter only for step 4; ignore cameras, TVs, and anything
   else entirely.
2. **Groups.** The manifest names 24 groups. For each one that does not
   exist, create it with exactly the CSV name (Devices → + → Add Group).
   Never delete or rename an existing group; if extra groups exist,
   record them in the report and leave them.
3. **Devices.** Work group by group through the CSV. For each row, find
   the device (Alexa app search under Devices, or the All Devices list)
   by `alexa_name` or `likely_current_name` using the matching rules
   above. Then:
   - rename it to `alexa_name` if its current name differs
     (device → gear icon → Edit Name);
   - make sure it is in its `group` and in no other manifest group
     (edit the group → Edit → tick/untick, or the device's own settings).
   - If a name matches more than one device, or one device plausibly
     matches more than one row, skip it and report it — never guess.
4. **Echoes.** For each Echo / Alexa speaker whose name clearly contains
   exactly one manifest group's name, make sure it is a member of that
   group (that is what lets "Alexa, turn on the lights" work in-room).
   Any Echo you cannot place unambiguously: leave it and report it.
5. **Leftovers.** A device matching no manifest row: leave it exactly as
   is — do not move, rename, or delete it — and record it. Expected
   examples: Control4-sourced duplicates of the same lights, and Alexa's
   own non-smart-home entries.

Rules:

- Never delete or forget a device, never unlink or disable a skill, never
  touch Routines, Hunches, account or Echo settings. The only changes you
  make are: create a missing group, rename a matched device, change group
  membership.
- The six `(none — leave ungrouped)` scene switches keep their exact names
  and stay out of all groups — if one is found inside a group, remove it
  from the group (not from Alexa).
- The manifest has 143 rows: 137 devices across 24 groups plus the 6
  ungrouped scene switches. Within a group every `alexa_name` is unique,
  and `alexa_name` is unique across the whole house.
- Keep a running count as you go; if the app gets stuck or a screen looks
  unfamiliar, pause and describe it rather than tapping blindly.

Final report: for every group — devices confirmed, renamed, added to the
group, and removed from it; every Echo placed (or unplaceable); the list
of unmatched devices left alone (name + where they sit); and every
manifest row for which no device was found anywhere, with its `entity_id`
(those are almost certainly not yet exposed from Home Assistant — the
human fixes that, re-runs discovery, and this prompt can be run again; it
is idempotent). Target end state: each group's device set equals its
manifest rows exactly, every device named `alexa_name`, each Echo in its
room's group, and only the reported leftovers outside the manifest.

# Home Assistant Normalization Report

Applied: 2026-07-16, via WebSocket registry API. Registry/metadata changes only — no device-state services were called.

## Backup

Completed before any change: backup id `74aa5f38`, 2026-07-16 17:36 (local), agent `hassio.local`.
Note: this HA version has no `backup.create` service; its replacement `backup.create_automatic` was used.

## Floors — 2 created

| Floor | Level | floor_id |
|---|---|---|
| Floor 5 | 5 | `floor_5` |
| Floor 6 | 6 | `floor_6` |

## Areas — 25 total (21 created, 4 reused)

Reused: **Gym** (floor set → 5), **Kitchen** (floor set → 6), **Living Room → renamed "Lounge"** (floor 6), **Bedroom → renamed "Master Bedroom"** (floor 6). Both renames confirmed by Daniel.

Created, Floor 5 (13): Balcony (5th), Daniel's Study, Daniella's Study, Den, Downstairs Toilet, Guest Bathroom, Large Guest Room, Left Corridor, Medium Guest Room, Right Corridor, Sauna, Small Guest Room, Stairs & Landing.

Created, Floor 6 (8): Balcony (6th), Dining, Entrance, Master Bathroom, Master Bedroom Balcony, Master Corridor, Terrace, Utility Room.

All 25 areas verified present with the correct floor. No leftover areas outside the mapping.

## Entities — 184 of 184 processed, 0 failures

- **Areas assigned:** 176 entities → their room's area; 8 "Whole House" entities left area-less (their devices also carry no area, so nothing leaks through).
- **Renamed:** all 184 got a name override. 156 use `display_name` as-is; 26 are room-prefixed because the name repeats across rooms — "A/C & Heating" (12 rooms) and "Floor Heating" (14 rooms), e.g. "Sauna Floor Heating". Post-rename uniqueness verified: no duplicate names remain.
- **Hidden:** 30 entities with `visible=false` → `hidden_by: "user"`. Verified count: 30.

## Balcony media players (both in area "Balcony (6th)")

| New name | entity_id | Distinguishing attributes |
|---|---|---|
| Balcony Speakers 1 | `media_player.balcony` | platform `cast`, VSSL A3x, unique_id `7472454f-4285-b7b0-245b-479eae699183`, state **unavailable** at apply time; was "Balcony " (trailing space) |
| Balcony Speakers 2 | `media_player.balcony_2` | platform `control4`, unique_id `225`, state idle, sources incl. TuneIn/My Music; was "Balcony" |

Since Speakers 1 was unavailable (VSSL via cast), you may want to power it up and rename the pair to something location-accurate once you can hear which is which.

## Verification (fresh registry fetch after apply)

- Floors: 2/2 correct levels ✓
- Areas: 25/25 correct name + floor ✓
- Entities: 184/184 match expected name, area, hidden state — zero mismatches ✓
- Unprocessed entities: none.

## Not touched

Person/device_tracker/zone entities, all device-level settings, entity states, and the ~73 non-controllable registry entities outside the mapping file.

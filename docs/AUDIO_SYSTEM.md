# Whole-home audio: hardware map & control paths

Surveyed 2026-07-22/23 (HA registries + supported_features decoding + owner's
physical walk of the cabinets + live listening tests). This is the reference
for anything media/speakers.

## The four systems

### 1. Control4 matrix zones — the backbone (all main indoor + outdoor areas)

The Core 3 (Lounge cabinet, floor 6) drives an audio matrix whose zones are
HA `media_player` entities via the `control4` integration:

| entity | room |
|---|---|
| `media_player.den` | Den |
| `media_player.lounge` | Lounge |
| `media_player.kitchen` | Kitchen |
| `media_player.terrace` | Terrace |
| `media_player.balcony_2` | Balcony (6th) |
| `media_player.master_bedroom` | Master Bedroom (hidden in app) |
| `media_player.master_bathroom` | Master Bathroom |
| `media_player.master_bedroom_balcony` | Master Bedroom Balcony |

**Control quirks (supported_features 23821):** no `turn_on`, no `play_media`.
A zone WAKES BY SELECTING A SOURCE — that's why the app's original on/off
media card did nothing. Zones do support `select_source`, volume set/step/
mute, play/pause/stop, `turn_off`.

**Sources per zone:** physical inputs (Gramophone on Lounge/Kitchen — the
turntable; `Smart TV <room>`; XBox on Den) + Control4's built-in streaming
apps (TuneIn / My Music / Digital Media — **never configured, select to
silence**, hidden in the app) + 2-3 unnamed `Unknown Device - 42949662xx`
matrix inputs (identity still unconfirmed; hidden in the app).

**The headline discovery (2026-07-23): the Core has NATIVE per-zone Spotify
Connect.** Every zone appears in the Spotify app's device picker as
**"Spotify C4 \<Room\>"** — pick one and the Core streams straight to that
zone, "Very high" quality. No extra hardware, works today, covers Kitchen /
Terrace / Bathroom / balconies that have no other streamer. While a session
plays, the zone entity's `media_title` carries the track name (`source`
reads None — sessions aren't in `source_list`).

### 2. Yamaha MusicCast receivers (Den, Lounge, Master Bedroom)

| receiver | IP | HA entity | notes |
|---|---|---|---|
| RX-V6A | 10.0.0.35 | `media_player.master_bedroom_2` | white-noise host (docs/ALEXA_WHITE_NOISE.md) |
| RX-V6A | 10.0.0.14 | `media_player.room_lounge` | Lounge cabinet; added 2026-07-23 |
| RX-V4A | 10.0.0.76 | `media_player.room_den` | Den cabinet; added 2026-07-23 |

Both "new" receivers were on the LAN all along but never added to HA (the
discovered-integration cards sat unclicked). Native Spotify Connect +
AirPlay 2 + Bluetooth; full HA control incl. `play_media` (URL streams).
**Den's C4 audio path runs THROUGH the RX-V4A** (C4 feeds its HDMI2 —
verified live: `room_den` reported "playing" during a C4 music test), so
Spotify Connect to the receiver exits the same speakers as C4 audio.

### 3. VSSL streaming amps (outdoor + sauna)

- **A.1x** — Den cabinet (floor 5), single zone = **Sauna speakers**.
  Online and healthy via Google Cast (`media_player.sauna`). The KLAFS
  sauna *controls* are a separate system; only the audio is this amp.
- **A.3x** — Lounge cabinet (floor 6), under the Core 3. Three zones =
  "Balcony Speakers 1" (`media_player.balcony`), "MBR balcony", "BBQ
  speaker". **Powered (LED lit) but NO ethernet cable in its NETWORK
  jack** — VSSL A-series is ethernet-only, so its streaming half (Cast /
  AirPlay / Spotify Connect) has been dead since installation (its Cast
  zones were named once, so it was cabled during install). It very likely
  still works fine as the *analog power amp* for the outdoor speakers fed
  from the matrix. Its zones may appear as stale entries in the Spotify
  picker — they error if selected.
  **Fix when wanted:** one patch cable NETWORK jack → free Netgear port in
  the same cabinet. Optional now that C4's own Spotify covers those rooms.

### 4. The rest

Sonos Arc Ultra in the Gym (`media_player.gym_gym`, full transport +
grouping). Samsung TVs via cast/`samsungtv` (+ `dlna_dmr` Den TV soundbar).
Apple TV "Basement Jerusalem". Rack has its own AC (`climate.rack_unit_109`).

## Spotify device-picker decoder

- **Spotify C4 \<Room\>** → Control4 zone (the matrix speakers). Preferred
  for Kitchen/Terrace/Bathroom/balconies.
- **Lounge / Den / Master Bedroom** (receiver icon) → the Yamahas.
- **Gym** → Sonos. **Sauna** → the A.1x.
- **BBQ speaker / Balcony / MBR balcony** → the un-cabled A.3x; stale, will
  error until its ethernet is connected.

## App integration (web/)

- Commands: `select_source` (validated against live `source_list`, verified
  by source-attribute echo), `play`, `pause` + existing volume/on-off.
  Registry gives media players `select_source` + `transport` capabilities;
  `/api/home` serves `source`, `sourceList`, `mediaTitle`, `volumePct`, and
  `canTurnOn` (feature bit 128) so the UI never renders a control the
  hardware ignores.
- Room MediaCard: source chips (curated), play/pause + Off while active,
  volume slider, now-playing title. C4 zones show physical inputs only
  (`HIDDEN_SOURCES`); MusicCast receivers show Spotify / AirPlay /
  Bluetooth / TV (`RECEIVER_SOURCES`; receivers are recognized by "Spotify"
  in their source list).
- `data/entity_map.json`: **append rows at the END** — device ids derive
  from display-name slugs de-duped in file order; re-sorting breaks stored
  favorites/scenes.

## Open items

1. Ethernet cable for the A.3x (optional; adds direct Cast/AirPlay/Spotify
   to outdoor zones + brings them back into HA).
2. Identify the `Unknown Device` matrix inputs by ear someday (likely the
   Core's own streamer sessions and/or VSSL line-ins); rename in Composer.
3. Music Assistant add-on for in-app/voice playlist starts ("play X in the
   Lounge" without touching the Spotify app) and cross-system grouping.
4. Consider surfacing "Spotify C4" guidance in the app's media cards (e.g.
   a hint that streaming starts from the Spotify picker until MA lands).

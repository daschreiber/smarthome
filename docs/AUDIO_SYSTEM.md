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
| RX-V6A | 10.0.0.35 — **not there on 2026-09-03** (a Sonos held `.35`); current address unknown | `media_player.master_bedroom_2` | white-noise host (docs/ALEXA_WHITE_NOISE.md) |
| RX-V6A | 10.0.0.14 — **not there on 2026-09-03** (a Control4 device held `.14`); current address unknown | `media_player.room_lounge` | Lounge cabinet; added 2026-07-23 |
| RX-V4A | 10.0.0.76 (`4c:22:f3:72:54:e3`, verified 2026-09-03) | `media_player.room_den` | Den cabinet; added 2026-07-23 |

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

## Spotify integration (backend, lib/spotify.ts + lib/spotifyAccounts.ts)

The app's Play button on an idle Music card means "play MY music here": the
backend targets the room's Connect endpoint — the Core's "Spotify C4 …"
devices, which nothing else (incl. Music Assistant) can reach.

### Two kinds of account

The single household login was the original design, and it had a flaw that
no amount of app code can fix: **Spotify allows one active playback session
per ACCOUNT**. With everyone sharing one account, playing in the Kitchen
*moved* the music out of the Lounge, and the only "controls" were ours.

So there are now two kinds of account (lib/spotifyAccounts.ts):

- **House** — linked once by an admin (More → Spotify → House Spotify).
  Still the fallback for anyone who hasn't linked their own and for the
  APP_KEY admin. Same file and format as before (`SPOTIFY_TOKEN_PATH`), so
  the deployed volume needed no migration.
- **Per user** — each person links their own from More → Spotify → My
  Spotify. Their phone's Play/Pause/Skip then drive *their* account, so two
  people are two sessions and the rooms are genuinely independent. Stored
  in `SPOTIFY_LINKS_PATH`.

Skip only ever acts on the caller's own session — offering it for someone
else's music would skip a track in whichever room *you* were last playing
in.

**The Spotify ceiling is low, and it got lower.** Development Mode — the
tier a private household app lives in — went from 25 authorised users to
**five per Client ID** in February 2026, the app owner must have Premium,
and each person controlling speakers needs Premium too. Escaping that
(Extended Access) requires a registered business with 250k monthly users,
which this is not. A July 2026 update raised the *app* limit to 25 Client
IDs per developer with a shared quota, so a second Client ID is the escape
hatch if the house ever needs more than five people. The app enforces five
in `MAX_LINKED_USERS` and says so before sending anyone to a consent screen
they'd fail at.

Capacity is counted in **Spotify users, not links** (`usedSlots`). The house
account holds a slot of its own whenever it's a different Spotify account —
but it's usually the admin's own, and then their personal link is the same
user and costs nothing extra. So each link records the Spotify user id and
the count de-duplicates. The login gate has to guess before consent (the
identity isn't known yet), so the callback re-checks with the id in hand. A
house account linked before ids were recorded can't be matched, so it counts
as its own slot — over-counting produces a "free a slot first" message,
under-counting produces a dead end at Spotify's consent screen, and the
first is the kinder failure. Re-linking the house account records its id and
clears that up.

### Hand-off: "open my own Spotify on this room"

The Music card's **Open in Spotify ↗** is the answer to "the controls
aren't in the app". Spotify publishes **no deep link that pre-selects a
Connect device**, and the App Remote SDK that could is native-app-only
(this is a PWA). So the app does the half a link can't: `/api/music/handoff`
points the user's own account at the room's Connect endpoint over the Web
API, and the anchor navigates to `open.spotify.com` in the same tap — the
phone lands in Spotify already attached to that room, with full search,
playlists and queue. The POST is `keepalive` because Safari blocks a
`window.open` issued after an `await`.

Without a personal link the button explains itself instead of pretending:
transferring the *house* account and then opening *your* Spotify would
attach the room to one account and show you another.

### Setup

1. https://developer.spotify.com/dashboard → create an app. Redirect URI:
   `https://<railway domain>/api/spotify/callback`. Add every household
   member's Spotify email to the app's user allow-list (max five).
2. Railway env: `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`,
   `SPOTIFY_TOKEN_PATH=/data/spotify_token.json`,
   `SPOTIFY_LINKS_PATH=/data/spotify_links.json` (the persistent volume),
   optional `SPOTIFY_DEFAULT_CONTEXT=spotify:playlist:…` (cold-start
   fallback when an account has nothing to resume).
3. App → More → Spotify. Admins link the house account; everyone links
   their own. Refresh tokens persist on the volume; re-link any time.

Semantics: resume-first (bare `PUT /me/player/play?device_id=`), fall back
to `SPOTIFY_DEFAULT_CONTEXT`.

### Finding a room's Connect device

`ROOM_DEVICE` (lib/spotify.ts) maps app rooms to the Core's naming, which
differs from ours in several places. It is the first strategy, not the only
one: resolution falls back to normalized name/alias matching, so a zone
renamed in Composer doesn't silently kill a room's Play button. When a room
still can't be found, **the error names every device Spotify could see** —
that is the difference between "the Terrace won't connect" and a fact you
can act on (see below).

## Multi-room: "extend" (lib/audio.ts)

Putting the Lounge's music into the Kitchen and the Balcony is a **Control4
matrix** job, not a Spotify one. Spotify Connect fundamentally cannot do
it: one account, one session, so targeting a second "Spotify C4 …" endpoint
*moves* the music. The matrix exists precisely to fan one source out to
many zones.

So `/api/music/extend` selects the origin room's input on the target zones
(`ROOM_ZONE` maps room → matrix zone entity, explicit because the Terrace
and Balcony each hold a second, non-matrix player). Every outcome is read
back from the zone and reported per room: `confirmed` only when the target
echoed the input back, `sent` when it accepted but hasn't, `failed` with
the reason. Zone grouping (`media_player.join`) is deliberately not tried —
the C4 zones don't advertise the GROUPING feature bit.

**The known limit.** Only a *named* source can be mirrored. When a Core
Spotify session plays, the zone reports the track in `media_title` but
`source` reads None — the session isn't in `source_list` — so there is
nothing to name. The app says exactly that rather than faking success. The
fix is almost certainly one of the unidentified `Unknown Device -
42949662xx` matrix inputs: if one of them is the Core's own streamer,
naming it in `SPOTIFY_MIRROR_SOURCE` turns extend on for Spotify too. That
needs one listening test in the house (open item 2 below, now worth doing).

## Open items

1. Ethernet cable for the A.3x (optional; adds direct Cast/AirPlay/Spotify
   to outdoor zones + brings them back into HA).
2. Identify the `Unknown Device` matrix inputs by ear (likely the Core's own
   streamer sessions and/or VSSL line-ins); rename in Composer. **Now
   load-bearing:** whichever one carries the Core's streamer is the value
   for `SPOTIFY_MIRROR_SOURCE`, which is what lets a Spotify session extend
   into other rooms.
3. Music Assistant add-on — still interesting for cross-system grouping and
   library browsing, but no longer required for Play (the Web API covers
   the C4 zones, which MA cannot).
4. Confirm the Terrace's Connect device name from the app's own error text
   (below), and correct `ROOM_DEVICE` if the Core calls it something else.

## The Terrace "couldn't connect" report (2026-07-30)

The card showed **"The string did not match the expected pattern."** in the
status line. That string is not about the Terrace at all — it is Safari's
error from `await res.json()` when an error response body isn't JSON (a
proxy's HTML 502, an empty 504). The Music card's catch block displayed it
as though it were the reason the music didn't play, so a perfectly ordinary
upstream failure arrived as gibberish.

Fixed on both sides:

- `lib/fetchError.ts` reads error bodies as text and parses only if they
  look like JSON, otherwise saying something true about the status. No card
  can surface a JSON-parse complaint as a device fault again.
- The music fetches now send `appKeyHeaders()` like every other call in the
  app; they were the only ones that didn't, so an APP_KEY deployment got a
  401 out of Play and Skip.
- Device resolution now falls back to alias matching and, on failure, lists
  the devices Spotify *can* see — so the next time the Terrace misbehaves
  the card names the real cause instead of a parser's opinion.

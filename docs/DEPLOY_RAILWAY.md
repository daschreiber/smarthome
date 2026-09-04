# Phase D — Deploy to Railway (runbook Stage 7 + 8)

Goal: the app runs 24/7 at a Railway HTTPS URL, reaching Home Assistant
through the Home Assistant Cloud remote URL. After this, the Mac is out of
the loop and the app works from anywhere, including cellular.

## Part 1 — Home Assistant Cloud (on the Green, ~10 min, owner)

1. In Home Assistant: **Settings → Voice assistants & Cloud** (or **Settings
   → Home Assistant Cloud** depending on version) → sign up for Home
   Assistant Cloud (Nabu Casa, ~$6.50/mo, 30-day trial).
2. Enable **Remote control**.
3. Copy the remote URL — it looks like
   `https://<random-id>.ui.nabu.casa`. This is `HA_BASE_URL` for Railway.
   Treat it as semi-secret: don't post it publicly (runbook rule).
4. **Settings → People → Users → smarthome-app** → UNTICK "Can only log in
   from the local network" (the backend now connects via the cloud URL, which
   does not count as local). This was anticipated when the user was created.
5. Sanity check from a phone on cellular: the remote URL should show the
   Home Assistant login page. Do NOT log in from there day-to-day; it's for
   the backend.

The existing long-lived token keeps working — tokens are not
network-scoped, only the login restriction was.

## Part 2 — Railway (owner clicks, ~10 min)

1. railway.app → New Project → **Deploy from GitHub repo** →
   `daschreiber/smarthome` (authorize GitHub access if asked).
2. When the service is created, open **Settings**:
   - **Root Directory**: `web`
   - **Branch**: `main` (owner switched the service to main on 2026-07-17
     after the branch mixup described in COMMISSIONING_LOG — merged-to-main
     now means deployed).
   - Build/start commands: leave auto-detected (Next.js; start script
     already binds Railway's `PORT`).
3. **Add a Volume** (service → right-click/Settings → Attach Volume), mount
   path `/data`. This keeps users, favorites, and the audit log across
   deploys.
4. **Variables** tab — add:

   | Variable | Value |
   | --- | --- |
   | `HA_BASE_URL` | the `https://….ui.nabu.casa` URL from Part 1 |
   | `HA_TOKEN` | the smarthome-app long-lived token (password manager) |
   | `APP_USERS` | `daniel@…:<password>,daniella@…:<password>` — seeds the user store ONCE (first entry = admin); afterwards manage users in the app |
   | `APP_SESSION_SECRET` | output of `openssl rand -hex 32` |
   | `USERS_PATH` | `/data/users.json` |
   | `FAVORITES_PATH` | `/data/favorites.json` |
   | `AUDIT_LOG_PATH` | `/data/audit.log` |
   | `SCENES_PATH` | `/data/scenes.json` |
   | `AUTOMATIONS_PATH` | `/data/automations.json` |
   | `TIMERS_PATH` | `/data/timers.json` — auto-off timer rules |
   | `APP_TZ` | `Asia/Jerusalem` — house timezone for automation schedules (cloud hosts run UTC) |
   | `APP_BASE_URL` | the Railway URL (fill in after step 5; used in reset links) |
   | `SAUNA_BASE_URL` | the sauna app's URL (optional, enables the sauna card) |
   | `SAUNA_API_TOKEN` | the sauna app's API token (optional) |
   | `WHITENOISE_VIA_HA` | `1` — the white-noise server runs as an HA add-on on the LAN (the bedroom Yamaha can't play HTTPS, so the stream must be LAN plain-HTTP). Sound control and status ride through HA: `rest_command.whitenoise_set_noise` / `whitenoise_set_volume` and `sensor.white_noise_status`, configured in the Green's `configuration.yaml`. Enables the Master Bedroom noise card without the two vars below |
   | `WHITENOISE_STREAM_URL` | with `WHITENOISE_VIA_HA`: the add-on's LAN stream URL incl. token, e.g. `http://10.0.0.69:8099/stream?token=…` — what the app tells the media_player to play |
   | `WHITENOISE_BASE_URL` | direct mode only — the cloud noise server's URL (optional, enables the Master Bedroom noise card) |
   | `WHITENOISE_TOKEN` | direct mode only — the noise server's SECRET_TOKEN (optional) |
   | `WHITENOISE_MEDIA_ENTITY` | optional — the HA media_player entity the app tells to play/stop the stream for in-app on/off (defaults to `media_player.master_bedroom`; the actual bedroom speakers are the Yamaha MAIN zone `media_player.master_bedroom_2`) |
   | `WHITENOISE_MEDIA_SOURCE` | optional — Control4 rooms join *sources* rather than playing URLs (its HA integration ignores `play_media`). Once the stream is programmed into Control4 as a source (web-radio/station driver), set this to that source's exact name from the entity's `source_list`; "on" then does `select_source` on the room. Unset, the app falls back to `play_media` with the stream URL, which works on URL-capable entities (DLNA renderer, Sonos, Cast). Either way, "on" only reports confirmed once the noise server sees a listener connect |
   | `SLEEPWATCH_PATH` | `/data/sleepwatch.json` — the sleep watcher's state file (auto white-noise when the Master Bedroom looks asleep; arms 22:00–08:00, stops when the room wakes — a light on or a shade opening, no morning timer; toggle on the Automations screen) |
   | `ANTHROPIC_API_KEY` | optional — enables the "Ask the house" conversational assistant (console.anthropic.com → API keys); without it the chat screen shows a friendly "not configured" message |
   | `GOOGLE_CLIENT_ID` | optional — enables "Continue with Google" on the sign-in screen (Google Cloud Console → OAuth client, redirect URI `<APP_BASE_URL>/api/auth/google/callback`) |
   | `GOOGLE_CLIENT_SECRET` | optional — pairs with `GOOGLE_CLIENT_ID`. Google only proves identity; access still requires the email to be on the app's user list |
   | `RESEND_API_KEY` | optional — enables password-reset emails (resend.com) |
   | `EMAIL_FROM` | optional — sender for reset emails, needs a verified domain on Resend |
   | `AWAY_PATH` | `/data/away.json` — the Away switch's state file |
   | `SAUNAWATCH_PATH` | `/data/saunawatch.json` — the sauna-follower watcher's state file |
   | `LIFTWATCH_PATH` | `/data/liftwatch.json` — the TV follower's state file (MBR TV mirrors the ceiling lift's edges: down → on, up → off; toggle on the Automations screen). Must live on the volume or every redeploy loses the edge baseline AND a deliberately paused follower comes back on |
   | `LIFTWATCH_OFF_ENTITY` | optional — where the TV follower's OFF goes (default `media_player.55_qled`, the Samsung itself — the only path proven to reach it); `media_player.master_bedroom` = Control4 Room Off, only meaningful once the ON also goes through Control4 |
   | `LIFTWATCH_OFF_ATTEMPTS` | optional — off commands per stow, 1–3 (default 1: a power key is a toggle, never retried blind); `3` brings back the "still reads on → send again" enforcement |
   | `SAUNA_AC_TEMP` | optional — Master Bathroom A/C setpoint while the sauna heats (default 18) |
   | `SAUNA_AC_FAN` | optional — fan mode for the sauna follower (default `high`) |
   | `COVER_STATE_TRUSTED` | `1` — shade positions come from the native KNX covers and are real; the UI shows sliders/state instead of best-effort buttons (set on Railway 2026-07-26, `knx/README.md` item 8) |
   | `SLEEPWATCH_LIFT_STATE` | optional — lift relay state that means "stowed" (default `off`); shared polarity knob for the sleep watcher and the TV follower |
   | `EIGHTSLEEP_LEFT_TARGET_ENTITY` / `EIGHTSLEEP_RIGHT_TARGET_ENTITY` | Eight Sleep per-side temperature `number.*` entities — a side configured = a bed card side in the app (`docs/EIGHT_SLEEP_SETUP.md`) |
   | `EIGHTSLEEP_LEFT_PRESENCE_ENTITY` / `EIGHTSLEEP_RIGHT_PRESENCE_ENTITY` | optional — per-side presence `binary_sensor.*` entities (display-only) |
   | `EIGHTSLEEP_LEFT_LABEL` / `EIGHTSLEEP_RIGHT_LABEL` | optional — card labels (default "Bed — left/right side") |
   | `EIGHTSLEEP_HEAT_DURATION_SECONDS` | optional — heat-level hold duration (default 28800 = a full 8-hour night, per `docs/EIGHT_SLEEP_SETUP.md`) |
   | `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | optional — enables the Spotify link flow (More → Spotify, admin-only) and the music controls on receiver cards |
   | `SPOTIFY_TOKEN_PATH` | `/data/spotify_token.json` — where the linked account's refresh token lives |
   | `SPOTIFY_DEFAULT_CONTEXT` | optional — playlist/album URI Play falls back to when nothing is paused |
   | `VACUUM_ROOMS_PATH` | `/data/vacuum_rooms.json` — user-assigned Roborock segment names |
   | `ENTITY_MAP_PATH` | optional — explicit path to `entity_map.json`; unset, the app falls back to `../data/` then `./data/` (the repo copies) |

   This table is the deployment source of truth — when code starts reading
   a new `process.env.*` variable, add it here in the same commit.

   The app refuses all requests in production if no auth is configured —
   misconfiguration fails closed, not open. Without `RESEND_API_KEY`,
   password resets still work: an admin generates a one-hour reset link
   from the Users screen and sends it manually.
5. Deploy. Railway assigns `https://<something>.up.railway.app` (Settings →
   Networking → Generate Domain if none is shown). Put that URL into
   `APP_BASE_URL` (step 4) so emailed reset links point at the right place.

## Part 3 — Verify (owner + Claude)

1. Open `https://<app>.up.railway.app` on the iPhone **on cellular** — the
   sign-in screen should appear. Sign in.
2. Toggle one light. Round trips will be ~1-2s slower than on the LAN
   (phone → Railway → Nabu Casa → Green → Control4).
3. Check `/activity` shows the command with your email.
4. Re-do **Add to Home Screen** with the Railway URL (replace the old
   local-IP icon).

## Known tradeoffs at this stage

- `favorites.json` and `audit.log` live on the service filesystem and reset
  on each deploy. Acceptable for now; managed Postgres is the planned swap
  (IMPLEMENTATION_SPEC §3) once audit history should be durable.
- If home internet is down, remote control is down (inherently) and so is
  the app on home Wi-Fi; the Home Assistant companion app remains the local
  fallback, per the accepted spec tradeoff.
- The Control4 cloud outage caveat from IMPLEMENTATION_SPEC §10 still
  applies to HA↔Control4, independent of this deployment.

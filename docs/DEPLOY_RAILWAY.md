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
   - **Branch**: `claude/home-assistant-setup-sskcuf` (or `main` after the
     branch merges)
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
   | `APP_BASE_URL` | the Railway URL (fill in after step 5; used in reset links) |
   | `SAUNA_BASE_URL` | the sauna app's URL (optional, enables the sauna card) |
   | `SAUNA_API_TOKEN` | the sauna app's API token (optional) |
   | `RESEND_API_KEY` | optional — enables password-reset emails (resend.com) |
   | `EMAIL_FROM` | optional — sender for reset emails, needs a verified domain on Resend |

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

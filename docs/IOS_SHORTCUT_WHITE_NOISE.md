# iPhone Shortcut: "Sleep sound on" (runbook)

Goal: a Shortcut on the iPhone (Siri, Home Screen icon, Action Button,
Back Tap) that starts the sleep sound on the Master Bedroom speakers.
It drives the same `switch.white_noise` that Alexa uses
([ALEXA_WHITE_NOISE.md](ALEXA_WHITE_NOISE.md)), so it plays whatever
sound and volume the app's Sleep sound card is set to, and the sleep
watcher composes with it the same way (adopts a session started this
way; a deliberate off latches for the night).

## Option A (recommended): through the Home Assistant Companion app

No tokens, works away from home through Nabu Casa, because the
Companion app already holds the phone's own login.

1. **Shortcuts** app → **+** (new shortcut).
2. Search actions for **Home Assistant** → add **Perform Action**
   (older Companion builds call it **Call Service**).
3. Fill it in:
   - Server: **Home** (the Companion app's name for our Home Assistant;
     it is the only server listed).
   - Action: tap **Choose** → `switch.turn_on`
   - Payload (JSON):
     ```json
     {"entity_id": "switch.white_noise"}
     ```
4. Rename the shortcut **Sleep sound on**. The name is the Siri phrase:
   "Hey Siri, sleep sound on". Do not put "play" in the name; like
   Alexa, Siri routes "play …" into Music.
5. Duplicate it as **Sleep sound off** with `switch.turn_off`.

### Picking the sound in the same shortcut (optional)

Add a Perform Action step *before* the switch step:

| Want | Action | Payload |
|---|---|---|
| brown noise | `rest_command.whitenoise_set_noise` | `{"noise_type": "brown"}` (`white` / `pink` also valid) |
| a volume | `rest_command.whitenoise_set_volume` | `{"volume": 40}` (0-100) |

Those rest_commands live in configuration.yaml on the Green
(COMMISSIONING_LOG 2026-07-22) and are the same ones the Railway app
calls, so the app card follows within a minute.

### Ways to trigger it

- Siri: the shortcut name.
- Home Screen: shortcut ⋯ → **Add to Home Screen**.
- Action Button: Settings → Action Button → Shortcut.
- Back Tap: Settings → Accessibility → Touch → Back Tap.
- Automation: Shortcuts → Automation → e.g. "When I arrive home after
  22:00" or "When Sleep Focus turns on" → run Sleep sound on.

## Option B: plain HTTP (no Companion app on that phone)

Shortcuts → **Get Contents of URL**:

- URL: `https://<id>.ui.nabu.casa/api/services/switch/turn_on`
- Method: POST
- Headers: `Authorization: Bearer <long-lived token>`,
  `Content-Type: application/json`
- Request body (JSON): `entity_id` = `switch.white_noise`

The token ends up stored inside the shortcut, so make it a dedicated
HA user's token (Profile → Security → Long-lived access tokens), not the
owner's, and revoke it there if the phone is lost. Prefer Option A.

## Verify

Run the shortcut from the Shortcuts app first (it will ask once for
permission to run the Home Assistant action). The Yamaha wakes and the
stream plays; **Developer tools → States → `switch.white_noise`** turns
`on` within a minute (the listener sensor polls every 60 s). "Sleep
sound off" puts the receiver on standby.

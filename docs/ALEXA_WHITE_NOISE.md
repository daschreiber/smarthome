# Alexa: "turn on white noise" (runbook)

Goal: **"Alexa, turn on white noise"** / **"Alexa, turn off white noise"**
starts/stops the stream on the Master Bedroom speakers (the Yamaha's main
zone). The sound and volume are whatever the app's White noise card is set
to — noise type and volume are the stream's own persistent state on the
add-on, so a voice start plays exactly what the card shows. No custom
skill, no new services: Home Assistant Cloud (already subscribed for the
Railway backend) includes the Alexa integration.

Deliberately NOT "Alexa, play white noise": "play …" routes into Alexa's
music domain, and Amazon's built-in ambient sounds would answer it on the
Echo itself instead of the room speakers. "Turn on/off" is the smart-home
verb and goes to us. (If a custom phrase is ever wanted, an Alexa Routine
can trigger the same switch — pick a phrase that doesn't start with
"play".)

## Part 1 — a White Noise switch in HA (on the Green, ~5 min)

Add to `configuration.yaml`, next to the existing
`rest_command.whitenoise_*` / `sensor.white_noise_status` block (see
COMMISSIONING_LOG 2026-07-22), then reload Template entities (Developer tools → YAML):

```yaml
template:
  # Append to the EXISTING `template:` list (the HK covers). Modern format
  # only: a legacy `switch: - platform: template` block loads but never
  # sets up on current HA (2026.7, same as the covers — see the config's
  # comments). Verified live 2026-07-22.
  - switch:
      - name: "White Noise"
        unique_id: white_noise_master_bedroom
        # Honest state: the add-on's listener count, mirrored by the REST
        # sensor. The sensor polls every 60s, so Alexa's reported state can
        # lag up to a minute — commands are immediate, only the readback
        # lags.
        state: >-
          {{ (state_attr('sensor.white_noise_status', 'listeners') | int(0)) > 0 }}
        turn_on:
          # Same LAN plain-HTTP stream URL as WHITENOISE_STREAM_URL on
          # Railway (the Yamaha can't play HTTPS). Keep the token out of
          # the file proper:
          - action: media_player.play_media
            target:
              entity_id: media_player.master_bedroom_2
            data:
              media_content_id: !secret whitenoise_stream_url
              media_content_type: music
        turn_off:
          - action: media_player.turn_off
            target:
              entity_id: media_player.master_bedroom_2
```

Gotcha: the Supervisor pre-registers a (disabled) `switch.white_noise`
for the add-on itself, so the template switch first lands as
`switch.white_noise_2`. Fix in the entity registry: rename the add-on's
entry to `switch.white_noise_addon`, then rename ours to
`switch.white_noise`. Reload is enough — no restart: template entities
reload picks the switch up once it's in modern format.

And in `secrets.yaml`:

```yaml
whitenoise_stream_url: "http://10.0.0.69:8099/stream?token=<the add-on's SECRET_TOKEN>"
```

Sanity check before touching Alexa: **Developer tools → States →
`switch.white_noise`** exists; toggling it from HA starts/stops the noise
in the room, and its state follows within a minute.

## Part 2 — expose it to Alexa via HA Cloud (~10 min)

1. HA: **Settings → Voice assistants** (or **Home Assistant Cloud**) →
   **Alexa**.
2. **Expose entities manually** — do NOT expose everything; the house has
   hundreds of entities and Alexa should see exactly one for now. Expose
   only `switch.white_noise`.
3. In the **Alexa app** on a phone: Skills → search "Home Assistant" →
   enable, sign in with the Nabu Casa account.
4. Alexa app → Devices → discover (or "Alexa, discover devices"). A switch
   named **White Noise** appears.

## Part 3 — verify

- "Alexa, turn on white noise" → the Yamaha wakes and the stream plays,
  with the card's current sound/volume.
- "Alexa, turn off white noise" → receiver to standby.
- The app's White noise card and `switch.white_noise` agree with reality
  (listener count is the shared ground truth).

## How this composes with Sleep sense (no config needed)

Alexa drives the same stream and the same speakers, so the sleep watcher
needs no knowledge of it:

- Alexa-on during bedtime conditions → the watcher **adopts** the session;
  the 08:00 auto-off still applies.
- "Alexa, turn off white noise" mid-night → the watcher sees the listeners
  drop with the room still dark, reads a deliberate off, and **latches for
  the night** instead of restarting it 30s later.

## Notes

- The switch's `turn_on` duplicates the play call the Railway app makes
  (deliberately: HA-local, so voice works even if the Railway app is
  down). If `WHITENOISE_MEDIA_ENTITY` or the stream URL ever changes,
  update both places — Railway variables and this switch.
- Optional later: expose sibling scenes/scripts for "brown noise" /
  "pink noise" that call `rest_command.whitenoise_set_noise` first and
  then join the stream, for voice-switching the sound itself.

# Eight Sleep setup — on-site runbook

Goal: bring the Eight Sleep Pod into Home Assistant on the HA Green, then
switch on the app-side support that is already built and deployed:

- A **bed card** per side in the Master Bedroom (presence, warmth on Eight
  Sleep's −100…+100 scale, side on/off).
- **Automations**: "Bed on at warmth +30 at 21:30" from the normal builder.
- **Away mode** flips Eight Sleep's own away mode on both sides.
- **Sleep sense** upgrades: arming requires someone actually in bed, and
  "everyone left the bed" becomes a wake signal.

Everything activates purely by setting environment variables — no deploy of
new code is needed after this runbook, only a restart with the new envs.

## Why a community integration

Home Assistant's official Eight Sleep integration was removed after Eight
Sleep locked down their old API. The working path is the HACS custom
integration **lukas-clarke/eight_sleep** (OAuth2 against their current
API). It is cloud-only — there is no local control path for the Pod — so
expect it to fail when the internet or Eight Sleep's cloud is down, and
know it can break if Eight Sleep changes their API again.

## Stage 1 — HACS on the HA Green (skip if already installed)

1. Home Assistant → Settings → Add-ons → Add-on store → install
   "Get HACS" (or follow https://hacs.xyz/docs/use/download/download/).
2. Restart Home Assistant, then Settings → Devices & Services →
   Add Integration → HACS, and authorize it with a GitHub account.

## Stage 2 — the eight_sleep integration

1. HACS → (⋮ menu) → Custom repositories → add
   `https://github.com/lukas-clarke/eight_sleep` as type "Integration".
2. HACS → search "Eight Sleep" → Download.
3. Restart Home Assistant.
4. **In the Eight Sleep app: make sure NEITHER side is in away mode** —
   setup fails otherwise (integration README).
5. Settings → Devices & Services → Add Integration → "Eight Sleep" →
   sign in with the household Eight Sleep account credentials
   (client_id/client_secret can be left blank).

## Stage 3 — collect the entity and service names

In Developer Tools → States, filter for `eight` and note, per side:

- the **bed temperature entity** (the one the eight_sleep services
  target — on current versions it looks like
  `sensor.<name>_bed_temperature` or similar),
- the **bed presence entity** (`binary_sensor.<name>_bed_presence`).

In Developer Tools → Actions (Services), filter for `eight_sleep` and
confirm these services exist with these names:

- `eight_sleep.heat_set` (fields: target, sleep_stage)
- `eight_sleep.side_on` / `eight_sleep.side_off`
- `eight_sleep.away_mode_start` / `eight_sleep.away_mode_stop`

Sanity-check by calling `eight_sleep.heat_set` once from Developer Tools
against one side's temp entity (target 10, sleep_stage "current") and
confirming the Eight Sleep app reflects it.

> If any service name or field differs from the list above, STOP and
> report the actual names — they are constants in one place in the app
> (`web/src/lib/eightsleep.ts`) and need a one-line code fix first.

## Stage 4 — switch the app on

In the app deployment (Railway), set — sides you have, entities from
Stage 3:

```
EIGHTSLEEP_LEFT_TARGET_ENTITY=sensor.…_bed_temperature
EIGHTSLEEP_LEFT_PRESENCE_ENTITY=binary_sensor.…_bed_presence
EIGHTSLEEP_LEFT_LABEL=Daniel's side          # optional display name
EIGHTSLEEP_RIGHT_TARGET_ENTITY=…
EIGHTSLEEP_RIGHT_PRESENCE_ENTITY=…
EIGHTSLEEP_RIGHT_LABEL=…
```

Redeploy/restart the app. A side exists once its `*_TARGET_ENTITY` is set;
presence and label are optional (presence unlocks the Sleep sense
upgrades — set it if it exists).

## Stage 5 — verify

1. Master Bedroom in the app shows a card per configured side; presence
   reads correctly (lie down / get up, allow a minute of cloud lag).
2. Card "Warm" button: the Eight Sleep app shows the side heating.
   Commands report as **"sent"**, not "confirmed" — the Pod's entities
   can't echo the result back; that's honest, not broken.
3. Automations → New automation → Master Bedroom → Single device… →
   a bed side → "On at warmth…" — create a test one-shot a few minutes
   out and watch it fire (Activity logs it).
4. Flip Away mode on → both sides show away in the Eight Sleep app →
   flip it back off. The flips are in Activity as `bed_away_on/off`.
5. Sleep sense card on the Automations screen now mentions
   "someone's in bed" among its conditions.

## Watch-outs

- **Cloud lag**: presence and temperature updates arrive on the
  integration's polling cadence — treat sub-minute lag as normal.
- **Subscription**: base temperature control works per side, but some
  intelligence (Autopilot) assumes Eight Sleep's subscription.
- **First night**: Sleep sense now requires presence to arm. If the
  presence sensors misbehave (never "on"), the noise will not start —
  the fix is removing the `EIGHTSLEEP_*_PRESENCE_ENTITY` envs (arming
  then falls back to lights + TV lift only).

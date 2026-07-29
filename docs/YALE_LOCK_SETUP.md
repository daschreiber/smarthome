# Yale front-door lock — on-site runbook

Goal: bring the Yale Linus L2 into Home Assistant on the HA Green via the
official **Yale Home** integration, then activate the app-side support that
is already built and deployed:

- A **Front door card** at the Entrance (Security section, top of the room).
  It shows honest state only — locked/unlocked/jammed comes from confirmed
  Home Assistant read-back, battery from the lock's own sensor.
- The **security tier** (IMPLEMENTATION_SPEC Phase F): press-and-hold to
  command, an explicit confirm on every command, unlocking re-verifies the
  account password server-side, guests see state but get no controls, and
  every lock command is written to the audit log flagged `security`.
- Locks are **excluded everywhere else by design**: no scenes, no
  automations, no assistant, no Away sweeps. The server refuses lock
  commands from those paths (`web/src/lib/execute.ts`), not just the UI.

No new code is needed after this runbook — the card goes live the moment a
`lock.*` row lands in the entity map.

## Hardware on site (identified 2026-07, confirmed by owner)

- Yale **Linus L2** retrofit cylinder lock, front door — Matter enabled.
- Yale **Smart Keypad** — a lock accessory; works through the lock, needs
  no integration of its own.
- Yale **Smart Video Doorbell** — doubles as the Yale Home bridge, so no
  Yale Connect Bridge purchase is needed.

All three live in the Yale Home ecosystem, not on the Control4 Zigbee mesh.

## Stage 1 — the Yale Home integration

1. In the Yale Home app, confirm the lock is paired with the doorbell as
   its bridge and that remote operation works from the app when off Wi-Fi
   (this proves the bridge path the integration will use).
2. Home Assistant → Settings → Devices & Services → Add Integration →
   search "Yale Home". Sign in with the household Yale Home account when
   the OAuth flow asks. (Cloud-push integration: day-to-day events arrive
   pushed; it needs internet and Yale's cloud to be up.)
3. The Yale account credentials are secrets: password manager, never this
   repository.

## Stage 2 — collect the entity names

In Developer Tools → States, filter for `yale`, `front` and `door`, and
note:

- the lock entity (expected `lock.front_door` — the friendly name decides,
  see Stage 4)
- the lock's battery sensor
- the door-open/closed binary sensor, if the L2 reports one
- the doorbell's camera and doorbell/motion event entities (not consumed by
  the app yet — record them for later)

## Stage 3 — one careful control test

With someone physically at the front door:

1. Lock and unlock once from the Home Assistant UI; watch the bolt.
2. Check the state in HA follows within a few seconds in both directions.
3. Check the keypad still operates the lock afterwards.

## Stage 4 — re-export the inventory and rebuild the map

From the repo root, with the export env pointing at the Green (see
`tools/export_inventory.py`):

```bash
python3 tools/export_inventory.py
python3 tools/build_entity_map.py
```

`build_entity_map.py` already classifies `lock.*` entities as
`door_lock` → group **Security**, and infers room **Entrance** from a
"Front Door" friendly name. Check `data/MAPPING_REVIEW.md` shows exactly
that, then commit the regenerated `data/entity_map.json` (and the `web/data`
mirror) and redeploy. If the friendly name doesn't contain "front door",
either rename the entity in HA (preferred) or add a `ROOM_OVERRIDES` entry.

Note: the committed map currently predates some rule changes in the build
script, so the regenerated file will also pick up small unrelated
corrections (e.g. the terrace heater's category). Review the diff rather
than assuming every change is lock-related.

## Stage 5 — verify the app behavior

1. The Front door card appears at the Entrance (and in the Security group),
   replacing the "waiting for the Yale Home integration" placeholder.
2. Hold-to-lock works and the card reports **confirmed** locked state.
3. Unlock demands the account password; a wrong password refuses AND shows
   up in the activity log as a failed `security` event.
4. Sign in as a guest: the card shows state only, and a direct API call to
   the command route returns 403.
5. Confirm the lock is absent from the automations device picker and the
   assistant's vocabulary.

## Later (optional) — Matter over Thread for local control

The cloud path above is the low-effort first step. Matter is already
enabled on the L2 and both routes surface the same `lock` entity, so local
control can be added later without touching the app:

- Thread border router: the Apple TV 4K already on site provides Thread
  (docs/APPLE_HOME_SETUP.md) — no ZBT-1 dongle needed.
- HA's Matter server add-on, commissioned from the HA companion app on a
  phone near the lock (the Green has no Thread radio or Bluetooth).
- The Matter setup code stays in the owner's password manager, never here.

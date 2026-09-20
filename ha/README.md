# Home Assistant side

Files that live on the Green itself, kept here so they are reviewable and
survive a rebuild. Nothing in this directory is deployed automatically — each
piece is copied into `/config` or pasted into `configuration.yaml` by hand,
through the File editor add-on.

| File | Where it goes | What it is |
| --- | --- | --- |
| `c4_scan.py` | `/config/c4_scan.py` | Finds a device's current IP by MAC (UDP sweep + `/proc/net/arp`), with no add-ons, no root and no nmap. |
| `c4_repoint.py` | `/config/c4_repoint.py` | Rewrites the Control4 config entry's host in place, atomically, keeping credentials and every Stage 5 rename. Finds the address itself with `--mac`, or takes one on the command line. |
| `c4_recovery.yaml` | block in `configuration.yaml` | The `shell_command`s that drive the repoints, the watch sensors, the self-baselining IP-drift alerts, and the self-heal automations — for the Control4 Core 3 and, since 2026-09-03, the CoolMaster bridge. |
| `homekit_covers.yaml` | block in `configuration.yaml` | Deprecated 2026-07-26; see the file's own header. |
| `artframes_keypad.yaml` | block in `configuration.yaml` + one line in `secrets.yaml` | Since 2026-09-16: Night and Morning pressed on the wall keypad, or by Alexa, Siri / Apple Home or the HA dashboard, reach the app's picture-Frame follower. A `knx: event:` on the scene group address(es), a `rest_command` to the app, and one automation on both the KNX bus event and the service call. |

## Installing the Frames relay

Ten minutes, no restart. The app's Frame follower only sees presses made
in the app; the owner presses the wall, and the house also says it to
Alexa and Siri. This makes HA relay all of those.

1. **Capture the addresses.** HA → Settings → Devices & services → KNX →
   open the KNX panel → *Group monitor*. Press **Night** on the wall
   keypad: the new row's *Destination* is the group address, *Source* the
   keypad, *Payload* what it wrote. Press **Morning**; read the same. The
   header of `artframes_keypad.yaml` shows the two shapes this takes (two
   1-bit addresses, or one scene address with a scene number per button)
   and how to write each into the file.
2. **Mint the key.** `openssl rand -hex 32`. Put it on Railway as
   `HA_HOOK_KEY` (docs/DEPLOY_RAILWAY.md) and in `/config/secrets.yaml` as
   `smarthome_hook_key: "<the same string>"`. It is not `APP_KEY` and must
   not be: this key buys one Frame sweep and nothing else.
3. **Paste the block** from `artframes_keypad.yaml` at the end of
   `configuration.yaml` with the addresses, values and the app's host filled
   in. If the file already has a `knx:` or `rest_command:` key, merge the
   items into it rather than adding a second key. The Alexa / Siri /
   dashboard road needs nothing captured; optionally put the smarthome-app
   HA user's id (Settings → People → Users) in `app_user_id` so HA does not
   relay the app's own presses back — left blank, the app answers those
   "duplicate", which is harmless and shows as one Activity line.
4. **Developer tools → YAML → Check configuration**, then reload **KNX**,
   **REST commands** and **Automations** from the same page — all three:
   the new `rest_command` is not loaded by the other two reloads, and an
   automation calling an unknown service fails silently in its trace. (A
   restart does all three at once, if one is due anyway.)
5. **Test from the wall.** Press Night. Within a few seconds the Frames go
   dark, and the app's Activity shows `system:artframes` /
   `frames_turn_off` with user `ha:1.1.x` (the keypad). Press Morning; the
   Frames come back as art. Then "Alexa, turn on night mode": the same,
   with user `ha:voice-or-ui`. If the app shows nothing, HA → Settings →
   Automations → the relay → *Traces* says whether the press arrived and
   what the app answered (`202 accepted`, `duplicate`, `401`, `503 HA_HOOK_KEY
   is not set`).

**The buttons by the front door** (2026-09-17) ride the same relay. Each
is one or two rows in the yaml's `buttons:` table — a toggle is two rows,
one per value it writes — with a `floor` (6: the Dining sets and the
Lounge TV follow "Lights 6"; 5: the Den TV follows "Lights 5"; none: Exit
takes all five) and `spare: false`, because a press on the way out should
not leave a set lit on the strength of a sensor that sticks. Capture them
the same way, add each different address under `knx: event:`, reload KNX
and Automations. The `light.knx_switch_all_house_exit` switch is in the
`switches:` table too, so an Exit by voice or from the app does the same.
**"Exit floor" on floor 5** (owner, 2026-09-18) is one more row of the same
shape — not a toggle, one value, floor 5, no sparing — so it takes the Den
TV with the floor's lights, as the whole-house Exit already does. Live test
that day: the button switched the Den lights off and left the TV on, so
it was not yet in the relay; its address goes in that row.

**Back to art after a wake** (owner, 2026-09-20: Day Mode brought the Lounge
TV up as a television). A Frame wakes into whatever it showed when it went
off, and SmartThings has no "show art" command. `frame_art.py` goes in
`/config`; the relay runs it after a Morning press that reaches floor 6, for
the Lounge TV and the three Dining sets (`shell_command.frame_art_*`), in
two passes at 20 s and about 45 s because a set still waking answers
`unreachable`. It asks the set's own Art API (port 8002) first and leaves
a set already in art alone, and it reads host and token from HA's Samsung TV
config entry, so the TV shows no second "Allow" prompt.
`shell_command.frame_art_lounge_check` only reports (`art` / `tv` /
`unreachable`) — the honest "is someone watching" signal the sticking
SmartThings sensor is not. After adding the `shell_command:` lines, reload
**Shell commands** as well. The Den TV cannot use this until HA's local
Samsung entry reaches it again.

One press is one sweep, whichever roads it takes. A press in the app is
not seen on the KNX road — it goes through Control4, whose telegrams reach
HA's tunnel only as confirmation frames that the KNX integration drops
(knx/README.md, "the blind spot"; here the feature). It *is* seen on the
service road, a second after the app has already swept, and the app drops
that repeat (10 s window, `frames_duplicate` in Activity).

## Installing the Control4 recovery bundle

One-time, ~5 minutes, no restart needed until the last step.

1. **File editor → `/config`**: create `c4_scan.py` and `c4_repoint.py`, pasting
   this directory's copies verbatim.
2. **`configuration.yaml`**: paste the whole `c4_recovery.yaml` block at the
   end. If the file already has a `template:` or `command_line:` key, merge the
   list items into the existing one rather than adding a second key.
3. **Delete the old drift automation.** The 2026-08-12 guardrail compared the
   scanned IP to a hardcoded `10.0.0.33`; the new `binary_sensor.c4_ip_drift`
   compares it to the address the config entry is actually dialling, so the old
   automation would now alert in parallel — and wrongly, after any repoint.
4. **Rename the push service** in the automation's second action to whichever
   `notify.mobile_app_*` this house uses.
5. **Developer tools → YAML → Check configuration**, then restart once. A
   reload is no longer enough: the block now defines `input_boolean` and
   `input_datetime` helpers, and those are only created at boot.
6. **Turn `input_boolean.c4_self_heal` on.** It defaults to off after a fresh
   install, and nothing below acts while it is off.

Do not add a template to the `shell_command` while merging. Home Assistant
runs a templated `shell_command` through a shell, which would hand every
service caller — including the non-admin app token — arbitrary command
execution in the HA container. The service is deliberately a fixed argv that
resolves the controller by MAC and takes no input
(docs/SECURITY_AND_OPERATIONS.md §7). To repoint at an address the scan
cannot see, run it directly instead:

```
python3 /config/c4_repoint.py 10.0.0.42
```

Verify: `sensor.c4_ip_watch` and `sensor.c4_configured_host` should read the
same address, and `binary_sensor.c4_ip_drift` should be `off`.

## The self-heal automations

Added 2026-08-23, after the third occurrence. They act unattended, so the
conditions matter more than the actions:

| | `c4_reload_after_boot` | `c4_auto_repoint` |
| --- | --- | --- |
| Fault | Cloud auth died while the fibre was still coming up | Core 3 took a new DHCP lease |
| Fires on | `homeassistant.start`, after a 3-minute settle | `binary_sensor.c4_ip_drift` on for 30 minutes |
| Does | Refreshes both address sensors, then reloads the config entry up to 3× at 8-minute spacing | Rewrites the entry's host via `shell_command.c4_repoint`, then restarts |
| Refuses unless | Control4 entities exist in the registry | 80%+ of them are `unavailable`, both addresses are real IPv4 and disagree, and no auto-repoint in the last 6 hours |
| Notifies | Only if all three reloads failed — plus the confirmation for a repoint that worked, on the way back up | `repointing now` before, then `auto-repoint failed` if the rewrite exits non-zero |

Three things to know about the shape of it:

- **The eight-minute spacing is not padding.** `apis.control4.com` rate-limits
  fast retries and then drops connections in a way that looks exactly like
  wrong credentials (2026-07-16). One attempt, then wait.
- **The repoint waits out the reload.** Its 30-minute hold is longer than the
  reload's 27-minute budget on purpose — overlapping them would restart the
  house in the middle of a recovery that was about to work by itself.
- **The six-hour brake survives the restart it causes.** Without it, a
  controller that answers ARP at an address it cannot actually be reached on
  would rewrite-and-reboot forever. `input_datetime.c4_last_auto_repoint` is
  stamped *before* the rewrite, so a repoint that dies half way still burns
  the window.
- **No message claims success before the rewrite has happened.** The repoint
  script ends at `homeassistant.restart` and never returns, and persistent
  notifications do not survive a restart — so a "repointed" message sent from
  there would be both premature and, on the path where it was true, erased
  seconds later. It sends `repointing now` instead, and the confirmation comes
  from `c4_reload_after_boot` on the way back up. Every message on this fault
  shares one push `tag`, so the phone always holds the latest one rather than
  a stack ending in the most optimistic.

### CoolMaster (2026-09-03)

The same drift fault for the other box whose integration dials a stored
address and cannot follow a move. Three more automations in
`automation manual_cm_selfheal:`, driven by `sensor.cm_ip_watch`,
`sensor.cm_configured_host` and `binary_sensor.cm_ip_drift`:

| | Does |
| --- | --- |
| `cm_ip_drift_alert` | Detects, 5-minute debounce. |
| `cm_auto_repoint` | Acts: same conditions as `c4_auto_repoint`, a 35-minute hold, and it stands down while `binary_sensor.c4_ip_drift` is on — so when both boxes move on one boot the Control4 repoint goes first and this one fires on the boot that follows. Never two restarts racing. |
| `cm_after_boot` | Refreshes both CoolMaster sensors three minutes into every boot, and if that boot was the repoint's own restart, reports the outcome. |

The two that act ride the kill switch; the alert, like Control4's, always
fires and says whether self-heal is on. Both repoints also re-evaluate when
the switch is turned back on, so a drift that began during maintenance is
picked up once the switch returns. The bridge is local, so there is no
cloud-auth reload to mirror; only the repoint. Installing it is a merge, not
a paste: two
`- sensor:` items into the existing `command_line:` list, one `- name:` into
the existing `template:` binary_sensor list, one `cm_repoint:` line under
`shell_command:`, one helper under `input_datetime:`, and the whole
`automation manual_cm_selfheal:` block appended.

`input_boolean.c4_self_heal` switches all of it off from the phone. Turn it off
before any deliberate maintenance that makes the house look like an outage —
pulling the Core 3's power, moving it between switch ports, or a KNX
commissioning session that takes the lights down.

`tools/c4_recover.py` is unchanged and still the deliberate, human-driven
path. An outage is one command from anywhere the Green is reachable:

```
export HA_URL=http://10.0.0.69:8123        # or the Nabu Casa URL
export HA_TOKEN=<admin long-lived token>
python3 tools/c4_recover.py diagnose
python3 tools/c4_recover.py recover --yes
```

The full story and the by-hand fallback: [docs/OUTAGE_RECOVERY.md](../docs/OUTAGE_RECOVERY.md).

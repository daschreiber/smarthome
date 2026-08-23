# Home Assistant side

Files that live on the Green itself, kept here so they are reviewable and
survive a rebuild. Nothing in this directory is deployed automatically — each
piece is copied into `/config` or pasted into `configuration.yaml` by hand,
through the File editor add-on.

| File | Where it goes | What it is |
| --- | --- | --- |
| `c4_scan.py` | `/config/c4_scan.py` | Finds a device's current IP by MAC (UDP sweep + `/proc/net/arp`), with no add-ons, no root and no nmap. |
| `c4_repoint.py` | `/config/c4_repoint.py` | Rewrites the Control4 config entry's host in place, atomically, keeping credentials and every Stage 5 rename. Finds the address itself with `--mac`, or takes one on the command line. |
| `c4_recovery.yaml` | block in `configuration.yaml` | The `shell_command` that drives the repoint, the two watch sensors, the self-baselining IP-drift alert, and the two self-heal automations. |
| `homekit_covers.yaml` | block in `configuration.yaml` | Deprecated 2026-07-26; see the file's own header. |

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

`input_boolean.c4_self_heal` switches both off from the phone. Turn it off
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

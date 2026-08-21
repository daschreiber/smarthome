# Home Assistant side

Files that live on the Green itself, kept here so they are reviewable and
survive a rebuild. Nothing in this directory is deployed automatically — each
piece is copied into `/config` or pasted into `configuration.yaml` by hand,
through the File editor add-on.

| File | Where it goes | What it is |
| --- | --- | --- |
| `c4_scan.py` | `/config/c4_scan.py` | Finds a device's current IP by MAC (UDP sweep + `/proc/net/arp`), with no add-ons, no root and no nmap. |
| `c4_repoint.py` | `/config/c4_repoint.py` | Rewrites the Control4 config entry's host in place, atomically, keeping credentials and every Stage 5 rename. |
| `c4_recovery.yaml` | block in `configuration.yaml` | The `shell_command` that drives the repoint, the two watch sensors, and the self-baselining IP-drift alert. |
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
5. **Developer tools → YAML → Check configuration**, then **Reload** template
   entities and command_line, or restart once.

Verify: `sensor.c4_ip_watch` and `sensor.c4_configured_host` should read the
same address, and `binary_sensor.c4_ip_drift` should be `off`.

From then on, an outage is one command from anywhere the Green is reachable:

```
export HA_URL=http://10.0.0.69:8123        # or the Nabu Casa URL
export HA_TOKEN=<admin long-lived token>
python3 tools/c4_recover.py diagnose
python3 tools/c4_recover.py recover --yes
```

The full story and the by-hand fallback: [docs/OUTAGE_RECOVERY.md](../docs/OUTAGE_RECOVERY.md).

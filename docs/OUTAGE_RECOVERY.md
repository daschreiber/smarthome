# Power-outage recovery: Control4 comes back last

The house has lost Control4 to a power cut twice — 2026-08-12 and 2026-08-21 —
with the same signature both times. This is the runbook for the third time.

> **Start here instead when the house is down:**
> [`OUTAGE_RECOVERY_RUNBOOK.md`](OUTAGE_RECOVERY_RUNBOOK.md) — self-contained,
> start to finish, including the browser-only route.
>
> Since 2026-08-21 the HA-side bundle **is installed** on the Green
> (`c4_scan.py`, `c4_repoint.py`, `shell_command.c4_repoint`, the two watch
> sensors and `binary_sensor.c4_ip_drift`), so the "Doing it by hand" section
> below is now a fallback for a rebuilt Green, not the normal path. The Core 3
> is currently at **`10.0.0.38`**.

## Recognising it

The app says a large number of devices are not responding, and the split is
diagnostic:

| Still working | Dead |
| --- | --- |
| A/C zones (CoolMaster bridge, `10.0.0.90`) | Every light (KNX via Control4) |
| Shades (native KNX tunnel) | Underfloor heating valves |
| Media players, sauna, bed | The per-floor A/C changeover relays → "mode not responding" |

Everything dead is Control4-proxied; everything alive reaches its hardware by
another road. **The Control4 system itself is fine** — the native Control4 app
and the wall panels work throughout. What broke is Home Assistant's link to
the Core 3.

If instead a handful of devices are out and the rest are fine, this is not
your outage: that is a device or a KNX channel, not the integration.

## Recovering it

```
export HA_URL=http://10.0.0.69:8123        # Nabu Casa URL when away
export HA_TOKEN=<long-lived token, ADMIN user>
python3 tools/c4_recover.py diagnose       # read-only
python3 tools/c4_recover.py recover --yes
```

The token must belong to an **admin** user. The `smarthome-app` token is
deliberately non-admin and cannot reload a config entry or restart HA.

`recover` walks the two faults in order, because the first one hides the
second:

1. **Reload the config entry.** Home Assistant boots faster than the fibre
   comes back, so the Control4 *cloud* auth call dies mid-request and the entry
   is left in `setup_error` with no retry (the same cloud-auth fragility first
   seen on 2026-07-16, but hard-failing instead of retrying). The internet is
   back by the time you look, so a single reload gets past it.

2. **Repoint the host, if the reload times out.** The reload's own error names
   the problem — `Timeout connecting to Control4 controller at 10.0.0.29` —
   because the Core 3 took a new DHCP lease while the power was out. The tool
   compares where the controller answers ARP (`sensor.c4_ip_watch`, MAC
   `00:0f:ff:9f:3b:44`) against the host in the config entry
   (`sensor.c4_configured_host`), rewrites the host, and restarts.

Recovery is proven when the Control4 integration is back at **179 devices /
178 entities** and a light toggles from the app.

`recover` refuses to act on a **partial** fault — most lights still working,
a handful down. Reloading the entry would interrupt every device that is fine
and a repoint restarts Home Assistant, neither of which is a proportionate
answer to one dead KNX channel. `diagnose` names the failing devices; fix
those, or pass `--force` if you are certain the integration is the problem.
A house-wide outage (80%+ of the Control4 lights down) needs no override.

### Never delete and re-add the integration

The config entry holds the controller host, the homeowner's Control4 account
credentials, and — through the entity registry keyed on it — every rename and
Area assignment from Stage 5 normalization. Re-adding it costs the Control4
password and 184 entities' worth of naming. Only the `host` field goes stale;
`ha/c4_repoint.py` rewrites exactly that field, atomically, after a backup.

### Do not retry Control4 cloud auth in a hurry

Rapid-fire setup attempts get rate-limited by
`apis.control4.com`, which then drops connections and looks exactly like a
credentials failure (2026-07-16). One attempt, then wait.

## Doing it by hand

When the HA-side bundle isn't installed, or the API route is unavailable:

1. **Find the controller.** Add the **Nmap Tracker** integration (UI-only
   setup, scan range `10.0.0.0/24`, ARP ping). It creates a `device_tracker`
   per host with a `mac` attribute; the one matching `00:0f:ff:9f:3b:44`
   reports the current IP. Remove the integration afterwards.
2. **Reload first.** Settings → Devices & Services → Control4 → ⋮ → Reload. If
   the entities come back, you are done.
3. **Repoint.** With the HA-side bundle installed this is just
   `python3 /config/c4_repoint.py 10.0.0.42` followed by one restart. Without
   it: File editor add-on → `/config/configuration.yaml`, add a throwaway
   `command_line` sensor whose command rewrites the entry's host
   (`tools/c4_recover.py repoint` prints this one-liner with the addresses
   filled in), then **restart Home Assistant twice** — the first boot runs the
   rewrite, and config entries are only read from `.storage` at boot, so the
   second is what picks the corrected file up. Delete the sensor afterwards.

The add-on *store* 404s on this install, so Terminal & SSH cannot be installed
to shortcut any of this; File editor is what there is.

## Preventing it

- [ ] **DHCP reservation for the Core 3** at the router (`10.0.0.138`,
  dealer-managed, reachable only on-site). This is the fix that ends the
  failure mode; everything above is a workaround for not having it. Open since
  2026-07-16, and the reason 2026-08-21 happened at all.
- [x] **Drift detector** (`ha/c4_recovery.yaml`): compares the ARP-observed
  address to the configured host and alerts when they disagree. It detects
  only — a human applies the repoint — and it re-baselines itself after one,
  unlike the 2026-08-12 version with `10.0.0.33` hardcoded in the automation.

## What the app does while it is down

Deliberate behaviour, not gaps — an integration outage must never read as a
quiet house (`web/src/lib/reachability.ts`, `web/src/lib/systemSummary.ts`):

- Rooms and system tiles say **"not responding"**, never "all off".
- A banner names the count house-wide once three or more devices are down.
- Commands to unreachable devices are **refused**, including the per-floor A/C
  changeover — with the relay dead the 13-second sequence would still cycle a
  CoolMaster unit, flip nothing, and log success.
- Scenes, automations and the scheduler still command blind on purpose: they
  re-assert when entities come back, and a scene fired during a blip should
  land on whatever is reachable.

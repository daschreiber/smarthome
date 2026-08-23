# Control4 outage recovery — the one-shot runbook

Everything needed to repair Home Assistant's link to the Control4 Core 3 after
a power cut, start to finish, without reading anything else. Written after the
third occurrence (2026-08-21 evening), when the repair had to be driven from a
browser because no usable terminal was available.

Background and design rationale: `docs/OUTAGE_RECOVERY.md`.
History: `docs/COMMISSIONING_LOG.md` (2026-08-12, 2026-08-21).

---

## 0. House facts (memorise or copy)

| Thing | Value |
| --- | --- |
| Home Assistant | `http://10.0.0.69:8123` (LAN) / Nabu Casa URL when away |
| Core 3 MAC — **never changes** | `00:0f:ff:9f:3b:44` |
| Core 3 address **now** | `10.0.0.38` (was `10.0.0.33`, before that `10.0.0.29`) |
| Router (dealer-managed, on-site only) | `10.0.0.138` |
| Config entry title | `control4_core3_000FFF9F3B44` |
| Healthy integration | **179 devices / 178 entities** |
| Control4-proxied entities | 168 lights, 31 climate (UFH zones + changeover), covers ride native KNX |
| Push service on this house | `notify.mobile_app_daniel_iphone_17` |

Installed on the Green as of 2026-08-21 (the "HA-side bundle"):

| File / entity | Purpose |
| --- | --- |
| `/config/c4_scan.py` | Finds an IP by MAC: UDP sweep + `/proc/net/arp`. No root, no nmap. |
| `/config/c4_repoint.py` | Rewrites the config entry's `host`, atomically, after a backup. |
| `shell_command.c4_repoint` | Fixed argv, `--mac 00:0f:ff:9f:3b:44`. Takes **no** caller input. |
| `sensor.c4_ip_watch` | Where the controller answers ARP. `scan_interval: 43200`. |
| `sensor.c4_configured_host` | The host inside `.storage/core.config_entries`. |
| `binary_sensor.c4_ip_drift` | On when both read real addresses and they disagree. |
| `automation.control4_ip_drift_alert` | Persistent notification + phone push, 5-minute debounce. |

Added 2026-08-23 — the house now attempts both repairs itself:

| File / entity | Purpose |
| --- | --- |
| `automation.control4_self_heal_reload_after_a_boot_before_internet_failure` | Fault 1. On start: refresh both address sensors, then reload the entry up to 3× at 8-minute spacing. |
| `automation.control4_self_heal_repoint_after_a_dhcp_lease_change` | Fault 2. Drift on for 30 min + 80%+ down + two real disagreeing addresses → repoint and restart, once per 6 hours. |
| `input_boolean.c4_self_heal` | Kill switch for both. Turn it **off** before deliberate maintenance that makes the house look like an outage. |
| `input_datetime.c4_last_auto_repoint` | The six-hour brake, stamped before the rewrite so it survives the restart. |

Because the bundle is installed, **§3 is now the whole repair**. §5 exists only
for the case where someone has rebuilt the Green.

**Before you start: check whether it already fixed itself.** The self-heal
takes up to 27 minutes for fault 1 and up to about an hour for fault 2. Look
for a `Control4 repointed automatically` or `Control4 did not come back`
notification first — the first means you are done except for recording the new
address in the commissioning log, and the second means the automations have
already spent their attempts and you are starting from a known place.

---

## 1. Is this the outage?

Yes if the split looks like this:

| Dead | Still working |
| --- | --- |
| Every light (KNX via Control4) | Native KNX shades |
| Underfloor-heating valves | CoolMaster A/C bridge (`10.0.0.90`) |
| The two KNX heat/cool changeover relays | Media players, sauna, bed |

Everything dead is Control4-proxied. Everything alive reaches its hardware by
another road. **The Control4 system itself is fine** — the native app and the
wall panels work throughout. What is broken is Home Assistant's link to it.

**Not this outage** if a handful of devices are down and the rest are fine.
That is a device or a KNX channel. `recover` refuses it on purpose, and so
should you: reloading the entry interrupts everything that still works, and a
repoint restarts the whole house. House-wide means **80%+ of the Control4
lights down**.

**Collateral that is not this fault.** A bad boot takes other integrations with
it. On 2026-08-21 the same boot left 28 Alexa entities and 6 Cast players
unavailable, and Eight Sleep in `setup_error`. None of that is Control4 and
none of it is fixed by this runbook. Check it separately, afterwards.

---

## 2. The two faults, and why order matters

1. **Boot-before-internet.** Home Assistant comes back before the fibre does.
   The Control4 **cloud** auth call dies mid-request and the entry is left in
   `setup_error` with no retry. The traceback ends in
   `pyControl4/account.py … _send_account_auth_request` → aiohttp
   `_resolve_host` → `CancelledError` → `TimeoutError` from
   `asyncio.timeout(10)`. One occurrence, never retried. A **reload** clears it.

2. **An IP change hiding behind it.** Once auth succeeds, setup gets as far as
   the controller and reports
   `Failed setup, will retry: Timeout connecting to Control4 controller at <old ip>`.
   The Core 3 took a new DHCP lease while the power was out. The entry's stored
   `host` has to be repointed.

Fault 1 masks fault 2. You cannot see the drift until the reload gets past
auth — which is why the reload always comes first, and why the tool does it
in that order.

---

## 3. The repair

### 3a. If you have a shell that can reach the house

```
cd <smarthome repo>
export HA_URL=http://10.0.0.69:8123        # or the Nabu Casa URL
export HA_TOKEN=<long-lived token, ADMIN user>
python3 tools/c4_recover.py diagnose       # read-only, always start here
python3 tools/c4_recover.py recover --yes
```

The token must be **admin**. The `smarthome-app` token is deliberately
non-admin and cannot reload a config entry or restart HA. Revoke the token
afterwards if it was pasted anywhere it should not live.

With the bundle installed, `recover` now does the whole thing itself: reload,
then repoint via `shell_command.c4_repoint`, then restart, then verify. Go to §4.

### 3b. If you only have a browser (the 2026-08-21 route)

This works because Chrome on a machine in the house can reach the LAN even
when nothing else can. Everything below runs in the Home Assistant tab.

**Log in first.** An agent cannot type a password or a token — that is a hard
boundary, not a limitation. A human logs in; the rest can be driven.

**Get a handle on the authenticated frontend.** In the HA tab:

```js
const hass = document.querySelector('home-assistant').hass;
```

`hass.callService`, `hass.callWS` and `hass.callApi` now run as the logged-in
admin. No token is needed and none is ever read.

**Diagnose (read-only).**

```js
const st = hass.states;
const lights = Object.keys(st).filter(e => e.startsWith('light.'));
const down = lights.filter(e => st[e].state === 'unavailable').length;
const c4 = (await hass.callWS({type:'config_entries/get', domain:'control4'}))[0];
`${down}/${lights.length} lights down | entry=${c4.state} | ` +
`observed=${st['sensor.c4_ip_watch']?.state} configured=${st['sensor.c4_configured_host']?.state}`;
```

Verdict, same rule as the tool: `down/total >= 0.8` is house-wide, below that
is partial and you stop. `observed !== configured` and both real is a drift.

**Reload the entry — once.** Settings → Devices & Services → Control4 → ⋮ →
Reload, or:

```js
await hass.callService('homeassistant','reload_config_entry',{entry_id:c4.entry_id});
```

Wait, then re-read. If the lights come back you are done. If the entry now
says `Timeout connecting to Control4 controller at <ip>`, that is fault 2.

**Repoint and restart.**

```js
await hass.callService('shell_command','c4_repoint',{},undefined,false,true);
// -> {"response":{"stdout":"00:0f:ff:9f:3b:44 answers at 10.0.0.38\n
//     repointed control4: 10.0.0.33 -> 10.0.0.38 (backup …) — restart HA now","returncode":0}}
await hass.callService('homeassistant','restart',{});
```

Restart **immediately** after the repoint. HA holds config entries in memory
and rewrites `.storage` on its own schedule; if it saves between the write and
the restart, the edit is gone. That is why the 2026-08-12 manual fix needed two
boots. Wait ~90 seconds, then verify (§4).

---

## 4. Verification — all of it

```js
const hass = document.querySelector('home-assistant').hass, st = hass.states;
const c4 = (await hass.callWS({type:'config_entries/get', domain:'control4'}))[0];
const devs = (await hass.callWS({type:'config/device_registry/list'}))
  .filter(d => (d.config_entries||[]).includes(c4.entry_id)).length;
const ents = (await hass.callWS({type:'config/entity_registry/list'}))
  .filter(e => e.config_entry_id === c4.entry_id).length;
const dom = d => { const e = Object.keys(st).filter(x => x.startsWith(d+'.'));
  return e.filter(x => st[x].state === 'unavailable').length + '/' + e.length; };
`entry=${c4.state} devices=${devs} entities=${ents} ` +
`light=${dom('light')} climate=${dom('climate')} cover=${dom('cover')} ` +
`observed=${st['sensor.c4_ip_watch'].state} configured=${st['sensor.c4_configured_host'].state} ` +
`drift=${st['binary_sensor.c4_ip_drift'].state}`;
```

Pass looks like: `entry=loaded devices=179 entities=178 light=0/168
climate=0/31 cover=0/48`, both addresses equal, `drift=off`.

Also confirm exactly **one** drift automation exists — if
`automation.control4_ip_drift_alert` appears twice, or an old `c4watch` block
survives in `configuration.yaml`, the house alerts twice.

**The only proof that counts is a physical light.** A command round-trip
(`light.turn_on` → state `on` → restore) proves HA reaches the director, which
is strong but not the same as a bulb changing. Ask a human in the house to flip
one.

---

## 5. If the bundle is missing (rebuilt Green, or you are on an older branch)

Source of truth: `ha/c4_scan.py`, `ha/c4_repoint.py`, `ha/c4_recovery.yaml`,
install notes in `ha/README.md`.

1. Write `c4_scan.py` and `c4_repoint.py` into `/config` **byte-for-byte**.
   Do not retype them. `c4_repoint.py` edits `core.config_entries`; a
   transcription slip there is a house that will not boot.
2. Merge `c4_recovery.yaml` into `configuration.yaml`. This file already has
   `template:` and `command_line:` keys — **merge into them**, never add a
   second key. Add `shell_command:` fresh.
3. **Do not put a template in the `shell_command`.** HA renders service data
   into a `shell_command` and runs the result through a shell, so
   `{{ ip }}` is arbitrary command execution in the HA container, reachable by
   anything that can call a service — including the non-admin `smarthome-app`
   token in an internet-facing app. The service is a fixed argv on purpose
   (`SECURITY_AND_OPERATIONS.md` §7). To repoint somewhere the scan cannot see,
   run it by hand: `python3 /config/c4_repoint.py 10.0.0.42`.
4. Rename `notify.mobile_app_iphone` to the service this house actually has
   (`notify.mobile_app_daniel_iphone_17`; check `hass.services.notify`).
5. Delete any older drift automation. On 2026-08-21 it was **not** in the UI —
   it was `automation c4watch:` inside `configuration.yaml`, comparing against
   a hardcoded `10.0.0.33`.
6. Check configuration, then restart:
   ```js
   await hass.callApi('POST','config/core/check_config');   // {"result":"valid"}
   await hass.callService('homeassistant','restart',{});
   ```

### Reading and writing `/config` from the browser

The File editor add-on's own API, reachable from the authenticated page. The
add-on lives in a same-origin iframe nested in shadow DOM:

```js
function deep(root, acc){ (root.querySelectorAll ? root.querySelectorAll('*') : []).forEach(el => {
  if (el.tagName === 'IFRAME') acc.push(el); if (el.shadowRoot) deep(el.shadowRoot, acc); }); return acc; }
const ifr = deep(document, [])[0];        // on /core_configurator
const w = ifr.contentWindow, base = ifr.src;
```

| Operation | Call |
| --- | --- |
| Read | `GET  base + 'api/file?filename=configuration.yaml'` |
| Write | `POST base + 'api/save'`, urlencoded `filename=…&text=…` |
| Delete | `POST base + 'api/delete'`, urlencoded `path=…` |

Paths are **relative to `/config`**. An absolute `/config/…` returns
"Access denied" on read and "No such file" on delete. Multipart bodies are
rejected — use `application/x-www-form-urlencoded`.

**Back up before writing**, and verify every write by reading it back and
comparing the exact string. `crypto.subtle` is unavailable (the page is plain
HTTP), so string equality plus a byte-length check is the integrity proof:

```js
const enc = s => new TextEncoder().encode(s).length;
// after saving: readBack === textWritten && enc(readBack) === expectedBytes
```

To move a file from a repo clone onto the Green with no shell in between:
base64 it on the machine that has it, decode in the browser, save, then read
back and compare. Verify the byte count against `wc -c` on the source.

### Finding the Core 3 without `c4_scan.py`

Add the **Nmap Tracker** integration (UI-only, hosts `10.0.0.0/24`, defaults
otherwise — its default `-PR` is an ARP ping, which is what you want). Then:

```js
Object.values(hass.states).filter(s => s.entity_id.startsWith('device_tracker.') &&
  (s.attributes.mac||'').toUpperCase().includes('3B:44'))
  .map(s => `${s.entity_id} ip=${s.attributes.ip} ${s.state}`);
```

It names the device for you: `device_tracker.control4_9f_3b_44`. **Remove the
integration afterwards** — `hass.callApi('DELETE','config/config_entries/entry/'+id)`.
On this HA build the `config_entries/remove` websocket command returns
"Unknown command"; the REST call works.

---

## 6. Rules — these matter more than finishing fast

- **Never delete and re-add the Control4 integration.** The entry holds the
  homeowner's Control4 password and, through the entity registry keyed on it,
  all 184 Stage 5 renames and Area assignments. Only `host` goes stale, and
  `c4_repoint.py` rewrites exactly that field, atomically, after a timestamped
  backup, refusing any store shape it does not recognise.
- **Never retry Control4 cloud auth in a hurry.** `apis.control4.com`
  rate-limits and then drops connections in a way that looks exactly like wrong
  credentials (2026-07-16). One reload, then wait. A third reload means stop
  and report.
- **If the tool refuses, believe it.** "This is a partial fault", "this is not
  an IP drift", "no Control4 config entry found" — each means the problem is
  not the one this runbook fixes. Do not reach for `--force`.
- **Never hand-edit `/config/.storage/core.config_entries`.** Use
  `c4_repoint.py`. A malformed file there is a house that will not boot.
- **Never print or store the access token**, and never write it into the repo.
- Restarting Home Assistant is expected and fine. It takes about 90 seconds.

---

## 7. Traps that cost time — read before you start

- **`sensor.c4_ip_watch` can be empty and still be "working".** On 2026-08-21
  it ran once at 04:51 while the network was still coming up, found nothing,
  and — on the old `scan_interval: 86400` — would not have run again for 24
  hours. The tool then says "Cannot find where the Core 3 is" and stops. It is
  now 43200, but the trap is structural: after a bad boot, force a refresh
  rather than trusting the reading —
  `hass.callService('homeassistant','update_entity',{entity_id:'sensor.c4_ip_watch'})`.
- **A macOS terminal cannot be driven by an agent.** Computer-use grants
  Terminal in *click-only* mode: visible and clickable, but no typing or
  pasting. Plan for the browser route (§3b), not the shell route.
- **The Cowork device shell is sandboxed away from the LAN and from GitHub.**
  `10.0.0.69` and `10.0.0.138` both return an instant synthetic `403`, and
  `git fetch` fails with `403 from proxy after CONNECT`. It can read the repo
  clone on disk and nothing more. If the clone is stale, a human has to run
  `git fetch origin && git checkout <branch>`.
- **`javascript_tool` is refused on any page carrying cookies**, GitHub
  included, so repo files cannot be scraped from a blob or raw page that way.
  Plain-text extraction of those pages **silently strips indentation** — fine
  for reading, fatal for Python. Get the bytes off disk instead.
- **The add-on store 404s on this install.** Terminal & SSH cannot be added.
  File editor is what there is.
- **Nothing answers on `10.0.0.138:80`**, so the DHCP lease table is not
  readable from a browser either.
- **The old drift automation was YAML, not UI.** Looking in
  Settings → Automations for something to delete will find nothing.

---

## 8. Address history

| Date | Core 3 | How it was found | Fix |
| --- | --- | --- | --- |
| 2026-07-16 | `10.0.0.29` | — | reservation follow-up opened |
| 2026-08-12 | `10.0.0.33` | Nmap Tracker | throwaway `command_line` sensor, two restarts |
| 2026-08-21 | `10.0.0.38` | Nmap Tracker, then `c4_scan.py` confirmed it | `shell_command.c4_repoint`, one restart |

---

## 9. The fix that ends this

- [ ] **DHCP reservation for `00:0f:ff:9f:3b:44`** on the router at
  `10.0.0.138`, and one for the Green at `10.0.0.69`, and owner-level admin
  access to that router. Dealer-managed, reachable only on-site. Open since
  2026-07-16, and the direct cause of both 2026-08-12 and 2026-08-21. The
  request is written out ready to hand over, in Hebrew:
  [`DEALER_NETWORK_REQUEST_HE.md`](DEALER_NETWORK_REQUEST_HE.md).
- [ ] **UPS on the comms cabinet** (ONT, router, switch, Green). Ends fault 1
  for any cut shorter than the runtime, and it is the only fix that also
  covers the collateral — Alexa, Cast and Eight Sleep all broke on the same
  2026-08-21 boot and none of them are in this runbook.

Everything in this document is a workaround for not having those. It is a
well-instrumented workaround now, and since 2026-08-23 an automatic one — but
the drift will keep happening on every power cut until the lease is pinned,
and self-heal that runs on every outage is a fire alarm that keeps going off,
not a building that stopped catching fire.

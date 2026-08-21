#!/usr/bin/env python3
"""Control4 outage recovery — diagnose and repair the Home Assistant link.

The house has now lost Control4 to a power cut twice (2026-08-12, 2026-08-21)
with the same shape both times: every Control4-backed entity goes
`unavailable` — all the lights, the underfloor-heating valves, the KNX
changeover relays — while the CoolMaster A/C bridge, the native KNX covers
and the media players keep working, because they do not go through the Core 3.
Two faults stack up (docs/OUTAGE_RECOVERY.md tells the longer story):

  1. Boot-before-internet. Home Assistant comes back before the fibre does,
     the Control4 cloud auth call dies mid-request, and the config entry is
     left in `setup_error` with no retry. A reload fixes it.
  2. An IP change hiding behind it. The Core 3 takes a new DHCP lease during
     the outage, so the reload then fails with "Timeout connecting to
     Control4 controller at <old ip>". The entry's host has to be repointed.

This tool walks that decision tree over the Home Assistant HTTP API. It reads
first, changes nothing without `--yes`, and never deletes the config entry:
the entry holds the Control4 account credentials AND every Stage 5 rename and
Area assignment, so delete-and-re-add is the one move that must not happen.

    export HA_URL=http://10.0.0.69:8123        # or the Nabu Casa URL
    export HA_TOKEN=<long-lived token, ADMIN user — not smarthome-app>
    python3 tools/c4_recover.py diagnose       # read-only, always start here
    python3 tools/c4_recover.py recover --yes  # reload, repoint if needed

The `repoint` step needs the one-time HA-side bundle installed (ha/README.md:
c4_scan.py, c4_repoint.py and the c4_recovery.yaml block). Without it the tool
still diagnoses the fault and prints the manual File-editor procedure with the
addresses filled in.
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

# The Core 3's MAC never changes; only its DHCP lease does. This is the
# anchor every lookup hangs off (Fing, 2026-07-16; unchanged 2026-08-12).
CORE3_MAC = "00:0f:ff:9f:3b:44"
DOMAIN = "control4"

IP_SENSOR = "sensor.c4_ip_watch"           # ARP-observed IP of CORE3_MAC
HOST_SENSOR = "sensor.c4_configured_host"  # host inside the config entry
REPOINT_SERVICE = ("shell_command", "c4_repoint")

MAP_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                        "data", "entity_map.json")
IPV4 = re.compile(r"^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$")
# "Timeout connecting to Control4 controller at 10.0.0.33" — the integration
# names the stale host in its own setup error, which is the fallback when the
# HOST_SENSOR half of the guardrail isn't installed yet.
LOG_HOST = re.compile(r"Control4 controller at (\d+\.\d+\.\d+\.\d+)")


class HaError(RuntimeError):
    pass


def valid_ip(value):
    m = IPV4.match(value or "")
    return bool(m) and all(0 <= int(g) <= 255 for g in m.groups())


class Ha:
    """Thin Home Assistant REST client (stdlib only, same shape as
    tools/export_inventory.py)."""

    def __init__(self, base, token, timeout=30):
        self.base = base.rstrip("/")
        self.token = token
        self.timeout = timeout

    def request(self, path, payload=None, timeout=None):
        req = urllib.request.Request(
            self.base + path,
            data=json.dumps(payload).encode() if payload is not None else None,
            headers={"Authorization": f"Bearer {self.token}",
                     "Content-Type": "application/json"},
            method="POST" if payload is not None else "GET",
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout or self.timeout) as resp:
                return resp.status, resp.read().decode()
        except urllib.error.HTTPError as exc:
            body = exc.read().decode(errors="replace")
            if exc.code in (401, 403):
                raise HaError(
                    f"HTTP {exc.code} on {path} — this needs a long-lived token of an "
                    "ADMIN user. The smarthome-app token is deliberately non-admin and "
                    "cannot reload config entries or restart Home Assistant."
                ) from exc
            return exc.code, body
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise HaError(f"cannot reach {self.base}: {exc}") from exc

    def json(self, path, payload=None, timeout=None):
        status, body = self.request(path, payload, timeout)
        if status >= 400:
            raise HaError(f"HTTP {status} on {path}: {body[:200]}")
        return json.loads(body) if body.strip() else None

    def alive(self, timeout=5):
        try:
            return self.request("/api/", timeout=timeout)[0] == 200
        except HaError:
            return False

    def states(self):
        return {s["entity_id"]: s for s in self.json("/api/states")}

    def state_of(self, entity_id):
        status, body = self.request(f"/api/states/{entity_id}")
        return json.loads(body)["state"] if status == 200 else None

    def error_log(self):
        status, body = self.request("/api/error_log")
        return body if status == 200 else ""

    def call(self, domain, service, data):
        status, body = self.request(f"/api/services/{domain}/{service}", data)
        if status >= 400:
            raise HaError(f"{domain}.{service} failed: HTTP {status} {body[:200]}")
        return body


def control4_light_entities():
    """The Control4-proxied KNX lights, from the generated entity map — the
    population whose availability IS the health of the integration. Covers are
    native KNX and climate rides the CoolMaster bridge, so neither belongs
    here: both stayed up through both outages."""
    try:
        with open(MAP_PATH) as f:
            rows = json.load(f)
    except OSError:
        return None
    rows = rows.get("devices", rows) if isinstance(rows, dict) else rows
    return [r["entity_id"] for r in rows if r.get("domain") == "light"]


# A device or a KNX channel can die on its own; the integration takes the
# whole house with it. The line between them is a ratio, not "every single
# one": the entity map can carry a row the integration no longer owns, and one
# stale row must not stop a real recovery.
OUTAGE_RATIO = 0.8


def outage_verdict(down, total):
    """healthy | house-wide | partial | unknown — the one place that decides."""
    if not total:
        return "unknown"
    if down == 0:
        return "healthy"
    return "house-wide" if down / total >= OUTAGE_RATIO else "partial"


def health(ha):
    """How much of Control4 is answering, as a (down, total) count."""
    states = ha.states()
    ids = control4_light_entities()
    if not ids:  # no entity map to hand — fall back to every light HA knows
        ids = [e for e in states if e.startswith("light.")]
    down = sum(1 for e in ids
               if e not in states or states[e]["state"] == "unavailable")
    return down, len(ids), states


def find_entry_id(ha):
    """The Control4 config entry id, by whichever route this HA build offers.

    The REST config view and the `config_entry_id` template function have both
    moved around between releases, so try both and let the caller pass
    --entry-id if a future version drops them both."""
    status, body = ha.request("/api/config/config_entries/entry")
    if status == 200:
        try:
            for entry in json.loads(body):
                if entry.get("domain") == DOMAIN:
                    return entry.get("entry_id"), entry.get("state")
        except (ValueError, TypeError):
            pass
    ids = control4_light_entities() or []
    for entity_id in ids[:5]:  # any Control4 entity resolves to the same entry
        status, body = ha.request(
            "/api/template", {"template": "{{ config_entry_id('%s') }}" % entity_id})
        if status == 200 and body.strip() and body.strip() not in ("None", "null", ""):
            return body.strip(), None
    return None, None


def configured_host(ha, log=None):
    """The host Home Assistant is actually dialling — from the guardrail
    sensor if installed, otherwise from the integration's own setup error."""
    host = ha.state_of(HOST_SENSOR)
    if host and valid_ip(host):
        return host, HOST_SENSOR
    found = LOG_HOST.findall(log if log is not None else ha.error_log())
    return (found[-1], "error log") if found else (None, None)


def observed_ip(ha):
    """Where the Core 3 actually answers ARP right now."""
    ip = ha.state_of(IP_SENSOR)
    return ip if ip and valid_ip(ip) else None


def diagnose(ha):
    down, total, _ = health(ha)
    entry_id, entry_state = find_entry_id(ha)
    log = ha.error_log()
    host, host_src = configured_host(ha, log)
    ip = observed_ip(ha)

    print(f"Control4 lights unavailable : {down}/{total}")
    print(f"config entry               : {entry_id or 'NOT FOUND'}"
          f"{f' ({entry_state})' if entry_state else ''}")
    print(f"configured host            : {host or 'unknown'}"
          f"{f'  [{host_src}]' if host else ''}")
    print(f"controller answering ARP at: {ip or f'unknown ({IP_SENSOR} not installed?)'}")

    c4_errors = [ln for ln in log.splitlines()
                 if "control4" in ln.lower() or "pyControl4" in ln][-4:]
    if c4_errors:
        print("recent Control4 log lines  :")
        for line in c4_errors:
            print(f"  {line[:160]}")

    verdict = outage_verdict(down, total)
    healthy = verdict == "healthy"
    drifted = bool(ip and host and ip != host)
    print()
    if healthy and drifted:
        print("VERDICT: Control4 is up, but the two address readings disagree")
        print(f"         (answering at {ip}, entry dialling {host}). Nothing is broken yet,")
        print("         so nothing is changed here — re-check before repointing a working house.")
    elif healthy:
        print("VERDICT: Control4 is up. Nothing to recover.")
    elif verdict == "partial":
        print(f"VERDICT: {down} of {total} lights are unavailable — a partial fault, not the")
        print("         whole integration. Look at those devices before touching the entry.")
        if drifted:
            print(f"         (the address readings also disagree: {host} vs {ip}.)")
    elif drifted:
        print(f"VERDICT: the Core 3 moved — {host} -> {ip}. The entry needs a repoint.")
        print(f"         run: c4_recover.py repoint --ip {ip} --yes")
    else:
        print("VERDICT: Control4 is down house-wide.")
        print("         run: c4_recover.py recover --yes   (reload first, repoint if that times out)")
    return {"down": down, "total": total, "entry_id": entry_id, "host": host,
            "ip": ip, "healthy": healthy, "drifted": drifted, "verdict": verdict}


def reload_entry(ha, entry_id, polls=9, every=5):
    """Reload the config entry — fault 1 on its own (auth died at boot,
    internet is back now) needs nothing more than this."""
    print(f"reloading config entry {entry_id} …")
    ha.call("homeassistant", "reload_config_entry", {"entry_id": entry_id})
    for _ in range(polls):
        time.sleep(every)
        down, total, _ = health(ha)
        print(f"  {total - down}/{total} lights back")
        if total and down == 0:
            return True
    return False


def wait_for_restart(ha, polls=30, every=10):
    """Home Assistant drops the API while it restarts; wait for it to answer
    again, then give the Control4 setup a moment to run."""
    print("  waiting for Home Assistant to come back …", end="", flush=True)
    time.sleep(15)
    for _ in range(polls):
        if ha.alive():
            print(" up")
            time.sleep(20)  # config entry setup runs a little after the API
            return True
        print(".", end="", flush=True)
        time.sleep(every)
    print(" TIMED OUT")
    return False


def manual_repoint(host, ip):
    """What to do by hand when the HA-side bundle isn't installed. This is the
    2026-08-12 procedure, with the addresses filled in."""
    print()
    print("The shell_command isn't installed on this Home Assistant, so the repoint")
    print("has to be done by hand — File editor add-on, Settings → Add-ons:")
    print()
    print("  1. Install the HA-side bundle once (ha/README.md in this repo) and re-run")
    print("     this tool, OR do it the 2026-08-12 way:")
    print("  2. Edit /config/configuration.yaml, add:")
    print()
    print("       command_line:")
    print("         - sensor:")
    print("             name: c4 repoint once")
    print("             command: >-")
    print("               python3 -c \"import json;p='/config/.storage/core.config_entries';"
          f"d=json.load(open(p));[e['data'].__setitem__('host','{ip or '<NEW-IP>'}') "
          f"for e in d['data']['entries'] if e['domain']=='{DOMAIN}'];"
          "json.dump(d,open(p+'.tmp','w'));import os;os.replace(p+'.tmp',p);print('ok')\"")
    print()
    print("  3. Restart Home Assistant TWICE (the first boot runs the rewrite; config")
    print("     entries are only read from .storage at boot, so the second picks it up).")
    print("  4. Delete the throwaway sensor, and check Settings → Devices & Services:")
    print("     Control4 should be back with 179 devices / 178 entities.")
    if host:
        print()
        print(f"  (host in the entry: {host}    controller now at: {ip or 'unknown'})")


def repoint(ha, ip, attempts=2):
    """Rewrite the entry's host and restart, up to twice.

    Twice because Home Assistant holds config entries in memory and rewrites
    .storage on its own schedule: if it saves between our write and the
    restart, our edit is gone. The 2026-08-12 recovery needed two boots for
    the same reason. The second attempt is the belt, not the norm."""
    before, _ = configured_host(ha)
    for attempt in range(1, attempts + 1):
        print(f"repointing the {DOMAIN} entry to {ip} (attempt {attempt}/{attempts}) …")
        try:
            # No service data: the shell_command is a fixed argv that resolves
            # the controller's address from ARP itself, precisely so nothing a
            # caller sends can reach a shell (ha/c4_recovery.yaml). `ip` here
            # is what we EXPECT it to land on, and what we verify below.
            out = ha.call(*REPOINT_SERVICE, {})
            print(f"  {out.strip()[:200] or 'shell_command accepted'}")
        except HaError as exc:
            if "not found" in str(exc).lower() or "400" in str(exc):
                print(f"  {REPOINT_SERVICE[0]}.{REPOINT_SERVICE[1]} is not defined here.")
                return False
            raise
        print("  restarting Home Assistant …")
        ha.call("homeassistant", "restart", {})
        if not wait_for_restart(ha):
            return False
        host, _ = configured_host(ha)
        down, total, _ = health(ha)
        print(f"  host now {host or 'unknown'}; {total - down}/{total} lights back")
        if total and down == 0:
            return True
        if host == ip:
            # The host took but the entities didn't come back: not a drift
            # problem any more — the controller itself isn't answering.
            print("  host is correct but Control4 still won't set up.")
            return False
        if host and host != before and valid_ip(host):
            # A third address: the service repoints to whatever owns the Core
            # 3's MAC, so this means the scan saw something else entirely.
            # Retrying would just write it again.
            print(f"  the entry landed on {host}, not the {ip} this run expected.")
            return False
        # Host unchanged — the write was accepted and then lost to one of
        # Home Assistant's own .storage saves. That is the case worth retrying.
    return False


def recover(ha, yes, force=False):
    state = diagnose(ha)
    print()
    if state["healthy"]:
        return 0
    # A reload drops every Control4 device for a few seconds and a repoint
    # restarts Home Assistant outright. Neither is a proportionate answer to
    # one dead channel, and diagnose has just said so — so don't do it behind
    # its own advice (Codex review, PR #101).
    if state["verdict"] == "partial" and not force:
        print(f"Refusing: {state['down']} of {state['total']} lights are down, which is a")
        print("partial fault. Reloading the entry would interrupt every device that is")
        print("still working, and a repoint would restart Home Assistant. Fix the named")
        print("devices, or pass --force if you are sure the integration is the problem.")
        return 2
    if not state["entry_id"]:
        print("Cannot continue: no Control4 config entry found. Pass --entry-id, or check")
        print("Settings → Devices & Services to confirm the integration is still added.")
        return 2
    if not yes:
        print("Dry run — nothing changed. Re-run with --yes to reload"
              + (" and repoint." if state["drifted"] else "."))
        return 0

    # Fault 1 first: it is the cheap one, and it is also what exposes fault 2
    # (the reload's own timeout is what names the stale host).
    if not state["drifted"]:
        if reload_entry(ha, state["entry_id"]):
            print("\nRecovered by reload. Control4 is back.")
            return 0
        print("  reload did not bring it back — re-reading the fault …")
        state = diagnose(ha)
        print()

    ip, host = state["ip"], state["host"]
    if not ip:
        print(f"Cannot find where the Core 3 is: {IP_SENSOR} is missing or unknown.")
        print("Install the HA-side bundle (ha/README.md) — it ARP-scans for "
              f"{CORE3_MAC} — or add the Nmap Tracker integration temporarily, scan range")
        print("10.0.0.0/24, and read the ip attribute of the tracker with that MAC.")
        return 2
    if host and ip == host:
        print(f"The entry already points at {host} and that is where the controller")
        print("answers ARP, so this is not an IP drift. Check that the Core 3 itself is")
        print("healthy (the native Control4 app), then reload again.")
        return 2

    if repoint(ha, ip):
        print(f"\nRecovered by repoint: {host or '?'} -> {ip}. Control4 is back.")
        print("Follow-up: give the Core 3 a DHCP reservation at the router (10.0.0.138)")
        print("so this cannot happen a third time.")
        return 0
    manual_repoint(host, ip)
    return 1


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("action", choices=["diagnose", "reload", "repoint", "recover"])
    ap.add_argument("--url", default=os.environ.get("HA_URL"))
    ap.add_argument("--token", default=os.environ.get("HA_TOKEN"))
    ap.add_argument("--entry-id", help="skip config-entry lookup")
    ap.add_argument("--ip", help="repoint: the address to expect the entry to land on "
                                 "(the service resolves it by MAC; to force a different "
                                 "one, run ha/c4_repoint.py on the Green directly)")
    ap.add_argument("--yes", action="store_true",
                    help="actually change things (without it, everything is a dry run)")
    ap.add_argument("--force", action="store_true",
                    help="recover: act even on a partial fault, where most devices "
                         "are still working")
    args = ap.parse_args()

    if not args.url or not args.token:
        sys.exit("Set HA_URL and HA_TOKEN (admin long-lived token), or pass --url/--token.")
    ha = Ha(args.url, args.token)
    if not ha.alive(timeout=15):
        sys.exit(f"No answer from {args.url}. On the LAN try http://10.0.0.69:8123; "
                 "from outside, the Nabu Casa URL.")

    try:
        if args.action == "diagnose":
            diagnose(ha)
            return 0
        if args.action == "reload":
            entry_id = args.entry_id or find_entry_id(ha)[0]
            if not entry_id:
                sys.exit("No Control4 config entry found; pass --entry-id.")
            if not args.yes:
                print(f"Dry run: would reload config entry {entry_id}. Re-run with --yes.")
                return 0
            return 0 if reload_entry(ha, entry_id) else 1
        if args.action == "repoint":
            ip = args.ip or observed_ip(ha)
            if not ip or not valid_ip(ip):
                sys.exit(f"Need a target address: pass --ip, or install {IP_SENSOR}.")
            if not args.yes:
                host, _ = configured_host(ha)
                print(f"Dry run: would repoint {host or 'the entry'} -> {ip} and restart "
                      "Home Assistant. Re-run with --yes.")
                return 0
            if repoint(ha, ip):
                print(f"\nControl4 is back on {ip}.")
                return 0
            manual_repoint(configured_host(ha)[0], ip)
            return 1
        return recover(ha, args.yes, args.force)
    except HaError as exc:
        sys.exit(str(exc))


if __name__ == "__main__":
    sys.exit(main() or 0)

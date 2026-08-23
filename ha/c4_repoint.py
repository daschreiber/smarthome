#!/usr/bin/env python3
"""Point the Control4 config entry at the controller's current address.

Lives at /config/c4_repoint.py on the Green. The `shell_command.c4_repoint`
service invokes it with a fixed `--mac`, which is how tools/c4_recover.py
drives a repoint from a laptop.

Why edit .storage at all: the Control4 config entry holds the controller host
AND the homeowner's Control4 account credentials AND — through the entity
registry keyed on it — every rename and Area assignment from Stage 5. Only
the host goes stale when the Core 3 takes a new DHCP lease, so deleting and
re-adding the integration to change one field would cost the credentials and
the entire normalization pass. This rewrites the one field, atomically, after
a timestamped backup, and refuses any store shape it does not recognise.

    python3 c4_repoint.py --mac 00:0f:ff:9f:3b:44   # find it, then point at it
    python3 c4_repoint.py 10.0.0.42                 # point at a known address

`--mac` takes no input from the caller at all: it resolves the address from
the ARP table (c4_scan.py), so the only thing this can ever do is point the
entry at whatever machine owns that MAC. That is what lets the Home Assistant
service run it with no templated arguments — see ha/c4_recovery.yaml.

Restart Home Assistant afterwards: config entries are read from .storage at
boot and held in memory, so nothing changes until it reboots. Exit code 0 on
success or when the host is already correct, 1 on any refusal.
"""

import argparse
import json
import os
import re
import shutil
import sys
import time

STORE = "/config/.storage/core.config_entries"
IPV4 = re.compile(r"^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$")


def fail(message):
    print(f"refused: {message}")
    return 1


def valid_ip(value):
    match = IPV4.match(value or "")
    return bool(match) and all(0 <= int(g) <= 255 for g in match.groups())


def resolve(mac):
    """Ask c4_scan for the address this MAC currently answers at. Both files
    live in /config, so a plain import finds it."""
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    try:
        import c4_scan
    except ImportError:
        return None, "c4_scan.py is not next to this script"
    found = c4_scan.arp_lookup(mac.lower())
    if not found:
        c4_scan.sweep(c4_scan.subnet_prefix())
        time.sleep(2)
        found = c4_scan.arp_lookup(mac.lower())
    return found, None if found else f"{mac} did not answer on this network"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("host", nargs="?", help="the controller's address")
    parser.add_argument("--mac", help="find the controller by MAC instead")
    parser.add_argument("--domain", default="control4", help="config entry domain")
    parser.add_argument("--store", default=None, help=argparse.SUPPRESS)
    try:
        args = parser.parse_args(argv if argv is not None else sys.argv[1:])
    except SystemExit:
        return 1

    store_path = args.store or STORE
    if bool(args.host) == bool(args.mac):
        return fail("give exactly one of <host> or --mac")

    if args.mac:
        new_host, why = resolve(args.mac)
        if not new_host:
            return fail(why)
        print(f"{args.mac} answers at {new_host}")
    else:
        new_host = args.host.strip()
    if not valid_ip(new_host):
        return fail(f"{new_host!r} is not an IPv4 address")

    try:
        with open(store_path) as handle:
            store = json.load(handle)
    except (OSError, ValueError) as exc:
        return fail(f"cannot read {store_path}: {exc}")

    entries = store.get("data", {}).get("entries")
    if not isinstance(entries, list):
        return fail(f"{store_path} is not shaped like a config-entry store")

    targets = [e for e in entries
               if e.get("domain") == args.domain and isinstance(e.get("data"), dict)]
    if len(targets) != 1:
        return fail(f"expected exactly one {args.domain} entry, found {len(targets)}")

    entry = targets[0]
    old_host = entry["data"].get("host")
    if old_host is None:
        return fail(f"the {args.domain} entry has no host field to rewrite")
    if old_host == new_host:
        print(f"unchanged: {args.domain} already points at {new_host}")
        return 0

    backup = store_path + time.strftime(".bak-%Y%m%d%H%M%S")
    try:
        shutil.copy2(store_path, backup)
        entry["data"]["host"] = new_host
        tmp = store_path + ".tmp"
        with open(tmp, "w") as handle:
            json.dump(store, handle, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, store_path)  # atomic: a crash mid-write cannot truncate it
    except OSError as exc:
        return fail(f"write failed ({exc}); original left in place, backup at {backup}")

    print(f"repointed {args.domain}: {old_host} -> {new_host} "
          f"(backup {backup}) — restart HA now")
    return 0


if __name__ == "__main__":
    sys.exit(main())

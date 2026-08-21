#!/usr/bin/env python3
"""Point the Control4 config entry at a new controller address, in place.

Lives at /config/c4_repoint.py on the Green and is invoked by the
`shell_command.c4_repoint` service (ha/c4_recovery.yaml), which is how
tools/c4_recover.py drives it from a laptop.

Why edit .storage at all: the Control4 config entry holds the controller host
AND the homeowner's Control4 account credentials AND — through the entity
registry keyed on it — every rename and Area assignment from Stage 5. Only
the host goes stale when the Core 3 takes a new DHCP lease, so deleting and
re-adding the integration to change one field would cost the credentials and
the entire normalization pass. This rewrites the one field and leaves the rest
untouched.

    python3 c4_repoint.py 10.0.0.42 [domain]

Restart Home Assistant afterwards: config entries are read from .storage at
boot and held in memory, so nothing changes until it reboots. Exit code 0 on
success or when the host is already correct, 1 on any refusal — the file is
only ever replaced atomically, after a timestamped backup, and never on a
structure this script does not recognise.
"""

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


def main():
    if len(sys.argv) < 2:
        return fail("usage: c4_repoint.py <new-ip> [domain]")
    new_host = sys.argv[1].strip()
    domain = (sys.argv[2].strip() if len(sys.argv) > 2 else "control4")

    match = IPV4.match(new_host)
    if not match or not all(0 <= int(g) <= 255 for g in match.groups()):
        return fail(f"{new_host!r} is not an IPv4 address")

    try:
        with open(STORE) as handle:
            store = json.load(handle)
    except (OSError, ValueError) as exc:
        return fail(f"cannot read {STORE}: {exc}")

    entries = store.get("data", {}).get("entries")
    if not isinstance(entries, list):
        return fail(f"{STORE} is not shaped like a config-entry store")

    targets = [e for e in entries
               if e.get("domain") == domain and isinstance(e.get("data"), dict)]
    if len(targets) != 1:
        return fail(f"expected exactly one {domain} entry, found {len(targets)}")

    entry = targets[0]
    old_host = entry["data"].get("host")
    if old_host is None:
        return fail(f"the {domain} entry has no host field to rewrite")
    if old_host == new_host:
        print(f"unchanged: {domain} already points at {new_host}")
        return 0

    backup = STORE + time.strftime(".bak-%Y%m%d%H%M%S")
    try:
        shutil.copy2(STORE, backup)
        entry["data"]["host"] = new_host
        tmp = STORE + ".tmp"
        with open(tmp, "w") as handle:
            json.dump(store, handle, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, STORE)  # atomic: a crash mid-write cannot truncate it
    except OSError as exc:
        return fail(f"write failed ({exc}); original left in place, backup at {backup}")

    print(f"repointed {domain}: {old_host} -> {new_host} (backup {backup}) — restart HA now")
    return 0


if __name__ == "__main__":
    sys.exit(main())

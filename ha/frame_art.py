#!/usr/bin/env python3
"""Put a Samsung Frame back into art mode, from inside Home Assistant.

Lives at /config/frame_art.py on the Green and is run by the
`shell_command.frame_art_*` services (ha/artframes_keypad.yaml), a few
seconds after the Frames relay has relayed a Morning press. A Frame wakes
into whatever it was showing when it went off, and SmartThings — the only
road the app on Railway has — can switch a set on but has no "show art"
command (owner, 2026-09-20: Day Mode brought the Lounge TV up as a
television). The set's own Art API on port 8002 can, and only a machine on
the LAN can reach it.

It asks before it acts: a set that says it is already in art is left alone,
so running this twice, or on a set nobody woke, changes nothing.

    python3 frame_art.py "Lounge TV"            # art if it is not already
    python3 frame_art.py "Lounge TV" --check    # report only

The argument is a piece of the Samsung TV config entry's title. Host and
token are read from that entry (.storage/core.config_entries), so the TV
sees the client it has already allowed — no second "Allow" prompt — and the
address follows HA when the set takes a new lease. The token is never
printed.

Prints one word — `art` (already), `set` (switched), `tv` (--check: not in
art), `unreachable`, `unknown` (no such entry) — and exits 0 unless the
switch itself failed, so a trace reads cleanly.
"""

import json
import sys

ENTRIES = "/config/.storage/core.config_entries"
CLIENT_NAME = "HomeAssistant"  # the name HA's samsungtv integration pairs under
ART_PORT = 8002
TIMEOUT = 8


def find_entry(fragment):
    with open(ENTRIES, encoding="utf-8") as fh:
        entries = json.load(fh)["data"]["entries"]
    wanted = fragment.lower()
    for entry in entries:
        if entry.get("domain") == "samsungtv" and wanted in entry.get("title", "").lower():
            return entry
    return None


def main(argv):
    args = [a for a in argv if not a.startswith("--")]
    check_only = "--check" in argv
    if not args:
        print("usage: frame_art.py <entry title fragment> [--check]")
        return 2
    entry = find_entry(args[0])
    if entry is None or not entry["data"].get("host"):
        print("unknown")
        return 0

    from samsungtvws import SamsungTVWS  # ships with HA's samsungtv integration

    tv = SamsungTVWS(
        host=entry["data"]["host"],
        port=ART_PORT,
        token=entry["data"].get("token"),
        name=CLIENT_NAME,
        timeout=TIMEOUT,
    )
    try:
        art = tv.art()
        try:
            mode = art.get_artmode()
        except Exception:  # noqa: BLE001 - off, asleep, or not answering: all one answer
            print("unreachable")
            return 0
        if mode == "on":
            print("art")
            return 0
        if check_only:
            print("tv")
            return 0
        try:
            art.set_artmode(True)
        except Exception as err:  # noqa: BLE001
            print(f"failed: {type(err).__name__}")
            return 1
        print("set")
        return 0
    finally:
        try:
            tv.close()
        except Exception:  # noqa: BLE001
            pass


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

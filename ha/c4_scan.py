#!/usr/bin/env python3
"""Find a device's current IP address by MAC, from inside Home Assistant.

Lives at /config/c4_scan.py on the Green and is run by the `C4 IP watch`
command_line sensor (ha/c4_recovery.yaml). It answers the one question that
took the longest during the 2026-08-12 outage: the Core 3 took a new DHCP
lease, and nothing on this network announces where it went.

Constraints it is written to survive, all learned that day:
  * No add-on store on this install, so no Terminal & SSH and no nmap.
  * No router integration, so no DHCP lease table to read.
  * The HA core container has no arp/ping binaries worth relying on.

So it does the smallest thing that works anywhere: send a UDP datagram to
every address on the subnet, which makes the kernel ARP for each one, then
read the answers straight out of /proc/net/arp. No root, no dependencies, no
raw sockets. Roughly a second of traffic, twice a day.

    python3 c4_scan.py 00:0f:ff:9f:3b:44 [10.0.0]

Prints the IP, or "unknown" if the MAC did not answer — never an error, so
the sensor always has a clean state.
"""

import re
import socket
import sys
import time

ARP_TABLE = "/proc/net/arp"
DISCARD_PORT = 9  # RFC 863; nothing has to be listening for ARP to resolve
EMPTY_MAC = "00:00:00:00:00:00"
MAC_RE = re.compile(r"^([0-9a-f]{2}:){5}[0-9a-f]{2}$")


def sweep(prefix):
    """Touch every host on the /24 so the kernel resolves it."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setblocking(False)
    try:
        for host in range(1, 255):
            try:
                sock.sendto(b"\x00", (f"{prefix}.{host}", DISCARD_PORT))
            except OSError:
                pass  # no route, buffer full — the next address may still answer
    finally:
        sock.close()


def arp_lookup(mac):
    """The IP currently paired with this MAC, or None."""
    try:
        with open(ARP_TABLE) as table:
            next(table, None)  # header
            for line in table:
                fields = line.split()
                # ip, hw type, flags, mac, mask, device
                if len(fields) >= 4 and fields[3].lower() == mac and fields[3] != EMPTY_MAC:
                    return fields[0]
    except OSError:
        return None
    return None


def main():
    mac = (sys.argv[1] if len(sys.argv) > 1 else "").strip().lower()
    if not MAC_RE.match(mac):
        print("unknown")
        return 0
    prefix = sys.argv[2].strip() if len(sys.argv) > 2 else "10.0.0"

    # Already in the table from ordinary traffic? Then no sweep is needed.
    found = arp_lookup(mac)
    for _ in range(2):
        if found:
            break
        sweep(prefix)
        time.sleep(2)  # let the replies land
        found = arp_lookup(mac)
    print(found or "unknown")
    return 0


if __name__ == "__main__":
    sys.exit(main())

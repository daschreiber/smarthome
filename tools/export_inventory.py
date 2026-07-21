#!/usr/bin/env python3
"""Export a Home Assistant entity inventory (runbook Stage 4).

Usage:
    HA_URL=http://10.0.0.69:8123 HA_TOKEN=<long-lived-token> python3 export_inventory.py [outdir]

Reads only; changes nothing in Home Assistant. Writes two files to outdir
(default: ./inventory):
    entities.json  - full inventory: entity_id, domain, friendly name, state,
                     area, device_class, supported_features
    SUMMARY.md     - per-domain counts and notes, safe to commit

Privacy: location-bearing entities (person, device_tracker, zone) are skipped
entirely, and latitude/longitude-style attributes are stripped, so the output
contains no credentials, tokens, or location data.
"""

import json
import os
import sys
import urllib.request

STRIP_ATTRS = {"latitude", "longitude", "gps_accuracy", "source", "access_token", "entity_picture"}
SKIP_DOMAINS = {"person", "device_tracker", "zone"}
KEEP_ATTRS = {"friendly_name", "device_class", "supported_features", "supported_color_modes",
              "hvac_modes", "current_position", "unit_of_measurement"}


def api(base, token, path, payload=None):
    req = urllib.request.Request(
        base.rstrip("/") + path,
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST" if payload is not None else "GET",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read().decode()


AREA_TEMPLATE = """
{%- set m = namespace(d={}) -%}
{%- for e in states -%}
{%- set m.d = dict(m.d, **{e.entity_id: (area_name(e.entity_id) or "")}) -%}
{%- endfor -%}
{{ m.d | to_json }}
"""


def main():
    base, token = os.environ.get("HA_URL"), os.environ.get("HA_TOKEN")
    if not base or not token:
        sys.exit("Set HA_URL and HA_TOKEN environment variables first.")
    outdir = sys.argv[1] if len(sys.argv) > 1 else "inventory"
    os.makedirs(outdir, exist_ok=True)

    states = json.loads(api(base, token, "/api/states"))

    try:
        areas = json.loads(api(base, token, "/api/template", {"template": AREA_TEMPLATE}))
    except Exception as exc:  # areas are nice-to-have; states alone is still useful
        print(f"warning: area lookup failed ({exc}); continuing without areas", file=sys.stderr)
        areas = {}

    entities, domains = [], {}
    for s in states:
        entity_id = s["entity_id"]
        domain = entity_id.split(".", 1)[0]
        if domain in SKIP_DOMAINS:
            continue
        attrs = {k: v for k, v in s.get("attributes", {}).items()
                 if k in KEEP_ATTRS and k not in STRIP_ATTRS}
        entities.append({
            "entity_id": entity_id,
            "domain": domain,
            "name": attrs.get("friendly_name", entity_id),
            "state": s.get("state"),
            "area": areas.get(entity_id, ""),
            "attributes": attrs,
        })
        domains[domain] = domains.get(domain, 0) + 1

    entities.sort(key=lambda e: (e["domain"], e["area"], e["name"]))
    with open(os.path.join(outdir, "entities.json"), "w") as f:
        json.dump(entities, f, indent=2, ensure_ascii=False)

    unnamed = [e for e in entities if e["domain"] in ("light", "cover", "climate", "media_player", "vacuum")
               and not e["area"]]
    dupes = {}
    for e in entities:
        dupes.setdefault(e["name"], []).append(e["entity_id"])
    dupe_names = {n: ids for n, ids in dupes.items() if len(ids) > 1}

    lines = ["# Entity Inventory Summary", "",
             f"Total entities exported: **{len(entities)}**", "",
             "| Domain | Count |", "| --- | --- |"]
    lines += [f"| {d} | {c} |" for d, c in sorted(domains.items(), key=lambda x: -x[1])]
    lines += ["", f"Controllable entities without an Area: **{len(unnamed)}**",
              f"Duplicate friendly names: **{len(dupe_names)}**", ""]
    if dupe_names:
        lines.append("## Duplicate names needing rename (Stage 5)")
        lines.append("")
        for n, ids in sorted(dupe_names.items(), key=lambda x: -len(x[1]))[:25]:
            lines.append(f"- \"{n}\" x{len(ids)}: {', '.join(ids[:6])}{' ...' if len(ids) > 6 else ''}")
    with open(os.path.join(outdir, "SUMMARY.md"), "w") as f:
        f.write("\n".join(lines) + "\n")

    print("\n".join(lines))
    print(f"\nWrote {outdir}/entities.json and {outdir}/SUMMARY.md")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Build the classified entity map (runbook Stage 4->5 bridge).

Reads inventory/entities.json (raw Home Assistant states export) and produces:
  data/entity_map.json   - per-entity: room, category, app group, display name
  data/MAPPING_REVIEW.md - human-readable review sheet grouped by category

Key insight from the inventory: the Control4 project fronts a KNX bus, and many
KNX relay channels are exposed as `light` entities although they are actually
fans, vents, towel rails, boilers, appliance sockets, floor-heating valves,
scene group-switches, or a TV lift. Nothing is excluded from the app; each
entity is assigned an app group so consequential loads are organized apart
from everyday lighting. Classification happens here, in reviewable code.

Usage: python3 tools/build_entity_map.py
"""

import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Longest-match-first room inference from friendly names.
ROOMS = [
    ("daniel's study", "Daniel's Study"), ("daniel study", "Daniel's Study"),
    ("daniella's study", "Daniella's Study"), ("daniella study", "Daniella's Study"),
    ("master bedroom balcony", "Master Bedroom"), ("mbr balcony", "Master Bedroom"),
    ("master bathroom", "Master Bathroom"), ("master bedroom", "Master Bedroom"),
    ("mbr", "Master Bedroom"), ("master corridor", "Master Corridor"),
    ("guest bathroom+small guest room", "Guest Bathroom"),
    ("guest bathroom", "Guest Bathroom"),
    ("large guest room", "Large Guest Room"), ("medium guest room", "Medium Guest Room"),
    ("small guset room", "Small Guest Room"), ("small guest room", "Small Guest Room"),
    ("small guest roomhidden", "Small Guest Room"),
    ("downstairs toilet", "Downstairs Toilet"), ("restroom", "Downstairs Toilet"),
    ("left corridor", "Left Corridor"), ("right corridor", "Right Corridor"),
    ("entrance+kitchen", "Entrance"), ("lounge+dining", "Lounge"),
    ("dining table", "Lounge"), ("dining", "Lounge"),
    ("kitchen", "Kitchen"), ("lounge", "Lounge"), ("den", "Den"), ("gym", "Gym"),
    ("sauna", "Sauna"), ("utility", "Utility Room"), ("entrance", "Entrance"),
    ("landing", "Landing"), ("stairs", "Stairs"), ("hall", "Hall"),
    ("terrace", "Terrace"), ("bbq", "Terrace"), ("balcony", "Balcony"),
    ("boiler 6th", "Utility Room"), ("boiler roof", "Roof"), ("roof", "Roof"),
    ("electricity board", "Utility Room"), ("games closet", "Den"),
    ("rack", "Rack"), ("all house", "Whole House"), ("all rooms", "Whole House"),
    ("welcome", "Whole House"), ("55\" qled", "Lounge"),
]

# (regex on friendly name, category) - first match wins. Nothing is excluded:
# every entity gets an app group; consequential loads live in Utilities/Appliances.
LIGHT_RULES = [
    (r"all house|all rooms|main all house|welcome", "scene_switch"),
    (r"\bfh\b|- fh -", "floor_heating"),
    (r"ac\\\\? ?heat|ac\\ heat|ac.heat (5|6)th", "hvac_master_switch"),
    (r"boiler|pump|electricity board", "infrastructure"),
    (r"socket", "controlled_socket"),
    (r"tv lift", "motorized_furniture"),
    (r"\bvent\b|defog", "ventilation"),
    (r"towel rail", "towel_rail"),
    (r"\bfan\b", "fan"),
    (r"טוחן|מדיח|תנור|ברז", "kitchen_appliance"),
]

# Categories that are behind-the-scenes plumbing: kept in the map but hidden
# from the app's default view (and hidden in HA). Flip here to resurface.
HIDDEN_CATEGORIES = {
    "floor_heating", "kitchen_appliance", "controlled_socket",
    "hvac_master_switch", "infrastructure_climate",
}
VISIBILITY_OVERRIDES = {
    "light.knx_switch_stir_pump": False,
    "light.knx_switch_electricity_board_lightstrip": False,
}

GROUPS = {
    "light_dimmer": "Lighting", "light_switch": "Lighting",
    "shade": "Shades",
    "climate_zone": "Climate & Comfort", "floor_heating": "Climate & Comfort",
    "ventilation": "Climate & Comfort", "towel_rail": "Climate & Comfort",
    "fan": "Climate & Comfort", "hvac_master_switch": "Climate & Comfort",
    "infrastructure_climate": "Utilities",
    "media": "Media", "scene_switch": "Scenes",
    "kitchen_appliance": "Appliances",
    "infrastructure": "Utilities", "controlled_socket": "Utilities",
    "motorized_furniture": "Utilities",
}

HEBREW_NAMES = {
    "light.knx_switch_brz_mym_khmym_qrym": "Hot/Cold Water Tap",
    "light.knx_switch_tvkhn_bshry": "Garbage Disposal (Meat)",
    "light.knx_switch_tvkhn_khlby": "Garbage Disposal (Dairy)",
    "light.knx_switch_mdykh_khlby": "Dishwasher (Dairy)",
    "light.knx_switch_tnvr_mrkz": "Oven (Center)",
    "light.knx_switch_tnvr_lyvn": "Oven (Upper)",
    "light.knx_switch_tnvr_tkhtvn": "Oven (Lower)",
}


ROOM_OVERRIDES = {
    "light.knx_switch_5th_controlled_socket": "Utility Room",
    "light.knx_switch_ac_heat_5th": "Whole House",
    "light.knx_switch_ac_heat_6th": "Whole House",
    "light.knx_switch_contrroled_sockets_near_boiler": "Utility Room",
    "light.knx_switch_stir_pump": "Utility Room",
    "light.knx_switch_mdykh_khlby": "Kitchen",
    "light.knx_switch_tvkhn_khlby": "Kitchen",
    "light.knx_switch_tvkhn_bshry": "Kitchen",
    "light.knx_switch_brz_mym_khmym_qrym": "Kitchen",
    "light.knx_switch_tnvr_mrkz": "Kitchen",
    "light.knx_switch_tnvr_tkhtvn": "Kitchen",
    "light.knx_switch_tnvr_lyvn": "Kitchen",
}


def infer_room(name):
    low = name.lower()
    for key, room in ROOMS:
        if key in low:
            return room
    return ""


def clean_name(name, room):
    n = re.sub(r"^KNX (Dimmer|Switch) ", "", name)
    n = re.sub(r"^(5|6)th( -)?( FH -)? ?", "", n)
    n = re.sub(r"\s+", " ", n).strip()
    if room and room not in ("Whole House", "Rack"):
        # drop a duplicated leading room prefix ("Den Den Blinds" -> "Den Blinds")
        low, rl = n.lower(), room.lower()
        while low.startswith(rl + " " + rl):
            n = n[len(room) + 1:]
            low = n.lower()
    return n or name


def classify(e):
    domain, low = e["domain"], e["name"].lower()
    if domain == "climate":
        return "infrastructure_climate" if "rack" in low else "climate_zone"
    if domain == "cover":
        return "shade"
    if domain == "media_player":
        return "media"
    if domain == "light":
        for pattern, category in LIGHT_RULES:
            if re.search(pattern, low):
                return category
        return "light_dimmer" if "knx_dimmer" in e["entity_id"] else "light_switch"
    return f"other_{domain}"


def main():
    with open(os.path.join(ROOT, "inventory", "entities.json")) as f:
        entities = json.load(f)

    out, categories = [], {}
    for e in entities:
        if e["domain"] not in ("light", "cover", "climate", "media_player"):
            continue
        category = classify(e)
        room = (ROOM_OVERRIDES.get(e["entity_id"])
                or infer_room(e["name"])
                or infer_room(e["entity_id"].replace("_", " ")))
        if category == "climate_zone":
            display = "A/C & Heating"
        elif category == "floor_heating":
            display = "Floor Heating"
        else:
            display = HEBREW_NAMES.get(e["entity_id"]) or clean_name(e["name"], room)
        row = {
            "entity_id": e["entity_id"],
            "domain": e["domain"],
            "original_name": e["name"],
            "display_name": display,
            "room": room,
            "category": category,
            "group": GROUPS.get(category, "Utilities"),
            "visible": VISIBILITY_OVERRIDES.get(
                e["entity_id"], category not in HIDDEN_CATEGORIES),
        }
        out.append(row)
        categories.setdefault(category, []).append(row)

    os.makedirs(os.path.join(ROOT, "data"), exist_ok=True)
    out.sort(key=lambda r: (r["room"], r["category"], r["display_name"]))
    with open(os.path.join(ROOT, "data", "entity_map.json"), "w") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)

    groups = {}
    for r in out:
        groups.setdefault(r["group"], []).append(r)

    lines = ["# Entity Mapping Review Sheet", "",
             "Generated by `tools/build_entity_map.py` from `inventory/entities.json`.",
             "Edit the rules in the script (not this file) and regenerate.", "",
             "Every controllable entity is included; the `group` decides which app",
             "section it appears in. Consequential loads (boilers, ovens, pump, HVAC",
             "master cutoffs, TV lift) live under Utilities/Appliances and are",
             "candidates for a confirm-before-run tap in the UI.", "",
             f"Controllable entities mapped: **{len(out)}**", ""]
    for grp in sorted(groups):
        rows = sorted(groups[grp], key=lambda r: (r["room"], r["display_name"]))
        hidden = sum(1 for r in rows if not r["visible"])
        lines += [f"## {grp} ({len(rows)}{f', {hidden} hidden' if hidden else ''})", ""]
        lines += [f"- {'[hidden] ' if not r['visible'] else ''}[{r['room'] or 'NO ROOM'}] "
                  f"{r['display_name']} ({r['category']})  `{r['entity_id']}`"
                  for r in rows]
        lines.append("")
    with open(os.path.join(ROOT, "data", "MAPPING_REVIEW.md"), "w") as f:
        f.write("\n".join(lines))

    print(f"{len(out)} entities mapped into {len(categories)} categories, {len(groups)} app groups")
    for grp in sorted(groups, key=lambda g: -len(groups[g])):
        hid = sum(1 for r in groups[grp] if not r["visible"])
        print(f"  {grp:20} {len(groups[grp]):3}  hidden={hid}")
    print(f"visible={sum(1 for r in out if r['visible'])} hidden={sum(1 for r in out if not r['visible'])}")
    missing = [r for r in out if not r["room"]]
    print(f"entities with no inferred room: {len(missing)}")
    for r in missing:
        print(f"  ? {r['entity_id']} ({r['original_name']})")


if __name__ == "__main__":
    main()

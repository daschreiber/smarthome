# Prompt: apply the HomeKit Bridge exclusion list in Home Assistant

Copy everything below the line into a computer-use agent on a machine that
can reach the home LAN and is **already logged into Home Assistant as the
owner** at `http://10.0.0.69:8123` (do not give the agent any credentials;
log in yourself first if needed).

---

You are operating the Home Assistant web UI at `http://10.0.0.69:8123`,
already logged in. Your task is to update the exclusion list of the HomeKit
Bridge integration so that 44 specific entities stop being exposed to Apple
Home. You must only ADD to the exclusion list — never remove anything
already in it, and never change any other setting.

Steps:

1. Navigate to **Settings → Devices & Services**.
2. Find the **HomeKit Bridge** card and open it. There is exactly one
   entry: **"HASS Bridge AK:21074"**. If you see any other number of
   entries, stop and report.
3. Click the **gear (Configure)** icon on that entry.
4. First dialog ("Select mode and domains"): verify it shows HomeKit mode
   **bridge**, inclusion mode **exclude**, and domains **Climate, Cover,
   Light**. Change nothing. Click **Submit**.
5. Second dialog: a searchable entity picker for entities to exclude.
   Clicking an entity in the dropdown adds it as a chip to the field;
   already-added entities show as chips. For each name in the list below:
   type a distinctive part of it in the search box, click the exact
   matching entity, and confirm a chip appeared. If a name is already
   present as a chip, skip it. If a search returns nothing or the match is
   uncertain, skip it and note it in your report — do not click a
   near-match.
6. When all names are processed, click **Submit** and confirm the dialog
   closes without error.

Entities to exclude — thermostats (Control4 zones, 13):

- Daniel's Study A/C & Heating
- Daniella's Study A/C & Heating
- Den A/C & Heating
- Gym A/C & Heating
- Kitchen A/C & Heating
- Large Guest Room A/C & Heating
- Lounge A/C & Heating
- Master Bedroom A/C & Heating
- Medium Guest Room A/C & Heating
- Sauna A/C & Heating
- Small Guest Room A/C & Heating
- Utility Room A/C & Heating
- Rack UNIT 109

Thermostats (CoolMaster units, 2) — search "L1.1":

- L1.109
- L1.110

Floor-heating relays (14) — search "Floor Heating":

- Daniel's Study Floor Heating
- Daniella's Study Floor Heating
- Den Floor Heating
- Downstairs Toilet Floor Heating
- Entrance Floor Heating
- Guest Bathroom Floor Heating
- Gym Floor Heating
- Large Guest Room Floor Heating
- Lounge Floor Heating
- Master Bathroom Floor Heating
- Master Bedroom Floor Heating
- Medium Guest Room Floor Heating
- Sauna Floor Heating
- Utility Room Floor Heating

Utility and appliance relays (15) — exact names, quirky spellings are real:

- AC\ HEAT 5TH
- AC\HEAT 6TH
- Boiler 6th Floor
- Boiler Roof
- Controlled Socket
- Contrroled Sockets near Boiler
- Dishwasher (Dairy)
- Electricity board lightstrip
- Garbage Disposal (Dairy)
- Garbage Disposal (Meat)
- Hot/Cold Water Tap
- Oven (Center)
- Oven (Lower)
- Oven (Upper)
- Stir pump

Final report: how many of the 44 were newly added, how many were already
present, and the exact names skipped with the reason. Do not restart Home
Assistant or touch anything else.

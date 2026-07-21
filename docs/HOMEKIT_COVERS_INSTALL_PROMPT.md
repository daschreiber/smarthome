# Prompt: install the HomeKit template covers and swap the bridge over

Copy everything below the line into a computer-use agent on the dev Mac
(on the home LAN, browser already logged into Home Assistant as the owner
at `http://10.0.0.69:8123`). Attach `ha/homekit_covers.yaml`.

---

You are operating the Home Assistant web UI at `http://10.0.0.69:8123`,
already logged in as an admin. Goal: add 13 template cover entities from
the attached YAML file, then swap the HomeKit Bridge from the broken
Control4 covers to the new ones. Work in exactly this order and stop
immediately (reporting what happened) if any step fails.

## Phase 1 — File editor add-on

1. Go to **Settings → Add-ons**. If "File editor" is already installed,
   ensure it is started and continue. Otherwise open the **Add-on Store**,
   install **File editor**, start it, and enable "Show in sidebar".

## Phase 2 — configuration.yaml edit

2. Open File editor and load `configuration.yaml`. Read it first:
   - If it already contains a top-level `cover:` key, STOP and report its
     contents instead of editing.
   - Note whether the file ends with a newline.
3. Append the entire content of the attached `homekit_covers.yaml` (from
   the `cover:` line onward, comments included) to the end of
   `configuration.yaml`, separated by one blank line. Change nothing else
   in the file. Save.
4. Go to **Developer Tools → YAML → Check configuration**. If the result
   is anything other than a success/valid message: reopen File editor,
   remove exactly the block you added, save, re-run the check to confirm
   the config is valid again, and STOP with a report quoting the error.

## Phase 3 — restart and verify

5. With the check passing, click **Restart Home Assistant** (full restart,
   not quick reload) and confirm. Wait for the UI to come back (up to
   3 minutes; reload the page if needed).
6. Go to **Developer Tools → States** and filter for `cover.hk_`. There
   must be exactly 13 entities (hk_daniel_study_blinds …
   hk_medium_guest_room_blinds). If not, STOP and report what exists.

## Phase 4 — bridge swap

7. Go to **Settings → Devices & Services → HomeKit Bridge** → gear icon on
   "HASS Bridge AK:21074". First dialog: change nothing, Submit.
8. In the entity exclusion picker, ADD these 13 Control4 covers (they do
   NOT have the "HK" prefix — never exclude an "HK …" entity):
   - Daniel's Study Daniel Study Blinds
   - Daniella's Study Daniella Study Blinds
   - Den Blinds
   - Guest Bathroom Blinds
   - Kitchen Left
   - Kitchen Right
   - Large Guest Room Blinds
   - Lounge Left
   - Lounge Right
   - Master Bedroom Balcony Left
   - Master Bedroom Balcony Right
   - Master Bedroom Window
   - Medium Guest Room Blinds
   Never remove existing exclusion chips. Submit.

## Report

State: add-on status; whether the YAML block was appended cleanly; config
check result; restart completed; the 13 `cover.hk_*` entities present or
not; which of the 13 exclusions were newly added vs already present; any
step skipped and why. Do not change anything else anywhere.

# Prompt: fix the template covers (attempt 2, modern format) and swap the bridge

Attempt 1 appended a legacy-format `cover: - platform: template` block that
validated but never set up (0 entities). Attempt 2 replaces it with the
modern `template:` format in the attached `homekit_covers.yaml`.

Copy everything below the line into the computer-use agent (dev Mac, on the
home LAN, browser logged into Home Assistant as owner at
`http://10.0.0.69:8123`). Attach `ha/homekit_covers.yaml`.

---

You are operating the Home Assistant web UI at `http://10.0.0.69:8123`,
already logged in as an admin. A previous session appended a block to
`configuration.yaml` starting at the comment
`# HomeKit cover workaround — see docs/APPLE_HOME_SETUP.md` and containing
a top-level `cover:` section with 13 template covers. That block silently
fails to set up. Your job: replace it with the corrected block from the
attached file, verify the 13 entities exist, then update the HomeKit
Bridge exclusions. Stop and report at any failure.

## Phase 1 — replace the block

1. Open **File editor** (sidebar) and load `configuration.yaml`.
2. Delete the previously appended block: from the line
   `# HomeKit cover workaround — see docs/APPLE_HOME_SETUP.md` through the
   end of the `cover:` section it introduced (attempt 1's block runs to the
   end of the file). Delete nothing else.
3. Check whether the remaining file already contains a top-level
   `template:` key.
   - If NO: append the attached file's entire content (comments included)
     at the end, after one blank line.
   - If YES: append only the attached block's `- cover:` list item (from
     `  - cover:` to the end, keeping its indentation) under the existing
     `template:` key, and add the comment lines just above the
     `template:` key.
4. Save. Go to **Developer Tools → YAML → Check configuration**. If it
   fails: restore the file to the state after step 2 (i.e. old block
   removed, nothing added), confirm the check passes, and STOP, quoting
   the error.

## Phase 2 — restart and verify

5. **Developer Tools → YAML → Restart Home Assistant** (full restart).
   Wait for the UI to return.
6. **Developer Tools → States**, filter `cover.hk_`. Expect exactly 13
   entities.
7. If fewer than 13: go to **Settings → System → Logs**, search for
   `template` and for `cover`, copy every error or warning mentioning
   them, and STOP — report the log excerpts verbatim. Leave the config in
   place.

## Phase 3 — bridge swap (only if all 13 exist)

8. **Settings → Devices & Services → HomeKit Bridge** → gear on
   "HASS Bridge AK:21074" → first dialog unchanged → Submit.
9. In the exclusion picker ADD these 13 Control4 covers (never anything
   with the "HK" prefix, never remove existing chips):
   Daniel's Study Daniel Study Blinds; Daniella's Study Daniella Study
   Blinds; Den Blinds; Guest Bathroom Blinds; Kitchen Left; Kitchen Right;
   Large Guest Room Blinds; Lounge Left; Lounge Right; Master Bedroom
   Balcony Left; Master Bedroom Balcony Right; Master Bedroom Window;
   Medium Guest Room Blinds.
10. Submit.

## Report

State: old block removed; whether `template:` pre-existed and how the new
block was merged; config check result; restart done; `cover.hk_*` count;
log excerpts if verification failed; exclusions newly added vs already
present. Change nothing else anywhere.

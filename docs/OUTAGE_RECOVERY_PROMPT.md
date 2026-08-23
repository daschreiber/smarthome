# Prompt: recover Control4 after a power outage

> **Superseded 2026-08-21.** The HA-side bundle is now installed on the Green,
> so the repoint no longer needs the File-editor detour this prompt describes.
> Use [`OUTAGE_RECOVERY_RUNBOOK.md`](OUTAGE_RECOVERY_RUNBOOK.md), which also
> covers the browser-only route for when no terminal can be driven.


Copy everything below the line into a computer-control session (Claude Cowork
or similar) running **on the Mac**, which — unlike a cloud session — can reach
the Home Assistant Green.

Context for the human — do these before running:

1. **Be on the house network**, or have the Nabu Casa URL to hand. The LAN
   address is `http://10.0.0.69:8123`.
2. **Have an admin long-lived token ready.** Home Assistant → click your
   profile (bottom left) → Security → Long-lived access tokens → Create.
   It must be an **admin** user: the `smarthome-app` token is deliberately
   non-admin and cannot reload a config entry or restart HA. Revoke the token
   afterwards if it has been pasted anywhere it shouldn't live.
3. **Know where the repo clone is** on the Mac, and give the agent a terminal.
4. If a repoint turns out to be needed, the agent will want the **File editor**
   add-on in a browser. The add-on *store* 404s on this install, so File editor
   is what there is — Terminal & SSH cannot be added.

The full background is `docs/OUTAGE_RECOVERY.md`; the prompt below repeats what
the agent needs so it can work without reading anything else.

---

You are recovering Home Assistant's link to the Control4 controller in a house,
working on this Mac. Work in a terminal; use a browser only if step 4 says so.

## What has happened

A power cut has left every Control4-backed entity `unavailable` in Home
Assistant: all the lights, the underfloor-heating valves, and the two KNX
heat/cool changeover relays. The A/C zones, the shades and the media players
still work, because they reach their hardware without going through Control4.

**The Control4 system itself is fine** — the native Control4 app and the wall
panels work throughout. What is broken is Home Assistant's connection to it.
This house has had exactly this failure before (2026-08-12), and it is two
faults stacked:

1. **Boot-before-internet.** Home Assistant came back before the fibre did, so
   the Control4 *cloud* authentication call died mid-request and left the
   config entry in `setup_error` with no retry. Reloading the entry is enough
   to clear this.
2. **An IP change hiding behind it.** The controller (a Control4 Core 3, MAC
   `00:0f:ff:9f:3b:44`) may have taken a new DHCP lease while the power was
   out, so the reload then fails with `Timeout connecting to Control4
   controller at <old address>`. Then the config entry's stored host has to be
   repointed at the new address.

There is a tool in the repo that walks both faults in order. Use it rather
than improvising.

## Rules — these matter more than finishing fast

- **Never delete and re-add the Control4 integration.** The config entry holds
  the homeowner's Control4 account password, and every one of 184 entity
  renames and room assignments hangs off it. Losing that is hours of work and
  a password nobody has to hand. Only the stored `host` goes stale, and it is
  rewritten in place.
- **Never retry Control4 cloud authentication rapidly.** `apis.control4.com`
  rate-limits, then drops connections in a way that looks exactly like wrong
  credentials. One attempt, then wait. If you find yourself reloading the
  entry a third time, stop and report instead.
- **If the tool refuses, believe it.** It refuses on purpose: "this is not an
  IP drift", "this is a partial fault". Those mean the problem is not the one
  you are here to fix. Report and stop; do not reach for `--force`.
- **Do not edit `/config/.storage/core.config_entries` by hand**, except by
  the exact procedure in step 4. A malformed file there is a house that will
  not boot.
- Do not print the access token, and do not write it into any file in the repo.
- Restarting Home Assistant is expected and fine when the steps call for it.
  It takes a couple of minutes and everything comes back.

## 1. Get the tool

```
cd <the smarthome repo on this Mac>
git fetch origin
git checkout claude/power-outage-recovery-ya5tln
```

Ask the human for the repo path if you cannot find it. `python3` is the only
dependency; if it is missing, run `xcode-select --install`.

## 2. Connect

Ask the human for the Home Assistant URL and an **admin** long-lived token,
then, in the shell you will keep using:

```
export HA_URL=http://10.0.0.69:8123      # or the Nabu Casa URL if not at home
export HA_TOKEN=<the token>
```

## 3. Diagnose — this changes nothing

```
python3 tools/c4_recover.py diagnose
```

Show the human the output. It prints how many Control4 lights are unavailable,
the config entry and its state, the address the entry is dialling, the address
the controller actually answers at, recent Control4 log lines, and a verdict.

Two things to expect on this particular install: `sensor.c4_ip_watch` exists
and should report a real address, while `sensor.c4_configured_host` does not
exist yet — so the configured host will be sourced from `[error log]`. That is
normal and just as reliable.

If the verdict is **"Control4 is up. Nothing to recover."**, the house fixed
itself. Report that and stop.

## 4. Recover

```
python3 tools/c4_recover.py recover --yes
```

It reloads the config entry first, and only repoints if the reload cannot fix
it. Let it run; it polls and prints progress. Then one of these:

**(a) The lights come back.** Fault 1 only. Go to step 5.

**(b) It reports the controller has moved, and then stops** because
`shell_command.c4_repoint` is not defined on this Home Assistant. Expected —
the helper is new and has not been installed here yet. It prints a by-hand
procedure with the new address already filled in. Take the cleaner route
instead, which also leaves the house better off:

1. Open Home Assistant in a browser → Settings → Add-ons → **File editor**.
2. Create `/config/c4_scan.py` and `/config/c4_repoint.py`, pasting the
   contents of `ha/c4_scan.py` and `ha/c4_repoint.py` from the repo clone on
   this Mac, verbatim.
3. Open `/config/configuration.yaml` and paste in the whole `ha/c4_recovery.yaml`
   block from the repo. If `configuration.yaml` already has a `template:` or
   `command_line:` key, merge the new list items into the existing key rather
   than adding a second one. **Do not add a template to the `shell_command`** —
   it is written without one on purpose, because Home Assistant runs a
   templated shell_command through a shell.
4. In the automation at the bottom of that block, change
   `notify.mobile_app_iphone` to whichever `notify.mobile_app_*` service this
   house actually has (Developer tools → Actions, type `notify.` to see them).
5. Delete the existing automation named **"Control4 IP drift alert"**
   (Settings → Automations). The new block replaces it, and leaving both makes
   the house alert twice.
6. Developer tools → YAML → **Check configuration**. Fix anything it reports
   before continuing. Then restart Home Assistant.
7. Back in the terminal, run `python3 tools/c4_recover.py recover --yes` again.
   It will now do the repoint and the restart itself.

If the human would rather not install anything right now, follow the by-hand
procedure the tool printed instead — including its instruction to restart
Home Assistant **twice**, and to delete the throwaway sensor afterwards.

**(c) It refuses** — "not an IP drift", "partial fault", "no Control4 config
entry found", or it cannot find where the controller is. Read what it says,
report it, and stop. Do not use `--force`.

## 5. Verify

- `python3 tools/c4_recover.py diagnose` → "Control4 is up. Nothing to recover."
- Home Assistant → Settings → Devices & Services → Control4 shows **179 devices
  / 178 entities**.
- Turn one light on and off from the Home Assistant app and confirm the real
  light responds. This is the only proof that matters.

## 6. Report back

Tell the human:

- Which fault it turned out to be — reload alone, or a repoint.
- **The Core 3's address now**, and what it was before. This needs recording.
- Whether the HA-side bundle got installed, and whether the old "Control4 IP
  drift alert" automation was deleted.
- Anything you refused to do and why.
- Whether the physical light test passed.

Then say plainly that the permanent fix is still outstanding: a **DHCP
reservation for `00:0f:ff:9f:3b:44` on the router at `10.0.0.138`**. It is
dealer-managed and only reachable on-site. Until that exists this will happen
again on the next power cut, and everything above is a workaround.

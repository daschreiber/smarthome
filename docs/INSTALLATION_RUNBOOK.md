# Installation and Commissioning Runbook

> **Status: completed.** All stages were executed (Stages 1–6 on site by
> 2026-07-16, deployment Stages 7–8 per `DEPLOY_RAILWAY.md` on
> 2026-07-17). Kept as the record of how the system was brought up;
> day-to-day state lives in `docs/COMMISSIONING_LOG.md`.

Use this when the Home Assistant Green arrives.

## Before starting

Have available:

- Home Assistant Green
- Power supply
- Ethernet cable
- Access to the home router or network equipment
- Control4 homeowner email and password
- An iPhone or Mac on the same network

Do not post passwords, long-lived tokens, registration codes, or public remote URLs in GitHub or chat.

## Stage 1 — bring up Home Assistant Green

1. Connect Green to the router or network switch by Ethernet.
2. Connect power.
3. Wait approximately 10 minutes for first boot and updates.
4. On a device on the same network, open `http://homeassistant.local:8123`.
5. If that does not resolve, locate the device IP in the router and open `http://<IP>:8123`.
6. Create the Home Assistant owner account.
7. Set location, timezone, units, and a strong password.
8. Install all offered Home Assistant OS/Core updates.
9. Reserve the Green's IP address in the router if practical.

## Stage 2 — connect Control4

1. In Home Assistant, open **Settings → Devices & services**.
2. Check whether Control4 was automatically discovered.
3. If not, select **Add Integration** and search for **Control4**.
4. Enter the Control4 Core 3 local IP address.
5. Enter the ordinary Control4 homeowner credentials.
6. Complete configuration.
7. Record whether the integration succeeds and how many entities it creates.

## Stage 3 — first safe tests

Test only reversible, visible devices:

1. Choose one light in the same room.
2. Turn it on and off from Home Assistant.
3. Adjust brightness if available.
4. Choose one shade and test open, stop, close.
5. Test one thermostat read; change set-point only if the displayed state is clearly correct.
6. Test one non-security scene.

Do not test locks, alarms, gates, garage doors, or security functions during initial commissioning.

## Stage 4 — inventory export

Capture:

- Home Assistant version
- Green local IP
- Control4 integration status
- Number of entities by domain
- Entity ID
- Friendly name
- State
- Supported features
- Home Assistant Area
- Whether control succeeds

The implementation should include an admin discovery function that exports this safely without credentials.

## Stage 5 — normalize Home Assistant

1. Assign each useful entity to a Home Assistant Area.
2. Rename unclear entity names.
3. Disable duplicate or irrelevant entities.
4. Create Home Assistant scenes/scripts for compound actions not exposed cleanly by Control4.
5. Note missing Alexa capabilities for possible dealer work.

## Stage 6 — create application credentials

1. Create a dedicated Home Assistant user named for the application.
2. Grant only the access required by the selected Home Assistant version and deployment model.
3. Generate a long-lived access token from that user's profile.
4. Store the token only in the backend secret manager.
5. Never paste the token into source code, screenshots, GitHub, or browser JavaScript.

## Stage 7 — choose remote access

Preferred: Home Assistant Cloud remote access.

1. Enable the remote connection.
2. Record the remote base URL in the backend's secret environment.
3. Do not expose router port 8123 directly.
4. Confirm Home Assistant is reachable from cellular data before integrating the app.

## Stage 8 — deploy the app

1. Configure backend secrets.
2. Run `/api/health`.
3. Run admin discovery.
4. Review and approve entity mappings.
5. Test one device of each supported class.
6. Publish the dashboard.
7. Add the PWA to the iPhone home screen.

## Stage 9 — acceptance checklist

- [ ] Green is updated and has a stable network address
- [ ] Control4 integration is healthy
- [ ] One light works
- [ ] One dimmer works
- [ ] One shade works
- [ ] Climate state is accurate
- [ ] One scene works
- [ ] Remote access works over cellular
- [ ] Application secret is server-side only
- [ ] Dashboard loads on phone and desktop
- [ ] Failed commands are visible as failures
- [ ] Audit log records commands
- [ ] Backup is enabled

## Information to bring to a fresh chat

Provide the repository name `daschreiber/smarthome` and say:

> Read the repository specifications and continue from the installation runbook. The Home Assistant Green is connected. Help me commission Control4, export the entity inventory, and finish the MVP app.

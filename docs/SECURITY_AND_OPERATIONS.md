# Security and Operations

## 1. Trust boundaries

The system has four separate trust zones:

1. Browser/PWA
2. Application backend
3. Home Assistant Green
4. Control4 controller and household devices

The browser is never trusted with Home Assistant or Control4 credentials.

## 2. Secrets

Server-side only:

- Home Assistant long-lived token
- Application session secret
- Database credentials
- Remote-access URL if treated as private

Never commit:

- Control4 password
- Home Assistant token
- Control4 Director token
- Controller registration code
- Router credentials
- raw diagnostic exports containing any of the above

Provide `.env.example`, but never `.env`.

## 3. Authentication

MVP should use a reputable identity provider or passwordless email sign-in with an explicit allow-list. Only approved household accounts can access the application.

Use short-lived application sessions. Do not make the Home Assistant token the user's session credential.

## 4. Authorization

Roles:

- `admin`: mappings, users, diagnostics, all approved controls
- `member`: normal approved controls (named `household` in early drafts)
- `guest`: optional, limited rooms/scenes

Security-sensitive domains remain disabled by default.

## 5. Network exposure

- Do not port-forward Home Assistant port 8123.
- Prefer Home Assistant Cloud, VPN, or an outbound tunnel.
- Keep Home Assistant Green and Control4 on a trusted home network.
- Use Ethernet for Green and Control4 where possible.
- Use HTTPS for every remote application connection.

## 6. Least privilege

The browser API exposes only named application commands. It does not expose:

- arbitrary Home Assistant service calls
- raw entity IDs
- configuration endpoints
- token creation
- add-on or supervisor management

The Home Assistant application user should be a non-administrator user. Be aware of the real limit: Home Assistant has no per-entity or per-service permissions for regular users, so the application's long-lived token can still call services on any entity. Non-admin status protects configuration, add-ons, and user management — the effective control boundary for device commands is the backend's server-side allow-list, which is why no generic service-call endpoint may ever exist.

## 7. Command safety

- Confirm whole-home or disruptive scenes.
- Rate-limit command endpoints.
- Deduplicate rapid repeated commands.
- Put temperature and volume bounds in server policy.
- Do not automatically retry non-idempotent compound scenes.
- Disable locks, alarms, gates, and garage controls until separately reviewed.

### Known LAN exposure: CoolMaster console

The CoolMaster HVAC bridge (10.0.0.90) accepts **unauthenticated** ASCII
commands on TCP port 10102 — anyone on the house WiFi can read and command
every A/C unit. This is how the device ships; it is the same channel Home
Assistant's `coolmaster` integration uses. The app never talks to it directly
(only via Home Assistant), but treat LAN access as HVAC control: keep guests
on a guest SSID, and never port-forward 10102.

### Home Assistant `shell_command`: never templated

Home Assistant renders service data into a `shell_command` and then runs the
result **through a shell**; a command with no template is exec'd as argv
instead. So any `{{ … }}` in a `shell_command` is arbitrary command execution
inside the HA container for anyone who can call the service — and §6 above is
exactly why that matters here: HA has no per-service permissions for regular
users, so the non-admin `smarthome-app` token, which lives in an
internet-facing app's environment, can reach every service.

The Control4 repoint service (`ha/c4_recovery.yaml`) is written to that rule:
a fixed argv with the Core 3's MAC as a literal, and `c4_repoint.py` resolves
the address from the ARP table itself. It takes no caller input at all, so the
worst any caller can do is point the config entry at the machine that owns
that MAC — which is the only thing it is for, and a no-op when it is already
the host. Repointing at an address the scan cannot see is a deliberate
by-hand act: run the script on the Green directly.

## 8. Logging

Record:

- user
- stable device/scene ID
- command
- timestamp
- result
- latency
- normalized error

Never record tokens, passwords, authorization headers, or complete upstream payloads by default.

## 9. Backups and recovery

- Enable automatic Home Assistant backups.
- Keep an encrypted backup outside the Green.
- Keep application configuration and mappings in version control without secrets.
- Document how to rotate the Home Assistant token.
- Maintain a rollback path for application releases.

## 10. Maintenance

Monthly:

- review Home Assistant and Control4 availability
- review failed commands
- confirm backups are completing

Before upgrades:

- take a backup
- run representative-device regression tests
- record current versions

After upgrades:

- verify integration health
- test one light, shade, climate zone, and scene
- check entity IDs have not changed

## 11. Incident response

If unexpected control occurs:

1. Disable the application deployment or revoke its session access.
2. Revoke the Home Assistant long-lived token.
3. Review application audit logs.
4. Check Home Assistant logs and user sessions.
5. Rotate secrets before restoring service.

If Home Assistant fails, Control4 and its normal interfaces should continue operating independently.

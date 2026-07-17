# Test Plan

## 1. Test layers

### Unit tests

- Entity mapping validation
- Capability detection
- Command-to-service translation
- Safety/confirmation rules
- Error normalization
- Authentication and authorization

### Integration tests with mocked Home Assistant

- State inventory
- Service calls
- Timeout and retry behavior
- Unavailable and unknown states
- Malformed upstream responses
- Home Assistant authentication failure

### Live commissioning tests

Run against selected reversible devices only.

## 2. Device-class acceptance tests

### Light

- Read on/off state
- Turn on
- Turn off
- Set brightness where supported
- Confirm physical and reported state agree
- Handle unavailable state

### Cover

- Read open/closed/position state
- Open
- Stop
- Close
- Set position where supported
- Avoid repeated conflicting commands

### Climate

- Read current temperature (Control4 zone entity)
- Read target temperature (zone's first CoolMaster unit entity — the Control4
  entity never reports a real setpoint)
- Set target temperature within configured safe bounds; verify the write
  lands on ALL of the zone's CoolMaster units (kitchen has 3, lounge 2)
- On/off routes to the CoolMaster units; verify the Control4 zone state
  follows within ~4-8s (that is what the read-back confirms against)
- Setpoint read-back: "confirmed" only when the unit reports the requested
  target; "sent" when the coolmaster integration is absent
- Reject unsupported HVAC modes
- Confirm unit conversion is not occurring unexpectedly (bridge is °C)

### Scene/script

- Trigger once
- Require confirmation where configured
- Prevent accidental rapid double execution
- Refresh affected device states afterward

### Media

- Test only advertised capabilities
- Power on/off
- Volume set within bounds
- Confirm unsupported transport functions are hidden

## 3. End-to-end scenarios

1. Open the app on home Wi-Fi and control a favorite light.
2. Open the app on cellular data and control the same light.
3. Trigger Good Night and confirm affected states refresh.
4. Disconnect Home Assistant network access and verify a clear failure.
5. Make one Control4 entity unavailable and verify the app does not pretend it succeeded.
6. Tap a command twice quickly and verify behavior is safe and understandable.
7. Use two browsers simultaneously and verify state converges.
8. Restart Home Assistant Green and verify recovery without manual reconfiguration.
9. Restart the Control4 controller and verify recovery.
10. Rotate the Home Assistant token and verify the old token stops working.
11. Restart the Control4 integration (or Home Assistant) while the internet connection is up but note the dependency: integration re-authentication requires the Control4 cloud. If a controlled test is possible, block outbound access from Home Assistant to Control4 cloud endpoints and confirm that already-authenticated local control keeps working and that the failure mode after a restart is visible and understandable.

## 4. Performance targets

- Dashboard initial response: under 2 seconds on a normal connection, excluding cold starts
- Command acknowledgement: under 1 second
- Confirmed state: ordinarily under 5 seconds
- State polling while active: every 2–5 seconds for MVP
- No uncontrolled retry storms

## 5. Security tests

- Browser bundle contains no `HA_TOKEN`
- API rejects unauthenticated calls
- API rejects raw entity IDs supplied by the browser
- API rejects arbitrary Home Assistant domain/service names
- Non-admin user cannot modify mappings
- Logs redact authorization headers and tokens
- Rate limits apply to command endpoints
- CORS permits only approved origins

## 6. Regression inventory

After the entity mapping is known, maintain a small list of representative real devices:

- one binary light
- one dimmer
- one shade
- one climate zone
- one scene
- one media room, if supported

Run these checks after Home Assistant, Control4, or application upgrades.

## 7. Release gate

Do not call a release usable until:

- all supported device classes pass a live test
- remote access works
- no secret appears in source or browser tools
- backup/restore has been configured
- known unsupported devices are documented
- a rollback path exists

# Product Specification — Smart Home Control

## 1. Goal

Build a private, simple web and phone-friendly application that controls the existing Control4 home through Home Assistant Green.

The first version should make common household controls faster and clearer than Alexa or the standard Control4 interface, without attempting to replace the full Control4 dealer configuration.

## 2. Primary users

- Daniel
- Daniella
- Trusted household members added later

## 3. Core jobs to be done

1. See the current state of important rooms and devices.
2. Turn lights on and off and adjust dimmers.
3. Open, close, and position shades.
4. View and change climate set-points where exposed.
5. Trigger household scenes such as Good Night, Away, Movie, and All Off.
6. Control basic room media where Home Assistant exposes it reliably.
7. Use the same interface on a phone, tablet, or web browser.

## 4. MVP scope

### Included

- Responsive progressive web app (PWA)
- Secure sign-in
- Home dashboard
- Room-by-room navigation
- Lights and dimmers
- Covers/shades
- Climate controls
- Scene/script buttons
- Basic media controls if exposed by Control4
- Device availability and last-update indication
- Favorites
- Confirmation for broad or disruptive commands such as All Off
- Audit log of commands issued by the app

### Excluded from MVP

- Alarm disarming
- Door-lock control (Yale locks planned for a later phase)
- Sauna control (remains on the manufacturer's app until a later phase)
- Garage or gate control
- Camera streaming
- Intercom
- Dealer-level Control4 programming
- Arbitrary execution of Home Assistant services
- Voice control
- AI-generated automations

These may be added only after the core system is stable and permissions are deliberately designed.

## 5. Success criteria

The MVP is successful when:

- At least 90% of everyday light, shade, climate, and scene actions work reliably.
- A command normally completes or visibly fails within five seconds.
- Device state shown in the app is not materially stale.
- The system continues to function locally if the cloud application is temporarily unavailable.
- No Home Assistant or Control4 secret is exposed in browser code.
- Daniel can add the app to an iPhone home screen and use it like an app.

## 6. User experience principles

- Default to rooms and scenes, not technical device lists.
- Make the current state obvious.
- Keep primary actions one tap away.
- Separate ordinary controls from security-sensitive controls.
- Never present a command as successful until Home Assistant confirms it.
- Prefer a small number of reliable controls over complete but confusing coverage.

## 7. Initial screen structure

### Home

- Favorites
- Whole-home scenes
- Rooms with summary state
- Connectivity status

### Room

- Lights
- Shades
- Climate
- Media
- Room-specific scenes

### Settings

- Entity mapping
- Favorites
- User access
- Diagnostics
- Command history

## 8. Design assumptions

- Home Assistant Green and Control4 Core 3 are on the same wired network.
- Home Assistant's official Control4 integration discovers supported entities.
- Home Assistant is the only component that talks directly to Control4.
- The custom application talks only to Home Assistant or to a narrow backend that proxies Home Assistant.
- Home Assistant entity IDs are not suitable as user-facing labels and will be mapped to friendly names and rooms.

## 9. Open questions to resolve after installation

- Exact entities exposed by Control4 within the four supported domains (`light`, `cover`, `climate`, `media_player`)
- ~~Whether Control4 scenes appear as Home Assistant entities or services~~ Resolved: they do not. The official integration exposes no scene, switch, script, or lock entities; household scenes will be built as Home Assistant scenes/scripts.
- Quality of room-media support
- Sauna brand/model and its controlling app, to identify the matching Home Assistant integration for a later phase
- Yale lock model and connection type (Control4 Zigbee mesh vs. Yale Access/August Wi-Fi module), which determines whether a Home Assistant path exists at all
- Whether Home Assistant Cloud remote access will be used
- Whether any custom dealer-created virtual switches or scenes are needed
- Which actions merit confirmation
- Preferred visual style and room order

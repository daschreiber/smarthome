# Design and Delivery Loop

This project should be developed through short, evidence-based loops rather than by guessing at the Control4 installation.

## Loop 0 — preserve context

Before each major change:

- Read this repository's README and specifications.
- Record current Home Assistant and Control4 versions.
- Do not commit credentials or raw diagnostic exports containing secrets.
- Work on a feature branch once application code exists.

## Loop 1 — discover

Input: live Home Assistant entity and service inventory.

Actions:

1. Enumerate states and supported services.
2. Group candidates by domain and Home Assistant Area.
3. Identify duplicate, unavailable, and unclear entities.
4. Capture supported features rather than assuming capabilities.
5. Produce an entity-mapping draft.

Output: reviewed inventory and known gaps.

## Loop 2 — prove the vertical slice

Implement the smallest complete path:

```text
One button in browser
→ authenticated backend
→ Home Assistant service call
→ Control4
→ one physical light
→ confirmed state in browser
```

Do not build the full interface until this path is reliable locally and remotely.

## Loop 3 — model

Create stable application models for:

- rooms
- devices
- states
- capabilities
- scenes
- commands
- users
- audit events

Raw Home Assistant payloads must remain behind an adapter. The UI should not depend directly on entity attributes that may vary by integration.

## Loop 4 — design

For each screen:

1. State the user task.
2. Show current state before controls.
3. Put frequent controls first.
4. Show pending, confirmed, failed, unavailable, and stale states.
5. Test on an iPhone-sized viewport first.
6. Remove controls that are unreliable or ambiguous.

## Loop 5 — implement

For each feature:

1. Add or update a typed backend command.
2. Add validation and authorization.
3. Add Home Assistant adapter logic.
4. Add tests using mocked Home Assistant responses.
5. Test against one real entity.
6. Expand only after the first entity works.

## Loop 6 — verify

Every feature must pass:

- happy path
- unavailable device
- Home Assistant timeout
- unsupported capability
- repeated tap / duplicate command
- stale state
- unauthorized user
- mobile layout

## Loop 7 — observe

Record:

- command latency
- failure rate
- unavailable entities
- mapping errors
- upstream error messages, with secrets removed

The diagnostics screen should make failures understandable without exposing credentials.

## Loop 8 — refine

After household use:

- promote frequently used controls to Favorites
- simplify labels
- create compound scenes for repeated sequences
- remove low-value controls
- ask the Control4 dealer to expose missing functions as scenes or virtual switches

## Definition of done for MVP

- Installation runbook completed
- Entity mapping reviewed
- Core domains controlled reliably
- Secure remote use confirmed
- PWA installed on phone
- Backups configured
- Tests documented and passing
- Known limitations recorded

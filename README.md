# Smart Home Control Project

## Objective

Build a private app that can control the existing Control4 smart-home system without relying on Alexa or the standard Control4 interface.

## Current home setup

- Control4 controller: Core 3
- Control4 OS: 3.4.3.727848-res
- Existing interfaces: Control4 app and Alexa
- Homeowner Control4 credentials work with Control4 cloud authentication
- Home Assistant Green has been selected as the likely local bridge device

## What we established

### 1. Homeowner credentials are sufficient for local API authentication

The open-source `pyControl4` library can authenticate using the same Control4 username and password used by the homeowner app. It retrieves:

- the Control4 account token
- the registered controller record
- a Director bearer token intended for controller access

No dealer or Composer Pro credentials are required for ordinary local API control.

### 2. The relevant Control4 API is local

`pyControl4` and Home Assistant use the controller's built-in REST API over the home network.

Expected architecture:

```text
Custom app / cloud service
        ↓
Home Assistant Green on the home network
        ↓
Control4 Core 3 local REST API
        ↓
Lights, shades, climate, media, scenes
```

### 3. Cloud-only access was investigated

Several tests were run against Control4's cloud account APIs. They exposed:

- controller identity
- OS version
- registration status
- 4Sight licence information
- users and dealer metadata
- Director authorization capability

They did **not** expose:

- a remote controller hostname
- a relay URL
- a proxy address
- a WebSocket endpoint
- a tunnel address
- a public cloud-control endpoint

Conclusion: the Control4 cloud can authenticate the homeowner and identify the controller, but the remote-control path used by Alexa and the official Control4 app appears to be a separate private relay service. The same local REST API cannot simply be pointed at a public cloud address.

### 4. Alternative architecture considered

A dealer-installed custom Control4 driver could run directly on the Core 3 and open an outbound HTTPS or WebSocket connection to a private cloud service. This would avoid a separate local device, but would require dealer support and custom DriverWorks development.

Dealer: Kahane, Herzliya.

### 5. Why Home Assistant Green was chosen

Home Assistant Green is preferred over a Raspberry Pi because it is preassembled, has Home Assistant installed, and requires little setup. It includes Ethernet, power supply, 4 GB RAM and 32 GB storage. No Zigbee, Thread or Z-Wave dongles are required for this Control4 project.

An Apple TV or Aqara Hub M3 cannot serve as the bridge because neither permits a general-purpose always-on local service such as Home Assistant, Python or Docker.

## Expected supported Control4 device classes

Likely to work through Home Assistant's Control4 integration:

- lights and dimmers
- shades, blinds and covers
- thermostats and climate
- room media controls
- standard scenes or exposed actions

Potential gaps:

- bespoke Composer programming
- custom keypad events
- complex AV routing
- security functions
- dealer-installed proprietary drivers
- scenes not exposed as standard Control4 entities

Those gaps may require the dealer to expose actions as scenes, virtual switches or experience buttons.

## Next steps when Home Assistant Green arrives

1. Connect Home Assistant Green to power and Ethernet on the same network as the Control4 Core 3.
2. Open Home Assistant in a browser and complete initial setup.
3. Add the official Control4 integration.
4. Enter the Control4 controller's local IP address plus the ordinary homeowner username and password.
5. Confirm which lights, shades, thermostats, rooms and media devices appear.
6. Test read-only state first, then a harmless device command such as toggling one light.
7. Record any Alexa-visible actions that do not appear in Home Assistant.
8. Decide whether to build the custom app against Home Assistant's REST/WebSocket API or connect more directly with `pyControl4`.
9. For remote access, use Home Assistant Cloud, Tailscale, a VPN or a private outbound relay. Do not expose the Control4 controller directly to the public internet.

## Security notes

- Do not commit Control4 passwords, bearer tokens or registration codes to GitHub.
- Store credentials in Home Assistant's secrets/configuration mechanisms.
- Prefer outbound encrypted connections from the home network.
- Avoid public port forwarding to the Control4 controller.

## Resume prompt for a future chat

> Continue the Control4 smart-home project in `daschreiber/smarthome`. Read the README first. The Home Assistant Green has now arrived; guide me step by step through connecting it to my Control4 Core 3 and testing the official Home Assistant Control4 integration.

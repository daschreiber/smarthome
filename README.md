# Smart Home Control Project

## Objective

Build a private app that can control the existing Control4 smart-home system without relying on Alexa or the standard Control4 interface.

## Current home setup

- Control4 controller: Core 3
- Control4 OS: 3.4.3
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
- a WebSocket
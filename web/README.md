# smarthome-web

The application backend + PWA (vertical slice stage, Loop 2).

## Run locally (Mac on the home LAN)

```bash
cd web
npm install
cp .env.example .env.local   # then fill in HA_TOKEN (and APP_KEY if desired)
npm run dev
```

Open http://localhost:3000 — you should see Daniel's Study with live device
states. Buttons send typed commands through the backend; the UI only shows
what Home Assistant confirms.

## Endpoints

- `GET  /api/health` — app + Home Assistant reachability
- `GET  /api/home` — all visible devices joined with live state
- `POST /api/devices/:deviceId/command` — typed command (zod-validated)
- `GET  /api/activity` — recent audit events (JSONL-backed)

If `APP_KEY` is set in the environment, all endpoints require the
`x-app-key` header; the UI has a field for it (stored in localStorage).
This is a slice-level gate only — real sign-in lands in Phase C.

## Tests

```bash
npm test         # vitest: command mapping + registry
npm run typecheck
```

## Design notes

- `src/lib/registry.ts` — loads `data/entity_map.json` (repo root), builds
  stable app device IDs; raw HA entity IDs never reach the browser.
- `src/lib/ha.ts` — the only module that talks to Home Assistant (REST,
  5s timeout, no blind command retries).
- `src/lib/commands.ts` — typed semantic command layer; the future
  conversational layer calls this same surface.
- `src/lib/audit.ts` — append-only JSONL audit of every command.

- `src/lib/sauna.ts` — adapter for the KLAFS sauna service
  (github.com/daschreiber/sauna on Vercel). With `SAUNA_BASE_URL` +
  `SAUNA_API_TOKEN` set, the sauna joins the registry as a virtual device
  (room "Sauna", on_off + set_temperature 40–100°C). Sauna commands are
  safety-tiered: every command must include `"confirm": true` or the API
  answers 428. The KLAFS heating-verification/watchdog logic stays in the
  sauna app; this backend only consumes its `/api/quick/*` endpoints.

Deployment target (Phase D): an always-on Node host (e.g. Railway), with
`HA_BASE_URL` switched to the Home Assistant Cloud remote URL and secrets in
the host's environment settings.

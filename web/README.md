# smarthome-web

The application backend + PWA: a Next.js (App Router) app serving both the
phone UI and the typed API in front of Home Assistant. Deployed on Railway
(root directory `web`, branch `main` auto-deploys — see
`docs/DEPLOY_RAILWAY.md`).

## Run locally (Mac on the home LAN)

```bash
cd web
npm install
cp .env.example .env.local   # fill in HA_BASE_URL + HA_TOKEN at minimum
npm run dev
```

Open http://localhost:3000. With no users configured, dev mode is open;
production fails closed unless auth is configured. The full environment
variable reference is the table in `docs/DEPLOY_RAILWAY.md`.

## API

The complete, accurate surface (~30 routes) is documented in
`docs/API_CONTRACT.md`. Auth is a session cookie (password or Google
sign-in) with roles `admin/member/guest`; state-changing calls land in the
append-only audit log.

## Tests

```bash
npm test         # vitest — 20+ suites across the lib layer
npm run typecheck
```

## Layout

- `src/app/` — pages (Home, Automations, Assistant, Systems, More, Users,
  Activity) and the API route handlers under `src/app/api/`.
- `src/lib/` — the domain layer; route handlers stay thin. Highlights:
  - `registry.ts` — loads `data/entity_map.json` (repo root, hand-maintained;
    the `web/data/` copy must stay identical — `dataSync.test.ts` enforces
    it), builds stable app device IDs; raw HA entity IDs never reach the
    browser. Virtual devices (sauna, bed, noise, heating) join here.
  - `ha.ts` — the only module that talks to Home Assistant (REST, 5s
    timeout, no blind command retries).
  - `commands.ts` — pure typed command layer: schema, capability checks,
    command→service-call translation. `execute.ts` is the shared execution
    path on top of it.
  - `assistant.ts` — translates LLM proposals into the same typed actions;
    it never executes anything itself.
  - `scheduler.ts` + `sleepwatch.ts` + `saunawatch.ts` — the minute-tick
    automation engine and the two standing watchers.
  - `audit.ts` — append-only JSONL audit log.
- `data/` — deploy-time copy of the repo-root `data/` JSON inputs (Railway
  builds with `web` as root, so `../data` is unavailable there).

## Domain notes

- **Climate** bypasses Control4: commands go to the CoolMaster units
  (`coolmaster.ts`); zone state is read from Control4 entities that mirror
  the bridge. See the root README.
- **Shades** are native HA KNX covers with trusted positions
  (`COVER_STATE_TRUSTED=1`); see `knx/README.md`.
- **Sauna** commands are safety-tiered: every command must include
  `"confirm": true` or the API answers 428. The KLAFS watchdog logic lives
  in the separate sauna service; this backend only consumes its
  `/api/quick/*` endpoints.

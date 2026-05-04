# DP Isolate Test Client

Small browser client for the two DP-isolate endpoints:

- `POST /api/incident/isolation/enable/{asset_id}`
- `POST /api/incident/isolation/disable/{asset_id}`

When resuming this DP Isolate test-client work and asking "what's next?",
use `TASKS.md` in this directory as the source of truth for the next action.

Run from `sdcc-tests`:

```bash
make run-dp-isolate
```

For client-only development:

```bash
npm run dp-isolate-client
```

The Vite dev server proxies `/api/*` to `http://localhost:8000` by default.
Override with:

```bash
PORTAL_ORIGIN=http://localhost:8000 npm run dp-isolate-client
```

In dev mode the app reads defaults from the workspace root `.env`,
`docker/legacy-portal/.env`, and `client/dp-isolate/.env.local`.
Later files and process environment values override earlier files.

```dotenv
PORTAL_USER=twister@example.com
PORTAL_PASSWORD=...
DP_ISOLATE_AUTO_LOGIN=1
DP_ISOLATE_ASSET_ID=24-character-default-asset-id
```

`DP_ISOLATE_ASSET_ID` prefills the Selected Asset ID field on page load and
wins over the last browser-selected asset when it is set. `DP_ISOLATE_AUTO_LOGIN=0`
disables automatic login.

The asset picker also uses a local-only Vite endpoint,
`/__dp-isolate-topology`, to read sanitized MongoDB topology facts from the
Docker Mongo container. This lets the picker show the active incident's primary
scrubbing center, backend, selected DPs, and whether that SC has DPs in
`attack_zone`. Rows with active incidents but no Attack Zone DPs are shown as
blocked and are not selectable from the picker.

## Database fixtures

The client is meant to be used with swappable local MongoDB snapshots for
different DP Isolate cases. From `sdcc-tests`:

```bash
npm run dp-isolate-fixtures:list
npm run dp-isolate-fixtures:capture -- no-attack-zone-dps --description "No DPs in Attack Zone"
npm run dp-isolate-fixtures:restore -- no-attack-zone-dps --yes
```

Restoring a fixture runs `mongorestore --drop` against the configured database,
so treat it as a destructive replacement of the local lab DB state. Snapshot
archives are stored under `fixtures/dp-isolate/` and ignored by git.

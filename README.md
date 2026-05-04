# sdcc-tests

No-prod SDCC test and tooling workspace.

## DP Isolate local app

From this directory:

```bash
make run-dp-isolate
```

This starts the legacy portal Docker Compose stack, starts the DP Isolate Vite
client in the background, and opens the client in a browser window.

Useful targets:

```bash
make                  # help
make status           # portal/client status
make dp-isolate:start # start portal, client, and browser
make dp-isolate:restart
make dp-isolate:rebuild
make dp-isolate:stop
make dp-isolate:status
make portal-up        # start legacy portal Docker
make client-up        # start only the DP Isolate client
make open-dp-isolate  # open the client URL
make logs             # show recent portal/client logs
make stop             # stop client and portal
```

Defaults:

- Legacy portal: `http://localhost:8000`
- DP Isolate client: `http://localhost:5173`
- Docker Compose profile: `internal-mongo`

Override with environment variables such as `LEGACY_PORTAL_PORT`,
`DP_ISOLATE_CLIENT_PORT`, `PORTAL_ORIGIN`, and `DP_ISOLATE_COMPOSE_PROFILE`.
Set `DP_ISOLATE_COMPOSE_PROFILE=none` to run Compose without a profile, for
example when the portal should connect to a native MongoDB process instead of
the internal Compose MongoDB service.

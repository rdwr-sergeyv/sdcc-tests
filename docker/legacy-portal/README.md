# Legacy Portal Docker Smoke Harness

This is a first-pass development container for the legacy Django portal.
It is not a production image and does not try to reproduce the legacy
nginx/uwsgi/systemd installation.

From the workspace root:

```bash
docker compose -f sdcc-tests/docker/legacy-portal/docker-compose.yml up --build
```

From `sdcc-tests`, the DP Isolate helper can start this stack and the test
client together:

```bash
make run-dp-isolate
```

Then open:

```text
http://localhost:8000/
```

The compose stack writes a minimal `/etc/sdcc/sdcc.conf`, connects to MongoDB,
bootstraps the minimal SDCC default database documents needed for the portal,
and runs the portal:

```bash
python manage.py runserver 0.0.0.0:8000
```

It also starts two separate backend containers for the Docker-required workers
used by the isolation queue flow:

```text
incident-manager -> sdcc-incident-manager.py, backend role: master
cmd-executor     -> sdcc-cmd-executor.py, backend role: monitor
```

Backend-involved helper modes default to `SDCC_TASK_TYPE=build`. In this mode
`cmd-executor` builds/generated commands and marks tasks complete without
executing commands on devices. Override with `SDCC_TASK_TYPE=provisioning` only
for a lab run that should touch devices.

Production runs these through systemd on separate backend roles. The Docker
harness mirrors that split with one process per container and relies on Compose
restart policy instead of systemd.

Activate SDCC licensed modules in both backend worker containers:

```bash
make -C sdcc-tests portal-license-backends
```

From the workspace root, this equivalent shortcut is also available:

```bash
make license-backends
```

The helper runs `sdcc-manage-module` in `incident-manager` and `cmd-executor`
using `eth0`. Optional overrides:

```bash
SDCC_LICENSE_IFN=eth0 make -C sdcc-tests portal-license-backends
SDCC_LICENSE_SERVICES=incident-manager,cmd-executor make -C sdcc-tests portal-license-backends
SDCC_LICENSE_MODULES=sdcc_cmd_executor,sdcc-alert-manager make -C sdcc-tests portal-license-backends
```

Reset the seeded database with:

```bash
docker compose -f sdcc-tests/docker/legacy-portal/docker-compose.yml down -v
```

By default the portal connects to the compose MongoDB service, which bind-mounts
the local lab data directory from `LEGACY_PORTAL_MONGO_DB_PATH`.

```bash
docker compose -f sdcc-tests/docker/legacy-portal/docker-compose.yml --profile internal-mongo up --build
```

Stop any native `mongod` process before using this mode; MongoDB data files must
not be opened by two server processes at the same time.

To connect the portal container to a native MongoDB process instead, set:

```dotenv
SDCC_MONGO_HOST=host.docker.internal
```

and run compose without `--profile internal-mongo`.

Path and port defaults live in `.env` next to this compose file:

```dotenv
SDCC_REPO_PATH=../../../sdcc
SDCC_PORTAL_REPO_PATH=../../../sdcc-portal
LEGACY_PORTAL_PORT=8000
LEGACY_PORTAL_MONGO_IMAGE=mongo:8.2
LEGACY_PORTAL_MONGO_PORT=27017
LEGACY_PORTAL_MONGO_DB_PATH=../../.tmp/legacy-portal-mongo-db
SDCC_MONGO_HOST=mongo
SDCC_MONGO_PORT=27017
SDCC_MONGO_DB=sdcc
SDCC_PORTAL_PUBLIC_URL=http://localhost:8000
```

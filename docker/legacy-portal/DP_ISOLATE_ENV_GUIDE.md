# DP Isolate Legacy Portal Environment Guide

This guide assumes you have access to an existing legacy CDDOS environment and
helps you replicate it on a laptop or any other environment with Docker
available.

The goal is to recreate enough of the legacy portal environment to integrate
against the DP Isolate API endpoints.

## What You Need

Required source repositories:

```text
workspace/
├── sdcc/          # legacy backend/common code
└── sdcc-portal/   # legacy Django portal/API code
```

Required environment artifacts:

- Docker Compose setup for the legacy portal harness.
- A MongoDB dump/archive from the original environment, or direct access to the
  lab MongoDB that contains representative DP Isolate data.
- Portal credentials for an operator admin/super user.

If you receive a prepared environment bundle from Sergey, it should include the
Docker files, helper scripts, API examples, and optionally a Mongo archive. You
can place that bundle anywhere, as long as its Docker Compose paths point to
your local `sdcc/` and `sdcc-portal/` clones.

## API Endpoints

The integration endpoints are:

```text
POST /api/incident/isolation/enable/{asset_id}
POST /api/incident/isolation/disable/{asset_id}
```

`{asset_id}` is a 24-character Mongo ObjectId for the asset.

Enable body:

```json
{
  "trigger": "manual"
}
```

`trigger` can be `manual` or `auto`. Invalid or omitted values fall back to
`manual`.

Disable body:

```json
{}
```

Expected success/no-op response:

```json
{
  "reply": "OK"
}
```

## Docker Harness Shape

The replicated local stack runs the portal plus the legacy backend services:

```text
mongo            # local MongoDB restored from lab/fixture data
portal           # Django legacy portal, exposes http://localhost:8000
minimal profile  # mongo, portal, incident-manager, cmd-executor
full profile     # mongo, portal, and all ported backend services
```

All backend services are associated with one hybrid backend in Docker. The
launcher defaults to `DP_ISOLATE_COMPOSE_PROFILE=minimal`; set it to `full` to
run the complete ported service set.

The split matters:

- `incident-manager` moves incident work from `in_queue` to `pending`.
- `cmd-executor` moves tasks from `pending` to `in_progress`, then `done` or
  `failed`.

The local helper defaults backend-involved modes to `SDCC_TASK_TYPE=build`.
That lets `cmd-executor` resolve dependencies and build/generated commands
without executing them against devices. Set `SDCC_TASK_TYPE=provisioning`
explicitly only for a lab run that should execute commands on devices.

If only the portal is running, API calls can create tasks but execution may not
finish.

## Suggested Local Layout

Example:

```text
workspace/
├── sdcc/
├── sdcc-portal/
└── legacy-portal-docker/
    ├── docker-compose.yml
    ├── Dockerfile
    ├── entrypoint.sh
    ├── sdcc.conf
    └── fixtures/
        └── default/
            └── sdcc.archive.gz
```

The Docker Compose file should build with both source trees available as build
contexts or bind mounts.

Typical path variables:

```dotenv
SDCC_REPO_PATH=../sdcc
SDCC_PORTAL_REPO_PATH=../sdcc-portal
LEGACY_PORTAL_PORT=8000
LEGACY_PORTAL_MONGO_IMAGE=mongo:8.2
LEGACY_PORTAL_MONGO_PORT=27018
LEGACY_PORTAL_MONGO_DB_PATH=../../.tmp/legacy-portal-mongo-db
SDCC_MONGO_HOST=mongo
SDCC_MONGO_PORT=27017
SDCC_MONGO_DB=sdcc
SDCC_PORTAL_PUBLIC_URL=http://localhost:8000
```

Adjust paths for your machine.

## Starting The Stack

From the directory that contains `docker-compose.yml`:

```bash
docker compose --profile internal-mongo up --build -d
```

Check services:

```bash
docker compose ps
docker compose logs --tail 120
```

Open:

```text
http://localhost:8000
```

## Restoring Data From The Original Environment

You need a Mongo database with:

- `DPZones`, including `name: "attack_zone"`.
- `Accounts`
- `ScrubbingCenters`
- `Assets`
- `Incidents`
- task collections for execution/history if needed.

If you have a Mongo archive:

```bash
docker cp sdcc.archive.gz <mongo-container>:/tmp/sdcc.archive.gz
docker exec <mongo-container> mongorestore --drop --archive=/tmp/sdcc.archive.gz --gzip --db sdcc
docker exec <mongo-container> rm -f /tmp/sdcc.archive.gz
```

If the archive was created from database `sdcc`, this restores into local
database `sdcc`.

If you need to restore only the DP Isolate-relevant collections from a larger
archive, use namespace filters:

```bash
docker exec <mongo-container> mongorestore --drop \
  --archive=/tmp/sdcc.archive.gz \
  --gzip \
  --nsFrom='sdcc.*' \
  --nsTo='sdcc.*' \
  --nsInclude='sdcc.DPZones' \
  --nsInclude='sdcc.Accounts' \
  --nsInclude='sdcc.ScrubbingCenters' \
  --nsInclude='sdcc.Assets' \
  --nsInclude='sdcc.Incidents' \
  --nsInclude='sdcc.BackupIncidents' \
  --nsInclude='sdcc.Tasks' \
  --nsInclude='sdcc.AssetTasksLogs' \
  --nsInclude='sdcc.Alerts'
```

## Preparing A Clean Happy-Path Test State

For a clean API integration run, pick one asset with an active incident and
Attack Zone DefensePro availability.

Recommended cleanup for a test-only database:

```javascript
db.Tasks.deleteMany({});
db.AssetTasksLogs.deleteMany({});
db.BackupIncidents.deleteMany({});

db.Incidents.find({}).forEach((incident) => {
  let changed = false;
  if (incident.in_queue) {
    incident.in_queue = false;
    changed = true;
  }
  (incident.diversion || []).forEach((diversion) => {
    if ((diversion.tasks || []).length) {
      diversion.tasks = [];
      changed = true;
    }
    if (diversion.state && (diversion.state.curr_tasks || []).length) {
      diversion.state.curr_tasks = [];
      changed = true;
    }
  });
  if (changed) {
    db.Incidents.replaceOne({ _id: incident._id }, incident);
  }
});
```

Run it with:

```bash
docker exec -it <mongo-container> mongosh sdcc
```

Then paste the JavaScript above.

Notes:

- Deactivated diversions may be kept for retrospection.
- A deactivated diversion with `zone: null` is acceptable.
- For a test-only DB, removing deactivated diversions is also acceptable if you
  want the fixture to behave like no old diversion existed.

## Verifying The Test Asset

In `mongosh`:

```javascript
const assetId = ObjectId("PUT_ASSET_ID_HERE");
const incident = db.Incidents.findOne({ asset: assetId, endedAt: null });
printjson({
  incident: incident && String(incident._id),
  status: incident && incident.status,
  in_queue: incident && incident.in_queue,
  isolated: !!(incident && incident.isolation_state && incident.isolation_state.isolated),
  zones: incident && (incident.diversion || []).map((d) => d.zone && String(d.zone)),
  taskCounts: incident && (incident.diversion || []).map((d) => (d.tasks || []).length),
  currTaskCounts: incident && (incident.diversion || []).map((d) => ((d.state && d.state.curr_tasks) || []).length),
  tasks: db.Tasks.countDocuments({}),
  assetTaskLogs: db.AssetTasksLogs.countDocuments({})
});
```

Expected before a clean happy-path run:

```text
in_queue: false
isolated: false
tasks: 0
assetTaskLogs: 0
```

## Manual API Calls

Login first:

```bash
curl -i -c cookies.txt \
  -H 'Content-Type: application/json' \
  -d '{"u":"twister@example.com","p":"PASSWORD"}' \
  http://localhost:8000/api/auth/
```

Enable:

```bash
curl -i -b cookies.txt \
  -H 'Content-Type: application/json' \
  -d '{"trigger":"manual"}' \
  http://localhost:8000/api/incident/isolation/enable/PUT_ASSET_ID_HERE
```

Disable:

```bash
curl -i -b cookies.txt \
  -H 'Content-Type: application/json' \
  -d '{}' \
  http://localhost:8000/api/incident/isolation/disable/PUT_ASSET_ID_HERE
```

## Postman / IntelliJ Examples

If you received the API examples bundle, import one of:

```text
dp-isolate-api.postman_collection.json
dp-isolate-api.http
```

Set:

```text
baseUrl = http://localhost:8000/api
assetId = your test asset id
username = operator admin/super user
password = matching password
```

## Expected Happy-Path Observations

Enable:

- HTTP `200`.
- New `Tasks` are created.
- New `AssetTasksLogs` are created.
- Incident becomes `isolation_state.isolated == true`.
- `original_selected_dp_ids` captures selected DPs before isolation.

Disable:

- HTTP `200`.
- New rollback `Tasks` are created.
- New rollback `AssetTasksLogs` are created.
- Incident becomes `isolation_state.isolated == false`.
- `rollback_at` is set.
- `original_selected_dp_ids` is cleared.

Execution completion requires the backend workers:

```text
in_queue   -> incident-manager picked queued incident
pending    -> cmd-executor can pick task
in_progress
done / failed
```

## Troubleshooting

If tasks remain `in_queue`:

- `incident-manager` is not running or did not admit the incident.
- Check `docker compose logs incident-manager`.

If tasks remain `pending`:

- `cmd-executor` is not running or cannot execute the command.
- Check `docker compose logs cmd-executor`.

If API behavior looks stale after source changes:

```bash
docker compose --profile internal-mongo up --build --force-recreate -d
```

If Mongo fails to start:

- Check whether another MongoDB process is using the same data directory.
- Use a separate `LEGACY_PORTAL_MONGO_DB_PATH` for this harness.

If auth fails:

- Verify the restored DB contains the expected user.
- Use credentials from the original/lab environment.

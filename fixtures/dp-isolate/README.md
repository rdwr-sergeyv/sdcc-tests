# DP Isolate Mongo Fixtures

This directory stores local MongoDB snapshots for the DP Isolate test harness.
Snapshot archives are intentionally ignored by git because they can contain
real lab data.

Use from `sdcc-tests`:

```bash
npm run dp-isolate-fixtures:capture -- current-baseline --description "Current lab DB"
npm run dp-isolate-fixtures:list
npm run dp-isolate-fixtures:restore -- current-baseline --yes
npm run dp-isolate-fixtures:restore -- current-baseline --yes --preset dp-isolate
npm run dp-isolate-fixtures:restore-clean -- --yes
```

The fixture scripts expect the Docker MongoDB container from
`docker/legacy-portal/docker-compose.yml` to be running. By default they use:

- container: `legacy-portal-mongo-1`
- database: `sdcc`

Override when needed:

```bash
LEGACY_PORTAL_MONGO_CONTAINER=legacy-portal-mongo-1 SDCC_MONGO_DB=sdcc npm run dp-isolate-fixtures:list
```

To reset the local MongoDB container from the clean source database without
capturing the current local state, use:

```bash
npm run dp-isolate-fixtures:restore-clean -- --yes
```

The default clean source is `mongodb://10.20.4.110:27017/sdcc`. Override it with
`--source-uri` or `DP_ISOLATE_CLEAN_MONGO_URI` when needed. The command runs
`mongorestore --drop` against the target database.

To restore only the DP Isolate-relevant collections from a full fixture archive,
use:

```bash
npm run dp-isolate-fixtures:restore -- <name> --yes --preset dp-isolate
```

The preset restores only these `sdcc` collections and leaves other collections
untouched:

- `DPZones`
- `Accounts`
- `ScrubbingCenters`
- `Assets`
- `Incidents`
- `BackupIncidents`
- `Tasks`
- `AssetTasksLogs`
- `Alerts`

For an ad hoc subset, use `--collections`, for example:

```bash
npm run dp-isolate-fixtures:restore -- <name> --yes --collections DPZones,Incidents,Tasks
```

Useful fixture names for DP Isolate testing:

- `baseline`: known-good manual login and asset picker state.
- `no-attack-zone-dps`: no DPs are present in the Attack Zone, so enable
  isolation should fail when it tries to move asset or incident state there.
- `attack-zone-ready`: at least one usable DP exists in the Attack Zone, so
  enable isolation can exercise the successful update path.

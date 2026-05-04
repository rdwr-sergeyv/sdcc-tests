# DP Isolate Mongo Fixtures

This directory stores local MongoDB snapshots for the DP Isolate test harness.
Snapshot archives are intentionally ignored by git because they can contain
real lab data.

Use from `sdcc-tests`:

```bash
npm run dp-isolate-fixtures:capture -- current-baseline --description "Current lab DB"
npm run dp-isolate-fixtures:list
npm run dp-isolate-fixtures:restore -- current-baseline --yes
```

The fixture scripts expect the Docker MongoDB container from
`docker/legacy-portal/docker-compose.yml` to be running. By default they use:

- container: `legacy-portal-mongo-1`
- database: `sdcc`

Override when needed:

```bash
LEGACY_PORTAL_MONGO_CONTAINER=legacy-portal-mongo-1 SDCC_MONGO_DB=sdcc npm run dp-isolate-fixtures:list
```

Useful fixture names for DP Isolate testing:

- `baseline`: known-good manual login and asset picker state.
- `no-attack-zone-dps`: no DPs are present in the Attack Zone, so enable
  isolation should fail when it tries to move asset or incident state there.
- `attack-zone-ready`: at least one usable DP exists in the Attack Zone, so
  enable isolation can exercise the successful update path.

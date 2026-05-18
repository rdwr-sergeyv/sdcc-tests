# DP Isolate Lab Environment Todo

Local planning checklist for preparing a shared DP Isolation test lab package.
Do not sync this file directly to Jira without review.

## Lab Env Preparation

- [x] Prepare a self-contained ready-to-run package.
  - Include the compose stack, config files, fixture seed, license helpers, manual client, and run guide.
  - Target: teammate can unpack/clone and run without relying on Sergey's local Docker state.
  - Package foundation: `artifacts/dp-isolate-legacy-portal-bundle`.

  - [x] Prepare a DB seed that is ready for tests.
    - Mostly done via `fixtures/dp-isolate/ready-for-tests` and the fixture tooling.
    - Verify it includes enough active incidents/assets/SCs/DPs for enable, rollback, update-during-isolation, and task execution.
    - Keep restore/init/cleanup repeatable; current API tests use `restoreReadyForTests()`.

  - [x] Prepare a Docker Compose based package.
    - Mostly done in `docker/legacy-portal/docker-compose.yml` and supporting files.
    - Include `docker-compose.yml`, `sdcc.conf`, `.env`, entrypoints, and any supporting config.
    - Keep MongoDB optional:
      - internal Mongo via compose profile `internal-mongo`;
      - external Mongo via `SDCC_MONGO_HOST=host.docker.internal` or lab Mongo host.

  - [x] Prepare scripts that initialize or reinitialize backend license keys.
    - Probably done:
      - root shortcut: `make license-backends`;
      - test repo target: `make -C sdcc-tests portal-license-backends`;
      - implementation: `sdcc-tests/tools/dp-isolate-dev.cjs`.
    - Verify defaults and overrides for lab use:
      - `SDCC_LICENSE_IFN`;
      - `SDCC_LICENSE_SERVICES`;
      - `SDCC_LICENSE_MODULES`.

  - [x] Prepare a standalone client UI for manual DP Isolation testing.
    - Existing reference client: `client/dp-isolate`.
    - Make it accessible from the same lab environment as the portal/API.
    - Consider adding it as an optional container/profile in the existing compose suite.
    - Keep it as a reference implementation for manual enable/disable/update flows, not only a developer convenience.

  - [x] Prepare a run/usage guide for the environment.
    - Existing docs to consolidate:
      - `docker/legacy-portal/README.md`;
      - `docker/legacy-portal/DP_ISOLATE_ENV_GUIDE.md`;
      - `fixtures/dp-isolate/README.md`;
      - `client/dp-isolate/README.md`.
    - Include:
      - prerequisites;
      - package layout;
      - internal vs external Mongo modes;
      - fixture restore/reset;
      - backend license initialization;
      - portal/client URLs;
      - smoke/API test commands;
      - troubleshooting for incident-manager, cmd-executor, Mongo, and license failures.

## Open Checks

### Current priorities

- [x] Prepare an intermediate base Docker image with pre-installed system/Python/Node libraries to reduce portal rebuild time.
- [ ] add a case which tests an invalid ISOLATION_TRIGGER value;
- [ ] add test case: there are not enough DPs with unallocated policies by setting max policy count to 1 and trying to enable isolation on an incident with 2 DPs that have no policies; expected result: the same error as it's triggered by existing incident create/update;
- [ ] introduce "build-only" testing mode; "build" and "provision" are existing stages of the task handling by cmd-exec; "build-only" means tasks are marked as "done" after dependency resolution and other prerequisite steps but without actually running the commands against the devices; could require temporary code changes in the api under test;
- [ ] add an isolated DP to the current set of 2 DPs to test (??)

### Later/optional

- [ ] Check whether the lab and its devices are accessible from home.
- [ ] If lab device access works, run backend containers that can perform actual device configuration updates.

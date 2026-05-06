# CDDOS-2113 Progress Testing Suite

Test helpers for DP Isolate Jira tasks that are currently marked with
`progress:testing`.

## Source Contract Check

Run from the umbrella repository root:

```powershell
python sdcc-tests\tasks\cddos-2113\progress-testing\verify_progress_testing_contracts.py
```

The suite verifies the local task docs and the cross-repo implementation
contracts in `sdcc/` and `sdcc-portal/`. It does not replace the live API matrix
against a running legacy portal environment.

## Live API Matrix

The live matrix runner follows the integration-test workflow:

1. Send the API request: enable/disable, valid/invalid scenario.
2. Observe the immediate HTTP response.
3. Observe the active incident state from MongoDB.
4. Observe task and `AssetTasksLogs` creation.
5. Poll until created work reaches a terminal execution state (`done` or
   `failed`), when tasks are created.

Start with the happy path. A single asset ID runs enable first, waits for the
created work, then runs disable on the same asset:

```powershell
$env:PORTAL_ORIGIN = "http://localhost:8000"
$env:PORTAL_USER = "twister@example.com"
$env:PORTAL_PASSWORD = "..."
$env:DP_ISOLATE_HAPPY_PATH_ASSET_ID = "000000000000000000000000"
node sdcc-tests\tasks\cddos-2113\progress-testing\run_isolation_api_matrix.cjs
```

Edge and invalid cases are opt-in:

```powershell
$env:DP_ISOLATE_INCLUDE_EDGE_CASES = "1"
$env:DP_ISOLATE_ENABLE_INVALID_ASSET_ID = "111111111111111111111111"
$env:DP_ISOLATE_DISABLE_INVALID_ASSET_ID = "222222222222222222222222"
node sdcc-tests\tasks\cddos-2113\progress-testing\run_isolation_api_matrix.cjs
```

For a custom matrix, provide `DP_ISOLATE_SCENARIOS_JSON`:

```json
[
  {
    "name": "enable valid manual",
    "action": "enable",
    "assetId": "000000000000000000000000",
    "trigger": "manual",
    "expectStatus": 200,
    "expectTasks": "created"
  },
  {
    "name": "disable no-op",
    "action": "disable",
    "assetId": "111111111111111111111111",
    "expectStatus": 200,
    "expectTasks": "none"
  }
]
```

The JSON report is written to
`sdcc-tests/artifacts/dp-isolate-progress-testing-report.json` by default.

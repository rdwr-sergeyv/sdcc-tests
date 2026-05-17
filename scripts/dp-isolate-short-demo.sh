#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

HAPPY_ASSET_ID="5e5bb8fa2cbdfd02c6581656"
INSUFFICIENT_DPS_ASSET_ID="67f502c30f9d41266261bc50"
NO_ACTIVE_INCIDENT_ASSET_ID="6575808ecc009ff81b5124b2"

step() {
  printf '\n\n=== %s ===\n' "$1"
}

pause() {
  printf '\n%s\n' "$1"
  read -r -p "Press Enter to continue..." _
}

run() {
  printf '+'
  printf ' %q' "$@"
  printf '\n'
  "$@"
}

restore_ready() {
  run make restore-ready
}

snapshot() {
  local asset_id="${1:-$HAPPY_ASSET_ID}"
  run make task-snapshot "ASSET_ID=$asset_id"
}

step "Start short demo environment"
cat <<'TEXT'
This starts only Mongo, the portal/API, and the DP Isolate UI client.
incident-manager and cmd-executor are intentionally not used in this demo.
TEXT
pause "Ready to start the short demo environment?"
run make portal-ui-up
run make restore-ready
run make client-up
run make open-dp-isolate
pause "UI should now be open at http://localhost:5173. Confirm login/asset list, then continue."

step "Scenario 1: enable isolation"
restore_ready
cat <<TEXT
In the UI:
1. Select asset $HAPPY_ASSET_ID.
2. Keep trigger as Manual.
3. Click Enable Isolation.

Expected response: HTTP 200 with {"reply":"OK"}.
TEXT
pause "Run the UI enable action, observe the response, then continue to snapshot DB state."
snapshot "$HAPPY_ASSET_ID"
pause "Talk track: incident is isolated, zone is attack_zone, task/log records were created but not executed."

step "Scenario 2: disable isolation"
cat <<TEXT
In the UI:
1. Keep asset $HAPPY_ASSET_ID selected.
2. Click Disable Isolation.

Expected response: HTTP 200 with {"reply":"OK"}.
TEXT
pause "Run the UI disable action, observe the response, then continue to snapshot DB state."
snapshot "$HAPPY_ASSET_ID"
pause "Talk track: incident is no longer isolated; rollback used per-diversion original_selected_dp_ids and then cleared them."

step "Scenario 3: not enough Attack Zone DPs"
restore_ready
cat <<TEXT
In the UI:
1. Search for asset $INSUFFICIENT_DPS_ASSET_ID.
2. With Client validations enabled, show the row is not applicable.
3. Disable Client validations.
4. Select or paste asset $INSUFFICIENT_DPS_ASSET_ID.
5. Click Enable Isolation.

Expected response: HTTP 422.
TEXT
pause "Run the blocked/forced UI action, observe the response, then continue to snapshot DB state."
snapshot "$INSUFFICIENT_DPS_ASSET_ID"
pause "Talk track: backend enforces the rule; no isolation task/log records should be created."

step "Scenario 4: already isolated no-op"
restore_ready
cat <<TEXT
In the UI:
1. Select asset $HAPPY_ASSET_ID.
2. Click Enable Isolation once.
TEXT
pause "Run the first enable, observe HTTP 200, then continue to snapshot DB state."
snapshot "$HAPPY_ASSET_ID"
cat <<TEXT
In the UI:
1. Click Enable Isolation again for the same asset.

Expected response: HTTP 200 no-op.
TEXT
pause "Run the second enable, observe HTTP 200, then continue to snapshot DB state."
snapshot "$HAPPY_ASSET_ID"
pause "Talk track: already-isolated enable is successful no-op; it should not create a duplicate task set."

step "Scenario 5: missing active incident no-op"
restore_ready
cat <<TEXT
In the UI:
1. Select or paste asset $NO_ACTIVE_INCIDENT_ASSET_ID.
2. Click Enable Isolation.
3. Click Disable Isolation.

Expected response for both calls: HTTP 200 no-op.
TEXT
pause "Run the missing-incident enable/disable actions, then continue to snapshot DB state."
snapshot "$NO_ACTIVE_INCIDENT_ASSET_ID"
pause "Talk track: no active incident means no incident, task, or task log is created."

step "Demo complete"
cat <<'TEXT'
The short demo environment is still running.
Stop it when finished with:
  make stop
TEXT

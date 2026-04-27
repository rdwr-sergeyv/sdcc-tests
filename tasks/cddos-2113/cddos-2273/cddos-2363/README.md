# CDDOS-2363 Verification Helpers

Playwright helpers for checking Attack Zone visibility in the legacy portal.

Keep the local Playwright install between runs to avoid repeated install/uninstall cycles.
From the repository root, install once:

```powershell
New-Item -ItemType Directory -Force -Path tmp-playwright | Out-Null
Push-Location tmp-playwright
npm init -y
npm install playwright@1.59.1
Pop-Location
```

Run helpers with `NODE_PATH` pointing at that install:

```powershell
$env:NODE_PATH=(Resolve-Path .\tmp-playwright\node_modules).Path
node sdcc-tests\tasks\cddos-2113\cddos-2273\cddos-2363\check_account_zone_picker.js --url https://10.20.3.43/ --user twister@example.com --password d0sattack --account meir_policy_test --browser msedge --headless true
node sdcc-tests\tasks\cddos-2113\cddos-2273\cddos-2363\check_dp_zone_picker.js --url https://10.20.3.43/ --user twister@example.com --password d0sattack --sc SCRUBBING_1 --browser msedge --headless true
```

# CDDOS-2371 Verification Helpers

Helpers for verifying `POST /incident/isolation/enable/{asset_id}`.

## Source Contract Check

Run from the umbrella repository root:

```powershell
python sdcc-tests\tasks\cddos-2113\cddos-2274\cddos-2371\verify_isolation_enable_contract.py
```

This checks that the current local source contains the expected endpoint route,
handler guard chain, `422` quorum mapping, trigger handling, and utility write
path. It does not replace the live API/environment matrix.

## Live Matrix Still Required

Run against an environment that already has:

- CDDOS-2273 Attack Zone seed/model changes.
- One active incident for the target asset.
- Representative Attack Zone DPX availability for both success and quorum
  failure cases.

Required live cases remain the checklist in
`docs/tasks/dp-isolate/JIRA/CDDOS-2113/CDDOS-2274/CDDOS-2371.md`.

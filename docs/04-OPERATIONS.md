# 04 — Operations Manual

## Manual SOP

1. Confirm sheet ready (only new rows blank), ports numeric, key valid via single GET.
2. Open workflow (`active: false`), verify green credential badges, Execute on `Start Manually`.
3. Watch loop 1/N, do not close tab or edit sheet mid-run.
4. Verify: blank `Status` count = 0, Instantly dashboard count += `Added`.

## Reruns — blanks only

Idempotent via blank filter + skip + `matchingColumns: Email`. To retry `Failed - ...`, clear those cells to blank and rerun. Never clear `Added`. Never run concurrently on same tab. For large retries copy blanks to `Retry_YYYY-MM-DD` tab.

## Monitoring

Executions list, `saveManualExecutions: true`. Check `Loop Each Row` in/out counts, `Check` vs `Add` counts, `Update Status` confirmations. Alert if `Failed` > 10% in first 20 rows (likely 401/403) — stop and triage.

## Rollback

No single undo. Stop execution, note last `Added` email, delete in Instantly by `created_at`, fix rows, rerun blanks. Record in CHANGELOG.

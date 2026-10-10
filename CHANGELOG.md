# Changelog

All notable changes to the `Instantly SMTP Accounts – Bulk Upload` workflow and docs.

## [2.0.0] - 2026-10-10

Matches `docs/RUNBOOK.md` v2.0.0. 8-node Status write-back design → 7-node status-less design.

### Removed
- `Update Status` node and the `Status` column. The Google Sheet is now
  read-only input (11 columns). Outcomes live in the n8n execution log +
  Instantly dashboard delta only.

### Changed
- Workflow simplified to 7 nodes: `Start Manually → Get Sheet Rows →
  Keep Valid Rows → Loop Each Row → Check Exists → Skip Existing →
  Add Account`, with skip / success / error all looping back.
- `Keep Valid Rows` repurposed from plain Filter to trim-aware Code gate:
  `String(item.json?.Email ?? '').trim() !== ''`, so whitespace-only
  trailing rows never enter the loop.
- Per-row `GET /api/v2/accounts/{email}` kept as the idempotency probe.
  A prefetch variant was tried and reverted (it ate rows).
- Native `n8n-nodes-instantly` swap scrapped: `account:create` is
  SMTP-only with no IMAP fields / `provider_code`. Stays on HTTP nodes
  with `provider_code: 1` (custom SMTP/IMAP).
- Canonical JSON synced: `workflows/instantly-smtp-accounts-bulk-upload.json`
  now matches the live canvas (commit `6777025`).

### Fixed
- Code-context bug: `$('Loop Each Row').item` inside a Code node →
  `$input.all().filter(...)`. The `$('...').item` form is for expressions
  only; Code nodes use `$input`.
- `Add Account` timeout 10s → 30s. Creates verify live mailboxes; the 10s
  limit caused real `ECONNABORTED` timeouts in production. `Check Exists`
  stays at 10s (lookups are instant).
- Retries pinned: GET 2 tries / 1s wait, POST 2 tries / 2s wait, both
  `onError: continueErrorOutput` so one bad row never halts the run.
- `Email` (Sheet, capital E) vs `email` (API, lowercase e) documented and
  enforced; ports via `Number()`, passwords never trimmed.

### Security
- Both HTTP nodes use `Authorization: Bearer YOUR_INSTANTLY_API_KEY`
  placeholder in git. Live key lives in the n8n runtime only.
- Settings pinned: `active: false`, `executionOrder: v1`,
  `saveDataSuccessExecution: none`, `saveManualExecutions: true`.

### Verified
- 40-row runs: 35 created / 4 skipped / 1 timeout, then 30 created /
  10 skipped / 0 failed. ~2 min total, ~3 s/row. Timeouts resolve on
  rerun via the GET probe (skip if landed, recreate if not).

### Docs
- Rewrote root `README.md`, `docs/README.md`, `docs/GUIDE.md`,
  `docs/RUNBOOK.md` for the 7-node flow; retired stale-JSON banners.

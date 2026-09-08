# Documentation Index

Bulk-upload custom SMTP accounts from Google Sheets to Instantly API v2, one-by-one, with skip-if-exists and `Added` / `Failed` write-back.

## Architecture

`Start Manually` -> `Get Sheet Rows` -> `Keep Blanks Only` (`Status` empty) -> `Loop Each Row` (`batchSize: 1`) -> `Check Exists` (`GET /api/v2/accounts/{email}`) -> `Skip Existing` (IF `$json.email notEmpty`) -> `Add Account` (`POST /api/v2/accounts`, `provider_code: 1`) -> `Update Status` (`appendOrUpdate` on `Email`) -> loop-back.

Error outputs (`continueErrorOutput`) converge on `Update Status` so one bad row never halts the run.

## Reading paths

- First-time setup -> `01-SETUP.md`
- Understand nodes -> `02-WORKFLOW.md`
- API contract -> `03-API_REFERENCE.md`
- Daily runs -> `04-OPERATIONS.md`
- Fix failures -> `05-TROUBLESHOOTING.md`
- Credentials safety -> `06-SECURITY.md`

## Conventions

- `Email` (capital E) = sheet column. `email` (lowercase) = Instantly JSON field.
- `Status`: blank = todo, `Added` = success/exists, `Failed - reason` = triage.
- Ports coerced with `Number()`, emails with `trim().toLowerCase()`.
- Node label format: `Name (type@typeVersion)`.

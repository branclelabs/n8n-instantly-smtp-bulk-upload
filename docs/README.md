# n8n-instantly-smtp-bulk-upload
> Bulk-upload custom SMTP/IMAP email accounts to Instantly.ai from Google Sheets with duplicate-skip, per-row status writeback, and safe re-runs.
[![n8n >=1.x](https://img.shields.io/badge/n8n-%3E%3D1.x-blue)](#prerequisites) [![8 nodes](https://img.shields.io/badge/workflow-8_nodes-green)](#workflow-at-a-glance--8-nodes) [![Sheets](https://img.shields.io/badge/source-Google_Sheets-yellow)](#google-sheet-preparation) [![Instantly v2](https://img.shields.io/badge/target-Instantly.ai_v2-purple)](#prerequisites) [![Last tested 2026-09-08](https://img.shields.io/badge/last_tested-2026--09--08-lightgrey)](#prerequisites)
## Pitch
Manually adding dozens or hundreds of custom SMTP mailboxes in the Instantly.ai UI is slow, error-prone, and unauditable. This repo provides a single production-ready n8n workflow that reads candidate accounts from a Google Sheet, normalizes each email, checks existence via `GET /api/v2/accounts/{email}`, creates only missing accounts via `POST /api/v2/accounts` with full IMAP+SMTP settings, and writes `Added` or `Failed - <reason>` back to the same row — so the sheet becomes your idempotent queue, audit log, and retry list with zero extra infrastructure.
## Table of Contents
- [How to Read This Repo](#how-to-read-this-repo)
- [What It Does](#what-it-does)
- [What It Does NOT Do](#what-it-does-not-do)
- [Architecture](#architecture)
- [Conventions You Must Know](#conventions-you-must-know)
- [Workflow at a Glance — 8 Nodes](#workflow-at-a-glance--8-nodes)
- [Prerequisites](#prerequisites)
- [Google Sheet Preparation](#google-sheet-preparation)
- [Credentials Setup](#credentials-setup)
- [Import the Workflow](#import-the-workflow)
- [5-Minute Quickstart](#5-minute-quickstart)
- [2-Row Smoke Test](#2-row-smoke-test)
- [Repository Layout](#repository-layout)
- [Next Steps](#next-steps)
- [Troubleshooting Preview](#troubleshooting-preview)
- [Maintenance and Versioning](#maintenance-and-versioning)
## How to Read This Repo
This README is the onboarding front door. It gets you from zero to a first green run. Read it fully once; then use the companions for depth and operations.
| Document | Purpose | When to read it |
|----------|---------|-----------------|
| `docs/README.md` (this file) | Onboarding, prerequisites, sheet prep, credentials, import, quickstart, smoke test | Start here. Read Sections 1–12 in order. |
| `docs/GUIDE.md` | Deep-dive operator guide: every node, expression, mapping, customization recipes | After first green run or when changing logic. |
| `docs/RUNBOOK.md` | Day-2 operations: monitoring, re-runs, triage, rate limits, rollback, scheduling | Before scheduling or when something fails. |
| `workflows/instantly-smtp-accounts-bulk-upload.json` | Canonical workflow JSON, single source of truth | Import this; do not hand-rebuild from screenshots. |
How to use this guide:
1. First-time setup: read top to bottom. Do not skip Conventions — `Email` vs `email` casing causes most first-run failures.
2. Second run and beyond: jump to 5-Minute Quickstart and `RUNBOOK.md`.
3. Customization: go to `GUIDE.md` for field maps and safe edit recipes.
4. All paths are relative to repo root. Canonical workflow is always:
```text
workflows/instantly-smtp-accounts-bulk-upload.json
```
> Rule: if the n8n canvas and the JSON file disagree, the JSON file wins. Re-import from `workflows/` and re-apply IDs and keys.
## What It Does
- Reads a Google Sheet as a queue. `Get Sheet Rows` pulls every row from the accounts sheet (columns A–L, header + data).
- Filters to actionable rows only. `Keep Blanks Only` keeps rows where `Status` is empty (`{{ $json.Status }}` is empty). `Added` and `Failed - <reason>` rows are ignored.
- Processes one row at a time. `Loop Each Row` (`splitInBatches`, `batchSize: 1`) isolates each account so one bad row never aborts the batch.
- Deduplicates against Instantly. `Check Exists` calls `GET https://api.instantly.ai/api/v2/accounts/{{ $json.Email }}` for the loop email.
- Branches on existence. `Skip Existing` (`if@2.3`, `{{ $json.email }}` is `notEmpty`) routes existing accounts to writeback without a POST.
- Creates missing accounts. `Add Account` calls `POST https://api.instantly.ai/api/v2/accounts` with 12 fields including `provider_code: 1` (custom SMTP/IMAP), full name, IMAP and SMTP username/password/host/port.
- Writes outcome back to the sheet. `Update Status` (`appendOrUpdate` matching on `Email`) writes `Added` on success or `Failed - <reason>` on failure to the same row.
- Is idempotent. Re-running without sheet changes is safe: `Added` rows are filtered out, existing accounts are skipped via GET, only blank-`Status` rows generate POSTs.
- Keeps secrets out of logs. Passwords travel sheet → n8n memory → Instantly API over HTTPS; workflow never writes them to logs.
- Runs manually by default. Trigger is `Start Manually` (`manualTrigger@1`). Click Execute when ready. Scheduling is opt-in (see `RUNBOOK.md`).
## What It Does NOT Do
Clarity here prevents incidents. This workflow explicitly does not:
| # | Non-goal | Explanation | Do instead |
|---|----------|-------------|------------|
| 1 | Warm up inboxes | No warmup pools, ramp-up, spam-score checks | Use Instantly warmup separately |
| 2 | Verify DNS (SPF/DKIM/DMARC) | No DNS queries or deliverability checks | Validate DNS before upload; see RUNBOOK pre-flight |
| 3 | Create sheets or workspaces | Assumes sheet, n8n credential, Instantly workspace exist | Follow Prerequisites first |
| 4 | Rotate passwords / update existing accounts | POST is create-only; existing emails are skipped, never patched | Update in Instantly UI or extend per GUIDE.md |
| 5 | Handle Gmail/Outlook OAuth | `provider_code: 1` is generic IMAP/SMTP only | Use Instantly OAuth flows for those |
| 6 | Bulk-delete / disable | No `DELETE` calls anywhere | Delete manually in Instantly |
| 7 | Send campaigns / assign to campaigns | No campaign endpoints called | Assign in Instantly after upload |
| 8 | Retry with backoff internally | One attempt per row per run; failures recorded for next run | Fix cause, clear Status, re-run |
| 9 | Mask sheet-stored secrets | IMAP/SMTP passwords live in sheet in cleartext by API necessity | Lock down sheet sharing + n8n access |
| 10 | Guarantee upstream API stability | Endpoints, limits, error shapes can change | Pin test date; re-smoke-test after changelogs |
> If you need any of the above, treat this as a starting template — do not assume it already covers that case.
## Architecture
### Data flow in one sentence
Google Sheet (12 columns, blank `Status` = todo) → Filter → Loop (1-by-1) → GET exists? → POST if missing → appendOrUpdate `Status` in same row.
### Mermaid graph
Renders on GitHub, GitLab, and most docs sites.
```mermaid
flowchart TD
    A[Start Manually<br/>manualTrigger@1] --> B[Get Sheet Rows<br/>googleSheets@4.7 read]
    B --> C[Keep Blanks Only<br/>filter@2.3<br/>Status is empty]
    C --> D[Loop Each Row<br/>splitInBatches@3<br/>batchSize 1]
    D --> E[Check Exists<br/>HTTP GET<br/>/api/v2/accounts/:email]
    E --> F{Skip Existing<br/>if@2.3<br/>email notEmpty?}
    F -- true: exists --> H[Update Status<br/>googleSheets@4.7<br/>appendOrUpdate on Email]
    F -- false: missing --> G[Add Account<br/>HTTP POST<br/>/api/v2/accounts<br/>provider_code 1]
    G --> H
    H --> D
    D -- done --> Z([End<br/>all blank rows processed])
```
### Execution semantics
```text
Manual trigger
  └─ Get Sheet Rows (one n8n item per sheet row)
       └─ Keep Blanks Only (drops Added / Failed rows)
            └─ Loop Each Row (batchSize=1)
                 ├─ iteration N: Check Exists (GET loop email)
                 │    ├─ email returned → Skip Existing=true → Update Status → loop back
                 │    └─ email empty/404 → Skip Existing=false → Add Account (POST) → Update Status → loop back
                 └─ no more items → done branch → end
```
Key properties:
- Sequential. `batchSize: 1` avoids rate-limit bursts and keeps writeback unambiguous.
- Stateful queue. `Status` column is the cursor. Blank = pending.
- No in-workflow global state. All cross-run state lives in the sheet.
- Fail-soft. Per-item `Add Account` errors still reach `Update Status` so failures are recorded, not aborting the loop.
## Conventions You Must Know
Read twice. Most first-run tickets trace to one of these four.
### Email (capital E) vs email (lowercase e)
Two different fields from two systems. Mixing them breaks the GET URL or IF branch.
| Field | Casing | Source | Example | Where it appears |
|-------|--------|--------|---------|------------------|
| `Email` | Capital E | Google Sheets header | `maria@acme.co` | Get Sheet Rows, Check Exists URL, Update Status match column |
| `email` | Lowercase e | Instantly API JSON | `maria@acme.co` | Skip Existing condition, Add Account POST body |
Rules:
- Sheet side is always `Email`. Header must be exactly `Email`. `EMAIL`, `email`, `E-mail` will not match `appendOrUpdate` and will create duplicates.
- API side is always `email`. Instantly returns `{ "email": "..." }`. `Skip Existing` tests `{{ $json.email }}` (lowercase).
- Bridge is the `Check Exists` URL, injecting the sheet value into the API call:
```javascript
// Check Exists — GET URL. $json is the loop item (Sheets row), so Email is capital-E.
https://api.instantly.ai/api/v2/accounts/{{ $json.Email }}
```
```javascript
// Skip Existing — IF condition. $json is the Instantly GET response, so email is lowercase-e.
// string 'email' is notEmpty → true = exists → skip POST; false = missing → POST
{{ $json.email }}
```
> Mnemonic: Capital `Email` comes from the Sheet; lowercase `email` comes from Instantly.
### Status lifecycle: blank → Added / Failed - reason
`Status` is queue cursor and audit trail.
| Value | Meaning | Who writes it | Next run |
|-------|---------|---------------|----------|
| (empty) | Pending | You (leave blank) | Picked up by Keep Blanks Only |
| `Added` | Confirmed (POST 200/201 or GET already existed) | Update Status | Skipped — never retried |
| `Failed - <reason>` | POST/validation failed; reason is API message | Update Status | Skipped until you clear to blank |
Lifecycle:
```text
(blank) ── run ──► Added
(blank) ── run ──► Failed - <reason> ──► (fix, clear to blank) ── run ──► Added
(Added) ── run ──► ignored (filter drops it)
```
Rules:
1. Never pre-fill `Status`. A single space counts as non-empty and will be skipped — clear fully.
2. To retry, delete cell contents only (make blank). Do not delete the row; `appendOrUpdate` matches on `Email`.
3. Do not invent statuses like `Done` or `Pending`. Filter understands empty vs non-empty only. `Done` behaves like `Added` (skipped) even if Instantly never saw it.
4. Audit via the sheet. Filter `Status` for `Failed*` for your retry list. No separate log needed.
### Normalization: trim().toLowerCase()
Email matching is URL-sensitive but mailbox-insensitive. Workflow normalizes before comparison:
```javascript
// Canonical normalization before GET and POST
{{ $json.Email.toString().trim().toLowerCase() }}
```
| Raw sheet value | Without normalization | With normalization |
|-----------------|-----------------------|--------------------|
| ` Maria@Acme.co ` | GET `.../ Maria@Acme.co ` → 404, duplicate POST | GET `.../maria@acme.co` → correct dedup |
| `MARIA@ACME.CO` | Treated distinct from `maria@acme.co` | Matches existing |
| `maria@acme.co\n` | Trailing newline breaks URL | Clean address |
> Keep this chain everywhere email is a key. If you add nodes, copy `trim().toLowerCase()`. Full recipe in `GUIDE.md`.
### Numeric coercion: Number()
Instantly expects integers for ports and `provider_code`. Sheets returns strings even for numeric cells. Workflow coerces:
```javascript
// Add Account POST excerpts
{
  "provider_code": 1,
  "imap_port": "{{ Number($json['IMAP Port']) }}",
  "smtp_port": "{{ Number($json['SMTP Port']) }}"
}
```
| Sheet cell | Raw $json type | After Number() | API expects |
|------------|----------------|----------------|-------------|
| `993` | `"993"` (string) | `993` (number) | `993` |
| `587` | `"587"` (string) | `587` (number) | `587` |
| (empty) | `""` | `0` → should fail fast | non-zero port |
Rules:
- Always wrap ports in `Number()`. Sending `"993"` (quoted) is rejected or misinterpreted by API version.
- `provider_code` is literal `1`, not from sheet. `1` = generic SMTP/IMAP. Do not change unless migrating providers (see `GUIDE.md`).
- Empty ports become `0`. Should surface as `Failed - Invalid port`, never dial port 0. Validate sheet per next section.
## Workflow at a Glance — 8 Nodes
Canvas order (left → right):
| # | Node name | Type + version | Operation | Purpose |
|---|-----------|----------------|-----------|---------|
| 1 | Start Manually | `manualTrigger@1` | manual trigger | Entry point; click Execute. |
| 2 | Get Sheet Rows | `googleSheets@4.7` | read | Loads all rows from accounts sheet. |
| 3 | Keep Blanks Only | `filter@2.3` | `{{ $json.Status }}` is empty | Drops processed rows. |
| 4 | Loop Each Row | `splitInBatches@3` | `batchSize: 1` | One account per pass. |
| 5 | Check Exists | `httpRequest@4.5` | `GET /api/v2/accounts/{{ $json.Email }}` | Asks if mailbox exists. |
| 6 | Skip Existing | `if@2.3` | `{{ $json.email }}` is `notEmpty` | Branch: skip POST vs create. |
| 7 | Add Account | `httpRequest@4.5` | `POST /api/v2/accounts`, 12 fields, `provider_code: 1` | Creates missing account. |
| 8 | Update Status | `googleSheets@4.7` | `appendOrUpdate` on `Email` | Writes `Added` / `Failed - reason`. |
Connections:
```text
Start Manually → Get Sheet Rows → Keep Blanks Only → Loop Each Row
Loop Each Row (loop) → Check Exists → Skip Existing
Skip Existing (true) → Update Status → Loop Each Row (back-edge)
Skip Existing (false) → Add Account → Update Status → Loop Each Row (back-edge)
Loop Each Row (done) → end
```
### Node 1 — Start Manually (manualTrigger@1)
Manual entry point. No webhook, schedule, or polling. Bulk credential uploads deserve a human gate: review sheet, then Execute. Scheduling is opt-in (see `RUNBOOK.md`).
```json
{ "name": "Start Manually", "type": "n8n-nodes-base.manualTrigger", "typeVersion": 1, "position": [240, 300], "parameters": {} }
```
### Node 2 — Get Sheet Rows (googleSheets@4.7 read)
Reads full data range. Credential: Google OAuth2. Placeholder `YOUR_GOOGLE_SHEET_ID`. Output: one item per row, keys exactly matching headers (`Email`, `First Name`, …, `Status`).
```json
{ "sheetName": "Accounts", "documentId": "YOUR_GOOGLE_SHEET_ID", "operation": "read" }
```
> Both Sheets nodes must point at same document ID with same OAuth credential, or writeback lands in a different file than the read source.
### Node 3 — Keep Blanks Only (filter@2.3)
Condition `{{ $json.Status }}` is empty (string `isEmpty`). Only truly blank `Status` passes. `Added` / `Failed - …` dropped. Gotcha: a space is not empty — clear failures fully to retry.
```javascript
// Field: {{ $json.Status }} | Operator: isEmpty | Type: string
```
### Node 4 — Loop Each Row (splitInBatches@3 batchSize 1)
`batchSize: 1`. `loop` emits one item per iteration; `done` fires when exhausted. Strict serialization avoids rate limits and keeps writeback unambiguous. Do not raise without reading RUNBOOK rate-limit guidance.
```json
{ "batchSize": 1, "options": {} }
```
### Node 5 — Check Exists (httpRequest@4.5 GET)
`GET https://api.instantly.ai/api/v2/accounts/{{ $json.Email }}`. Auth header `Authorization: Bearer YOUR_INSTANTLY_API_KEY` (replace in both HTTP nodes; never commit real key). Input `$json` is loop item so `Email` is capital-E. `200` with `{ "email": "…" }` = exists; `404`/empty = missing. Both expected, neither aborts loop.
```http
GET https://api.instantly.ai/api/v2/accounts/maria@acme.co
Authorization: Bearer YOUR_INSTANTLY_API_KEY
Accept: application/json
```
### Node 6 — Skip Existing (if@2.3)
Condition `{{ $json.email }}` (lowercase, from GET response) is `notEmpty` (string). True → exists → direct to Update Status (writes `Added`, no POST). False → missing → to Add Account.
```javascript
// IF condition — string, notEmpty
{{ $json.email }}
```
### Node 7 — Add Account (httpRequest@4.5 POST 12 fields)
`POST https://api.instantly.ai/api/v2/accounts`. Same `Authorization: Bearer YOUR_INSTANTLY_API_KEY` header. JSON body with 12 fields, `provider_code: 1`. Ports via `Number()`; email via `trim().toLowerCase()`.
```json
{
  "email": "={{ $json.Email.toString().trim().toLowerCase() }}",
  "first_name": "={{ $json['First Name'] }}",
  "last_name": "={{ $json['Last Name'] }}",
  "provider_code": 1,
  "imap_username": "={{ $json['IMAP Username'] }}",
  "imap_password": "={{ $json['IMAP Password'] }}",
  "imap_host": "={{ $json['IMAP Host'] }}",
  "imap_port": "={{ Number($json['IMAP Port']) }}",
  "smtp_username": "={{ $json['SMTP Username'] }}",
  "smtp_password": "={{ $json['SMTP Password'] }}",
  "smtp_host": "={{ $json['SMTP Host'] }}",
  "smtp_port": "={{ Number($json['SMTP Port']) }}"
}
```
Field reference:
| # | POST field | Sheet source | Transform |
|---|------------|--------------|-----------|
| 1 | `email` | `Email` | `trim().toLowerCase()` |
| 2 | `first_name` | `First Name` | as-is (trim recommended) |
| 3 | `last_name` | `Last Name` | as-is (trim recommended) |
| 4 | `provider_code` | literal `1` | integer, not from sheet |
| 5 | `imap_username` | `IMAP Username` | as-is |
| 6 | `imap_password` | `IMAP Password` | as-is, keep secret |
| 7 | `imap_host` | `IMAP Host` | `trim().toLowerCase()` recommended |
| 8 | `imap_port` | `IMAP Port` | `Number()` |
| 9 | `smtp_username` | `SMTP Username` | as-is |
| 10 | `smtp_password` | `SMTP Password` | as-is, keep secret |
| 11 | `smtp_host` | `SMTP Host` | `trim().toLowerCase()` recommended |
| 12 | `smtp_port` | `SMTP Port` | `Number()` |
### Node 8 — Update Status (googleSheets@4.7 appendOrUpdate)
Matches on `Email` (capital-E exact), updates `Status`. Writes `Added` on success (including skip-existing path) or `Failed - <reason>` on error. Same credential + document as Get Sheet Rows.
```json
{ "operation": "appendOrUpdate", "documentId": "YOUR_GOOGLE_SHEET_ID", "sheetName": "Accounts", "matchOn": "Email" }
```
> See `GUIDE.md` for `_status` derivation and message truncation; `RUNBOOK.md` for retry semantics.
## Prerequisites
Do not start quickstart until every row is green.
### Platform
| Requirement | Minimum | Recommended | Notes |
|-------------|---------|-------------|-------|
| n8n version | `>= 1.x` (any 1.x) | Latest stable 1.x | Uses `executionOrder: v1`. Cloud or self-host. |
| Node runtime (self-host) | Node 18 | Node 20 LTS | Self-host only. |
| Browser | Evergreen Chrome/Edge/Firefox | Chrome | For OAuth + canvas. |
| Network egress | HTTPS to `googleapis.com`, `oauth2.googleapis.com`, `api.instantly.ai` | Same | Allowlist on corporate proxies. |
| Last tested | `2026-09-08` | — | Re-smoke-test if newer versions. |
### Required node versions
Canonical JSON pins these `typeVersion` values. Accept n8n migration prompt on import if newer, then verify 8-node list still matches above.
| Node | Type string | Pinned typeVersion |
|------|-------------|--------------------|
| Start Manually | `n8n-nodes-base.manualTrigger` | `1` |
| Get Sheet Rows | `n8n-nodes-base.googleSheets` | `4.7` |
| Keep Blanks Only | `n8n-nodes-base.filter` | `2.3` |
| Loop Each Row | `n8n-nodes-base.splitInBatches` | `3` |
| Check Exists | `n8n-nodes-base.httpRequest` | `4.5` |
| Skip Existing | `n8n-nodes-base.if` | `2.3` |
| Add Account | `n8n-nodes-base.httpRequest` | `4.5` |
| Update Status | `n8n-nodes-base.googleSheets` | `4.7` |
### Google account and OAuth
| Requirement | Details |
|-------------|---------|
| Google account | Any with Sheets access; workspace account recommended for teams. |
| OAuth consent | Approve Sheets OAuth scopes in n8n (`spreadsheets` read/write). |
| Sheet access | `Editor` on accounts sheet for OAuth identity (read alone fails writeback). |
| Credential type | `Google Sheets OAuth2 API` (`googleSheetsOAuth2Api`). Both Sheets nodes share it. |
### Instantly.ai account and API scopes
| Requirement | Details |
|-------------|---------|
| Plan | Paid workspace (free/trial may lack API or quota). |
| API key | Settings → API. One key per workspace. Treat like password. |
| Scopes | `accounts:read` (Check Exists GET) + `accounts:create` (Add Account POST). Enable both if granular. |
| Quota | Enough slots for batch (50 blanks need 50 slots). Check Limits before large runs. |
| Base URL | `https://api.instantly.ai/api/v2` — no trailing slash. |
### Access checklist
- [ ] n8n `>= 1.x` reachable, can create + execute workflows.
- [ ] Google OAuth credential created (or permission to create one).
- [ ] `Editor` on target sheet (test by typing in `Status` once).
- [ ] Instantly paid workspace + key with `accounts:read` + `accounts:create`.
- [ ] 2 test mailboxes (disposable/staging) for smoke test.
- [ ] Canonical JSON present at `workflows/instantly-smtp-accounts-bulk-upload.json`.
## Google Sheet Preparation
### Create the sheet
1. Create new Google Sheet (e.g., `Instantly SMTP Upload`).
2. Rename first tab to `Accounts` (workflow default `sheetName`).
3. Paste header below into row 1, columns A–L. Spelling, spacing, order must match exactly — workflow references headers by name.
### Canonical CSV header (copy-paste)
```csv
Email,First Name,Last Name,IMAP Username,IMAP Password,IMAP Host,IMAP Port,SMTP Username,SMTP Password,SMTP Host,SMTP Port,Status
```
Expected layout after paste:
| Email | First Name | Last Name | IMAP Username | IMAP Password | IMAP Host | IMAP Port | SMTP Username | SMTP Password | SMTP Host | SMTP Port | Status |
|-------|------------|-----------|---------------|---------------|-----------|-----------|---------------|---------------|-----------|-----------|--------|
| maria@acme.co | Maria | Diaz | maria@acme.co | •••••• | imap.acme.co | 993 | maria@acme.co | •••••• | smtp.acme.co | 587 |  |
| sam@acme.co | Sam | Lee | sam@acme.co | •••••• | imap.acme.co | 993 | sam@acme.co | •••••• | smtp.acme.co | 587 |  |
Column reference:
| Col | Header (exact) | Required | Example | Notes |
|-----|----------------|----------|---------|-------|
| A | `Email` | Yes | `maria@acme.co` | Lowercase preferred; unique per row; writeback key. |
| B | `First Name` | Yes | `Maria` | Sent as `first_name`. |
| C | `Last Name` | Yes | `Diaz` | Sent as `last_name`. |
| D | `IMAP Username` | Yes | `maria@acme.co` | Usually same as email. |
| E | `IMAP Password` | Yes | `app-password-xyz` | App password for most providers. |
| F | `IMAP Host` | Yes | `imap.acme.co` | No `https://`, no trailing slash. |
| G | `IMAP Port` | Yes | `993` | Typically `993` or `143`. Digits only. |
| H | `SMTP Username` | Yes | `maria@acme.co` | Sent as `smtp_username`. |
| I | `SMTP Password` | Yes | `app-password-xyz` | Often same as IMAP password. |
| J | `SMTP Host` | Yes | `smtp.acme.co` | No protocol prefix. |
| K | `SMTP Port` | Yes | `587` | Typically `587` or `465`. Digits only. |
| L | `Status` | Leave blank | (empty) | Workflow writes `Added` / `Failed - reason`. |
### Data hygiene rules
- One account per row. Dedupe column A (Data → Remove duplicates) before running.
- No blank `Email` rows. GET becomes `/accounts/` (invalid). Delete empty trailing rows.
- Trim whitespace. Spaces in `Email`/hosts/usernames are #1 first-run failure. Use `=TRIM(A2)` helper, paste values back.
- Ports digits only. `993`, not `993/tcp`. Workflow `Number()` cannot fix `imap:993`.
- Leave `Status` blank for new rows. Do not type `Pending` or `-`.
- Freeze row 1 (View → Freeze → 1 row) so sorting never buries headers.
- Copy Sheet ID now. From `https://docs.google.com/spreadsheets/d/YOUR_GOOGLE_SHEET_ID/edit`, copy middle segment for both Sheets nodes.
```text
https://docs.google.com/spreadsheets/d/1AbC2dEfGhIjKlMnOpQrStUvWxYz/edit#gid=0
                                         └──────── YOUR_GOOGLE_SHEET_ID ────────┘
```
## Credentials Setup
Four touchpoints: two Sheets nodes share one OAuth credential; two HTTP nodes share one API-key header; plus one sharing step.
### Google OAuth — both Sheets nodes
Apply to both `Get Sheet Rows` and `Update Status`:
1. n8n → Credentials → New → Google Sheets OAuth2 API.
2. Connect account with `Editor` on sheet; approve Sheets scopes.
3. Name e.g. `Google Sheets – Instantly Upload`.
4. Canvas → `Get Sheet Rows` → Credential → select it.
5. Repeat for `Update Status` — same credential. Two nodes, one credential. Differing credentials can make writeback appear to do nothing.
| Node | Credential field | Expected value |
|------|------------------|----------------|
| Get Sheet Rows | Google Sheets OAuth2 | `Google Sheets – Instantly Upload` |
| Update Status | Google Sheets OAuth2 | Same credential as above |
Verification:
```text
Get Sheet Rows → Execute Step → green, N items (one per row)
Update Status → dropdown shows same credential name
```
### Instantly API key — both HTTP nodes
Apply to both `Check Exists` (GET) and `Add Account` (POST):
1. Instantly → Settings → API → create/copy key.
2. `Check Exists` → Headers: Name `Authorization`, Value `Bearer YOUR_INSTANTLY_API_KEY` → replace with `Bearer <real-key>` (one space after Bearer).
3. `Add Account` → set identical header. Placeholder appears in both HTTP nodes in committed JSON — replace in both places after import.
| Node | Header name | Header value (after setup) |
|------|-------------|----------------------------|
| Check Exists | `Authorization` | `Bearer sk-live-…` (your key) |
| Add Account | `Authorization` | `Bearer sk-live-…` (same key) |
> Security: never commit real key. Keep placeholder in git; inject live key only in n8n (or credential store / env var). Rotate in Instantly if key appears in log, screenshot, or export.
Quick header test (redacted):
```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Bearer $INSTANTLY_API_KEY" \
  https://api.instantly.ai/api/v2/accounts/maria@acme.co
# 200 exists | 404 missing (both fine — auth works) | 401/403 key or scopes wrong
```
### Share the sheet with the OAuth identity
1. Sheets → Share → add same Google/service account you OAuth'd with.
2. Grant Editor (not Viewer/Commenter).
3. For service accounts, share with e.g. `n8n-uploader@project.iam.gserviceaccount.com`.
4. Confirm: `Get Sheet Rows` → Document → paste `YOUR_GOOGLE_SHEET_ID` → Execute Step returns rows. `403`/`not found` here is always sharing/ID problem, never Instantly.
Checklist:
- [ ] Both Sheets nodes: same OAuth, same Sheet ID replaced.
- [ ] Both HTTP nodes: same `Authorization: Bearer …` live key.
- [ ] Sheet shared as Editor to OAuth identity.
- [ ] No live secrets in exported JSON.
## Import the Workflow
### Import steps
1. Confirm canonical file exists:
```bash
ls -l workflows/instantly-smtp-accounts-bulk-upload.json
```
2. n8n → Workflows → ⋯ → Import from File → select that JSON.
3. Verify canvas shows 8 nodes with exact names above. Accept `typeVersion` migration prompt if shown.
4. Confirm settings after import:
```json
{ "name": "Instantly SMTP Accounts Bulk Upload", "active": false, "executionOrder": "v1" }
```
| Setting | Expected | Why |
|---------|----------|-----|
| `active` | `false` | Manual gate: run deliberately, not on restart. Activate only for schedules (RUNBOOK.md). |
| `executionOrder` | `v1` | Loop + writeback ordering tested against v1. Do not flip to v0 without re-testing. |
5. Replace placeholders: `Get Sheet Rows` Document ID `YOUR_GOOGLE_SHEET_ID` → real ID; `Update Status` same replacement; `Check Exists` header `Bearer YOUR_INSTANTLY_API_KEY` → live key; `Add Account` same live key.
6. Re-select credentials (imports strip them): both Sheets → OAuth; both HTTP → header auth.
7. Save (Ctrl/Cmd+S). Resting state is saved with `active: false`.
### Post-import validation
```bash
python3 -c "import json; d=json.load(open('workflows/instantly-smtp-accounts-bulk-upload.json')); print([n['name'] for n in d['nodes']]); print('active:', d.get('active'))"
# Expected: 8 names in order, active False
```
In n8n UI:
- [ ] 8/8 nodes, no unknown-node banners.
- [ ] No red credential warnings.
- [ ] `Get Sheet Rows → Execute Step` returns rows.
- [ ] Toggle shows Inactive (deliberate).
> If migration warnings appear, see `GUIDE.md` for upgrading node versions before editing logic.
## 5-Minute Quickstart
Assumes prerequisites, sheet, credentials, import done. ~5 min for 2 rows.
| Minute | Action | Where |
|--------|--------|-------|
| 0:00–1:00 | Confirm 2 blank-`Status` rows | Google Sheets |
| 1:00–2:00 | Confirm Inactive + credentials green | n8n canvas |
| 2:00–3:00 | Click Execute workflow, watch loop | n8n executions |
| 3:00–4:00 | Confirm `Status` flips to `Added` | Google Sheets |
| 4:00–5:00 | Spot-check in Instantly UI | Instantly → Accounts |
Steps:
1. Prep 2 rows with blank `Status` and valid test credentials. Leave others as `Added` (or remove for first run).
2. Open workflow. Toggle reads Inactive — manual runs work while inactive; expected.
3. Click Execute workflow. `Loop Each Row` pulses twice (once per row).
4. All 8 nodes green within ~10–30s for 2 rows.
5. Sheet: both rows read `Added` in column L. Refresh if open during run.
6. Instantly: Accounts → search each email → Connected/Active.
7. Re-run safety demo: Execute again without sheet edits. Finishes in ~3s with no POSTs (filter drops `Added`). Proves idempotency.
```text
Run 1 (2 blanks): GET x2 → POST x2 (if new) → Status: Added x2   ✅
Run 2 (0 blanks): filter drops all → done immediately             ✅ no-op
```
If `Failed - …`, do not re-run blindly — fix cause (usually creds/ports), clear cell to blank, re-run. Full triage in `RUNBOOK.md`.
## 2-Row Smoke Test
Prove pipeline before real data. Use staging/disposable mailboxes, never production.
### Fixture (paste into rows 2–3, columns A–L)
```csv
Email,First Name,Last Name,IMAP Username,IMAP Password,IMAP Host,IMAP Port,SMTP Username,SMTP Password,SMTP Host,SMTP Port,Status
smoke01@test-acme.dev,Smoke,ZeroOne,smoke01@test-acme.dev,REPLACE_IMAP_PASS_01,imap.test-acme.dev,993,smoke01@test-acme.dev,REPLACE_SMTP_PASS_01,smtp.test-acme.dev,587,
smoke02@test-acme.dev,Smoke,ZeroTwo,smoke02@test-acme.dev,REPLACE_IMAP_PASS_02,imap.test-acme.dev,993,smoke02@test-acme.dev,REPLACE_SMTP_PASS_02,smtp.test-acme.dev,587,
```
> Replace `REPLACE_*` with real test passwords. Keep `Status` empty — trailing comma with nothing after is intentional.
### Expected results
| Step | Expected |
|------|----------|
| Get Sheet Rows | ≥ 2 items |
| Keep Blanks Only | 2 items through |
| Loop Each Row | 2 passes, then done |
| Check Exists (first run) | 404 / empty email → false branch |
| Add Account | 200/201, response contains lowercase email |
| Update Status | Rows → `Added` |
| Second Execute (no edits) | 0 past filter, no POSTs |
| Instantly UI | Both smoke accounts visible |
### Pass / fail criteria
- PASS: both rows → `Added` within 60s; second run no-op; both searchable in Instantly.
- FAIL: either row `Failed - <reason>`. Map with starter table (full table in `RUNBOOK.md`):
| Status value | Likely cause | Fix |
|--------------|--------------|-----|
| `Failed - 401 Unauthorized` | Wrong key or scopes | Re-paste key in both HTTP nodes; confirm accounts:read/create |
| `Failed - 404` on POST | Wrong base URL / workspace | Confirm `https://api.instantly.ai/api/v2/accounts`, correct key |
| `Failed - Invalid port` / 400 | Ports not digits | Fix to `993`/`587`, clear Status, re-run |
| `Failed - Auth failed (IMAP/SMTP)` | Mailbox password/host wrong | Verify in mail client; use app passwords |
| `Failed - Exists check failed` | GET failed (network/auth) | Check key + network; re-run |
| Still blank after run | Hidden space in Status or loop never reached | Clear fully; check Keep Blanks Only count |
### Clean up after smoke test
- Delete/disable smoke accounts in Instantly if test-only.
- Leave rows as `Added` (skipped forever) or delete rows.
- Load real batch in chunks (25–50 rows per run; see `RUNBOOK.md` for batch sizing).
## Repository Layout
```text
n8n-instantly-smtp-bulk-upload/
├── workflows/instantly-smtp-accounts-bulk-upload.json  # canonical workflow (import this)
├── docs/README.md    # you are here (onboarding)
├── docs/GUIDE.md     # deep-dive operator guide
├── docs/RUNBOOK.md   # production operations + triage
├── README.md         # landing (points here)
└── LICENSE
```
Conventions:
- After canvas changes: Export → overwrite `workflows/instantly-smtp-accounts-bulk-upload.json` → commit naming nodes touched.
- Never commit live secrets. Git must always show `YOUR_GOOGLE_SHEET_ID` and `Bearer YOUR_INSTANTLY_API_KEY`. Any commit with live key = rotation event.
- Placeholders only in docs; real passwords in sheet + n8n runtime only.
## Next Steps
| Goal | Go to |
|------|-------|
| Every node, expression, 12-field POST map in depth | [GUIDE.md](./GUIDE.md) — operator guide |
| Schedule, batch sizing, triage Failed, rate limits, rollback | [RUNBOOK.md](./RUNBOOK.md) — runbook |
| Import and run | Import + Quickstart above |
| Customize safely (new columns, dry-run, Slack alerts) | GUIDE.md customization recipes |
Suggested path:
1. ✅ This README (theory done).
2. → GUIDE.md Node-by-node — read both HTTP nodes fully.
3. → RUNBOOK.md Pre-flight — print for first real batch.
4. → Schedule only after 3 consecutive clean manual runs.
## Troubleshooting Preview
Full trees in `RUNBOOK.md`. Three onboarding blockers:
### Get Sheet Rows returns 0 items or errors
| Symptom | Cause | Fix |
|---------|-------|-----|
| `403 PERMISSION_DENIED` | Not shared with OAuth identity | Share as Editor; re-execute |
| `404 File not found` | Wrong Sheet ID | Re-copy ID; no extra chars |
| 0 items, no error | Wrong tab / sheetName | Set tab to `Accounts` or match param |
| Headers with undefined keys | Header typo/case | Restore exact CSV header above |
### Everything writes Failed - 401
Both HTTP nodes share same key. Fixing one and forgetting other leaves half graph broken.
```bash
# Check Exists 401 → GET auth broken | Add Account 401 → POST auth broken (second node missed)
# Fix: paste SAME live key into BOTH nodes, Save, re-run one cleared row.
```
### Update Status does not write back
- Same document ID + credential as Get Sheet Rows.
- Match column `Email` (capital-E). Lowercase never matches.
- Confirm loop reaches Update Status (red Add Account without fail-soft routing can strand item; see GUIDE.md Error paths).
> Still stuck? Capture execution ID, exact Status string, failing node output JSON, then follow RUNBOOK.md Incident template.
## Maintenance and Versioning
| Item | Policy |
|------|--------|
| Canonical artifact | `workflows/instantly-smtp-accounts-bulk-upload.json` in git; canvas ephemeral. |
| Settings | Keep `active: false`, `executionOrder: v1` unless RUNBOOK scheduling says otherwise. |
| Node upgrades | Accept migrations, diff vs 8-node list, run smoke test. |
| Last tested | `2026-09-08` on n8n 1.x, googleSheets@4.7, filter@2.3, splitInBatches@3, httpRequest@4.5, if@2.3, Instantly `/api/v2/accounts`. |
| Change log | Commit messages name nodes (e.g., `fix(Add Account): coerce smtp_port via Number()`). |
| Secret hygiene | Placeholders in git always; live values in n8n runtime only. |
| Review cadence | Re-smoke-test quarterly or after n8n minor / Instantly changelog. |
## License and Support
- License: see `LICENSE` at root.
- Support: file issue with n8n version, 8 node versions, exact Status string, redacted execution JSON. Never paste live keys or passwords.
- Contributing: PRs welcome for docs. PRs embedding live credentials closed without review.
*You are ready. Import the workflow, run the 2-row smoke test, then continue with [GUIDE.md](./GUIDE.md) for mastery and [RUNBOOK.md](./RUNBOOK.md) for production confidence. Happy uploading.*

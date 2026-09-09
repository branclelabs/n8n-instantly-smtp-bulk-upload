# n8n-instantly-smtp-bulk-upload — Technical Reference Guide

> **Workflow:** `Instantly SMTP Accounts – Bulk Upload`
> **File:** `workflows/instantly-smtp-accounts-bulk-upload.json`
> **n8n executionOrder:** `v1` · **Nodes:** 8 · **Trigger:** Manual
> **Audience:** Builders, operators, reviewers

---

## Table of Contents

- [1. Overview](#1-overview)
- [2. Repository Map](#2-repository-map)
- [3. Google Sheet Schema — 12 Columns](#3-google-sheet-schema--12-columns)
- [4. Connection Map and Control Flow](#4-connection-map-and-control-flow)
- [5. Node 1 — Start Manually (`manualTrigger@1`)](#5-node-1--start-manually-manualtrigger1)
- [6. Node 2 — Get Sheet Rows (`googleSheets@4.7` Read)](#6-node-2--get-sheet-rows-googlesheets47-read)
- [7. Node 3 — Keep Blanks Only (`filter@2.3`)](#7-node-3--keep-blanks-only-filter23)
- [8. Node 4 — Loop Each Row (`splitInBatches@3`)](#8-node-4--loop-each-row-splitinbatches3)
- [9. Node 5 — Check Exists (`httpRequest@4.5` GET)](#9-node-5--check-exists-httprequest45-get)
- [10. Node 6 — Skip Existing (`if@2.3`)](#10-node-6--skip-existing-if23)
- [11. Node 7 — Add Account (`httpRequest@4.5` POST)](#11-node-7--add-account-httprequest45-post)
- [12. Node 8 — Update Status (`googleSheets@4.7` appendOrUpdate)](#12-node-8--update-status-googlesheets47-appendorupdate)
- [13. Data Shapes](#13-data-shapes)
- [14. Inlined Samples](#14-inlined-samples)
- [15. Instantly v2 API Subset](#15-instantly-v2-api-subset)
- [16. Environment Reference (`.env`)](#16-environment-reference-env)
- [17. Hardening — Guards and Traps](#17-hardening--guards-and-traps)
- [18. Operations Cheatsheet](#18-operations-cheatsheet)
- [19. FAQ](#19-faq)
- [20. Roadmap](#20-roadmap)
- [Appendix A — Full Expression Inventory](#appendix-a--full-expression-inventory)
- [Appendix B — Version Pin Table](#appendix-b--version-pin-table)

---

## 1. Overview

This guide is the normative technical reference for the
`n8n-instantly-smtp-bulk-upload` repository.

The workflow bulk-creates custom SMTP/IMAP sending accounts in
Instantly.ai from rows in a Google Sheet, one row at a time,
with idempotent skip-if-exists semantics and per-row status write-back.

### 1.1 What it does

1. Reads every row from a configured Google Sheet.
2. Keeps only rows where `Status` is empty.
3. Loops rows sequentially with `batchSize: 1`.
4. For each row, `GET /api/v2/accounts/{email}` to check existence.
5. Branches on the GET result:
   - Exists → skip creation, mark row.
   - Not exists → `POST /api/v2/accounts` with `provider_code: 1`.
6. Writes `Added` or `Failed - <reason>` back to `Status`, matched on `Email`.
7. Loops back until the batch is exhausted.

### 1.2 Design principles

- **Sequential over parallel.**
  One API write at a time avoids Instantly rate-limit bursts
  and keeps Google Sheet write-back deterministic.
- **Idempotent reruns.**
  `Keep Blanks Only` plus `matchingColumns: [Email]` means
  re-executing the workflow only processes unfinished rows.
- **Fail-row, not fail-run.**
  Both HTTP nodes use `onError: continueErrorOutput` so one bad
  credential, typo, or 4xx does not abort the remaining 999 rows.
- **No silent trim of secrets.**
  Passwords are passed verbatim. Everything else human-typed
  (`email`, names, hosts, usernames) is trimmed.
- **Explicit types on the wire.**
  `provider_code`, `imap_port`, `smtp_port` are JSON numbers,
  never quoted strings.

### 1.3 Node inventory

| # | Name | Type | typeVersion | Role |
|---|---|---|---|---|
| 1 | Start Manually | `n8n-nodes-base.manualTrigger` | 1 | Manual entry point |
| 2 | Get Sheet Rows | `n8n-nodes-base.googleSheets` | 4.7 | Read all sheet rows |
| 3 | Keep Blanks Only | `n8n-nodes-base.filter` | 2.3 | Keep `Status` empty |
| 4 | Loop Each Row | `n8n-nodes-base.splitInBatches` | 3 | Sequential loop, `batchSize: 1` |
| 5 | Check Exists | `n8n-nodes-base.httpRequest` | 4.5 | `GET accounts/{email}` |
| 6 | Skip Existing | `n8n-nodes-base.if` | 2.3 | Branch on `$json.email` notEmpty |
| 7 | Add Account | `n8n-nodes-base.httpRequest` | 4.5 | `POST accounts`, `provider_code: 1` |
| 8 | Update Status | `n8n-nodes-base.googleSheets` | 4.7 | `appendOrUpdate` on `Email` |

### 1.4 Execution settings (pinned)

```json
{
  "executionOrder": "v1",
  "binaryMode": "separate",
  "saveExecutionProgress": true,
  "saveManualExecutions": false,
  "saveDataErrorExecution": "all",
  "saveDataSuccessExecution": "none",
  "executionTimeout": 300
}
```

Notes:

- `saveDataSuccessExecution: none` keeps large bulk runs light.
- `saveDataErrorExecution: all` preserves failed items for forensics.
- `executionTimeout: 300` (seconds) bounds a stuck run.
- `active: false` by default. This workflow is manual-only.
  Do not activate on a schedule without adding a Scheduler trigger
  and re-validating idempotency.

---

## 2. Repository Map

```text
.
├── workflows/
│   └── instantly-smtp-accounts-bulk-upload.json
├── docs/
│   ├── README.md
│   ├── GUIDE.md
│   └── RUNBOOK.md
├── README.md
├── LICENSE
├── .gitignore
└── .env.example
```

Canonical sources of truth:

- Workflow topology: `workflows/instantly-smtp-accounts-bulk-upload.json`.
- Sheet contract: header block in [§3](#3-google-sheet-schema--12-columns).
- POST contract: sample body in [§14.1](#141-sample-post-json).
- Status contract: sample output in [§14.2](#142-sample-status-json).
- Secrets template: `.env.example`.

---

## 3. Google Sheet Schema — 12 Columns

The sheet **MUST** contain exactly these 12 headers in row 1,
spelled exactly as shown (case-sensitive, single spaces).

> Header block (copy-paste safe):

```csv
Email,First Name,Last Name,IMAP Username,IMAP Password,IMAP Host,IMAP Port,SMTP Username,SMTP Password,SMTP Host,SMTP Port,Status
```

### 3.1 Schema table

| Column | Type | Required | Transform | Example | Failure |
|---|---|---|---|---|---|
| `Email` | string (email) | **Yes** | `trim() + toLowerCase()` in GET URL and POST `email` | `john.doe@example.com` | `422` / `Failed - invalid email` if malformed; `NaN`/empty breaks GET lookup |
| `First Name` | string | **Yes** | `.toString().trim()` | `John` | Leading/trailing spaces sent verbatim if transform removed; API may `400` on empty |
| `Last Name` | string | **Yes** | `.toString().trim()` | `Doe` | Same as First Name; empty last name risks `422` |
| `IMAP Username` | string | **Yes** | `.toString().trim()` | `john.doe@example.com` | Untrimmed whitespace causes IMAP auth failure post-creation (account created but broken) |
| `IMAP Password` | string (secret) | **Yes** | **NO trim** — `.toString()` only | `xY9#qW2!vLp$7` | Trimming breaks passwords with leading/trailing spaces; never log this value |
| `IMAP Host` | string (hostname) | **Yes** | `.toString().trim()` | `imap.example.com` | Trailing space or `https://` prefix causes connection failure; `Failed - ...` on verify |
| `IMAP Port` | integer-as-string in Sheet → number on wire | **Yes** | `Number(...)` | `993` | Empty/alpha → `NaN` → `400/422`; see [NaN-port guard](#171-nan-port-guard) |
| `SMTP Username` | string | **Yes** | `.toString().trim()` | `john.doe@example.com` | Same whitespace risk as IMAP Username |
| `SMTP Password` | string (secret) | **Yes** | **NO trim** — `.toString()` only | `sMtP$3cReT!9` | Same as IMAP Password; keep verbatim |
| `SMTP Host` | string (hostname) | **Yes** | `.toString().trim()` | `smtp.example.com` | Same as IMAP Host |
| `SMTP Port` | integer-as-string in Sheet → number on wire | **Yes** | `Number(...)` | `587` | Same `NaN` risk; typical values `587` (STARTTLS) or `465` (SSL) |
| `Status` | string (workflow-owned) | No (leave blank to queue) | Written by `Update Status`; read by `Keep Blanks Only` as `empty` | `Added` or `Failed - Account already exists` | Non-empty blocks rerun; truncated to ~207 chars (`Failed - ` + 200 sliced chars) |

### 3.2 Detailed column notes

#### `Email` (key)

- The **only** match key for `Update Status` (`matchingColumns: [Email]`).
- Must be unique per row. Duplicates cause last-write-wins on Status.
- Normalized to lowercase on every API call.
- The Sheet value itself is **not** rewritten to lowercase;
  only the API payload and GET URL use the normalized form.
- If you need canonical lowercase in the Sheet, normalize the Sheet
  before running.

#### `First Name` / `Last Name`

- Trimmed. Empty after trim is sent as `""`.
- Instantly generally requires non-empty names for deliverability display.
- Do not pass `null`. The workflow always stringifies.

#### `IMAP Username` / `SMTP Username`

- Usually identical to `Email`, but may differ on custom setups.
- Trimmed independently of `Email`.
- Case is preserved (only `Email` is lowercased).

#### `IMAP Password` / `SMTP Password`

- **Never trimmed. Never logged. Never pasted into issues.**
- `.toString()` only, preserving every character including
  leading/trailing spaces.
- If your provider auto-strips spaces, you must pre-normalize
  deliberately — do not change the workflow default.

#### `IMAP Host` / `SMTP Host`

- Bare hostname only. No scheme, no port suffix, no path.
- Correct: `imap.example.com`.
- Wrong: `https://imap.example.com`, `imap.example.com:993`.

#### `IMAP Port` / `SMTP Port`

- Entered as plain digits in the Sheet (`993`, `587`).
- Converted with `Number()` in `Add Account`.
- Common pairs:
  - IMAP SSL: `993`; IMAP STARTTLS: `143`.
  - SMTP submission: `587`; SMTP SSL: `465`.
- See [NaN-port guard](#171-nan-port-guard) for hardening.

#### `Status` (workflow-owned)

- Leave **blank** to queue a row.
- `Keep Blanks Only` uses strict `empty` on `{{ $json.Status }}`.
- A single space is **not** empty. Clean stray spaces before running.
- Values written:
  - `Added` — success path.
  - `Failed - <message>` — error path, message sliced to 200 chars.
- To retry a failed row, clear its `Status` cell and rerun.

### 3.3 Validation checklist before each run

- [ ] Row 1 headers match the CSV header block exactly.
- [ ] No extra columns before `Email` or after `Status`.
- [ ] `Email` column has no leading/trailing spaces in the raw cell
  (workflow trims for API, but matching uses raw `Email` for lookup).
- [ ] Ports are digits only, no `993/tcp` or `"993" with quotes`.
- [ ] Passwords pasted without accidental line breaks.
- [ ] `Status` is truly empty for rows to process (not `" "` or `"-"`).

---

## 4. Connection Map and Control Flow

### 4.1 Connection map table

| From | Output | To | When |
|---|---|---|---|
| Start Manually | `main` | Get Sheet Rows | Manual execution |
| Get Sheet Rows | `main` | Keep Blanks Only | After Sheet read |
| Keep Blanks Only | `main` (true) | Loop Each Row | Only `Status` empty rows pass |
| Loop Each Row | `main[1]` (loop) | Check Exists | One item per iteration; `main[0]` (done) terminates |
| Check Exists | `main[0]` (success) | Skip Existing | GET returned 2xx with JSON body |
| Check Exists | `main[1]` (error output) | Add Account | GET errored (`continueErrorOutput`); interpreted as not-found path — see caveat below |
| Skip Existing | `main[0]` (true) | Update Status | `$json.email` notEmpty → account exists, skip creation |
| Skip Existing | `main[1]` (false) | Add Account | `$json.email` empty/missing → create |
| Add Account | `main[0]` (success) | Update Status | POST 2xx |
| Add Account | `main[1]` (error output) | Update Status | POST 4xx/5xx/timeout after retries; `Status` becomes `Failed - ...` |
| Update Status | `main` | Loop Each Row | Write-back then loop-back for next item |

> **Caveat on `Check Exists → Add Account (error output)`:**
> Any GET error (404, 401, 429, 5xx, timeout after 3 tries)
> flows to `Add Account` via the error output.
> A `404` is the intended “not found → create” signal.
> A `401/429/5xx` will also attempt creation and then surface as
> `Failed - ...` on the POST error branch if creation also fails.
> Do not treat error-output routing as proof of non-existence.
> See [error-to-Status mapping](#158-error-to-status-mapping).

### 4.2 Full mermaid graph

```mermaid
flowchart TB
  A["Start Manually<br/>manualTrigger@1"] --> B["Get Sheet Rows<br/>googleSheets@4.7 read"]
  B --> C{"Keep Blanks Only<br/>filter@2.3<br/>Status empty?"}
  C -- "No (Status set) → dropped" --> Z1["(discarded)"]
  C -- "Yes → pass" --> D["Loop Each Row<br/>splitInBatches@3<br/>batchSize=1"]
  D -- "done (no items left)" --> Z2["(run ends)"]
  D -- "loop: 1 item" --> E["Check Exists<br/>httpRequest@4.5<br/>GET accounts/{email}"]
  E -- "success output [0]" --> F{"Skip Existing<br/>if@2.3<br/>$json.email notEmpty?"}
  E -- "error output [1]<br/>404 / 401 / 429 / 5xx / timeout" --> G["Add Account<br/>httpRequest@4.5<br/>POST accounts"]
  F -- "true: email present<br/>→ exists" --> H["Update Status<br/>googleSheets@4.7<br/>appendOrUpdate"]
  F -- "false: email empty<br/>→ create" --> G
  G -- "success output [0]" --> H
  G -- "error output [1]" --> H
  H -- "loop-back" --> D
```

### 4.3 Loop semantics

- `splitInBatches@3` with default `batchSize: 1` emits one item
  on the loop output per iteration.
- `Update Status` connects back to `Loop Each Row`.
  n8n routes the completion signal to fetch the next item.
- When no items remain, the `done` output fires (connected to nothing),
  ending the run cleanly.
- Do **not** insert concurrency, batch-size increases, or parallel
  branches inside the loop without re-testing Sheet match races
  and Instantly rate limits.

### 4.4 Error-branch semantics

- `onError: continueErrorOutput` on both HTTP nodes splits each
  node into two outputs: `[0]` success, `[1]` error-as-item.
- Downstream `Update Status` inspects `$json.error`:
  - Present → `Failed - <sliced message>`.
  - Absent → `Added`.
- This is why both `Add Account` outputs converge on `Update Status`.

---

## 5. Node 1 — Start Manually (`manualTrigger@1`)

### 5.1 Purpose

Manual entry point. No schedule, no webhook. Operator clicks
**Execute workflow** in n8n.

### 5.2 Parameters (literal)

```json
{
  "parameters": {},
  "name": "Start Manually",
  "type": "n8n-nodes-base.manualTrigger",
  "typeVersion": 1
}
```

Position: `[240, 448]`.

### 5.3 Expressions

None. No inputs, no configuration.

### 5.4 Pitfalls

- Forgetting the run is manual and expecting automatic pickup
  of new Sheet rows. There is no polling. Rerun manually.
- Activating the workflow in n8n does nothing useful —
  there is no active trigger to listen. Keep `active: false`.
- Running twice concurrently can double-create or double-write.
  Wait for the first execution to finish.

### 5.5 Version pin

- `manualTrigger@1`. Stable. No reason to upgrade unless n8n
  deprecates v1. Validate after any major n8n upgrade.

---

## 6. Node 2 — Get Sheet Rows (`googleSheets@4.7` Read)

### 6.1 Purpose

Reads all rows from the configured spreadsheet tab.

### 6.2 Parameters (literal)

```json
{
  "documentId": {
    "mode": "list",
    "value": "YOUR_GOOGLE_SHEET_ID"
  },
  "sheetName": {
    "mode": "list",
    "value": "YOUR_SHEET_NAME"
  },
  "options": {}
}
```

- Type: `n8n-nodes-base.googleSheets`.
- typeVersion: `4.7`.
- Operation: default **Read** (no explicit `operation`/`resource`
  in JSON; n8n infers read from absence of `appendOrUpdate`).
- Position: `[464, 448]`.
- Credentials: Google Sheets OAuth2 / service account
  (configured in n8n UI, not in JSON).

### 6.3 Expressions

None inside parameters. `documentId` and `sheetName` are static
list-mode references. Replace `YOUR_GOOGLE_SHEET_ID` and
`YOUR_SHEET_NAME` in the n8n UI or via environment wiring.

### 6.4 Output shape

One item per Sheet row (excluding header), e.g.:

```json
{
  "Email": "john.doe@example.com",
  "First Name": "John",
  "Last Name": "Doe",
  "IMAP Username": "john.doe@example.com",
  "IMAP Password": "dummy-imap-pass-1",
  "IMAP Host": "imap.example.com",
  "IMAP Port": "993",
  "SMTP Username": "john.doe@example.com",
  "SMTP Password": "dummy-smtp-pass-1",
  "SMTP Host": "smtp.example.com",
  "SMTP Port": "587",
  "Status": ""
}
```

> Note: Ports arrive as **strings** from Sheets (`"993"`).
> They become numbers only in `Add Account` via `Number()`.

### 6.5 Pitfalls

- Wrong tab selected (`sheetName` is a display name / GID-backed list value).
  Renaming the tab breaks the list reference — re-select it.
- Google credential lacks access → node errors before any filtering.
  Share the Sheet with the service account email if using service auth.
- Header rename (e.g. `email` lowercase) silently produces
  `undefined` downstream and `NaN` ports. Headers are case-sensitive.
- Empty trailing rows in Sheets can emit items with all-empty fields.
  `Keep Blanks Only` will pass them (Status empty) and they will fail
  at POST with `422`. Delete trailing empty rows.

### 6.6 Version pin

- `googleSheets@4.7`. Pinned. v4.x changed `documentId`/`sheetName`
  to object-mode (`{ mode, value }`). Do not downgrade to v3
  without rewriting these fields.

---

## 7. Node 3 — Keep Blanks Only (`filter@2.3`)

### 7.1 Purpose

Drops every row whose `Status` is non-empty, so reruns are incremental.

### 7.2 Parameters (literal)

```json
{
  "conditions": {
    "options": {
      "caseSensitive": true,
      "leftValue": "",
      "typeValidation": "strict",
      "version": 3
    },
    "conditions": [
      {
        "id": "cond1",
        "leftValue": "={{ $json.Status }}",
        "rightValue": "",
        "operator": {
          "type": "string",
          "operation": "empty",
          "singleValue": true
        }
      }
    ],
    "combinator": "and"
  },
  "options": {}
}
```

- Type: `n8n-nodes-base.filter`, typeVersion `2.3`.
- Position: `[688, 448]`.

### 7.3 Literal expressions

| Field | Literal |
|---|---|
| Condition left | `={{ $json.Status }}` |
| Operator | `empty` (string, singleValue) |
| Right | `""` (unused by `empty`, kept as `""`) |

`caseSensitive: true`, `typeValidation: strict`, `version: 3`.

### 7.4 Pitfalls

- **Capital `S` trap.** The filter reads `$json.Status` (capital S,
  Sheet header). The later `Skip Existing` IF reads `$json.email`
  (lowercase, API field). Mixing them up inverts the logic.
  See [Email-vs-email trap](#172-email-vs-email-trap).
- A cell containing a single space `" "` is **not** empty.
  The row will be skipped forever. Trim the Sheet.
- `Added` vs `added` — `caseSensitive: true` does not affect `empty`,
  but if you later change to `equals`, case matters.
- If zero rows pass, downstream nodes receive no items and the run
  ends silently with success. That is correct — nothing to do.

### 7.5 Version pin

- `filter@2.3`. The `conditions.options.version: 3` blob is tied
  to this major. Do not hand-edit to v2 syntax.

---

## 8. Node 4 — Loop Each Row (`splitInBatches@3`)

### 8.1 Purpose

Sequential iterator. Guarantees one-at-a-time API pacing
and one-at-a-time Sheet write-back.

### 8.2 Parameters (literal)

```json
{
  "options": {}
}
```

- Type: `n8n-nodes-base.splitInBatches`, typeVersion `3`.
- Position: `[912, 448]`.
- Implicit `batchSize: 1` (n8n default when `options` is empty).
- No explicit `batchSize` key in JSON — relies on default.

> If your n8n version serializes `batchSize` explicitly, you may see
> `"batchSize": 1` in the UI. Functionally identical. Do not set >1
> without reading [§4.3](#43-loop-semantics) and rate limits.

### 8.3 Wiring

- Input: `Keep Blanks Only → Loop Each Row`.
- Loop output (`main[1]`): → `Check Exists`.
- Done output (`main[0]`): → unconnected (terminates).
- Loop-back input: `Update Status → Loop Each Row`.

```json
"Loop Each Row": {
  "main": [
    [],
    [{ "node": "Check Exists", "type": "main", "index": 0 }]
  ]
}
```

### 8.4 The `$('Loop Each Row').item.json` pattern

Downstream `Add Account` and `Update Status` do **not** use the
immediate upstream `$json` for identity fields. They reach back to
the loop's current item:

```javascript
$('Loop Each Row').item.json.Email
$('Loop Each Row').item.json['First Name']
$('Loop Each Row').item.json['IMAP Port']
```

This is load-bearing. By the time `Add Account` runs, `$json`
is the GET response (API shape, lowercase `email`), not the Sheet row.
Referencing `$json.Email` there would be `undefined`.
Always use `$('Loop Each Row').item.json.<Sheet Header>` for Sheet data
after `Check Exists` / `Skip Existing`.

### 8.5 Pitfalls

- Renaming `Loop Each Row` breaks every `$('Loop Each Row')` expression.
  If you rename, update `Add Account.jsonBody` and both
  `Update Status` column expressions.
- Setting `batchSize > 1` sends arrays downstream and breaks
  `{{ $json.Email.toString() }}` (array has no `.toString()` row semantics
  you expect — it stringifies the whole batch).
- Forgetting the loop-back edge (`Update Status → Loop Each Row`)
  processes exactly one row then stops.

### 8.6 Version pin

- `splitInBatches@3`. v3 changed output indexing (`done` is index 0).
  Older tutorials showing opposite wiring are for v1/v2 — ignore them.

---

## 9. Node 5 — Check Exists (`httpRequest@4.5` GET)

### 9.1 Purpose

Idempotency probe. Looks up the account by normalized email.
Success → route to `Skip Existing` for branch decision.
Any error → error output → `Add Account` (create attempt).

### 9.2 Parameters (literal)

```json
{
  "url": "=https://api.instantly.ai/api/v2/accounts/{{ $json.Email.toString().trim().toLowerCase() }}",
  "sendHeaders": true,
  "headerParameters": {
    "parameters": [
      {
        "name": "Authorization",
        "value": "Bearer YOUR_INSTANTLY_API_KEY"
      }
    ]
  },
  "options": {
    "timeout": 30000
  }
}
```

Plus node-level flags:

```json
{
  "type": "n8n-nodes-base.httpRequest",
  "typeVersion": 4.5,
  "retryOnFail": true,
  "maxTries": 3,
  "waitBetweenTries": 2000,
  "onError": "continueErrorOutput"
}
```

- Method: default `GET` (no explicit `method` key).
- Position: `[1136, 384]`.
- Timeout: `30000` ms per attempt.
- Retry: 3 tries, 2000 ms wait between tries.

### 9.3 Literal expressions

| Field | Literal |
|---|---|
| `url` | `=https://api.instantly.ai/api/v2/accounts/{{ $json.Email.toString().trim().toLowerCase() }}` |
| `Authorization` | `Bearer YOUR_INSTANTLY_API_KEY` (replace with credential / env) |

URL breakdown:

- Base: `https://api.instantly.ai/api/v2/accounts/`.
- Suffix: `{{ $json.Email.toString().trim().toLowerCase() }}`.
- `$json.Email` here is the **Sheet** row (capital E) because
  `Check Exists` is the first node after the loop — no API shape yet.

### 9.4 Expected statuses

| Status | Meaning | Routing |
|---|---|---|
| `200` | Account exists; body contains `email` | `main[0]` → `Skip Existing` (will take true branch) |
| `404` | No account for this email | `main[1]` error output → `Add Account` (intended create path) |
| `401` | Bad/expired API key | `main[1]` → `Add Account` (will also fail → `Failed - ...`); fix key, clear Status, rerun |
| `429` | Rate limited | Retried 3×, then `main[1]` → `Add Account`; see throttle strategy |
| `5xx` / timeout | Instantly or network fault | Same as 429 path |

### 9.5 Pitfalls

- `YOUR_INSTANTLY_API_KEY` committed to JSON. Replace with
  n8n credential, env expression, or header auth before sharing.
- Forgetting `.toString()` when `Email` is parsed as number-like
  (rare) throws `Cannot read properties of undefined`.
  The workflow guards with `.toString()` — keep it.
- Assuming error output always means 404. Log `$json.error`
  during debugging; 401 misdiagnosed as “not found” wastes runs.
- Lowercasing the GET but matching Status on raw `Email`:
  `John@X.com` vs `john@x.com` can create case-duplicate confusion.
  Normalize the Sheet if your data has mixed case.

### 9.6 Version pin

- `httpRequest@4.5`. Retry/timeout/`onError` semantics pinned here.
  Upgrading to 4.6+ requires re-validating `continueErrorOutput`
  output indexes.

---

## 10. Node 6 — Skip Existing (`if@2.3`)

### 10.1 Purpose

Routes GET successes: existing accounts skip creation;
empty/missing `email` proceeds to creation.
This node only sees the **success** output of `Check Exists`.

### 10.2 Parameters (literal)

```json
{
  "conditions": {
    "options": {
      "caseSensitive": true,
      "leftValue": "",
      "typeValidation": "strict",
      "version": 3
    },
    "conditions": [
      {
        "id": "c1",
        "leftValue": "={{ $json.email }}",
        "rightValue": "",
        "operator": {
          "type": "string",
          "operation": "notEmpty",
          "singleValue": true
        }
      }
    ],
    "combinator": "and"
  },
  "options": {}
}
```

- Type: `n8n-nodes-base.if`, typeVersion `2.3`.
- Position: `[1360, 448]`.

### 10.3 Literal expressions

| Field | Literal |
|---|---|
| Condition left | `={{ $json.email }}` — **lowercase `e`** (API field) |
| Operator | `notEmpty` (string) |
| True output `main[0]` | → `Update Status` (skip creation) |
| False output `main[1]` | → `Add Account` (create) |

Connections:

```json
"Skip Existing": {
  "main": [
    [{ "node": "Update Status", "type": "main", "index": 0 }],
    [{ "node": "Add Account", "type": "main", "index": 0 }]
  ]
}
```

### 10.4 Pitfalls — the central trap

This is the **Email-vs-email trap** in miniature.
See [full trap section](#172-email-vs-email-trap).

- `$json.email` (lowercase) = Instantly GET response field.
- `$json.Email` (capital) = Google Sheet header.
- Using capital `Email` here always evaluates `notEmpty → true`
  (because the GET body rarely has capital `Email`),
  or always false depending on response shape — either way wrong.
- Keep it lowercase. Do not “fix” to capital.

### 10.5 Version pin

- `if@2.3` with `conditions.options.version: 3`.
  Same family as `filter@2.3` — same syntax rules.

---

## 11. Node 7 — Add Account (`httpRequest@4.5` POST)

### 11.1 Purpose

Creates a custom SMTP account (`provider_code: 1`) from the
current Sheet row. Both success and error converge on `Update Status`.

### 11.2 Parameters (literal)

```json
{
  "method": "POST",
  "url": "https://api.instantly.ai/api/v2/accounts",
  "sendHeaders": true,
  "headerParameters": {
    "parameters": [
      { "name": "Authorization", "value": "Bearer YOUR_INSTANTLY_API_KEY" },
      { "name": "Content-Type", "value": "application/json" }
    ]
  },
  "sendBody": true,
  "specifyBody": "json",
  "jsonBody": "={{ JSON.stringify({ email: $('Loop Each Row').item.json.Email.toString().trim().toLowerCase(), first_name: $('Loop Each Row').item.json['First Name'].toString().trim(), last_name: $('Loop Each Row').item.json['Last Name'].toString().trim(), provider_code: 1, imap_username: $('Loop Each Row').item.json['IMAP Username'].toString().trim(), imap_password: $('Loop Each Row').item.json['IMAP Password'].toString(), imap_host: $('Loop Each Row').item.json['IMAP Host'].toString().trim(), imap_port: Number($('Loop Each Row').item.json['IMAP Port']), smtp_username: $('Loop Each Row').item.json['SMTP Username'].toString().trim(), smtp_password: $('Loop Each Row').item.json['SMTP Password'].toString(), smtp_host: $('Loop Each Row').item.json['SMTP Host'].toString().trim(), smtp_port: Number($('Loop Each Row').item.json['SMTP Port']) }) }}",
  "options": {
    "timeout": 30000
  }
}
```

Node flags:

```json
{
  "retryOnFail": true,
  "maxTries": 3,
  "waitBetweenTries": 2000,
  "onError": "continueErrorOutput"
}
```

- Position: `[1584, 304]`.
- `specifyBody: json` + `jsonBody` with leading `=` expression.

### 11.3 Field-by-field transform table (POST body)

| JSON key | Source (Sheet header) | Transform | Wire type | Example |
|---|---|---|---|---|
| `email` | `Email` | `trim + lower` | string | `"john.doe@example.com"` |
| `first_name` | `First Name` | `trim` | string | `"John"` |
| `last_name` | `Last Name` | `trim` | string | `"Doe"` |
| `provider_code` | — (constant) | literal `1` | **number** | `1` |
| `imap_username` | `IMAP Username` | `trim` | string | `"john.doe@example.com"` |
| `imap_password` | `IMAP Password` | **no trim** | string | `"dummy-imap-pass-1"` |
| `imap_host` | `IMAP Host` | `trim` | string | `"imap.example.com"` |
| `imap_port` | `IMAP Port` | `Number(...)` | **number** | `993` |
| `smtp_username` | `SMTP Username` | `trim` | string | `"john.doe@example.com"` |
| `smtp_password` | `SMTP Password` | **no trim** | string | `"dummy-smtp-pass-1"` |
| `smtp_host` | `SMTP Host` | `trim` | string | `"smtp.example.com"` |
| `smtp_port` | `SMTP Port` | `Number(...)` | **number** | `587` |

Critical:

- `provider_code: 1` is a **number**, not `"1"`.
  Quoted `"1"` is rejected or misrouted by the API.
- Ports are **numbers** (`993`, not `"993"`).
  `JSON.stringify` preserves JS number types — that is why
  `Number()` is applied before stringify.
- Passwords deliberately skip `.trim()`.

### 11.4 Readable form of `jsonBody` (identical logic, formatted)

```javascript
// Expression is a single line in n8n; formatted here for review.
={{ JSON.stringify({
  email:         $('Loop Each Row').item.json.Email.toString().trim().toLowerCase(),
  first_name:    $('Loop Each Row').item.json['First Name'].toString().trim(),
  last_name:     $('Loop Each Row').item.json['Last Name'].toString().trim(),
  provider_code: 1,
  imap_username: $('Loop Each Row').item.json['IMAP Username'].toString().trim(),
  imap_password: $('Loop Each Row').item.json['IMAP Password'].toString(),
  imap_host:     $('Loop Each Row').item.json['IMAP Host'].toString().trim(),
  imap_port:     Number($('Loop Each Row').item.json['IMAP Port']),
  smtp_username: $('Loop Each Row').item.json['SMTP Username'].toString().trim(),
  smtp_password: $('Loop Each Row').item.json['SMTP Password'].toString(),
  smtp_host:     $('Loop Each Row').item.json['SMTP Host'].toString().trim(),
  smtp_port:     Number($('Loop Each Row').item.json['SMTP Port'])
}) }}
```

### 11.5 Pitfalls

- Editing the expression in the n8n UI can strip the leading `=`.
  Without `=`, n8n sends the literal string `{{ JSON.stringify... }}`
  as the body. Always verify the `=` prefix after edits.
- Renaming `Loop Each Row` orphans all 12 field references.
- Calling `.trim()` on `undefined` (misspelled header like
  `IMAP userName`) throws and routes to error output as
  `Failed - Cannot read properties of undefined`.
  Copy header names from [§3](#3-google-sheet-schema--12-columns).
- `Number("")` → `0`; `Number("abc")` → `NaN`.
  Both serialize to JSON (`0` / `null`) and fail API validation.
  Add the [NaN-port guard](#171-nan-port-guard) if your Sheet is messy.
- Retries: 3 tries × 30 s timeout can hold one bad row for ~90 s
  plus waits. For 500 rows with 10% failures, budget accordingly.

### 11.6 Version pin

- `httpRequest@4.5`, same as `Check Exists`.
  Keep both HTTP nodes on the same major for consistent
  retry/timeout/error-output behavior.

---

## 12. Node 8 — Update Status (`googleSheets@4.7` appendOrUpdate)

### 12.1 Purpose

Writes the per-row outcome back to the Sheet, matched on `Email`,
then hands control back to the loop.

### 12.2 Parameters (literal)

```json
{
  "operation": "appendOrUpdate",
  "documentId": { "mode": "list", "value": "YOUR_GOOGLE_SHEET_ID" },
  "sheetName": { "mode": "list", "value": "YOUR_SHEET_NAME" },
  "columns": {
    "mappingMode": "defineBelow",
    "value": {
      "Email": "={{ $('Loop Each Row').item.json.Email }}",
      "Status": "={{ $json.error ? ('Failed - ' + JSON.stringify($json.error.message || $json.error).slice(0, 200)) : 'Added' }}"
    },
    "matchingColumns": ["Email"],
    "schema": [
      { "id": "Email", "displayName": "Email", "type": "string", "canBeUsedToMatch": true },
      { "id": "First Name", "displayName": "First Name", "type": "string", "canBeUsedToMatch": true },
      { "id": "Last Name", "displayName": "Last Name", "type": "string", "canBeUsedToMatch": true },
      { "id": "IMAP Username", "displayName": "IMAP Username", "type": "string", "canBeUsedToMatch": true },
      { "id": "IMAP Password", "displayName": "IMAP Password", "type": "string", "canBeUsedToMatch": true },
      { "id": "IMAP Host", "displayName": "IMAP Host", "type": "string", "canBeUsedToMatch": true },
      { "id": "IMAP Port", "displayName": "IMAP Port", "type": "string", "canBeUsedToMatch": true },
      { "id": "SMTP Username", "displayName": "SMTP Username", "type": "string", "canBeUsedToMatch": true },
      { "id": "SMTP Password", "displayName": "SMTP Password", "type": "string", "canBeUsedToMatch": true },
      { "id": "SMTP Host", "displayName": "SMTP Host", "type": "string", "canBeUsedToMatch": true },
      { "id": "SMTP Port", "displayName": "SMTP Port", "type": "string", "canBeUsedToMatch": true },
      { "id": "Status", "displayName": "Status", "type": "string", "canBeUsedToMatch": true }
    ],
    "attemptToConvertTypes": false,
    "convertFieldsToString": false
  },
  "options": {}
}
```

Full `schema` entries in the canonical JSON also include:

```json
{
  "required": false,
  "defaultMatch": false,
  "display": true,
  "removed": false
}
```

per column. Functionally inert; kept for UI fidelity.

- Position: `[1808, 496]`.
- `mappingMode: defineBelow` — only `Email` + `Status` are sent.
- `matchingColumns: ["Email"]` — match key is raw Sheet `Email`.
- `attemptToConvertTypes: false`, `convertFieldsToString: false`.

### 12.3 Literal expressions

| Column | Literal |
|---|---|
| `Email` | `={{ $('Loop Each Row').item.json.Email }}` — raw, **no trim/lower** (must match Sheet cell verbatim) |
| `Status` | `={{ $json.error ? ('Failed - ' + JSON.stringify($json.error.message \|\| $json.error).slice(0, 200)) : 'Added' }}` |

Status logic:

```javascript
// Pseudocode of the Status expression:
if ($json.error) {
  // error output from Check Exists (skip path) or Add Account
  Status = 'Failed - ' + JSON.stringify($json.error.message || $json.error).slice(0, 200);
} else {
  Status = 'Added';
}
```

- Success from `Add Account` → no `$json.error` → `Added`.
- Success from `Skip Existing` true-branch (existing account) →
  `$json` is the GET body (no `.error`) → also `Added`.
  The workflow does not distinguish “already existed” from “just created”
  in Status. If you need that distinction, see [Roadmap](#20-roadmap).
- Error from either HTTP node → `Failed - <first 200 chars of message>`.
- Max Status length ≈ `9 + 200 = 209` chars (`"Failed - "` is 9 chars).

### 12.4 Pitfalls

- Matching on a trimmed/lowercased `Email` here would miss rows
  whose Sheet cell has trailing spaces. The workflow correctly uses
  the **raw** loop value. Do not “improve” it with trim/lower.
- `defineBelow` with only 2 columns means other Sheet columns are
  untouched. Adding more mapped columns without need risks
  overwriting passwords with trimmed values.
- `appendOrUpdate` will **append** a new row if `Email` match fails
  (e.g. duplicate with different case). Deduplicate `Email` first.
- Sliced 200-char messages can cut mid-word or mid-JSON.
  For full errors, inspect the n8n execution log
  (`saveDataErrorExecution: all`).

### 12.5 Version pin

- `googleSheets@4.7`, same major as `Get Sheet Rows`.
  `appendOrUpdate` + `matchingColumns` + `defineBelow` are v4 idioms.

---

## 13. Data Shapes

### 13.1 Sheet row (input to loop)

Capital headers, all strings, ports as numeric strings:

```json
{
  "Email": "john.doe@example.com",
  "First Name": "John",
  "Last Name": "Doe",
  "IMAP Username": "john.doe@example.com",
  "IMAP Password": "dummy-imap-pass-1",
  "IMAP Host": "imap.example.com",
  "IMAP Port": "993",
  "SMTP Username": "john.doe@example.com",
  "SMTP Password": "dummy-smtp-pass-1",
  "SMTP Host": "smtp.example.com",
  "SMTP Port": "587",
  "Status": ""
}
```

### 13.2 GET success response (output of Check Exists, input to Skip Existing)

Lowercase API fields. Exact Instantly payload varies by account state;
representative shape:

```json
{
  "email": "john.doe@example.com",
  "first_name": "John",
  "last_name": "Doe",
  "provider_code": 1,
  "imap_host": "imap.example.com",
  "imap_port": 993,
  "smtp_host": "smtp.example.com",
  "smtp_port": 587,
  "status": "active"
}
```

Key point: lowercase `email`. This is what `Skip Existing`
tests with `notEmpty`.

### 13.3 GET error shape (error output → Add Account)

n8n wraps HTTP errors when `continueErrorOutput` is set:

```json
{
  "error": {
    "message": "Request failed with status code 404",
    "code": "ERR_BAD_REQUEST",
    "status": 404,
    "response": {
      "body": { "message": "Account not found" }
    }
  }
}
```

Field paths vary by n8n version. The Status expression defensively
reads `$json.error.message || $json.error`.

### 13.4 POST success response (output of Add Account)

```json
{
  "email": "john.doe@example.com",
  "first_name": "John",
  "last_name": "Doe",
  "provider_code": 1,
  "id": "acc_01HXYZ..."
}
```

No `$json.error` present → `Update Status` writes `Added`.

### 13.5 POST error shape (error output → Update Status)

```json
{
  "error": {
    "message": "Request failed with status code 422",
    "status": 422,
    "response": {
      "body": {
        "message": "Invalid smtp_port"
      }
    }
  }
}
```

Rendered Status (sliced):

```text
Failed - "Request failed with status code 422"
```

or, when inner message is exposed:

```text
Failed - "Invalid smtp_port"
```

depending on n8n error serialization. Always check execution logs
for the unsliced body.

### 13.6 Status write-back rows

```json
[
  { "Email": "john.doe@example.com", "Status": "Added" },
  { "Email": "jane.smith@example.com", "Status": "Failed - Account already exists" }
]
```

---

## 14. Inlined Samples

All samples below are inlined so this guide
is self-contained.

### 14.1 Sample POST JSON

```json
{
  "method": "POST",
  "url": "https://api.instantly.ai/api/v2/accounts",
  "headers": {
    "Authorization": "Bearer YOUR_INSTANTLY_API_KEY",
    "Content-Type": "application/json"
  },
  "body": {
    "email": "john.doe@example.com",
    "first_name": "John",
    "last_name": "Doe",
    "provider_code": 1,
    "imap_username": "john.doe@example.com",
    "imap_password": "REPLACE_WITH_IMAP_PASSWORD",
    "imap_host": "imap.example.com",
    "imap_port": 993,
    "smtp_username": "john.doe@example.com",
    "smtp_password": "REPLACE_WITH_SMTP_PASSWORD",
    "smtp_host": "smtp.example.com",
    "smtp_port": 587
  }
}
```

Type assertions:

- `provider_code` is integer `1` — no quotes.
- `imap_port` is integer `993` — no quotes.
- `smtp_port` is integer `587` — no quotes.
- Every other field is a string.

### 14.2 Sample status JSON (`sample-status-output.json`)

```json
[
  {
    "Email": "john.doe@example.com",
    "Status": "Added"
  },
  {
    "Email": "jane.smith@example.com",
    "Status": "Failed - Account already exists"
  }
]
```

### 14.3 CSV header block

```csv
Email,First Name,Last Name,IMAP Username,IMAP Password,IMAP Host,IMAP Port,SMTP Username,SMTP Password,SMTP Host,SMTP Port,Status
john.doe@example.com,John,Doe,john.doe@example.com,dummy-imap-pass-1,imap.example.com,993,john.doe@example.com,dummy-smtp-pass-1,smtp.example.com,587,
jane.smith@example.com,Jane,Smith,jane.smith@example.com,dummy-imap-pass-2,imap.example.com,993,jane.smith@example.com,dummy-smtp-pass-2,smtp.example.com,587,
```

Notes:

- Dummy passwords only. Never commit real credentials.
- Trailing comma on each data row = empty `Status` (queued).
- Ports are bare digits in CSV; they become numbers via `Number()`.

### 14.4 Minimal reproduction CSV (1 row)

```csv
Email,First Name,Last Name,IMAP Username,IMAP Password,IMAP Host,IMAP Port,SMTP Username,SMTP Password,SMTP Host,SMTP Port,Status
test.user@example.com,Test,User,test.user@example.com,test-pass-123,imap.example.com,993,test.user@example.com,test-pass-123,smtp.example.com,587,
```

Use this single row to smoke-test a fresh import before bulk runs.

---

## 15. Instantly v2 API Subset

> Scope: only the endpoints and behaviors this workflow depends on.
> For full platform docs, consult Instantly's official API reference.
> Behavior below matches the workflow's pinned assumptions.

### 15.1 Base and auth

| Item | Value |
|---|---|
| Base URL | `https://api.instantly.ai` |
| Version prefix | `/api/v2` |
| Accounts resource | `/api/v2/accounts` |
| Single account | `/api/v2/accounts/{email}` (URL-encoded, lowercased) |
| Auth scheme | `Authorization: Bearer <INSTANTLY_API_KEY>` |
| Auth location | Request header on both GET and POST |
| Content-Type (POST) | `application/json` |

Example headers:

```http
Authorization: Bearer YOUR_INSTANTLY_API_KEY
Content-Type: application/json
```

### 15.2 Scopes and key hygiene

- Use an Instantly API key with **accounts read + write** scopes.
- Read-only keys pass `Check Exists` but fail `Add Account` with `401/403`.
- Rotate keys on personnel change; old executions log only status codes,
  but n8n execution payloads may retain headers — restrict execution
  history access.
- Never paste the live key into the workflow JSON, screenshots, or issues.
  The canonical JSON ships with `Bearer YOUR_INSTANTLY_API_KEY` placeholder.

### 15.3 402 gate (plan / billing)

- `402 Payment Required` indicates the workspace hit a plan, seat,
  or account-credit gate (e.g. trial exhausted, sending-account cap).
- The workflow surfaces it as `Failed - ...` with the 402 body sliced.
- **Do not retry 402 in a loop.** Resolve billing/cap first,
  then clear affected `Status` cells and rerun.
- If you bulk-add hundreds of accounts, confirm your Instantly plan's
  account limit before running — partial runs leave mixed `Added`/`Failed`.

### 15.4 GET `accounts/{email}` — check existence

```http
GET /api/v2/accounts/john.doe%40example.com HTTP/1.1
Host: api.instantly.ai
Authorization: Bearer YOUR_INSTANTLY_API_KEY
```

| Status | Meaning | Workflow effect |
|---|---|---|
| `200` | Exists. Body includes `email`. | Success output → `Skip Existing` → true → `Update Status: Added` (skip) |
| `404` | Not found. | Error output → `Add Account` (create) |
| `401` | Unauthorized (bad key / scope). | Error output → `Add Account` (will fail) → `Failed - ...` |
| `429` | Rate limited. | Retried 3×/2 s, then error output → `Add Account` |

GET cURL:

```bash
curl -sS \
  -H "Authorization: Bearer $INSTANTLY_API_KEY" \
  "https://api.instantly.ai/api/v2/accounts/john.doe%40example.com"
```

### 15.5 POST `accounts` — create custom SMTP account

```http
POST /api/v2/accounts HTTP/1.1
Host: api.instantly.ai
Authorization: Bearer YOUR_INSTANTLY_API_KEY
Content-Type: application/json
```

#### POST field table

| Field | Type | Required | Notes |
|---|---|---|---|
| `email` | string | Yes | Lowercased; must be valid email; unique per workspace |
| `first_name` | string | Yes | Trimmed display name |
| `last_name` | string | Yes | Trimmed display name |
| `provider_code` | integer | Yes | Must be `1` for generic IMAP/SMTP; other codes are other providers — do not change |
| `imap_username` | string | Yes | Usually same as `email` |
| `imap_password` | string | Yes | Verbatim; case/space sensitive |
| `imap_host` | string | Yes | Bare hostname |
| `imap_port` | integer | Yes | e.g. `993` / `143` |
| `smtp_username` | string | Yes | Usually same as `email` |
| `smtp_password` | string | Yes | Verbatim |
| `smtp_host` | string | Yes | Bare hostname |
| `smtp_port` | integer | Yes | e.g. `587` / `465` |

POST cURL example:

```bash
curl -sS -X POST "https://api.instantly.ai/api/v2/accounts" \
  -H "Authorization: Bearer $INSTANTLY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "john.doe@example.com",
    "first_name": "John",
    "last_name": "Doe",
    "provider_code": 1,
    "imap_username": "john.doe@example.com",
    "imap_password": "REPLACE_WITH_IMAP_PASSWORD",
    "imap_host": "imap.example.com",
    "imap_port": 993,
    "smtp_username": "john.doe@example.com",
    "smtp_password": "REPLACE_WITH_SMTP_PASSWORD",
    "smtp_host": "smtp.example.com",
    "smtp_port": 587
  }'
```

Expected success: `200` or `201` with created-account JSON.

### 15.6 Limits

| Limit | Value | Notes |
|---|---|---|
| Burst | `100 req/s` | Per API key / workspace (whichever is tighter) |
| Sustained | `6000 req/min` | Long-run ceiling |
| Workflow pacing | ~1 req per 1–3 s (sequential + retries) | Well under limits by design |

The workflow's sequential loop is itself the throttle.
Two HTTP calls per new row (GET + POST), one per existing row (GET only).

Estimated timings (happy path, no retries):

| Rows | GET-only (all exist) | GET+POST (all new) |
|---|---|---|
| 10 | ~20–40 s | ~40–80 s |
| 100 | ~4–7 min | ~7–15 min |
| 1000 | ~35–70 min | ~70–150 min |

Add ~90 s per row that exhausts all 3 retries on timeout.

### 15.7 Throttle strategy

1. **Keep `batchSize: 1`.** Do not parallelize the loop.
2. **Keep 2000 ms `waitBetweenTries`.** It doubles as jittered backoff
   across rows when Instantly returns 429.
3. **On sustained 429:**
   - Stop the run.
   - Wait 60–120 s.
   - Clear only the 429-affected `Failed - ...` rows (or leave them
     failed and retry selectively).
   - Rerun. Already-`Added` rows are skipped automatically.
4. **Do not add a tight retry loop around `Add Account`.**
   3 tries is enough; more hides credential or plan errors.
5. For >2000 rows, split the Sheet into chunks (e.g. tabs of 500)
   and run sequentially to bound `executionTimeout: 300` s.
   If you hit the 300 s cap, increase timeout or chunk smaller.

### 15.8 Error-to-Status mapping

The `Update Status` expression maps any `$json.error` to
`Failed - <sliced>`. Use this table to interpret Status strings:

| HTTP | Typical Status text | Action |
|---|---|---|
| `400` | `Failed - Request failed with status code 400` (+ body e.g. `Invalid payload`) | Fix row fields (host/port/name); clear Status; rerun row |
| `401` | `Failed - Request failed with status code 401` | Fix API key/scopes; clear all 401 rows; rerun |
| `402` | `Failed - ... 402 ...` / plan-gate message | Resolve billing/cap; do not loop-retry; then rerun |
| `404` (on POST) | Rare; `Failed - ... 404 ...` | Check base URL / resource path; possible API version drift |
| `409` | `Failed - Account already exists` (or `conflict`) | Row is effectively done; either leave as Failed or set to `Added` manually after verifying in Instantly UI |
| `422` | `Failed - ... 422 ...` / `Invalid email` / `Invalid smtp_port` | Fix validation (email format, `NaN` ports, empty names); clear Status; rerun |
| `429` | `Failed - ... 429 ...` / `Rate limit` | Wait, then clear 429 rows and rerun; do not hammer |
| `5xx` | `Failed - ... 500/502/503 ...` | Wait, then rerun affected rows; transient |
| Timeout/`ECONNRESET` | `Failed - ... timeout ...` / `socket hang up` | Check network; rerun row; 3 retries already exhausted |
| `Cannot read properties of undefined` | `Failed - Cannot read properties of undefined (reading 'toString')` | Misspelled Sheet header or empty cell where `.toString()` expected; fix header/cell |

> Slicing: only the first 200 chars of the serialized error message
> reach the Sheet. Full bodies live in n8n execution details.

---

## 16. Environment Reference (`.env`)

`.env` is untracked. Copy `.env.example` → `.env` locally.
The workflow JSON itself does not read `.env` directly;
these variables document the values you paste into n8n
(credentials, list-mode selections) and scripts.

### 16.1 `.env.example` (inlined)

```bash
# Copy to .env (untracked). Never commit real values.
INSTANTLY_API_KEY=YOUR_INSTANTLY_API_KEY
GOOGLE_SHEET_ID=YOUR_GOOGLE_SHEET_ID
GID=YOUR_GID
N8N_VERSION=>=1.0.0
```

### 16.2 Variable table

| Variable | Required | Example | Used in | Notes |
|---|---|---|---|---|
| `INSTANTLY_API_KEY` | Yes | `sk_live_abc123...` | `Check Exists` + `Add Account` `Authorization` headers | Bearer token; rotate on leak; never commit |
| `GOOGLE_SHEET_ID` | Yes | `1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms` | `Get Sheet Rows` + `Update Status` `documentId` | Long alphanumeric ID from Sheet URL between `/d/` and `/edit` |
| `GID` | If multi-tab | `0` | Tab selection (`sheetName` list value) | First tab is usually `0`; confirm in Sheet URL `#gid=` |
| `N8N_VERSION` | Advisory | `>=1.0.0` | Ops / CI pin | Workflow validated on n8n 1.x with node majors listed in [Appendix B](#appendix-b--version-pin-table) |

### 16.3 Wiring `.env` into n8n

Option A — manual (recommended for first run):

1. `cp .env.example .env` and fill values.
2. In n8n, open `Get Sheet Rows` → select document matching `GOOGLE_SHEET_ID`.
3. Select the tab matching `GID`.
4. Repeat document/tab selection in `Update Status`.
5. In both HTTP nodes, set `Authorization: Bearer <INSTANTLY_API_KEY>`.
6. Execute manually on the 1-row CSV first.

Option B — n8n credentials + env expressions:

```text
Authorization = Bearer {{ $env.INSTANTLY_API_KEY }}
```

Requires n8n configured to expose env (`N8N_BLOCK_ENV_ACCESS_IN_NODE=false`
or allowlisted vars, depending on version). Prefer n8n's built-in
Header Auth credential over raw env interpolation where available.

---

## 17. Hardening — Guards and Traps

### 17.1 NaN-port guard

**Problem.** `Number()` on an empty or non-numeric Sheet cell yields
`0` or `NaN`:

```javascript
Number("")      // 0
Number("  ")    // 0
Number("abc")   // NaN
Number(undefined) // NaN
```

`JSON.stringify({ imap_port: NaN })` emits `{"imap_port": null}`,
which Instantly rejects with `400/422`. `0` is a valid number
syntactically but an invalid port semantically.

**Where it bites.** `Add Account.jsonBody`:

```javascript
imap_port: Number($('Loop Each Row').item.json['IMAP Port']),
smtp_port: Number($('Loop Each Row').item.json['SMTP Port'])
```

**Guard snippet.** Validate before stringify, or pre-validate in a
Code node. Minimal inline guard (drop-in for `jsonBody` ports):

```javascript
// Inline NaN-port guard — use inside Add Account jsonBody
// Replaces: Number($('Loop Each Row').item.json['IMAP Port'])
(() => {
  const raw = $('Loop Each Row').item.json['IMAP Port'];
  const n = Number(String(raw ?? '').trim());
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`Invalid IMAP Port for ${$('Loop Each Row').item.json.Email}: ${JSON.stringify(raw)}`);
  }
  return n;
})()
```

```javascript
// Same for SMTP:
(() => {
  const raw = $('Loop Each Row').item.json['SMTP Port'];
  const n = Number(String(raw ?? '').trim());
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`Invalid SMTP Port for ${$('Loop Each Row').item.json.Email}: ${JSON.stringify(raw)}`);
  }
  return n;
})()
```

Throwing inside `jsonBody` routes the row to the error output,
producing a clear Status like:

```text
Failed - Invalid SMTP Port for john.doe@example.com: ""
```

instead of a generic `422`.

**Sheet-side prevention (cheaper than code):**

- Format `IMAP Port` / `SMTP Port` columns as **Plain text**,
  then enforce digits-only via Data → Data validation → Number.
- Conditional-format non-numeric ports red before each run.
- `FILTER` or `QUERY` for `ISNUMBER(VALUE(G2:G)) = FALSE` to find offenders.

**Full pre-flight Code node (optional, insert between loop and GET):**

```javascript
// n8n Code node (Run Once for Each Item) — port + email preflight
const row = $('Loop Each Row').item.json;
const email = String(row.Email ?? '').trim().toLowerCase();
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  throw new Error(`Invalid Email: ${JSON.stringify(row.Email)}`);
}
for (const col of ['IMAP Port', 'SMTP Port']) {
  const n = Number(String(row[col] ?? '').trim());
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`Invalid ${col} for ${email}: ${JSON.stringify(row[col])}`);
  }
}
return { json: row };
```

### 17.2 Email-vs-email trap

This is the #1 mis-edit in this workflow. Two different fields,
two different cases, two different stages:

| Expression | Case | Stage | Meaning |
|---|---|---|---|
| `$json.Status` | Capital `S` | `Keep Blanks Only` (Sheet shape) | Workflow queue flag |
| `$json.Email` | Capital `E` | `Check Exists` URL, `Update Status` Email column | Sheet identity (raw) |
| `$json.email` | lowercase `e` | `Skip Existing` condition, POST body `email` | Instantly API field |
| `$('Loop Each Row').item.json.Email` | Capital `E` | `Add Account` body, `Update Status` match | Pinned Sheet row, immune to upstream reshaping |

**Rules:**

1. Before `Check Exists`, `$json` is the **Sheet row** → capital `Email`.
2. After `Check Exists` success, `$json` is the **API body** → lowercase `email`.
3. Inside `Add Account` / `Update Status`, never trust bare `$json`
   for identity — always reach back via `$('Loop Each Row').item.json`.
4. Renaming any node with a `$('...')` reference requires updating
   every expression that names it.

**How it breaks (real examples):**

```javascript
// WRONG in Skip Existing — always false (GET body has no capital Email):
{{ $json.Email }}  // undefined → notEmpty = false → creates duplicates

// WRONG in Add Account — undefined email → 422:
email: $json.Email.toString()  // $json is GET response here, not Sheet row

// WRONG in Update Status Email — match miss → appended duplicate row:
{{ $json.Email }}  // $json is POST response; use $('Loop Each Row').item.json.Email
```

**Review checklist:**

- [ ] `Keep Blanks Only` reads `$json.Status` (capital S).
- [ ] `Check Exists` URL reads `$json.Email` (capital E).
- [ ] `Skip Existing` reads `$json.email` (lowercase e).
- [ ] `Add Account` reads `$('Loop Each Row').item.json.*` (capital headers).
- [ ] `Update Status` Email reads `$('Loop Each Row').item.json.Email`.
- [ ] `Update Status` Status reads `$json.error` (lowercase, n8n error wrapper).

### 17.3 Password whitespace trap

- Passwords are **not** trimmed by design.
- Many Sheet copy-pastes add a trailing space or newline.
- If IMAP/SMTP auth fails after `Added`, first suspect pasted whitespace
  in the Sheet — not the workflow.
- Mitigation: use `LEN()` checks in a helper column to spot
  `LEN(password) != LEN(TRIM(password))` before running.

### 17.4 Header rename trap

Google Sheets n8n node maps by **header string**, not column position.
Renaming `First Name` → `FirstName` yields `undefined`,
and `.toString()` on `undefined` throws:

```text
Failed - Cannot read properties of undefined (reading 'toString')
```

Fix the header, not the expression.

### 17.5 200-char Status truncation trap

Long API bodies (e.g. full HTML 502 pages) are sliced.
Do not debug from the Sheet cell alone — open the n8n execution,
expand the failed `Add Account` item, and read `error.response.body`.

---

## 18. Operations Cheatsheet

### 18.1 First run (5 minutes)

```bash
# 1. Clone and enter repo
git clone <repo-url> n8n-instantly-smtp-bulk-upload
cd n8n-instantly-smtp-bulk-upload

# 2. Secrets
cp .env.example .env
# edit .env: INSTANTLY_API_KEY, GOOGLE_SHEET_ID, GID

# 3. Prepare Sheet from the header block in [§3](#3-google-sheet-schema--12-columns)
# → create Google Sheet, paste header + 1 test row

# 4. Import workflow
# n8n UI → Workflows → Import from File → workflows/instantly-smtp-accounts-bulk-upload.json

# 5. Wire credentials + document/tab + API key, then Execute
```

### 18.2 Bulk run checklist

- [ ] Backup Sheet (File → Make a copy).
- [ ] Deduplicate `Email` (Data → Remove duplicates).
- [ ] Validate ports numeric, hosts bare, passwords intact.
- [ ] Confirm Instantly plan cap covers row count.
- [ ] Run 1-row smoke test → expect `Added`.
- [ ] Run full batch; monitor n8n executions.
- [ ] After run, filter `Status` starting with `Failed -` and triage
  via [§15.8](#158-error-to-status-mapping).
- [ ] Clear fixed rows’ `Status` and rerun (only blanks process).

### 18.3 Rerun / resume semantics

- Only `Status` blank rows run. `Added` and `Failed - ...` are skipped.
- To retry failures: clear those `Status` cells, rerun.
- To reprocess everything: clear the entire `Status` column, rerun.
- Concurrent executions are **not** safe. Run serially.

### 18.4 Backup and versioning

```bash
# Export current n8n workflow before editing (example via n8n CLI/API)
# Keep the exported JSON under workflows/ with a date suffix for audit.

cp workflows/instantly-smtp-accounts-bulk-upload.json \
   workflows/instantly-smtp-accounts-bulk-upload.$(date +%F).bak.json
```

Commit workflow changes with the node diff summarized
(node name + typeVersion + expression changed).

---

## 19. FAQ

**Q1. Why `batchSize: 1`? Can I speed it up with 10?**

No. `batchSize > 1` changes downstream shapes from object to array,
breaks `.toString()` row expressions, causes Sheet match races,
and risks `429`. The workflow is intentionally sequential.
For speed, shard the Sheet and run shards serially, or accept
the ~1–3 s/row pacing.

**Q2. Why does `Skip Existing` check lowercase `$json.email`?**

Because at that point `$json` is the Instantly GET response,
which uses lowercase `email`. The Sheet uses capital `Email`.
See [Email-vs-email trap](#172-email-vs-email-trap).

**Q3. Why do both HTTP outputs go to the same next node?**

`continueErrorOutput` splits success/error. For `Check Exists`,
error (usually 404) means “create”. For `Add Account`, both
outcomes need a Status write. Converging on `Update Status`
with `$json.error ? Failed : Added` handles both uniformly.

**Q4. My Status says `Added` but the account doesn’t work. Why?**

`Added` means the API accepted creation, not that IMAP/SMTP
credentials verify. Check for pasted whitespace in hosts/usernames,
wrong ports (587 vs 465), or provider-side blocks. Re-verify
credentials in Instantly UI.

**Q5. I got `Failed - Account already exists` but GET said 404. Why?**

Race or case variant: `John@X.com` vs `john@x.com`, or the account
was created between GET and POST (double run). Verify in Instantly;
if present, set Status to `Added` manually or leave as Failed
and filter it from retries.

**Q6. Ports show `Failed - ... 422 ... Invalid smtp_port`. What now?**

The Sheet cell was empty, had text, or `Number()` produced `NaN`/`0`.
Fix the cell to bare digits (`587`), clear Status, rerun.
Add the [NaN-port guard](#171-nan-port-guard) for messy Sheets.

**Q7. Should I trim passwords?**

No. Passwords are verbatim by design. Trimming breaks secrets with
intentional leading/trailing spaces. Fix whitespace Sheet-side
only if your provider documents that it strips.

**Q8. Why is `provider_code` the number `1`, not `"1"`?**

Instantly expects an integer provider enum. `1` = generic IMAP/SMTP.
A quoted string fails validation or misroutes. `JSON.stringify`
preserves the JS number type — keep it unquoted.

**Q9. Can I schedule this workflow nightly?**

Not as shipped (manual trigger only). To schedule, add a Schedule
trigger, keep the blank-Status filter, ensure single-concurrency
(no overlapping runs), and raise `executionTimeout` or chunk large
Sheets. Test idempotency with a dry-run tab first.

**Q10. Status shows `Failed - Request failed with status code 401`.**

API key wrong, expired, or missing accounts scope. Fix the key in
both HTTP nodes, clear affected Status cells, rerun. Do not
reinterpret 401 as “not found”.

**Q11. How do I distinguish “already existed” from “just created”?**

Currently both write `Added`. To distinguish, branch `Skip Existing`
true-path to a second `Update Status`-like node writing
`Skipped - exists`, or add a `Note` column. See [Roadmap](#20-roadmap).

**Q12. The run timed out at 300 s with rows left. What happened?**

`executionTimeout: 300` fired. Already-processed rows kept their
Status; unprocessed rows are still blank. Increase timeout or split
the Sheet, then rerun (only blanks resume).

---

## 20. Roadmap

Proposed, non-breaking improvements in priority order.
No roadmap item changes the 12-column contract without a major bump.

- [ ] **P1 — Distinguish skip vs create in Status.**
  Write `Skipped - exists` on the `Skip Existing` true branch
  (separate Google Sheets node or parameterized Status value).
  Preserves current rerun semantics (non-empty = done).

- [ ] **P1 — NaN-port preflight.**
  Promote the [guard snippet](#171-nan-port-guard) into a Code node
  or inline `jsonBody` validation so bad ports fail fast with
  `Failed - Invalid <PORT> ...` instead of generic `422`.

- [ ] **P2 — Credential hygiene.**
  Replace inline `Bearer YOUR_INSTANTLY_API_KEY` with n8n
  Header Auth / Generic Credential and `$env` reference.
  Scrub key from exported JSON in repo fixtures.

- [ ] **P2 — Dry-run mode.**
  Add a boolean toggle (e.g. `DRY_RUN=true`) that runs GET + validation
  and writes `DryRun - ok` / `DryRun - <reason>` without POST.
  Useful for validating 10k-row Sheets.

- [ ] **P2 — Full-error log column.**
  Add optional 13th column `Error Detail` (out of contract, opt-in)
  storing the unsliced error body / execution URL for forensics,
  keeping `Status` human-scannable.

- [ ] **P3 — Scheduler + single-concurrency guard.**
  Optional Schedule trigger with overlap lock (e.g. n8n static data
  flag or external lock row) for nightly pickup of blank-Status rows.

- [ ] **P3 — Chunked runner.**
  Split large CSVs into 500-row tabs and
  summarize `Added` / `Failed - *` counts post-run.

- [ ] **P3 — 409 reconciliation.**
  Map `409 Account already exists` on POST to `Added (reconciled)`
  after a confirmatory GET, reducing false-failure noise.

---

## Appendix A — Full Expression Inventory

Copy-paste reference. `=` prefix is part of the expression.

```text
# Keep Blanks Only — condition left
={{ $json.Status }}

# Check Exists — URL
=https://api.instantly.ai/api/v2/accounts/{{ $json.Email.toString().trim().toLowerCase() }}

# Skip Existing — condition left (lowercase!)
={{ $json.email }}

# Add Account — jsonBody (single line in n8n)
={{ JSON.stringify({ email: $('Loop Each Row').item.json.Email.toString().trim().toLowerCase(), first_name: $('Loop Each Row').item.json['First Name'].toString().trim(), last_name: $('Loop Each Row').item.json['Last Name'].toString().trim(), provider_code: 1, imap_username: $('Loop Each Row').item.json['IMAP Username'].toString().trim(), imap_password: $('Loop Each Row').item.json['IMAP Password'].toString(), imap_host: $('Loop Each Row').item.json['IMAP Host'].toString().trim(), imap_port: Number($('Loop Each Row').item.json['IMAP Port']), smtp_username: $('Loop Each Row').item.json['SMTP Username'].toString().trim(), smtp_password: $('Loop Each Row').item.json['SMTP Password'].toString(), smtp_host: $('Loop Each Row').item.json['SMTP Host'].toString().trim(), smtp_port: Number($('Loop Each Row').item.json['SMTP Port']) }) }}

# Update Status — Email (match key, raw)
={{ $('Loop Each Row').item.json.Email }}

# Update Status — Status
={{ $json.error ? ('Failed - ' + JSON.stringify($json.error.message || $json.error).slice(0, 200)) : 'Added' }}
```

Headers:

```text
# Check Exists
Authorization: Bearer YOUR_INSTANTLY_API_KEY

# Add Account
Authorization: Bearer YOUR_INSTANTLY_API_KEY
Content-Type: application/json
```

Matching / retry / timeout:

```text
Update Status matchingColumns: ["Email"]
Update Status mappingMode: defineBelow
Check Exists: retryOnFail=true, maxTries=3, waitBetweenTries=2000, timeout=30000, onError=continueErrorOutput
Add Account:  retryOnFail=true, maxTries=3, waitBetweenTries=2000, timeout=30000, onError=continueErrorOutput
Loop Each Row: batchSize=1 (default), loop output index 1 → Check Exists
```

---

## Appendix B — Version Pin Table

| Node | Type string | Pinned typeVersion | Notes |
|---|---|---|---|
| Start Manually | `n8n-nodes-base.manualTrigger` | `1` | No params; keep inactive by default |
| Get Sheet Rows | `n8n-nodes-base.googleSheets` | `4.7` | Read; `documentId`/`sheetName` object-mode |
| Keep Blanks Only | `n8n-nodes-base.filter` | `2.3` | `conditions.options.version: 3`, `empty` on `Status` |
| Loop Each Row | `n8n-nodes-base.splitInBatches` | `3` | `batchSize: 1` default; done=`main[0]`, loop=`main[1]` |
| Check Exists | `n8n-nodes-base.httpRequest` | `4.5` | GET; retry 3×/2000 ms; 30 s timeout; `continueErrorOutput` |
| Skip Existing | `n8n-nodes-base.if` | `2.3` | `notEmpty` on lowercase `$json.email` |
| Add Account | `n8n-nodes-base.httpRequest` | `4.5` | POST; same retry/timeout/error policy as GET |
| Update Status | `n8n-nodes-base.googleSheets` | `4.7` | `appendOrUpdate`, `matchingColumns: [Email]` |

Upgrade rule: bump one node at a time, re-run the 1-row smoke test,
and diff `connections` output indexes (`done`/`loop`, `true`/`false`,
`success`/`error`) before bulk runs.

---

*End of GUIDE.md — canonical workflow: `workflows/instantly-smtp-accounts-bulk-upload.json`.*

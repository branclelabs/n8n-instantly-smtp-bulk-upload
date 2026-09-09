# RUNBOOK — n8n-instantly-smtp-bulk-upload

> **Bulk Email Accounts Upload via API in Instantly**
> Manual-trigger → blanks-only → sequential loop → GET check + IF skip → POST create → Status write-back (`Added` / `Failed - <reason>` 200 chars)
> Audience: Operators, RevOps, Deliverability Engineers
> Environment: n8n (self-hosted or Cloud) + Google Sheets + Instantly.ai v2 API
> Run mode: **Manual, supervised, sequential. No schedule. No concurrency.**

---

## Document Control

| Field | Value |
|---|---|
| Repo | `n8n-instantly-smtp-bulk-upload` |
| File | `docs/RUNBOOK.md` |
| Version | `1.0.0` |
| Owner | Operations / Deliverability |
| Review cadence | Every bulk load or 90 days |
| Classification | Internal — contains operational secrets handling guidance |
| Related docs | `README.md`, `docs/README.md`, `docs/GUIDE.md` |
| Workflow file | `workflows/instantly-smtp-bulk-upload.json` |

---

## Table of Contents

- [1. Purpose and Scope](#1-purpose-and-scope)
- [2. Architecture — 8-Node Workflow](#2-architecture--8-node-workflow)
- [3. Roles and Responsibilities](#3-roles-and-responsibilities)
- [4. Pre-Flight Checklist](#4-pre-flight-checklist)
- [5. Step-by-Step Manual Run SOP](#5-step-by-step-manual-run-sop)
- [6. Blanks-Only Rerun and Idempotency](#6-blanks-only-rerun-and-idempotency)
- [7. Monitoring During Run](#7-monitoring-during-run)
- [8. Rollback — No Single Undo](#8-rollback--no-single-undo)
- [9. Rate-Limit Playbook](#9-rate-limit-playbook)
- [10. Troubleshooting Matrix (10 Rows)](#10-troubleshooting-matrix-10-rows)
- [11. Debug Recipe — Pin and Inspect](#11-debug-recipe--pin-and-inspect)
- [12. Security Operations](#12-security-operations)
- [13. FAQ (8 Questions)](#13-faq-8-questions)
- [14. Roadmap Pointer](#14-roadmap-pointer)
- [Appendix A: Go / No-Go Sign-Off Form](#appendix-a-go--no-go-sign-off-form)
- [Appendix B: Run Log Template](#appendix-b-run-log-template)
- [Appendix C: Status Values Reference](#appendix-c-status-values-reference)
- [Appendix D: Quick Command Reference](#appendix-d-quick-command-reference)

---

## 1. Purpose and Scope

### 1.1 Purpose

- [ ] This runbook is the **single authoritative SOP** for executing the bulk upload.
- [ ] It ensures every load is safe, auditable, idempotent, and recoverable.
- [ ] It prevents duplicates, partial writes, credential leaks, and sheet corruption.
- [ ] It defines what to do when Instantly, Google, or n8n fails mid-run.

### 1.2 Scope — In Scope

- [ ] Manual execution of `instantly-smtp-bulk-upload.json`.
- [ ] Google Sheet preparation, blanks-only filtering, and Status write-back.
- [ ] Sequential loop execution with GET check + IF skip + POST create.
- [ ] Monitoring, rerun, rollback, rate-limit handling, and troubleshooting.
- [ ] Credential hygiene and post-run vaulting.

### 1.3 Scope — Out of Scope

- [ ] Domain warmup strategy, DNS (SPF/DKIM/DMARC), inbox placement.
- [ ] Instantly campaign assignment, sequencing, or unibox routing.
- [ ] Automatic scheduling — this workflow **must remain Manual Trigger only**.
- [ ] Bulk deletion or migration off Instantly.

### 1.4 Principles

| # | Principle | Rule |
|---|---|---|
| P1 | Supervised runs only | Never schedule, never run unattended, never run concurrent copies |
| P2 | Blanks-only | Only rows where `Status` is blank are processed |
| P3 | Sequential | Loop `batchSize: 1`, one account at a time |
| P4 | Idempotent rerun | Rerunning processes only remaining blanks, never duplicates `Added` |
| P5 | Write-back is truth | `Added` or `Failed - <reason>` truncated to 200 chars |
| P6 | Least privilege | Temp API key per load, viewer-default sheet, revoke after |
| P7 | No silent failure | Every failure writes `Failed - <reason>`, never leaves blank on attempt |

---

## 2. Architecture — 8-Node Workflow

### 2.1 High-Level Flow

```text
[1 Manual Trigger]
        |
        v
[2 Google Sheets Read — Accounts tab]
        |
        v
[3 Filter — Status IS BLANK (blanks-only gate)]
        |
        v
[4 Loop — Sequential, batchSize=1 (1/N)]
        |
        v
[5 HTTP GET — Check Account Exists (Instantly v2)]
        |
        v
[6 IF — Skip if Exists? (200 + match → skip)]
       / \
    Yes   No
     |     |
     |     v
     |   [7 HTTP POST — Create Account]
     |     |
     v     v
[8 Google Sheets Update — Write-back Status: Added / Failed - reason (200 chars)]
```

### 2.2 8-Node Inventory

| # | Node Name (canonical) | Type | Purpose | Key Config |
|---|---|---|---|---|
| 1 | `Manual Trigger` | `n8n-nodes-base.manualTrigger` | Human-gated start. No schedule, no webhook. | `executeOnce` |
| 2 | `Sheets — Read Accounts` | `n8n-nodes-base.googleSheets` | Reads full Accounts tab including `Status` column. | Doc `YOUR_GOOGLE_SHEET_ID`, tab `Accounts`, `dataLocationOnSheet` header row |
| 3 | `Filter — Status Blank Only` | `n8n-nodes-base.filter` | Blanks-only gate. Drops `Added` and `Failed - *`. | Condition: `Status` is empty / `Status == ""` after trim |
| 4 | `Loop — Sequential 1/N` | `n8n-nodes-base.splitInBatches` | Forces sequential processing, enables 1/N progress. | `batchSize: 1`, sequential, reset on rerun |
| 5 | `Instantly — GET Check Exists` | `n8n-nodes-base.httpRequest` | Idempotency check before create. | `GET https://api.instantly.ai/api/v2/email-accounts`, Header `Authorization: Bearer YOUR_INSTANTLY_API_KEY` |
| 6 | `IF — Exists? Skip Create` | `n8n-nodes-base.if` | Branches to skip POST if email already exists (case-insensitive trim match). | `{{$json.email.toLowerCase().trim()}}` comparison |
| 7 | `Instantly — POST Create` | `n8n-nodes-base.httpRequest` | Creates SMTP account in Instantly. | `POST https://api.instantly.ai/api/v2/email-accounts`, JSON body with `smtp_*`, `imap_*`, `email` |
| 8 | `Sheets — Write-back Status` | `n8n-nodes-base.googleSheets` | Writes `Added` on 200/201, or `Failed - <reason>` truncated to 200 chars. | `operation: update`, match on `Email` or `Row Number`, value `={{...}}.slice(0,200)` |

### 2.3 Data Contract

| Column | Required | Notes |
|---|---|---|
| `Email` | Yes | Lowercased + trimmed for dedupe. Must be unique. |
| `SMTP Username` | Yes | Usually same as Email. |
| `SMTP Password` | Yes | App password. Plaintext in sheet during run only — vault after. |
| `SMTP Host` | Yes | e.g., `smtp.gmail.com`, `smtp.zoho.com`. |
| `SMTP Port` | Yes | Integer `465` or `587`. No `NaN`, no quotes-as-text. |
| `IMAP Host` | Yes | Required for reply sync. |
| `IMAP Port` | Yes | Integer `993` typically. |
| `Status` | System | Blank = pending. `Added` = success. `Failed - <reason>` = needs fix + rerun. 200 chars max. |

### 2.4 Expected Node Badges

- [ ] All 8 nodes show **green check** after a test run.
- [ ] No orange warning (missing credential, deprecated version).
- [ ] No red error badge persisting after fix.
- [ ] Google Sheets nodes show connected account (OAuth2), not `Select Credential`.
- [ ] HTTP nodes show `Authorization: Bearer ••••••` (header auth, not query param).

---

## 3. Roles and Responsibilities

| Role | Responsible For | Must Attend Run |
|---|---|---|
| Operator | Execute workflow, watch 1/N, log counts, stop on alert | Yes |
| Reviewer | Pre-flight sign-off, verify blanks count, approve Go | Yes (async OK) |
| Credential Owner | Issue `bulk-load-YYYY-MM-DD` temp key, revoke post-run | Pre + Post |
| Sheet Owner | Freeze sheet, set viewer-default, vault passwords post-run | Pre + Post |
| Deliverability Lead | Approve 500+ row tranches, rollback delete decision | If >200 rows |

---

## 4. Pre-Flight Checklist

> **Do not press Execute until every box is checked. If any box fails, mark No-Go.**

### 4.1 Workflow Hygiene

- [ ] Open n8n → Workflows → `instantly-smtp-bulk-upload`.
- [ ] Verify workflow is **Inactive** (scheduled OFF) — Manual Trigger only.
- [ ] Verify you are on the **saved version** — no unsaved changes banner.
- [ ] Verify 8 nodes present in order: Manual → Read → Filter Blank → Loop → GET → IF → POST → Write-back.
- [ ] Verify all nodes show green badges / successful last test.
- [ ] Verify Loop node is `batchSize: 1`, sequential, not parallel.
- [ ] Verify Filter node condition is `Status is empty` (not `contains`, not `not empty`).
- [ ] Verify IF node lowercases + trims email before compare.
- [ ] Verify Write-back node truncates to 200 chars: `.slice(0,200)` or `left(...,200)`.
- [ ] Verify no second trigger (no Schedule, no Webhook) was accidentally added.

### 4.2 Credentials and Placeholders

- [ ] HTTP GET node uses `Authorization: Bearer YOUR_INSTANTLY_API_KEY` via Header Auth credential.
- [ ] HTTP POST node uses **same** temp key — no hardcoded key in JSON body or URL.
- [ ] No placeholder text remains: search workflow JSON for `YOUR_INSTANTLY_API_KEY`.
- [ ] No placeholder sheet ID remains: search for `YOUR_GOOGLE_SHEET_ID`.
- [ ] Google Sheets nodes use OAuth2 credential with access to target Sheet ID.
- [ ] Confirm temp key name is `bulk-load-YYYY-MM-DD` (e.g., `bulk-load-2026-09-09`).
- [ ] Confirm temp key expiry is **7-day** max, scoped to email-accounts write.
- [ ] Test temp key with read-only curl (see Appendix D) — expect 200, not 401.

### 4.3 Google Sheet Readiness

- [ ] Sheet ID matches `YOUR_GOOGLE_SHEET_ID` replacement in run log.
- [ ] Tab name is exactly `Accounts` (or `Retry_YYYY-MM-DD` for rerun tranche — see §6).
- [ ] Header row is row 1, frozen, no merged cells.
- [ ] Required columns present: `Email`, `SMTP Username`, `SMTP Password`, `SMTP Host`, `SMTP Port`, `IMAP Host`, `IMAP Port`, `Status`.
- [ ] `SMTP Port` and `IMAP Port` are **numbers** (Format → Number), not text.
- [ ] No `NaN`, no `#ERROR!`, no formulas in port columns — values only.
- [ ] `Email` column has no leading/trailing spaces, all lowercase (use `=LOWER(TRIM())` to verify).
- [ ] No duplicate emails (case/space-insensitive) — run dedupe check.
- [ ] `Status` column: `Added` rows untouched, `Failed - *` rows fixed or left for triage, blanks = intended load.
- [ ] Record pre-run counts: Total rows, Blanks, Already Added, Prior Failed.
- [ ] Sheet sharing is **viewer-default** except Operator = editor during run.
- [ ] Sheet editing is **frozen** for all other users — announce in Slack/email.

### 4.4 Instantly Account Readiness

- [ ] Instantly workspace has capacity for new accounts (no 402 limit hit).
- [ ] No ongoing Instantly incident (check status page + test single create).
- [ ] Workspace API scope includes `email-accounts:read` + `email-accounts:write` (else 403).
- [ ] Rate limit headroom confirmed — no other bulk job running concurrently.
- [ ] Dashboard count recorded pre-run (screenshot + number in run log).

### 4.5 n8n Environment Readiness

- [ ] n8n version pinned and healthy, Executions list loads.
- [ ] `EXECUTIONS_DATA_MAX_AGE` is set (e.g., `168` hours / 7 days) to auto-prune PII.
- [ ] Workflow Settings → `saveDataSuccessExecution` = `none` (or `Save Successful Production Executions: Never`).
- [ ] Only **one** operator tab open — no concurrent runs, no second browser.
- [ ] Laptop on power, stable network, VPN if required for SMTP test.
- [ ] 2FA enabled on n8n account performing the run.
- [ ] Pinned data cleared from prior debug (no stale pin on Loop/HTTP nodes).

### 4.6 Go / No-Go Gate

| Check | Threshold | Go | No-Go |
|---|---|---|---|
| Blanks count matches intended load | Exact match | Proceed | Investigate |
| Duplicates (case/space-insensitive) | 0 | Proceed | Dedupe first |
| Port `NaN` / text ports | 0 | Proceed | Fix formatting |
| Temp key curl test | 200 | Proceed | Rotate key |
| Dashboard capacity (402 risk) | Headroom > load | Proceed | Upgrade / split |
| Prior run still `Running` | None running | Proceed | Wait / stop |
| Sheet editors | Operator only | Proceed | Freeze sheet |

- [ ] Reviewer signed Go in Appendix A.
- [ ] Run log created from Appendix B with pre-run counts.
- [ ] If load is 500+ rows, tranche plan (50–200 per run) is written and approved.

---

## 5. Step-by-Step Manual Run SOP

> Follow exactly. Do not improvise order. Do not edit sheet mid-run. Do not close tab.

### 5.1 Step 1 — Open Workflow

- [ ] Navigate to n8n → Workflows → `instantly-smtp-bulk-upload`.
- [ ] Confirm workflow name and tag (e.g., `prod`, `instantly`, `bulk-load`).
- [ ] Confirm you are in **Production** (not test canvas copy).
- [ ] Expand all 8 nodes visually — confirm connections are intact.

```text
Checklist:
[ ] Canvas loads without "Workflow could not be loaded" error
[ ] Connections: 1→2→3→4→5→6→7→8 (IF true-branch loops back / skips to 8)
[ ] No disconnected nodes, no sticky-note TODOs blocking run
```

### 5.2 Step 2 — Verify Green Badges

- [ ] Click each node → Settings → verify credential selected (not `Select...`).
- [ ] Run **Test Step** on Node 2 (Sheets Read) — expect rows returned, `Status` visible.
- [ ] Run **Test Step** on Node 3 (Filter Blank) — expect only blanks pass through.
- [ ] Inspect Node 5 (GET) test — expect 200 with account list (404 handling is normal, see §10).
- [ ] Clear test output if n8n prompts to avoid confusing production run.

| Node | Verify | Expected |
|---|---|---|
| 1 Manual Trigger | No config needed | `Execute` button enabled |
| 2 Sheets Read | Doc ID + tab correct | Returns N rows |
| 3 Filter Blank | Condition `Status is empty` | Blanks = pending count |
| 4 Loop 1/N | `batchSize 1` | Shows `1/N` on hover |
| 5 GET Check | Header auth, 200 | JSON list |
| 6 IF Exists | Expression valid | True/False branches wired |
| 7 POST Create | JSON body valid | 201 on test single |
| 8 Write-back | 200-char truncation | Writes to `Status` |

### 5.3 Step 3 — Execute

- [ ] Click **Execute Workflow** (bottom bar, not per-node Execute).
- [ ] Confirm execution starts — banner shows `Workflow started` + Execution ID.
- [ ] Copy Execution ID into run log immediately.
- [ ] Note start time (UTC) in run log.
- [ ] Do **not** click Execute a second time — one run only.

```text
Run Log Entry:
- Execution ID: __________
- Started (UTC): __________
- Operator: __________
- Intended blanks: __________
- Tranche: e.g., 1/3 (rows 2–101)
```

### 5.4 Step 4 — Watch 1/N Progress

- [ ] Keep n8n tab **focused and open** for entire run.
- [ ] Watch Loop node — it displays `1/N`, `2/N`, ... sequentially.
- [ ] Watch Node 8 write-backs appear in Google Sheet (refresh every ~20 rows, not continuously).
- [ ] Count: Loop **in** = blanks in, Loop **out** = write-backs attempted (see §7).
- [ ] If progress stalls >3 minutes on one item, do not refresh aggressively — check Executions → logs.

| What to Watch | Where | Healthy Sign |
|---|---|---|
| Loop counter | Canvas Loop node | Increments 1/N steadily |
| GET → IF branch | Canvas highlight | Mix of skip/create, no stuck spinner |
| POST status | Execution log | 200/201 per create |
| Sheet Status fills | Google Sheet tab | `Added` / `Failed - ...` appearing row by row |
| Execution status | Left panel Executions | `Running` (green pulse), not `Error` / `Waiting` |

- [ ] Expected throughput: ~2–5 sec per account (GET + POST + Sheets write).
- [ ] Example: 100 blanks ≈ 5–9 minutes. 200 blanks ≈ 10–18 minutes. Plan accordingly.
- [ ] Do not throttle manually — sequential loop already paces requests.

### 5.5 Step 5 — Don't Close Tab or Edit Sheet Mid-Run

- [ ] **DO NOT** close laptop lid, close browser tab, or navigate away.
- [ ] **DO NOT** edit the Sheet mid-run (no sorting, no filtering, no inserting rows).
- [ ] **DO NOT** let another operator press Execute concurrently.
- [ ] **DO NOT** revoke or rotate the temp API key mid-run.
- [ ] **DO NOT** rename the tab or change sharing mid-run.
- [ ] If you must step away: lock screen, keep power on, keep tab open, notify reviewer.

| Forbidden Mid-Run Action | Why It Breaks the Run |
|---|---|
| Closing tab | Manual execution is browser-tied on some n8n setups; run may abort |
| Sorting / filtering sheet | Row-number mapping shifts; Status writes land on wrong rows |
| Editing a blank row's email | GET check already ran on old value; POST creates stale address |
| Clearing `Added` to “retry” | Destroys idempotency; rerun will duplicate |
| Starting second execution | Two loops write same `Status` cells; race + duplicates |
| Revoking API key | All remaining POSTs 401; run marks mass `Failed` |

- [ ] If accidental edit occurs: **Stop** workflow immediately, note last `Added` row, follow §8 Rollback.

### 5.6 Step 6 — Verify Blanks = 0 + Dashboard Count

- [ ] Wait for Execution status = `Success` (not `Running`).
- [ ] In Google Sheet: filter `Status` = blank → expect **0 rows** (blanks=0).
- [ ] Count `Added` in this run = prior Added + new Added.
- [ ] Count `Failed - *` — triage per §10, do not clear.
- [ ] In Instantly → Email Accounts dashboard: refresh, record post-run count.
- [ ] Verify math:

```text
Post-run count - Pre-run count == New Added in sheet
If mismatch >2, investigate duplicates or manual adds outside workflow.
```

- [ ] Screenshot dashboard count + Executions Success page for audit.
- [ ] Fill Appendix B run log: end time, duration, Added, Failed, Skipped (IF true).
- [ ] Mark run log `Complete` or `Complete with failures`.

| Verification | How | Pass Criteria |
|---|---|---|
| Blanks = 0 | Filter `Status` blank | 0 rows |
| Write-back length | `=LEN(Status)` spot check | ≤200 chars |
| Dashboard delta | Instantly Email Accounts count | Delta == New `Added` |
| Execution log | n8n Executions → Success | No unhandled error |
| Loop in/out | Loop node counts | In == Out == blanks in |

- [ ] If blanks remain but Execution shows Success → see Row 1 of §10 (write-back miss).
- [ ] If dashboard delta < Added → check IF-skip count (already existed, correctly skipped).

---

## 6. Blanks-Only Rerun and Idempotency

### 6.1 Core Rule — Never Clear Added

- [ ] **NEVER** clear `Added` to force a retry. `Added` is permanent success marker.
- [ ] **NEVER** bulk-clear `Status` column. You will create duplicates on rerun.
- [ ] **ONLY** blanks are processed. `Added` and `Failed - *` are automatically skipped by Node 3.
- [ ] To retry failures: fix the underlying issue, then **clear only the fixed `Failed - *` cells back to blank**.
- [ ] Leave unfixable `Failed - *` intact for audit — do not blank them.

```text
Allowed transitions:
  (blank) ──run──> Added                ✅ success
  (blank) ──run──> Failed - <reason>    ⚠️ needs fix
  Failed - <reason> ──fix + clear──> (blank) ──rerun──> Added   ✅ retry
  Added ──clear──> (blank)              ❌ FORBIDDEN — creates duplicate

Forbidden:
  Added → blank → rerun → duplicate POST (may 409 or double-bill)
```

### 6.2 Never Concurrent Runs

- [ ] Check n8n → Executions → filter workflow → confirm **no `Running`** before rerun.
- [ ] Confirm prior Execution ID is `Success` / `Error` / `Stopped`, not `Running`.
- [ ] Only one operator, one tab, one Execute at a time.
- [ ] If prior run is stuck `Running` >30 min with no Loop progress: Stop it, then rerun blanks.

| State | Action |
|---|---|
| Prior `Success`, blanks remain | Safe to rerun blanks immediately |
| Prior `Error`, blanks remain | Fix error per §10, then rerun blanks |
| Prior `Running`, Loop incrementing | Wait — do not start second run |
| Prior `Running`, stalled >30 min | Stop, note last Added, rerun blanks |

### 6.3 Retry_YYYY-MM-DD Tab Technique

> Use when failures need isolated fixing without touching the main `Accounts` tab.

- [ ] Create new tab named `Retry_YYYY-MM-DD` (e.g., `Retry_2026-09-09`).
- [ ] Copy **header row exactly** from `Accounts` (same order, same spelling).
- [ ] Copy **only** the fixed rows (previously `Failed - *`, now corrected) into retry tab.
- [ ] Leave their `Status` cells **blank** in the retry tab.
- [ ] Do **not** copy `Added` rows into retry tab.
- [ ] Point Node 2 (Sheets Read) + Node 8 (Write-back) to `Retry_YYYY-MM-DD` temporarily.
- [ ] Run SOP §5 against retry tab (pre-flight + Execute + verify blanks=0).
- [ ] After success: copy `Added` / `Failed - *` results back to main `Accounts` tab by Email key.
- [ ] Point nodes back to `Accounts` tab, save, verify green badges.
- [ ] Keep retry tab for 30 days as audit trail — do not delete immediately.

```text
Example:
  Accounts (main):        500 rows — 480 Added, 20 Failed
  Retry_2026-09-09 (new): 20 rows — header + 20 fixed rows, Status blank
  Run retry tab → 18 Added, 2 Failed
  Copy back → Accounts: 498 Added, 2 Failed (audit complete)
```

- [ ] Checklist for retry tab:

- [ ] Header matches `Accounts` exactly (copy-paste, not retyped).
- [ ] Port columns formatted as Number in retry tab.
- [ ] Emails lowercased/trimmed, no duplicates within retry tab.
- [ ] Node 2 + Node 8 tab references updated and saved.
- [ ] Post-run copy-back verified by Email match (VLOOKUP/XLOOKUP).
- [ ] Node references reverted to `Accounts`.

### 6.4 50–200 Tranches for 500+ Rows

> Large loads must be split. Never run 500+ blanks in one execution.

- [ ] If blanks ≥500, split into tranches of **50–200 rows** each.
- [ ] Recommended tranche size:

| Total Blanks | Tranche Size | # Runs | Rationale |
|---|---|---|---|
| <100 | Single run | 1 | Low risk, fast verify |
| 100–300 | 100 per run | 1–3 | Balanced throughput + triage |
| 300–500 | 100–150 per run | 3–4 | Rate-limit headroom |
| 500–1000 | 100–200 per run | 5–10 | Avoid timeout, easier rollback |
| 1000+ | 50–100 per run | 10–20 | Operational safety, per-day Instantly caps |

- [ ] How to tranche without breaking idempotency:

- [ ] Option A (preferred): Fill `Status` with `Queued - tranche N` placeholder? **No — do not.** Filter only passes true blanks.
- [ ] Option A corrected: Stage tranches as separate tabs `Load_T1`, `Load_T2`, ... each with header + 50–200 rows, Status blank.
- [ ] Option B: Keep single `Accounts` tab, but pre-fill future tranches' `Status` with `On Hold - T2` (non-blank = skipped), then clear to blank tranche-by-tranche.
- [ ] Option B caution: `On Hold - T2` looks like failure — document clearly, use distinct prefix.
- [ ] Run T1 → verify → run T2 → verify (never concurrent).
- [ ] Log each tranche as separate row in run log (Execution ID per tranche).

- [ ] Between tranches:

- [ ] Check `Failed` rate — if >10% in first 20 rows, **stop** and fix before T2 (§7).
- [ ] Check Instantly dashboard delta matches Added.
- [ ] Pause 2–5 minutes between tranches to respect rate limits (§9).
- [ ] Re-verify temp key still valid (not expired/revoked).

---

## 7. Monitoring During Run

### 7.1 Where to Watch

| Surface | Path | What It Tells You |
|---|---|---|
| Canvas | Workflow → current Execution | Live node highlights, Loop 1/N |
| Executions | n8n left nav → Executions | Status (`Running`/`Success`/`Error`), duration, Execution ID |
| Loop counts | Loop node → output panel | In (items in) vs Out (write-backs) |
| Sheet | Google Sheet → `Accounts` tab | `Added` / `Failed - *` appearing live |
| Instantly | Dashboard → Email Accounts | Count incrementing |
| Logs | Execution → node logs | HTTP status per GET/POST, `$json.error` |

### 7.2 Loop In / Out Counts

- [ ] Node 4 Loop **In** = number of blanks fed into loop (should equal pre-run blanks).
- [ ] Node 4 Loop **Out** (done branch) = number of completed iterations with write-back.
- [ ] Healthy: `In == Out` at end of run.
- [ ] Unhealthy: `Out < In` with Execution `Error` → some items never wrote back (see §10 Row 1).

```text
Example healthy:
  Filter out: 100 blanks → Loop In: 100 → Loop Out: 100 → Sheet: 95 Added + 5 Failed

Example unhealthy:
  Filter out: 100 blanks → Loop In: 100 → Loop Out: 72 → Execution Error
  → 28 blanks never attempted → fix error, rerun (blanks-only picks up 28)
```

- [ ] Record In/Out in run log for every execution.
- [ ] If IF-skip path exists: also record Skipped (GET found existing) vs Created (POST 200/201).

### 7.3 Alert — Failed > 10% in First 20 Rows

> **Early-warning gate. Prevents burning 500 rows with a systemic misconfig.**

- [ ] After first ~20 write-backs appear, compute: `Failed / 20`.
- [ ] If `Failed > 10%` (i.e., ≥3 failures in first 20), **STOP the workflow immediately**.

| Step | Action |
|---|---|
| 1 | Press **Stop** in n8n execution banner |
| 2 | Note last `Added` row + Loop position (e.g., `23/100`) |
| 3 | Inspect `Failed - <reason>` — if all same reason, it's systemic (auth, ports, scope) |
| 4 | Do not continue, do not start tranche 2 |
| 5 | Fix per §10 matrix, test single row via §11 debug recipe |
| 6 | Rerun blanks-only (remaining blanks auto-picked up) |

- [ ] Common systemic causes tripping the 10% gate:

- [ ] 401 on every POST → temp key wrong/expired (see §10 Row 2).
- [ ] 400 `NaN` ports → port columns formatted as text (see §10 Row 6).
- [ ] 403 scope → key lacks write scope (see §10 Row 4).
- [ ] Google 403 → OAuth expired (see §10 Row 9).

- [ ] If failures are heterogeneous (different reasons per row), it's data quality — continue cautiously, triage post-run.
- [ ] Log the stop decision + reason in run log — never silently resume.

### 7.4 Monitoring Checklist (Every Run)

- [ ] Execution ID logged at start.
- [ ] Loop 1/N observed incrementing within first 60 seconds.
- [ ] First 5 Status write-backs appear within 2 minutes.
- [ ] First-20 failure rate computed and <10% (or stopped).
- [ ] No Execution `Error` banner mid-run.
- [ ] Sheet refresh shows no misaligned writes (Status on correct Email row).
- [ ] Dashboard count moves in step with `Added`.
- [ ] Final In == Out verified.
- [ ] Final blanks=0 verified (or remaining blanks explained).

---

## 8. Rollback — No Single Undo

> **There is no single Undo button. Rollback is manual: stop → note → delete → fix → rerun.**

### 8.1 When to Rollback

| Scenario | Rollback? | Action |
|---|---|---|
| Wrong Sheet tab loaded (test data uploaded to prod) | Yes | Stop + delete by `created_at` |
| Wrong Instantly workspace key (accounts in wrong workspace) | Yes | Stop + delete from wrong workspace |
| Systemic misconfig caused mass `Added` with bad SMTP (e.g., wrong host) | Yes | Stop + delete bad batch + fix + rerun |
| Few isolated `Failed` | No | Fix + blanks-only rerun, no delete needed |
| Duplicates created (case/space variant double-POST) | Partial | Delete newer duplicate, keep canonical |
| Sheet misalignment (Status on wrong rows) | No delete | Fix sheet mapping, verify, rerun blanks |

### 8.2 Rollback Procedure (Step-by-Step)

- [ ] **Step 1 — Stop.**

- [ ] Press **Stop** in n8n execution banner.
- [ ] Confirm Executions status = `Stopped` (not `Running`).
- [ ] Do not press Execute again until rollback complete.

- [ ] **Step 2 — Note last Added.**

- [ ] In Sheet, find last row with `Added` from this Execution ID's time window.
- [ ] Record: last Added Email, row number, timestamp (UTC).
- [ ] Record Loop position at stop (e.g., `47/200`).
- [ ] Screenshot Sheet + Execution log for audit.

- [ ] **Step 3 — Delete by created_at in Instantly.**

- [ ] In Instantly → Email Accounts → sort by **Created At descending**.
- [ ] Filter to `created_at` >= run start time (UTC) from run log.
- [ ] Verify list matches Sheet's new `Added` emails (cross-check 5–10 samples).
- [ ] Delete only the bad batch — newest first, one page at a time.
- [ ] If Instantly lacks bulk delete: delete in small batches, log each batch count.
- [ ] Do not delete pre-existing accounts (created before run start).

```text
Safety check before each delete batch:
  [ ] created_at >= run start? Yes → candidate
  [ ] Email in this run's Added list? Yes → candidate
  [ ] Both true → delete. Either false → skip.
```

- [ ] **Step 4 — Fix.**

- [ ] Fix root cause in Sheet (ports, host, credentials) or n8n (key, scope, mapping).
- [ ] Clear affected rows' `Status` from `Added` back to **blank** only for deleted accounts.
- [ ] Leave correctly-added rows as `Added` (do not touch).
- [ ] Re-run pre-flight checklist §4 (abbreviated: credentials + sheet + single-row test).

- [ ] **Step 5 — Rerun.**

- [ ] Execute blanks-only rerun per §5 SOP.
- [ ] Verify blanks=0 + dashboard delta matches rerun Added.
- [ ] Log rollback + rerun as linked entries in run log (original Execution ID → delete count → rerun Execution ID).

### 8.3 Rollback — What NOT to Do

- [ ] Do not bulk-clear entire `Status` column — destroys audit trail.
- [ ] Do not delete Instantly accounts without `created_at` filter — risks deleting prod senders.
- [ ] Do not rerun before delete completes — creates duplicates.
- [ ] Do not rollback for `Failed - *` rows — they were never created, nothing to delete.

### 8.4 Rollback Log Template

```text
Rollback Date (UTC): __________
Original Execution ID: __________
Stop position (Loop N/M): __________
Last Added Email: __________
Accounts deleted (count): __________
Delete verified by: __________
Root cause fixed: __________
Rerun Execution ID: __________
Reviewer sign-off: __________
```

---

## 9. Rate-Limit Playbook

### 9.1 Why Sequential Already Helps

- [ ] Loop `batchSize: 1` sends one GET + (optionally) one POST at a time.
- [ ] No parallel branches, no batch POST — Instantly sees gentle sequential traffic.
- [ ] Typical load (100 rows) rarely hits 429 if no other jobs run concurrently.

### 9.2 Signals You Are Rate-Limited

| Signal | Where | Meaning |
|---|---|---|
| `429 Too Many Requests` | POST node log, `$json.error` | Instantly throttling |
| `Retry-After` header | HTTP response headers | Seconds to wait before retry |
| Sudden mass `Failed - 429` | Sheet Status column | Systemic throttle, not data issue |
| GET 200 but POST 429 | Execution log | Write quota hit, reads OK |

### 9.3 Immediate Response (If 429 Appears)

- [ ] **Do not** hammer rerun — 429 + immediate rerun = longer ban.
- [ ] **Stop** the workflow if 429 rate >10% in first 20 (per §7 gate).
- [ ] Note `Retry-After` value (e.g., `60`, `120` seconds).
- [ ] Wait **at least** `Retry-After` + 60 seconds buffer before any retry.
- [ ] If no `Retry-After` header: wait **5 minutes** minimum.

```text
429 Response Plan:
  1. Stop execution
  2. Record 429 count + first 429 timestamp
  3. Wait Retry-After + 60s (or 5 min default)
  4. Reduce tranche to 50 rows max
  5. Rerun blanks-only (429 rows are still blank or Failed-429 → clear Failed-429 to blank)
  6. If 429 recurs on <20 rows, escalate to Instantly support + pause 1 hour
```

### 9.4 Preventive Pacing

- [ ] Run 50–200 tranches with **2–5 minute pauses** between tranches.
- [ ] Never run two bulk loads (or campaign sends) concurrently against same workspace.
- [ ] Schedule loads off-peak (avoid top-of-hour automation bursts).
- [ ] If n8n supports Wait node: do not insert artificial delays inside loop unless 429 recurs — sequential is already paced.

| Load Size | Pause Between Tranches | Max Parallel Runs |
|---|---|---|
| <100 | None needed | 1 |
| 100–300 | 2 min | 1 |
| 300–500 | 3–5 min | 1 |
| 500+ | 5 min + 429 watch | 1 (never 2) |

### 9.5 429 vs 402 vs 403 — Don't Confuse

| Code | Meaning | Retry Helps? | Action |
|---|---|---|---|
| 429 | Too many requests (throttle) | Yes, after wait | Pause + smaller tranche + rerun |
| 402 | Quota / billing limit | No | Upgrade plan or delete unused accounts |
| 403 | Forbidden / scope | No | Fix API scope, not pacing |

- [ ] If `Failed - 402` appears, stop — rerunning wastes time, fix billing first.
- [ ] If `Failed - 403 scope` appears, stop — fix key scope, not pacing.

---

## 10. Troubleshooting Matrix (10 Rows)

> `Status` write-back is truncated to 200 chars. Full error lives in Execution log → `$json.error`.
> Fix data, clear fixed `Failed - *` to blank, rerun blanks-only. Never clear `Added`.

| # | Symptom | Likely Cause | Fix (Operator Action) | Rerun Step |
|---|---|---|---|---|
| 1 | `Status` blank after `Success` execution | Write-back miss: row-number shift, tab mismatch, or Loop Out < In; Status write mapped to wrong row/tab | 1. Check Loop In vs Out — if Out < In, some items never wrote. 2. Verify Node 8 tab = same tab as Node 2. 3. Check for mid-run sort/filter that shifted rows. 4. Inspect Execution log for Sheets `update` 200 vs 400. | Fix tab mapping, clear nothing, rerun — blanks auto-picked up. Verify blanks=0 after. |
| 2 | `401` on both GET + POST (`Failed - 401 Unauthorized` mass) | Temp key wrong, expired, revoked mid-run, or `Bearer` prefix missing; placeholders `YOUR_INSTANTLY_API_KEY` still present | 1. Stop run. 2. Verify header is `Authorization: Bearer <key>` (not query param). 3. Search workflow JSON for `YOUR_INSTANTLY_API_KEY` — replace. 4. Issue new `bulk-load-YYYY-MM-DD` 7-day key, test with curl (expect 200). 5. Update Header Auth credential on both nodes. | Clear `Failed - 401*` to blank after key fix, rerun blanks-only. |
| 3 | `402 Payment Required` (`Failed - 402`) | Instantly workspace at account limit / billing cap | 1. Stop run. 2. Check Instantly → Billing / Usage — confirm cap. 3. Upgrade plan or archive/delete unused accounts. 4. Record pre-fix dashboard count. Do not pace/retry — retry cannot fix 402. | After capacity freed, clear `Failed - 402*` to blank, rerun in 50–100 tranches. |
| 4 | `403 Forbidden / scope` (`Failed - 403`) | API key lacks `email-accounts:write` (or wrong workspace / IP allowlist) | 1. Stop run. 2. Verify key scope includes `read` + `write`. 3. Confirm key belongs to correct workspace (not staging). 4. Check Instantly API restrictions / allowlist. 5. Re-issue key with correct scope. | Clear `Failed - 403*` to blank after scope fix, single-row test (§11), then rerun. |
| 5 | `429 Too Many Requests` (`Failed - 429`) | Rate-limited — too fast, concurrent job, or burst | 1. Stop if >10% in first 20. 2. Read `Retry-After` header, wait +60s buffer (min 5 min). 3. Confirm no concurrent runs/sends. 4. Reduce tranche to ≤50. See §9 playbook. | Clear `Failed - 429*` to blank after wait, rerun small tranche. |
| 6 | `400 NaN ports` (`Failed - 400 invalid port / NaN`) | `SMTP Port` / `IMAP Port` stored as text, formula error, or empty; Sheets formatting issue | 1. In Sheet, Format → Number for both port columns. 2. Find `NaN`, `#ERROR!`, blanks — replace with `465`/`587` (SMTP) and `993` (IMAP). 3. Ensure no quotes/spaces (`"587"` → `587`). 4. Verify Node 7 passes integers (`parseInt`). | Fix ports, clear `Failed - 400*` to blank, rerun. Validate with `=ISNUMBER()` check pre-rerun. |
| 7 | `404 on Check` (GET returns 404) — **Expected, not an error** | Check endpoint returns 404 when account does not yet exist (normal for new emails) | 1. Confirm IF node treats 404 / empty-match as “not exists → proceed to POST”. 2. Do not mark 404 as failure. 3. Only alert if GET 404 + POST never fires (IF wiring broken). Verify both branches wired to Node 8. | No fix needed. If IF misroutes 404 to Failed, fix IF expression, clear affected to blank, rerun. |
| 8 | Duplicates — case / space variants (`info@x.com` vs `Info@x.com `) create dupes or 409 | Dedupe was case/space-sensitive; Sheet has `Info@X.com` + `info@x.com` as separate blanks | 1. Stop if dupes detected. 2. Normalize: helper column `=LOWER(TRIM(Email))`, dedupe on helper. 3. Verify IF compare uses `toLowerCase().trim()` on both sides. 4. Delete newer duplicate in Instantly by `created_at` (§8). | Keep canonical `Added`, delete duplicate, do not blank canonical. Rerun remaining blanks. |
| 9 | Google `403` / Sheets write fails (Execution `Error`, Status stays blank) | Google OAuth expired, sheet sharing revoked, tab renamed mid-run, or quota exceeded | 1. Re-auth Google Sheets credential (OAuth refresh). 2. Confirm Operator still has editor access, sheet not view-only. 3. Confirm tab name unchanged (`Accounts` exact). 4. Check Google API quota dashboard. 5. Verify Node 8 match column (`Email`) still exists. | After auth fix, rerun blanks-only — unwritten blanks will process. Verify Loop Out == In. |
| 10 | `No rows processed` — Filter passes 0 items, Loop shows `0/N` | No true blanks: Status has spaces (`" "`), `On Hold`, or filter checks wrong column; Node 2 points to wrong tab | 1. In Sheet, filter Status blank — if 0, nothing to do (correct). 2. If blanks visible but 0 pass: check for whitespace — `=LEN(Status)` should be 0, not 1. Trim column. 3. Verify Node 3 condition targets `Status` (not `status` lowercase mismatch). 4. Verify Node 2 tab = intended tab (`Accounts` vs `Retry_YYYY-MM-DD`). | Fix whitespace/tab, confirm blanks count >0, rerun. Never force by disabling Filter. |

### 10.1 Notes on Reading the Matrix

- [ ] `Failed - <reason>` is truncated to 200 chars — full stack lives in Execution log.
- [ ] Same-reason mass failure = systemic (key, scope, ports, quota) → Stop + fix + rerun.
- [ ] Mixed reasons = data quality → finish run, triage row-by-row, retry fixed subset.
- [ ] 404-on-Check is the **only** row where “error” means success-path — do not “fix” it.
- [ ] When in doubt, single-row debug first (§11) before mass rerun.

---

## 11. Debug Recipe — Pin and Inspect

> Use for any persistent `Failed - *` or blank-after-Success. Never debug on full load — isolate one row.

### 11.1 Pin Single Item (Isolate)

- [ ] In n8n, open the failed Execution → find failed item (e.g., item `14/100`).
- [ ] Copy that item's input JSON (Email + SMTP/IMAP fields).
- [ ] Go to workflow canvas → Node 2 (Sheets Read) → **Pin** → paste single item as pinned data:

```json
{
  "json": {
    "Email": "debug-one@example.com",
    "SMTP Username": "debug-one@example.com",
    "SMTP Password": "REDACTED-FOR-DEBUG-USE-VAULT-VALUE",
    "SMTP Host": "smtp.example.com",
    "SMTP Port": 587,
    "IMAP Host": "imap.example.com",
    "IMAP Port": 993,
    "Status": ""
  }
}
```

- [ ] Alternatively: temporarily filter Sheet to one blank debug row, or use `Retry_YYYY-MM-DD` with 1 row.
- [ ] Execute workflow (or Execute from pinned node forward) — observe single-item path.

### 11.2 Inspect $json.error (Diagnose)

- [ ] Click failed node (GET or POST or Sheets Write-back) → Output → JSON tab.
- [ ] Expand `$json` → look for `error`, `message`, `statusCode`, `details`.

| Field to Inspect | Example | Meaning |
|---|---|---|
| `statusCode` | `401`, `402`, `403`, `429`, `400` | Maps to §10 matrix row |
| `$json.error` | `"Unauthorized"`, `"Invalid SMTP port"` | Root cause string (write-back truncates this to 200 chars) |
| `$json.message` | `"Quota exceeded"` | Human-readable detail |
| `headers.retry-after` | `"60"` | Wait time for 429 |
| `request.body.email` | `"Debug-One@..."` | Verify lowercase/trim applied |

- [ ] Copy full `$json.error` into run log (not just truncated Status).
- [ ] Check **both** GET and POST logs — 401 on one node only means credential mismatch between nodes.

```text
Debug checklist:
[ ] GET status? 200 (exists) / 404 (new, expected) / 401 (key bad) / 403 (scope)
[ ] IF branch taken? True=skip (correct if exists), False=create
[ ] POST status? 201 (created) / 400 (ports/body) / 401/403/402/429 (per matrix)
[ ] Write-back status? Sheets update 200 (Status filled) / 403 (Google auth)
[ ] Status length ≤200? Yes (truncation working)
```

### 11.3 Fix, Unpin, Rerun

- [ ] Fix root cause in Sheet or credential (per matrix row).
- [ ] **Unpin** all pinned data — confirm no pin icon remains on any node.
- [ ] Clear fixed `Failed - *` cells to blank (only fixed rows).
- [ ] Run full blanks-only rerun per §5 (or retry-tab run per §6.3).
- [ ] Verify debug Email now shows `Added`.

- [ ] Forbidden:

- [ ] Do not leave pin active during production run (will reprocess same debug row only).
- [ ] Do not paste real SMTP passwords into Slack/tickets — use vault references.
- [ ] Do not commit debug JSON with secrets to git.

---

## 12. Security Operations

### 12.1 Threat Model — Plaintext Passwords

| Threat | Where | Impact | Control (This Runbook) |
|---|---|---|---|
| SMTP passwords in Sheet plaintext | Google Sheet `SMTP Password` column | Sheet share = credential leak; anyone with view can send as user | Viewer-default sharing, editor-only during run, vault + clear post-run |
| API key in workflow JSON / logs | n8n HTTP nodes, Execution logs | Key exfiltrated via export, screenshot, or log retention | Header Auth credential (not hardcoded), `saveDataSuccessExecution: none`, `EXECUTIONS_DATA_MAX_AGE` prune |
| Long-lived key reuse | n8n credential store | Stale key abused after load | Temp per-load `bulk-load-YYYY-MM-DD` 7-day key + revoke + curl-401 test |
| Accidental git commit of secrets | Repo, workflow export | Public/shared history contains secrets | Never-commit list (§12.2), placeholders, pre-commit scan |
| Concurrent operator overwrites | Sheet + n8n | Wrong-row Status writes, duplicate creates | Single operator, frozen sheet, no concurrent runs |
| Log retention PII | n8n Executions history | Passwords persist in execution data | Disable success data save, short max age, manual prune |

- [ ] Assume Sheet + Execution logs contain secrets during run — treat both as sensitive.
- [ ] Assume any exported `workflows/*.json` will be shared — it must contain placeholders only.

### 12.2 Never-Commit List

> **These must never appear in git, PRs, issues, or chat logs.**

- [ ] Real Instantly API keys (live or expired) — use `YOUR_INSTANTLY_API_KEY`.
- [ ] Real Google Sheet IDs / Doc URLs with ID — use `YOUR_GOOGLE_SHEET_ID`.
- [ ] Real SMTP / IMAP passwords, app passwords, OAuth refresh tokens.
- [ ] Real mailbox addresses in bulk (use `user@example.com` in docs/tests).
- [ ] Exported workflow JSON containing embedded credentials or session tokens.
- [ ] Screenshots showing full API key, password column, or Bearer token.
- [ ] Execution logs with `$json` containing passwords.
- [ ] `.env` files, `credentials.json`, `service-account.json`.

| File Pattern | Must Contain | Must Never Contain |
|---|---|---|
| `workflows/*.json` | `YOUR_INSTANTLY_API_KEY`, `YOUR_GOOGLE_SHEET_ID` | `sk-`, `Bearer ey...`, real doc ID |
| `docs/*.md` | Placeholders + `bulk-load-YYYY-MM-DD` example | Real key, real sheet ID |
| `.env*`, `*.env` | Placeholder keys only (gitignored) | Real secrets |
| Screenshots in PRs | Redacted (blur password + key columns) | Full password column visible |

- [ ] Pre-commit check (run before every commit):

```bash
# Fail if real secrets or placeholders-missed patterns are staged
git diff --cached --name-only | xargs grep -En "sk-|Bearer ey|YOUR_INSTANTLY_API_KEY|YOUR_GOOGLE_SHEET_ID" || true
# Manually verify: placeholders SHOULD appear in workflows/*.json, real keys MUST NOT
```

- [ ] If scan finds real key: **stop commit**, rotate key immediately, purge history per §12.6.

### 12.3 Placeholders — Required Strings

- [ ] In all committed files, use exactly:

```text
YOUR_INSTANTLY_API_KEY
YOUR_GOOGLE_SHEET_ID
```

- [ ] Example committed HTTP header (safe):

```json
{
  "name": "Authorization",
  "value": "Bearer YOUR_INSTANTLY_API_KEY"
}
```

- [ ] Example committed Sheets node (safe):

```json
{
  "documentId": "YOUR_GOOGLE_SHEET_ID",
  "sheetName": "Accounts"
}
```

- [ ] At runtime, Operator replaces via n8n **Credential** (not by editing JSON text).
- [ ] Never commit the runtime-substituted file — keep substitution local / in n8n credential store.

### 12.4 Temp Per-Load Keys — bulk-load-YYYY-MM-DD, 7-Day + Revoke + curl-401 Test

- [ ] For **every** bulk load, issue a dedicated temp key:

```text
Name:   bulk-load-YYYY-MM-DD   (e.g., bulk-load-2026-09-09)
Scope:  email-accounts:read + email-accounts:write (minimum necessary)
Expiry: 7 days max (earlier if load completes sooner)
Owner:  Credential Owner (not shared personal key)
```

- [ ] Procedure:

- [ ] Step 1 — Create: Instantly → Settings → API → Create Key → name `bulk-load-YYYY-MM-DD`, 7-day expiry.
- [ ] Step 2 — Store: Save in n8n Header Auth credential named same (`bulk-load-YYYY-MM-DD`), attach to Node 5 + Node 7.
- [ ] Step 3 — Test (read-only curl, expect 200):

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Bearer $INSTANTLY_TEMP_KEY" \
  https://api.instantly.ai/api/v2/email-accounts
# Expected: 200
# If 401: key wrong / not propagated — do not start load
```

- [ ] Step 4 — Run load (§5 SOP).
- [ ] Step 5 — Revoke immediately post-run (same day load completes, no later than 7 days):

```text
[ ] Instantly → API → Revoke bulk-load-YYYY-MM-DD
[ ] n8n → Credentials → Delete or disable bulk-load-YYYY-MM-DD entry
[ ] Update run log: Revoked (UTC) + by whom
```

- [ ] Step 6 — curl-401 test (prove revocation):

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Bearer $INSTANTLY_TEMP_KEY" \
  https://api.instantly.ai/api/v2/email-accounts
# Expected after revoke: 401
# If still 200: revocation failed — retry + escalate
```

- [ ] Log both curl results (pre-run 200, post-revoke 401) in run log.
- [ ] Never reuse a `bulk-load-*` key for a second date — issue fresh per load.

### 12.5 Sheet Hygiene — Viewer-Default + Vault Post-Run

- [ ] Before run: sharing = **Viewer** default for all except Operator (Editor) + Sheet Owner.
- [ ] Before run: disable “Anyone with link can edit” — set to Viewer or Restricted.
- [ ] During run: no new shares, no link-sharing escalation.
- [ ] After run (within 24h):

- [ ] Copy `SMTP Password` column values into team vault (1Password / Bitwarden / Vault).
- [ ] Verify vault entries match Email keys (spot-check 5).
- [ ] Clear `SMTP Password` cells in Sheet (leave blank) **or** replace with `vault:ref:<id>`.
- [ ] Revert sharing to Viewer-default (Operator back to Viewer if no follow-up retry).
- [ ] Log vault + clear actions in run log.

```text
Post-run sheet hygiene:
[ ] Passwords vaulted? Yes — vault path: __________
[ ] Sheet password cells cleared / replaced with vault ref? Yes
[ ] Sharing reverted to viewer-default? Yes
[ ] Retry tabs retained 30 days then cleared of passwords? Yes
```

- [ ] If sheet must retain passwords for imminent retry: document exception, expiry date, and approver — max 7 days.

### 12.6 n8n Hardening — saveDataSuccessExecution none + EXECUTIONS_DATA_MAX_AGE + 2FA + 90-Day Rotation

- [ ] Workflow Settings → `saveDataSuccessExecution: none` (UI: “Save Successful Production Executions: Never”).

```json
{
  "settings": {
    "saveDataSuccessExecution": "none",
    "saveDataErrorExecution": "all",
    "executionTimeout": 3600
  }
}
```

- [ ] Rationale: success executions contain SMTP passwords in transit — do not persist them. Keep error executions (`all`) for debugging, pruned by max age.
- [ ] Server env: set `EXECUTIONS_DATA_MAX_AGE` to auto-prune (e.g., 168h = 7 days):

```bash
# n8n self-hosted .env / docker-compose
EXECUTIONS_DATA_MAX_AGE=168
EXECUTIONS_DATA_PRUNE=true
EXECUTIONS_DATA_PRUNE_MAX_COUNT=500
```

- [ ] n8n Cloud: set equivalent retention in Admin → Executions → Retention (7 days max for this workflow).
- [ ] 2FA: required for all n8n users with workflow execute + credential access.
- [ ] 90-day rotation: rotate Google OAuth + any long-lived n8n credentials every 90 days (temp Instantly keys already per-load).

| Control | Value | Verify |
|---|---|---|
| `saveDataSuccessExecution` | `none` | Workflow Settings JSON |
| `EXECUTIONS_DATA_MAX_AGE` | `168` (hours) | Server env / Admin panel |
| 2FA | Enforced | n8n Users → MFA column |
| Rotation | 90 days | Credential “Last rotated” log |
| Temp key expiry | 7 days | Instantly API panel |

### 12.7 Leak Incident Steps

> If a real key, password, or sheet ID is committed, screenshotted, or shared externally:

- [ ] **Step 1 — Contain (minutes).**

- [ ] Revoke leaked Instantly key immediately (do not wait for confirmation).
- [ ] Remove external share (revoke sheet link, delete screenshot/message if possible).
- [ ] Stop any running bulk load using leaked key.

- [ ] **Step 2 — Rotate (hours).**

- [ ] Issue new temp key if load must continue (`bulk-load-YYYY-MM-DD-r2`).
- [ ] Rotate Google OAuth if sheet link was public.
- [ ] Force password reset for exposed SMTP accounts if passwords leaked.

- [ ] **Step 3 — Purge (hours–days).**

- [ ] `git` — remove secret from history (`git filter-repo` / BFG), force-push, invalidate forks/caches.
- [ ] n8n — prune executions containing secret (`EXECUTIONS_DATA_PRUNE` manual + delete error executions).
- [ ] Vault — verify no stale copies in chat, tickets, or CI logs.

- [ ] **Step 4 — Verify.**

- [ ] curl-401 test on revoked key (expect 401).
- [ ] Grep repo for leaked prefix (expect 0 hits).
- [ ] Confirm dashboard shows no unauthorized creates (check `created_at` window).

- [ ] **Step 5 — Post-mortem.**

- [ ] File incident note: what leaked, where, duration exposed, accounts affected.
- [ ] Add guardrail: pre-commit hook, placeholder lint, or CODEOWNERS review on `workflows/`.
- [ ] Reviewer sign-off before resuming loads.

---

## 13. FAQ (8 Questions)

### Q1 — Can I just clear all Statuses and rerun to “start fresh”?

**No. Never.**

- Clearing `Added` destroys idempotency. The Filter will treat already-created accounts as new blanks and POST duplicates (or 409s + billing confusion).
- Correct approach: leave `Added` intact. Clear **only** the fixed `Failed - *` cells you have corrected, back to blank. Rerun picks up blanks only.
- If you already cleared `Added`: stop, restore `Added` from Instantly dashboard (`created_at` cross-check) or from `Retry_YYYY-MM-DD` audit tab, then rerun. If unsure, ask Reviewer before pressing Execute.

### Q2 — Can I run two executions at once to go faster?

**No. Never concurrent.**

- Two loops write to the same `Status` cells and POST the same emails — race conditions, misaligned writes, duplicates.
- The workflow is designed sequential (`batchSize: 1`) precisely to avoid this. Parallelism must come from smaller tranches run **serially**, not concurrent executions.
- Before every Execute: check Executions → confirm no `Running` for this workflow. One operator, one tab, one run.

### Q3 — GET returns 404 — is that a failure? Should I stop?

**No. 404-on-Check is expected and healthy.**

- 404 (or empty match) means “account does not exist yet → proceed to POST.” The IF node routes this to Create, which should then return 201 and write `Added`.
- Only stop if 404 is followed by no POST (IF wiring broken) or if every row 404s **and** every POST then 400/401 (systemic POST issue — see matrix Rows 5–6).
- Do not log 404 as `Failed`. Verify IF expression handles 404 as “not exists.”

### Q4 — How large a sheet can I run at once? What about 500+ rows?

**Split 500+ rows into 50–200 tranches, run serially.**

- Single-run limits: n8n execution timeout, Google quota, Instantly 429, and human attention. A 500-row single run risks timeout + painful rollback.
- Plan: `Load_T1` (rows 2–151), `Load_T2` (152–301), etc., or staged tabs. Pause 2–5 min between tranches. Log each Execution ID.
- After each tranche: verify blanks=0 for that tranche + dashboard delta before starting next. If first tranche hits >10% Failed in first 20, stop all tranches and fix root cause.

### Q5 — What exactly should I do with `Failed - <reason>` rows?

**Fix → clear fixed cells to blank → rerun blanks-only. Never bulk-clear.**

1. Read full `$json.error` in Execution log (Status is truncated to 200 chars).
2. Map to §10 matrix (ports? auth? scope? quota? throttle?).
3. Fix data in Sheet (e.g., correct ports to numbers) or fix credential/scope.
4. Clear **only** fixed rows’ Status to blank.
5. Rerun. Verify they flip to `Added`.
6. Leave genuinely unfixable rows as `Failed - *` for audit — do not force to `Added` manually unless you created the account out-of-band and verified in dashboard.

### Q6 — The run shows Success but some Statuses are still blank. Did it work?

**No — that's a write-back miss. Investigate, then rerun.**

- Causes: Node 8 pointed to wrong tab, row-number shift from mid-run sort, Google 403 on write, or Loop Out < In (early exit).
- Steps: check Loop In vs Out, verify Node 2 and Node 8 tab match, check Execution log for Sheets update errors, look for whitespace-only Status (`LEN=1`).
- Fix mapping/auth, then rerun — remaining blanks will process. Verify blanks=0 + Loop In == Out on rerun.

### Q7 — How do I handle SMTP passwords securely? Can they stay in the Sheet?

**No. Vault + clear within 24h post-run.**

- During run passwords must be in Sheet (workflow reads them). Sharing must be viewer-default, Operator editor-only.
- Within 24h post-run: copy passwords to team vault, verify 5 samples, then clear password cells (or replace with `vault:ref:<id>`). Revert sharing.
- Retaining plaintext passwords in a shared Sheet indefinitely is the top risk in §12.1. Exception (max 7 days for imminent retry) needs written approval + expiry.

### Q8 — Do I need a new API key every time? What about rotation?

**Yes — temp per-load key `bulk-load-YYYY-MM-DD`, 7-day expiry, revoke + curl-401 test every load.**

- Create → test (curl expect 200) → run → revoke same day → test (curl expect 401). Log both.
- Never reuse across dates. Never use a personal long-lived key for bulk loads.
- Separately: rotate Google OAuth + n8n long-lived credentials every 90 days, enforce 2FA, keep `saveDataSuccessExecution: none` + `EXECUTIONS_DATA_MAX_AGE=168` so secrets don’t linger in logs.

---

## 14. Roadmap Pointer

> This runbook covers the current Manual, sequential, blanks-only workflow. Planned improvements live in `ROADMAP.md` — do not implement ad-hoc during a production load.

- [ ] Read `ROADMAP.md` before proposing changes (parallelism, auto-retry, webhook trigger, dashboard).
- [ ] Candidate items (tracked in Roadmap, not in this SOP):

- [ ] Automatic 429 backoff with Wait + retry (currently manual §9).
- [ ] Structured `Retry_Queue` table replacing `Retry_YYYY-MM-DD` tabs.
- [ ] Pre-flight validator node (ports, dedupe, blanks count) before Loop.
- [ ] Slack/Email alert on >10% Failed gate (currently manual §7.3).
- [ ] Vault integration (read SMTP passwords at runtime, no Sheet plaintext).
- [ ] Dry-run mode (GET-only, no POST) for pre-flight counts.

- [ ] Change process:

- [ ] Propose in issue/PR referencing `ROADMAP.md` item.
- [ ] Test on copy (`instantly-smtp-bulk-upload — dev`), never on prod workflow.
- [ ] Update this runbook + `docs/SETUP.md` + version bump together.
- [ ] Reviewer approval required before prod promotion.

---

## Appendix A: Go / No-Go Sign-Off Form

```text
Load Name: __________   Date (UTC): __________   Operator: __________   Reviewer: __________
Sheet ID (last 6): __________   Tab: Accounts / Retry_YYYY-MM-DD: __________   Tranche: __/__
Temp Key: bulk-load-YYYY-MM-DD: __________   Expiry: __________

Pre-run counts:
  Total rows: __________   Blanks (intended): __________   Already Added: __________   Prior Failed: __________
  Duplicates (case/space-insensitive): __________ (must be 0)
  Port NaN / text: __________ (must be 0)
  Temp key curl: __________ (must be 200)
  Dashboard pre-count: __________   Screenshot: [ ]

Checklist:
  [ ] §4 Pre-flight all checked
  [ ] Green badges verified
  [ ] Sheet frozen, viewer-default
  [ ] No concurrent Running execution
  [ ] 500+ tranche plan attached (if applicable)

Decision: [ ] GO   [ ] NO-GO (reason): __________
Operator sig: __________   Reviewer sig: __________   Time (UTC): __________
```

---

## Appendix B: Run Log Template

```text
Load Name: __________   Execution ID: __________   Tranche: __/__   Tab: __________
Started (UTC): __________   Ended (UTC): __________   Duration: __________
Operator: __________   Temp Key: bulk-load-YYYY-MM-DD __________

Pre:  Total ___  Blanks ___  Added ___  Failed ___
Post: Blanks ___ (expect 0)  New Added ___  New Failed ___  Skipped (IF true) ___
Loop In ___  Loop Out ___  (expect In == Out)
Dashboard pre ___  post ___  delta ___  (expect delta == New Added)

First-20 Failed rate: ___%  Gate action: [ ] continue  [ ] stopped per §7.3
429 count: ___  Retry-After observed: ___  Wait applied: ___
Pre-run curl: ___ (expect 200)   Post-revoke curl: ___ (expect 401)   Revoked (UTC): ___

Failures summary (Email → $json.error → matrix row):
  1. __________ → __________ → Row __
  2. __________ → __________ → Row __
  3. __________ → __________ → Row __

Passwords vaulted: [ ] Yes  Path: __________  Sheet cleared: [ ] Yes  Sharing reverted: [ ] Yes
Screenshots: [ ] Exec Success  [ ] Dashboard post  [ ] Sheet blanks=0 filter
Status: [ ] Complete  [ ] Complete with failures  [ ] Stopped — rerun needed
Notes: __________
Reviewer sign-off: __________
```

---

## Appendix C: Status Values Reference

| Status Value | Meaning | Written By | Next Action |
|---|---|---|---|
| `(blank)` | Pending — will be processed on next run | Human (initial / cleared after fix) | Include in next blanks-only run |
| `Added` | Created in Instantly (POST 200/201) or skipped as already-exists (IF true) | Node 8 Write-back | Do nothing. Never clear. |
| `Failed - 401 Unauthorized` | Bad/expired key (see Matrix Row 2) | Node 8 (200 chars) | Fix key, clear to blank, rerun |
| `Failed - 402 Payment Required` | Quota/billing cap | Node 8 | Free capacity, clear, rerun |
| `Failed - 403 Forbidden` | Scope/workspace issue | Node 8 | Fix scope, clear, rerun |
| `Failed - 429 Too Many Requests` | Throttled | Node 8 | Wait + small tranche, clear, rerun |
| `Failed - 400 ...` | Bad request (ports/body) | Node 8 | Fix ports/body, clear, rerun |
| `Failed - <other>` | See `$json.error` full text | Node 8 | Map to matrix, fix, clear, rerun |
| `On Hold - T<N>` | Staged future tranche (non-blank = skipped) | Human (tranche staging only) | Clear to blank when tranche is due |

- [ ] All `Failed - *` values are truncated to 200 chars — full error in Execution log.
- [ ] Never write `Added` manually unless you verified the account exists in Instantly dashboard.
- [ ] Never use custom statuses (`Done`, `OK`, `Success`) — automation only recognizes `Added` / blank / `Failed - *`.

---

## Appendix D: Quick Command Reference

### D.1 Temp Key — Pre-Run Test (Expect 200)

```bash
INSTANTLY_TEMP_KEY="YOUR_INSTANTLY_API_KEY"
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Bearer $INSTANTLY_TEMP_KEY" \
  https://api.instantly.ai/api/v2/email-accounts
# → 200 means Go. 401 means No-Go (fix key).
```

### D.2 Temp Key — Post-Revoke Test (Expect 401)

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Bearer $INSTANTLY_TEMP_KEY" \
  https://api.instantly.ai/api/v2/email-accounts
# → 401 means revoke confirmed. 200 means revoke failed — retry.
```

### D.3 Sheet Checks (Helper Formulas)

```text
Lower+trim Email (helper col): =LOWER(TRIM(A2))
Status length (helper col):    =LEN(H2)          // H = Status, expect 0 or ≤200
Port is number check:          =ISNUMBER(E2)     // E = SMTP Port, expect TRUE
Find whitespace-only Status:   =FILTER(A2:H, LEN(H2:H)=1)
Count blanks:                  =COUNTBLANK(H2:H)
Count Added:                   =COUNTIF(H2:H,"Added")
Count Failed:                  =COUNTIF(H2:H,"Failed*")
```

### D.4 n8n Hardening Snippet

```bash
# .env for self-hosted n8n
EXECUTIONS_DATA_PRUNE=true
EXECUTIONS_DATA_MAX_AGE=168
EXECUTIONS_DATA_PRUNE_MAX_COUNT=500
```

```json
// Workflow settings (must include)
{
  "saveDataSuccessExecution": "none",
  "saveDataErrorExecution": "all",
  "executionTimeout": 3600
}
```

### D.5 Single-Row Debug Checklist (Pocket Version)

```text
[ ] Pin 1 item on Node 2 (single Email, Status blank)
[ ] Execute → watch GET → IF → POST → Write-back
[ ] Inspect $json.error + statusCode on failure
[ ] Map to §10 row, fix, unpin, clear Failed to blank, rerun blanks
[ ] Verify Added + blanks=0 + dashboard delta
```

---

## Sign-Off

- [ ] I ran pre-flight §4 fully and recorded Go in Appendix A.
- [ ] I followed SOP §5 exactly (green badges → Execute → 1/N watch → no tab close / no sheet edit → blanks=0 + dashboard).
- [ ] I respected blanks-only idempotency §6 (never cleared Added, never concurrent, used Retry_YYYY-MM-DD / 50–200 tranches as needed).
- [ ] I monitored §7 (Loop in/out, >10% stop gate) and handled rate limits per §9.
- [ ] I know rollback §8 is manual (stop → note last Added → delete by created_at → fix → rerun).
- [ ] I debugged via §11 (pin single item, inspect $json.error) and triaged via §10 matrix.
- [ ] I completed security §12 (bulk-load-YYYY-MM-DD 7-day + revoke + curl-401, viewer-default + vault, saveDataSuccessExecution none + EXECUTIONS_DATA_MAX_AGE + 2FA + 90-day rotation).
- [ ] Run log (Appendix B) is complete and screenshots attached.

```text
Operator: __________   Date (UTC): __________   Signature: __________
Reviewer: __________   Date (UTC): __________   Signature: __________
Next review due: __________ (90 days or next bulk load, whichever first)
```

> End of Runbook. For changes, see ROADMAP.md and open a PR with updated version + changelog.

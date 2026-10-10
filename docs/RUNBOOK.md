# RUNBOOK — n8n-instantly-smtp-bulk-upload

> **Bulk Email Accounts Upload via API in Instantly**
> Manual-trigger → trim-aware gate → sequential loop → GET check + IF skip → POST create → loop back (skip / success / error all converge)
> Audience: Operators, RevOps, Deliverability Engineers
> Environment: n8n (self-hosted or Cloud) + Google Sheets + Instantly.ai v2 API
> Run mode: **Manual, supervised, sequential. No schedule. No concurrency. No sheet writes.**

---

## Document Control

| Field | Value |
|---|---|
| Repo | `n8n-instantly-smtp-bulk-upload` |
| File | `docs/RUNBOOK.md` |
| Version | `2.0.0` |
| Owner | Operations / Deliverability |
| Review cadence | Every bulk load or 90 days |
| Classification | Internal — contains operational secrets handling guidance |
| Related docs | `README.md`, `docs/README.md`, `docs/GUIDE.md` |

---

## Table of Contents

- [1. Purpose and Scope](#1-purpose-and-scope)
- [2. Architecture — 7-Node Workflow](#2-architecture--7-node-workflow)
- [3. Roles and Responsibilities](#3-roles-and-responsibilities)
- [4. Pre-Flight Checklist](#4-pre-flight-checklist)
- [5. Step-by-Step Manual Run SOP](#5-step-by-step-manual-run-sop)
- [6. Reruns and Idempotency (No Cursor)](#6-reruns-and-idempotency-no-cursor)
- [7. Monitoring During Run](#7-monitoring-during-run)
- [8. Rollback — No Single Undo](#8-rollback--no-single-undo)
- [9. Rate-Limit Playbook](#9-rate-limit-playbook)
- [10. Troubleshooting Matrix (8 Rows)](#10-troubleshooting-matrix-8-rows)
- [11. Debug Recipe — Inspect the Execution](#11-debug-recipe--inspect-the-execution)
- [12. Security Operations](#12-security-operations)
- [13. FAQ (8 Questions)](#13-faq-8-questions)
- [Appendix A: Go / No-Go Sign-Off Form](#appendix-a-go--no-go-sign-off-form)
- [Appendix B: Run Log Template](#appendix-b-run-log-template)
- [Appendix C: Quick Command Reference](#appendix-c-quick-command-reference)

---

## 1. Purpose and Scope

### 1.1 Purpose

- [ ] This runbook is the **single authoritative SOP** for executing the bulk upload.
- [ ] It ensures every load is safe, auditable, idempotent, and recoverable.
- [ ] It prevents duplicates, partial runs, credential leaks, and sheet corruption.
- [ ] It defines what to do when Instantly, Google, or n8n fails mid-run.

### 1.2 Scope — In Scope

- [ ] Manual execution of the live 7-node workflow.
- [ ] Google Sheet preparation and trim-aware gating.
- [ ] Sequential loop execution with GET check + IF skip + POST create.
- [ ] Monitoring, rerun, rollback, rate-limit handling, and troubleshooting.
- [ ] Credential hygiene and post-run vaulting.

### 1.3 Scope — Out of Scope

- [ ] Domain warmup strategy, DNS (SPF/DKIM/DMARC), inbox placement.
- [ ] Instantly campaign assignment, sequencing, or unibox routing.
- [ ] Automatic scheduling — this workflow **must remain Manual Trigger only**.
- [ ] Bulk deletion or migration off Instantly.
- [ ] Per-row outcome tracking in the sheet — there is deliberately no
  Status column. Outcomes live in the execution log + dashboard delta.

### 1.4 Principles

| # | Principle | Rule |
|---|---|---|
| P1 | Supervised runs only | Never schedule, never run unattended, never run concurrent copies |
| P2 | Whole-file runs | Every run processes every valid row; skips are automatic |
| P3 | Sequential | Loop `batchSize: 1`, one account at a time |
| P4 | Idempotent rerun | Rerunning re-checks live Instantly state; existing skip, missing create |
| P5 | Execution log is truth | No sheet trail; audit via execution detail + dashboard delta |
| P6 | Least privilege | Temp API key per load, viewer-default sheet, revoke after |
| P7 | No silent halts | Every failure path loops forward; only pre-loop failures stop a run |

---

## 2. Architecture — 7-Node Workflow

### 2.1 High-Level Flow

```text
[1 Manual Trigger]
        |
        v
[2 Google Sheets Read — Accounts tab (read-only)]
        |
        v
[3 Code Gate — Keep Valid Rows (Email trims non-empty)]
        |
        v
[4 Loop — Sequential, batchSize=1 (1/N)]
        |
        v
[5 HTTP GET — Check Account Exists (Instantly v2, 10s, 2 tries)]
        |
        v
[6 IF — Skip if Exists? (200 + email match → skip)]
       / \
    Skip  Create
      |     |
      |     v
      |   [7 HTTP POST — Create Account (30s, 2 tries)]
      |     |  (success AND error both loop back)
      v     v
[4 Loop — next row (all three edges converge here)]
```

### 2.2 7-Node Inventory

| # | Node Name (canonical) | Type | Purpose | Key Config |
|---|---|---|---|---|
| 1 | `Start Manually` | `n8n-nodes-base.manualTrigger` | Human-gated start. No schedule, no webhook. | `executeOnce` |
| 2 | `Get Sheet Rows` | `n8n-nodes-base.googleSheets` | Reads full Accounts tab (11 columns). | Doc ID, tab `Accounts` |
| 3 | `Keep Valid Rows` | `n8n-nodes-base.code` | Trim-aware gate. Drops blank/whitespace-Email rows. | `String(Email).trim() !== ''` |
| 4 | `Loop Each Row` | `n8n-nodes-base.splitInBatches` | Forces sequential processing, enables 1/N progress. | `batchSize: 1`, three back-edges |
| 5 | `Check Exists` | `n8n-nodes-base.httpRequest` | Per-row idempotency check. | `GET …/accounts/{email}`, 10 s, 2 tries, `continueErrorOutput` |
| 6 | `Skip Existing` | `n8n-nodes-base.if` | Branches to skip POST if email already exists. | `{{$json.email}}` notEmpty |
| 7 | `Add Account` | `n8n-nodes-base.httpRequest` | Creates SMTP account in Instantly. | `POST …/accounts`, 12 fields, 30 s, 2 tries, `continueErrorOutput` |

### 2.3 Data Contract

| Column | Required | Notes |
|---|---|---|
| `Email` | Yes | Lowercased + trimmed for API calls. Must be unique. Blank/whitespace rows never enter the loop. |
| `SMTP Username` | Yes | Usually same as Email. |
| `SMTP Password` | Yes | App password. Plaintext in sheet during run only — vault after. |
| `SMTP Host` | Yes | e.g., `mail.spacemail.com`. |
| `SMTP Port` | Yes | Integer `465` or `587`. No `NaN`, no quotes-as-text. |
| `IMAP Host` | Yes | Required for reply sync. |
| `IMAP Port` | Yes | Integer `993` typically. |
| *(no Status column)* | — | Outcomes are NOT recorded. See §7 + §10 for how to audit. |

### 2.4 Expected Node Badges

- [ ] All 7 nodes show **green check** after a test run.
- [ ] No orange warning (missing credential, deprecated version).
- [ ] No red error badge persisting after fix.
- [ ] Google Sheets node shows connected account (OAuth2), not `Select Credential`.
- [ ] HTTP nodes show `Authorization: Bearer ••••••` (header auth, not query param).

---

## 3. Roles and Responsibilities

| Role | Responsible For | Must Attend Run |
|---|---|---|
| Operator | Execute workflow, watch 1/N, log counts, stop on alert | Yes |
| Reviewer | Pre-flight sign-off, verify row count, approve Go | Yes (async OK) |
| Credential Owner | Issue `bulk-load-YYYY-MM-DD` temp key, revoke post-run | Pre + Post |
| Sheet Owner | Freeze sheet, set viewer-default, vault passwords post-run | Pre + Post |
| Deliverability Lead | Approve 500+ row tranches, rollback delete decision | If >200 rows |

---

## 4. Pre-Flight Checklist

> **Do not press Execute until every box is checked. If any box fails, mark No-Go.**

### 4.1 Workflow Hygiene

- [ ] Open n8n → Workflows → `Instantly SMTP Accounts – Bulk Upload`.
- [ ] Verify workflow is **Inactive** (scheduled OFF) — Manual Trigger only.
- [ ] Verify you are on the **saved version** — no unsaved changes banner.
- [ ] Verify 7 nodes present in order: Manual → Read → Gate → Loop → GET → IF → POST.
- [ ] Verify all nodes show green badges / successful last test.
- [ ] Verify Loop node is `batchSize: 1`, sequential, not parallel.
- [ ] Verify Gate node is the Code node (trim-aware), not a Filter.
- [ ] Verify IF node checks lowercase `email` before compare.
- [ ] Verify all three loop-back edges exist (Skip-true, POST success, POST error).
- [ ] Verify no second trigger (no Schedule, no Webhook) was accidentally added.
- [ ] Verify `saveManualExecutions: true` (else failures leave no audit trail).

### 4.2 Credentials and Placeholders

- [ ] HTTP GET node uses live `Authorization: Bearer …` key.
- [ ] HTTP POST node uses **same** temp key — no hardcoded key in JSON body or URL.
- [ ] Google Sheets node uses OAuth2 credential with access to target Sheet ID.
- [ ] Confirm temp key name is `bulk-load-YYYY-MM-DD` (e.g., `bulk-load-2026-09-09`).
- [ ] Confirm temp key expiry is **7-day** max, scoped to accounts read + create.
- [ ] Test temp key with read-only curl (see Appendix C) — expect 200, not 401.

### 4.3 Google Sheet Readiness

- [ ] Tab name is exactly `Accounts` (or tranche tab — see §6).
- [ ] Header row is row 1, frozen, no merged cells — exact 11-column header.
- [ ] `SMTP Port` and `IMAP Port` are **numbers** (Format → Number), not text.
- [ ] No `NaN`, no `#ERROR!`, no formulas in port columns — values only.
- [ ] `Email` column has no leading/trailing spaces, all lowercase (use `=LOWER(TRIM())` to verify).
- [ ] No duplicate emails (case/space-insensitive) — run dedupe check (dupes POST twice; second 400s and skips — harmless but wasteful).
- [ ] Empty trailing rows deleted (gate drops them anyway, but clean sheets run cleaner).
- [ ] Record pre-run counts: Total rows.
- [ ] Sheet sharing is **viewer-default** except Operator = editor during run (editor only needed if you edit mid-prep; the workflow itself only reads).
- [ ] Sheet editing is **frozen** for all other users — announce in Slack/email.

### 4.4 Instantly Account Readiness

- [ ] Instantly workspace has capacity for new accounts (no 402 limit hit).
- [ ] No ongoing Instantly incident (check status page + test single create).
- [ ] Workspace API scope includes `accounts:read` + `accounts:create` (else 403/401).
- [ ] Rate limit headroom confirmed — no other bulk job running concurrently.
- [ ] Dashboard count recorded pre-run (screenshot + number in run log).

### 4.5 n8n Environment Readiness

- [ ] n8n version pinned and healthy, Executions list loads.
- [ ] `EXECUTIONS_DATA_MAX_AGE` is set (e.g., `168` hours / 7 days) to auto-prune PII.
- [ ] Workflow Settings → `saveDataSuccessExecution` = `none`; `saveManualExecutions` = `true`.
- [ ] Only **one** operator tab open — no concurrent runs, no second browser.
- [ ] Laptop on power, stable network, VPN if required for SMTP test.
- [ ] 2FA enabled on n8n account performing the run.
- [ ] Pinned data cleared from prior debug (no stale pin on Loop/HTTP nodes).

### 4.6 Go / No-Go Gate

| Check | Threshold | Go | No-Go |
|---|---|---|---|
| Row count matches intended load | Exact match | Proceed | Investigate |
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

- [ ] Navigate to n8n → Workflows → `Instantly SMTP Accounts – Bulk Upload`.
- [ ] Confirm you are in **Production** (not test canvas copy).
- [ ] Expand all 7 nodes visually — confirm connections are intact.

```text
Checklist:
[ ] Canvas loads without "Workflow could not be loaded" error
[ ] Connections: 1→2→3→4→5→6, 6(true)→4, 6(false)→7, 7(success+error)→4
[ ] No disconnected nodes, no sticky-note TODOs blocking run
```

### 5.2 Step 2 — Verify Green Badges

- [ ] Click each node → Settings → verify credential selected (not `Select...`).
- [ ] Run **Test Step** on Node 2 (Sheets Read) — expect rows returned.
- [ ] Run **Test Step** on Node 3 (Gate) — expect only real-Email rows pass.
- [ ] Inspect Node 5 (GET) test — expect 200 with account JSON (404 handling is normal, see §10).

| Node | Verify | Expected |
|---|---|---|
| 1 Manual Trigger | No config needed | `Execute` button enabled |
| 2 Sheets Read | Doc ID + tab correct | Returns N rows |
| 3 Gate | Trim-aware Code | Valid rows = Email-bearing count |
| 4 Loop 1/N | `batchSize 1` | Shows `1/N` on hover |
| 5 GET Check | Header auth, 200/404 | JSON or clean 404 |
| 6 IF Exists | Expression valid | True/False branches wired to Loop / POST |
| 7 POST Create | JSON body valid | 201 on test single |

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
- Intended rows: __________
- Tranche: e.g., 1/3 (rows 2–101)
```

### 5.4 Step 4 — Watch 1/N Progress

- [ ] Keep n8n tab **focused and open** for entire run.
- [ ] Watch Loop node — it displays `1/N`, `2/N`, ... sequentially.

| What to Watch | Where | Healthy Sign |
|---|---|---|
| Loop counter | Canvas Loop node | Increments 1/N steadily |
| GET → IF branch | Canvas highlight | Mix of skip/create, no stuck spinner |
| POST status | Execution log | 200/201 per create |
| Execution status | Left panel Executions | `Running` (green pulse), not `Error` / `Waiting` |

- [ ] Expected throughput: ~2–5 sec per account (GET + POST).
- [ ] Example: 100 rows ≈ 5–9 minutes. Plan accordingly.
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
| Sorting / filtering sheet | Row-number mapping shifts mid-read |
| Editing a row's email | GET check already ran on old value; POST creates stale address |
| Starting second execution | Two loops POST the same emails; race + duplicates |
| Revoking API key | All remaining calls 401; run skips everything past that point |

- [ ] If accidental edit occurs: **Stop** workflow immediately, note last loop position, follow §8 Rollback.

### 5.6 Step 6 — Verify Dashboard Delta + Execution

- [ ] Wait for Execution status = `Success` (not `Running`).
- [ ] In Instantly → Email Accounts dashboard: refresh, record post-run count.
- [ ] Verify math:

```text
Post-run count - Pre-run count == rows that took the POST path
Skipped rows (GET 200) create nothing — confirm via execution branch counts.
If mismatch, inspect error-branch items in the execution log.
```

- [ ] Screenshot dashboard count + Executions Success page for audit.
- [ ] Fill Appendix B run log: end time, duration, Created, Skipped, Failed-skipped.
- [ ] Mark run log `Complete` or `Complete with failures`.

| Verification | How | Pass Criteria |
|---|---|---|
| Loop completed | Execution `Success`, Loop done-branch fired | No stuck spinner |
| Dashboard delta | Instantly Email Accounts count | Delta == newly created |
| Error-branch review | Execution → Add Account error output items | Each triaged per §10 or accepted as transient |
| Loop in/out | Loop node counts | In == Out |

---

## 6. Reruns and Idempotency (No Cursor)

### 6.1 Core Rule — Just Rerun

- [ ] There is no queue cursor and nothing to reset. Rerunning re-checks
  every row against live Instantly state.
- [ ] Existing accounts skip via GET (zero POSTs). Only genuinely
  missing accounts generate POSTs.
- [ ] Failures from a prior run (bad key, fixed ports, transient
  timeouts) are retried naturally — fix the cause, rerun.
- [ ] Reference behavior: a 40-row rerun after 35 creates + 4 pre-existing
  skips completed with 30 new creates + 10 skips + 0 failures.

### 6.2 Never Concurrent Runs

- [ ] Check n8n → Executions → confirm **no `Running`** before rerun.
- [ ] Only one operator, one tab, one Execute at a time.
- [ ] If prior run is stuck `Running` >30 min with no Loop progress: Stop it, then rerun.

### 6.3 Tranches for 500+ Rows

> Large loads must be split. Never run 500+ rows in one execution.

- [ ] Split into tranches of **50–200 rows** each (separate tabs
  `Load_T1`, `Load_T2`, … each with the exact 11-column header).
- [ ] Point Node 2 at the tranche tab, run, verify, point at next tab.
- [ ] Never concurrent. Pause 2–5 minutes between tranches (§9).
- [ ] Between tranches: check error-branch rate — if >10% in first 20
  rows, **stop** and fix before next tranche (§7).

| Total Rows | Tranche Size | # Runs | Rationale |
|---|---|---|---|
| <100 | Single run | 1 | Low risk, fast verify |
| 100–300 | 100 per run | 1–3 | Balanced throughput + triage |
| 300–500 | 100–150 per run | 3–4 | Rate-limit headroom |
| 500–1000 | 100–200 per run | 5–10 | Avoid timeout, easier rollback |
| 1000+ | 50–100 per run | 10–20 | Operational safety, per-day Instantly caps |

---

## 7. Monitoring During Run

### 7.1 Where to Watch

| Surface | Path | What It Tells You |
|---|---|---|
| Canvas | Workflow → current Execution | Live node highlights, Loop 1/N |
| Executions | n8n left nav → Executions | Status (`Running`/`Success`/`Error`), duration, Execution ID |
| Loop counts | Loop node → output panel | Completed iterations |
| Instantly | Dashboard → Email Accounts | Count incrementing |
| Logs | Execution → node logs | HTTP status per GET/POST, `$json.error` on error-branch items |

### 7.2 What Healthy Looks Like

- [ ] Node 4 Loop **completes** all N items (done-branch fires, Execution `Success`).
- [ ] Mix of skip-branch (fast, no POST) and create-branch items.
- [ ] Dashboard count climbs only for genuinely new accounts.

```text
Example healthy (40 rows):
  GET 200 (skip) x10 → looped back, nothing created
  GET 404 → POST 201 (created) x29
  GET 404 → POST timeout (error-branch skip) x1 → rerun later
```

### 7.3 Alert — Error-Branch Rate > 10% in First 20 Rows

> **Early-warning gate. Prevents burning 500 rows with a systemic misconfig.**

- [ ] After ~20 loop iterations, inspect error-branch items in the execution.
- [ ] If error rate > 10% (≥3 in first 20), **STOP the workflow immediately**.

| Step | Action |
|---|---|
| 1 | Press **Stop** in n8n execution banner |
| 2 | Note Loop position (e.g., `23/100`) |
| 3 | Inspect errors — if all same reason, it's systemic (auth, ports, scope) |
| 4 | Do not continue, do not start next tranche |
| 5 | Fix per §10 matrix, test single row via §11 debug recipe |
| 6 | Rerun (skips handle everything already done) |

- [ ] Common systemic causes tripping the 10% gate: 401 on every POST (key), 400 ports-as-text, 403 scope, Google 403 on read.
- [ ] If failures are heterogeneous (different reasons per row), it's data quality — finish run, triage post-run.
- [ ] Log the stop decision + reason in run log — never silently resume.

### 7.4 Monitoring Checklist (Every Run)

- [ ] Execution ID logged at start.
- [ ] Loop 1/N observed incrementing within first 60 seconds.
- [ ] First error-branch review done by row ~20 (<10% or stopped).
- [ ] No Execution `Error` banner mid-run.
- [ ] Dashboard count moves in step with creates.
- [ ] Final run `Success` verified.
- [ ] Dashboard delta recorded.

---

## 8. Rollback — No Single Undo

> **There is no single Undo button. Rollback is manual: stop → note → delete → fix → rerun.**

### 8.1 When to Rollback

| Scenario | Rollback? | Action |
|---|---|---|
| Wrong Sheet tab loaded (test data uploaded to prod) | Yes | Stop + delete by `created_at` |
| Wrong Instantly workspace key (accounts in wrong workspace) | Yes | Stop + delete from wrong workspace |
| Systemic misconfig caused mass creates with bad SMTP (e.g., wrong host) | Yes | Stop + delete bad batch + fix + rerun |
| Few isolated error-branch skips | No | Fix + rerun (skips + retries automatically) |
| Duplicates created (case/space variant double-POST) | Partial | Delete newer duplicate, keep canonical |

### 8.2 Rollback Procedure (Step-by-Step)

- [ ] **Step 1 — Stop.** Press **Stop**; confirm `Stopped` (not `Running`).
- [ ] **Step 2 — Note position.** Loop position (e.g., `47/200`), timestamp (UTC). Screenshot Sheet + Execution log.
- [ ] **Step 3 — Delete by created_at in Instantly.** Sort Email Accounts by **Created At descending**; filter to `created_at` >= run start; delete only the bad batch (newest first). Safety check per batch: `created_at >= run start` AND email in this run's rows → delete; either false → skip.
- [ ] **Step 4 — Fix.** Root cause in Sheet (ports, host, credentials) or n8n (key, scope).
- [ ] **Step 5 — Rerun.** Execute per §5 SOP; verify dashboard delta. Log rollback + rerun as linked entries.

### 8.3 Rollback — What NOT to Do

- [ ] Do not delete Instantly accounts without `created_at` filter — risks deleting prod senders.
- [ ] Do not rerun before delete completes — creates duplicates.
- [ ] Do not rollback for error-branch skips that never created anything — nothing to delete.

---

## 9. Rate-Limit Playbook

### 9.1 Why Sequential Already Helps

- [ ] Loop `batchSize: 1` sends one GET + (optionally) one POST at a time.
- [ ] No parallel branches, no batch POST — gentle sequential traffic.

### 9.2 Signals You Are Rate-Limited

| Signal | Where | Meaning |
|---|---|---|
| `429 Too Many Requests` | POST/GET node log, `$json.error` | Instantly throttling |
| `Retry-After` header | HTTP response headers | Seconds to wait before retry |
| Sudden mass error-branch `429` | Execution log | Systemic throttle, not data issue |

### 9.3 Immediate Response (If 429 Appears)

- [ ] **Do not** hammer rerun — 429 + immediate rerun = longer ban.
- [ ] **Stop** the workflow if 429 rate >10% in first 20 (per §7 gate).
- [ ] Note `Retry-After` value; wait **at least** `Retry-After` + 60 seconds buffer (min 5 min without header).
- [ ] Reduce tranche to ≤50 and rerun.

### 9.4 Preventive Pacing

- [ ] Run 50–200 tranches with **2–5 minute pauses** between tranches.
- [ ] Never run two bulk loads (or campaign sends) concurrently against same workspace.
- [ ] Schedule loads off-peak (avoid top-of-hour automation bursts).

### 9.5 429 vs 402 vs 403 — Don't Confuse

| Code | Meaning | Retry Helps? | Action |
|---|---|---|---|
| 429 | Too many requests (throttle) | Yes, after wait | Pause + smaller tranche + rerun |
| 402 | Quota / billing limit | No | Upgrade plan or delete unused accounts |
| 403 | Forbidden / scope | No | Fix API scope, not pacing |

---

## 10. Troubleshooting Matrix (8 Rows)

> Failures skip forward into the next iteration — nothing is written
> to the sheet. Full error lives in Execution log → failed item → `$json.error`.
> Fix the cause, rerun. Skips + retries happen automatically.

| # | Symptom | Likely Cause | Fix (Operator Action) |
|---|---|---|---|
| 1 | `401` on both GET + POST (mass error-branch) | Temp key wrong, expired, revoked mid-run, or `Bearer` prefix missing | 1. Stop run. 2. Verify header is `Authorization: Bearer <key>`. 3. Issue new `bulk-load-YYYY-MM-DD` key, test with curl (expect 200). 4. Update Header Auth on both nodes. Rerun. |
| 2 | `402 Payment Required` | Instantly workspace at account limit / billing cap | 1. Stop run. 2. Check Billing / Usage. 3. Upgrade plan or archive unused accounts. Do not pace/retry — retry cannot fix 402. Rerun after capacity freed. |
| 3 | `403 Forbidden / scope` | API key lacks `accounts:read`/`accounts:create` (or wrong workspace / IP allowlist) | 1. Stop run. 2. Verify key scope. 3. Confirm correct workspace. 4. Re-issue key. Single-row test (§11), then rerun. |
| 4 | `429 Too Many Requests` | Rate-limited — concurrent job or burst | 1. Stop if >10% in first 20. 2. Wait `Retry-After` + 60 s (min 5 min). 3. Confirm no concurrent runs. 4. Reduce tranche to ≤50. See §9. |
| 5 | `400` invalid port / `NaN` (`SMTP Port` / `IMAP Port` as text, formula error, or empty) | Sheets formatting issue | 1. Format → Number for both port columns. 2. Replace `NaN`, `#ERROR!`, blanks with `465`/`587` (SMTP), `993` (IMAP). 3. Rerun (rows re-check automatically). |
| 6 | `Timeout ECONNABORTED` on POST | Mailbox verification slower than timeout (production case: 10 s limit hit on a real mailbox) | 1. Confirm POST timeout is 30 s (not 10 s). 2. Rerun — GET resolves ambiguity (skip if it landed, recreate if not). 3. If it recurs on many rows, suspect provider slowness, not the workflow. |
| 7 | `404 on Check` (GET returns 404) — **Expected, not an error** | Check endpoint returns 404 when account does not yet exist (normal for new emails) | No fix. If IF misroutes 404s (no POST fires), fix IF expression, rerun. |
| 8 | Google `403` / Sheets read fails (Execution `Error` before loop) | Google OAuth expired, sheet sharing revoked, tab renamed mid-run, or quota exceeded | 1. Re-auth Google Sheets credential. 2. Confirm access + tab name (`Accounts` exact). 3. Check Google API quota. Rerun. |

### 10.1 Notes on Reading the Matrix

- [ ] Same-reason mass failure = systemic (key, scope, ports, quota) → Stop + fix + rerun.
- [ ] Mixed reasons = data quality → finish run, triage row-by-row, rerun.
- [ ] 404-on-Check is the **only** row where “error” means success-path — do not “fix” it.
- [ ] Timeouts are ambiguous by nature — rerun, don't assume created-or-not.

---

## 11. Debug Recipe — Inspect the Execution

> Failures live only in the execution. Never debug from the sheet — it contains no outcome data.

### 11.1 Open the Failed Item

- [ ] n8n → Executions → open the run → find the error-branch item (Add Account error output, or the halted node).
- [ ] Expand output JSON → `$json.error` → `message`, `statusCode`/`status`, `response.body`.

| Field to Inspect | Example | Meaning |
|---|---|---|
| `statusCode` / `status` | `401`, `402`, `403`, `429`, `400` | Maps to §10 matrix row |
| `$json.error.message` | `"timeout of 10000ms exceeded"`, `"Account not found"` | Root cause string |
| `request.body.email` | `"Debug-One@..."` | Verify lowercase/trim applied |

- [ ] Check **both** GET and POST logs — 401 on one node only means credential mismatch between nodes.

```text
Debug checklist:
[ ] GET status? 200 (exists → skip) / 404 (new → POST, expected) / 401 (key bad) / 403 (scope)
[ ] IF branch taken? True=skip, False=create
[ ] POST status? 201 (created) / 400 (ports/body) / 401/403/402/429 (per matrix) / timeout (rerun resolves)
[ ] Loop completed? done-branch fired, Execution Success
```

### 11.2 Fix and Rerun

- [ ] Fix root cause in Sheet or credential (per matrix row).
- [ ] Rerun full workflow per §5 (skips + retries automatic — nothing to reset).
- [ ] Verify dashboard delta.

- [ ] Forbidden:

- [ ] Do not paste real SMTP passwords into Slack/tickets — use vault references.
- [ ] Do not commit debug JSON with secrets to git.

---

## 12. Security Operations

### 12.1 Threat Model — Plaintext Passwords

| Threat | Where | Impact | Control (This Runbook) |
|---|---|---|---|
| SMTP passwords in Sheet plaintext | Google Sheet password columns | Sheet share = credential leak | Viewer-default sharing, editor-only during run, vault + clear post-run |
| API key in workflow JSON / logs | n8n HTTP nodes, Execution logs | Key exfiltrated via export, screenshot, or log retention | Header auth (never commit), `saveDataSuccessExecution: none`, `EXECUTIONS_DATA_MAX_AGE` prune |
| Long-lived key reuse | n8n credential store | Stale key abused after load | Temp per-load `bulk-load-YYYY-MM-DD` 7-day key + revoke + curl-401 test |
| Accidental git commit of secrets | Repo, workflow export | Shared history contains secrets | Never-commit list (§12.2), placeholders, pre-commit scan |
| Concurrent operator overwrites | Sheet + n8n | Duplicate creates | Single operator, frozen sheet, no concurrent runs |
| Log retention PII | n8n Executions history | Passwords persist in execution data | Disable success data save, short max age, manual prune |

- [ ] Assume Sheet + Execution logs contain secrets during run — treat both as sensitive.
- [ ] Assume any exported `workflows/*.json` will be shared — it must contain placeholders only.

### 12.2 Never-Commit List

> **These must never appear in git, PRs, issues, or chat logs.**

- [ ] Real Instantly API keys (live or expired).
- [ ] Real Google Sheet IDs / Doc URLs with ID.
- [ ] Real SMTP / IMAP passwords, app passwords, OAuth refresh tokens.
- [ ] Real mailbox addresses in bulk (use `user@example.com` in docs/tests).
- [ ] Exported workflow JSON containing embedded credentials or session tokens.
- [ ] Screenshots showing full API key, password column, or Bearer token.
- [ ] Execution logs with `$json` containing passwords.
- [ ] `.env` files, `credentials.json`, `service-account.json`.

- [ ] Pre-commit check (run before every commit):

```bash
# Fail if real secrets patterns are staged (placeholders SHOULD appear in repo JSON)
git diff --cached --name-only | xargs grep -En "sk-live|Bearer [A-Za-z0-9+/=]{20,}" || true
```

- [ ] If scan finds real key: **stop commit**, rotate key immediately, purge history per §12.6.

### 12.3 Temp Per-Load Keys — bulk-load-YYYY-MM-DD, 7-Day + Revoke + curl-401 Test

- [ ] For **every** bulk load, issue a dedicated temp key:

```text
Name:   bulk-load-YYYY-MM-DD   (e.g., bulk-load-2026-09-09)
Scope:  accounts:read + accounts:create (minimum necessary)
Expiry: 7 days max (earlier if load completes sooner)
Owner:  Credential Owner (not shared personal key)
```

- [ ] Procedure: Create (Instantly → API) → paste into both HTTP nodes → test read-only curl (expect 200) → run → revoke same day → curl-401 test (expect 401) → log both results.

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Bearer $INSTANTLY_TEMP_KEY" \
  https://api.instantly.ai/api/v2/accounts?limit=1
# Pre-run expected: 200. Post-revoke expected: 401.
```

- [ ] Never reuse a `bulk-load-*` key for a second date — issue fresh per load.

### 12.4 Sheet Hygiene — Viewer-Default + Vault Post-Run

- [ ] Before run: sharing = **Viewer** default for all except Operator + Sheet Owner.
- [ ] After run (within 24h): vault `SMTP/IMAP Password` values, verify 5 samples, clear cells (or `vault:ref:<id>`), revert sharing.

### 12.5 n8n Hardening — saveDataSuccessExecution none + EXECUTIONS_DATA_MAX_AGE + 2FA + 90-Day Rotation

- [ ] Workflow Settings → `saveDataSuccessExecution: none`, `saveManualExecutions: true` (auditability requires saved runs), `saveDataErrorExecution: all`.

```bash
# n8n self-hosted .env / docker-compose
EXECUTIONS_DATA_MAX_AGE=168
EXECUTIONS_DATA_PRUNE=true
EXECUTIONS_DATA_PRUNE_MAX_COUNT=500
```

- [ ] 2FA required for all n8n users with execute + credential access.
- [ ] 90-day rotation for Google OAuth + long-lived credentials (temp Instantly keys already per-load).

### 12.6 Leak Incident Steps

> If a real key, password, or sheet ID is committed, screenshotted, or shared externally:

- [ ] **Step 1 — Contain (minutes).** Revoke leaked key; remove external share; stop any running load using it.
- [ ] **Step 2 — Rotate (hours).** Issue new temp key; rotate Google OAuth if sheet link was public; force SMTP password resets if passwords leaked.
- [ ] **Step 3 — Purge (hours–days).** Remove secret from git history; prune n8n executions containing it; check chat/tickets/CI logs.
- [ ] **Step 4 — Verify.** curl-401 on revoked key; grep repo (0 hits); dashboard `created_at` window check.
- [ ] **Step 5 — Post-mortem.** Incident note + guardrail (pre-commit hook / CODEOWNERS on `workflows/`).

---

## 13. FAQ (8 Questions)

### Q1 — How do I rerun after fixing something? Is there anything to reset?

**Nothing to reset — just rerun.** Every run re-checks all rows against live Instantly state. Existing skip, missing create, fixed rows retry naturally. There is no cursor column and no FAILED list to clear.

### Q2 — Can I run two executions at once to go faster?

**No. Never concurrent.** Two loops POST the same emails — races and duplicates. Parallelism comes from smaller tranches run **serially**. Before every Execute: confirm no `Running` for this workflow.

### Q3 — GET returns 404 — is that a failure? Should I stop?

**No. 404-on-Check is expected and healthy.** It means “not exists → proceed to POST.” Only stop if 404 is followed by no POST (IF wiring broken) or mass POST failures (systemic issue — see matrix).

### Q4 — How large a sheet can I run at once? What about 500+ rows?

**Split 500+ rows into 50–200 tranches, run serially** (separate tabs, repoint Node 2 per tranche). Between tranches check the error-branch rate and pause 2–5 min.

### Q5 — A row error-branched. What exactly do I do?

Open the execution → failed item → `$json.error` → map to §10 matrix → fix the cause (data, key, scope, quota) → rerun. Leave transient timeouts to the rerun (GET resolves ambiguity).

### Q6 — The run shows Success but the dashboard barely moved. Did it work?

**Probably yes — most rows skipped as already-existing.** Confirm via execution branch counts (skip-branch items vs POST items). Success + zero POSTs on an unchanged sheet is the correct no-op. If POSTs fired but the count didn't move, inspect error-branch items.

### Q7 — How do I handle SMTP passwords securely? Can they stay in the Sheet?

**No. Vault + clear within 24h post-run** (copy to vault, verify 5, clear cells, revert sharing). See §12.4.

### Q8 — Do I need a new API key every time? What about rotation?

**Yes — temp per-load key, 7-day expiry, revoke + curl-401 test every load.** Plus 90-day rotation for Google OAuth / long-lived credentials, 2FA everywhere.

---

## Appendix A: Go / No-Go Sign-Off Form

```text
Load Name: __________   Date (UTC): __________   Operator: __________   Reviewer: __________
Sheet ID (last 6): __________   Tab: Accounts / Load_T<N>: __________   Tranche: __/__
Temp Key: bulk-load-YYYY-MM-DD: __________   Expiry: __________

Pre-run counts:
  Total rows: __________   Valid-Email rows: __________
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

Pre:  Total rows ___   Dashboard pre ___
Post: Dashboard post ___  delta ___  (expect delta == newly created)
Loop: completed [ ] Yes  Iterations ___ == rows in [ ] Yes
Branch counts: Skipped (GET 200) ___  Created (POST 2xx) ___  Error-branch skips ___
Error-branch triage (email → error → matrix row):
  1. __________ → __________ → Row __
  2. __________ → __________ → Row __

First-20 error rate: ___%  Gate action: [ ] continue  [ ] stopped per §7.3
429 count: ___  Retry-After observed: ___  Wait applied: ___
Pre-run curl: ___ (expect 200)   Post-revoke curl: ___ (expect 401)   Revoked (UTC): ___
Dashboard screenshots: [ ] pre  [ ] post   Execution: [ ] Success
Passwords vaulted: [ ] Yes  Path: __________  Sheet cleared: [ ] Yes  Sharing reverted: [ ] Yes
Status: [ ] Complete  [ ] Complete with error-skips (rerun scheduled)
Notes: __________
Reviewer sign-off: __________
```

---

## Appendix C: Quick Command Reference

### C.1 Temp Key — Pre-Run Test (Expect 200)

```bash
INSTANTLY_TEMP_KEY="YOUR_INSTANTLY_API_KEY"
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Bearer $INSTANTLY_TEMP_KEY" \
  "https://api.instantly.ai/api/v2/accounts?limit=1"
# → 200 means Go. 401 means No-Go (fix key).
```

### C.2 Temp Key — Post-Revoke Test (Expect 401)

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Bearer $INSTANTLY_TEMP_KEY" \
  "https://api.instantly.ai/api/v2/accounts?limit=1"
# → 401 means revoke confirmed. 200 means revoke failed — retry.
```

### C.3 Sheet Checks (Helper Formulas)

```text
Lower+trim Email (helper col): =LOWER(TRIM(A2))
Port is number check:          =ISNUMBER(G2)      // G = IMAP Port, expect TRUE
                               =ISNUMBER(K2)      // K = SMTP Port, expect TRUE
Find whitespace-only Email:    =FILTER(A2:A, LEN(TRIM(A2:A))=0)
Count rows:                    =COUNTA(A2:A)
```

### C.4 n8n Hardening Snippet

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
  "saveManualExecutions": true
}
```

### C.5 Single-Row Debug Checklist (Pocket Version)

```text
[ ] Temp single-row tab (1 Email) or filter sheet to 1 row
[ ] Execute → watch GET → IF → POST
[ ] Inspect $json.error + statusCode on error-branch item
[ ] Map to §10 row, fix, rerun full sheet
[ ] Verify dashboard delta
```

---

## Sign-Off

- [ ] I ran pre-flight §4 fully and recorded Go in Appendix A.
- [ ] I followed SOP §5 exactly (green badges → Execute → 1/N watch → no tab close / no sheet edit → dashboard delta + execution review).
- [ ] I respected idempotency §6 (never concurrent, tranches serial).
- [ ] I monitored §7 (loop completion, >10% stop gate) and handled rate limits per §9.
- [ ] I know rollback §8 is manual (stop → note position → delete by created_at → fix → rerun).
- [ ] I debugged via §11 (execution item inspection) and triaged via §10 matrix.
- [ ] I completed security §12 (bulk-load-YYYY-MM-DD 7-day + revoke + curl-401, viewer-default + vault, hardening settings + 2FA + 90-day rotation).
- [ ] Run log (Appendix B) is complete and screenshots attached.

```text
Operator: __________   Date (UTC): __________   Signature: __________
Reviewer: __________   Date (UTC): __________   Signature: __________
Next review due: __________ (90 days or next bulk load, whichever first)
```

> End of Runbook. For workflow changes, open a PR with updated version + reviewer sign-off.

# 02 — Workflow Deep Dive

## Connection table

`Start Manually`->`Get Sheet Rows`->`Keep Blanks Only`->`Loop Each Row` (`loop`->`Check Exists`, `done` ends). `Check Exists` success->`Skip Existing`, error (404)->`Add Account`. `Skip Existing` true->`Update Status`, false->`Add Account`. `Add Account` success+error->`Update Status`. `Update Status`->`Loop Each Row`.

## Nodes

### 1. Start Manually (`n8n-nodes-base.manualTrigger@1`)

Manual SOP entry. No schedule. Prevents accidental bulk reruns. Note: Initiates the bulk email account upload process. Execute manually to process all sheet rows with blank Status.

### 2. Get Sheet Rows (`n8n-nodes-base.googleSheets@4.7`)

`resource: sheet`, `operation: read`, `documentId`/`sheetName` via list mode (`YOUR_GOOGLE_SHEET_ID`). Emits 1 item per row. Note: Retrieves all rows from the SMTP Bulk Upload sheet. Requires valid Google credentials and document access.

### 3. Keep Blanks Only (`n8n-nodes-base.filter@2.3`)

Condition `{{ $json.Status }}` is empty. Reruns exclude completed. Note: Filters to rows where Status is empty for processing. Previously completed rows are excluded from reruns.

### 4. Loop Each Row (`n8n-nodes-base.splitInBatches@3`)

`batchSize: 1`, sequential pacing for rate safety. Loop-back from `Update Status`. Note: Processes sheet rows sequentially one at a time. Ensures reliable API pacing and accurate status tracking.

### 5. Check Exists (`n8n-nodes-base.httpRequest@4.5`)

`GET https://api.instantly.ai/api/v2/accounts/{{ $json.Email }}` with `Authorization` header, timeout 30000, `retryOnFail: true, maxTries: 3, wait: 2000`, `onError: continueErrorOutput`. 200 = exists, 404 error = new. Note: Verifies account existence in Instantly via lookup. Determines whether creation or skip is required.

### 6. Skip Existing (`n8n-nodes-base.if@2.3`)

Condition `{{ $json.email }}` (lowercase API field) is notEmpty. True = skip, false = create. Do not confuse with sheet `Email`. Note: Routes existing accounts to status update without duplication. New addresses proceed to account creation.

### 7. Add Account (`n8n-nodes-base.httpRequest@4.5`)

`POST https://api.instantly.ai/api/v2/accounts`, body via `JSON.stringify` from `$('Loop Each Row').item.json`: `email` trim+lower, `first_name`/`last_name` trim, `provider_code: 1`, IMAP/SMTP user/host trim, passwords no trim, ports `Number()`. Same retry/error as Check. Note: Creates a custom SMTP account in Instantly via v2 API. Maps sheet fields dynamically with provider code 1.

### 8. Update Status (`n8n-nodes-base.googleSheets@4.7`)

`operation: appendOrUpdate`, `matchingColumns: [Email]`, `Email: {{ $('Loop Each Row').item.json.Email }}`, `Status: {{ $json.error ? 'Failed - ...' : 'Added' }}` sliced to 200 chars. Full 12-col schema present. Note: Records the processing outcome back to the Status column. Matches on Email and continues to the next row.

## Data shapes

Sheet row (`Email`, `First Name`...) vs API response (`email`, `timestamp_created`...) vs error (`$json.error`). Preserve identity via `$('Loop Each Row').item.json`.

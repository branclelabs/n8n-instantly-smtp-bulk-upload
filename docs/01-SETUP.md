# 01 — Setup Guide

## Prerequisites

- n8n >= 1.x with `manualTrigger@1`, `googleSheets@4.7`, `filter@2.3`, `splitInBatches@3`, `httpRequest@4.5`, `if@2.3`
- Google account + Google Sheets OAuth2 credential with edit access
- Instantly workspace (paid) + V2 key with `accounts:read` + `accounts:create`
- Outbound HTTPS to `https://api.instantly.ai`

## Google Sheet schema

Exact header row (case-sensitive):

`Email | First Name | Last Name | IMAP Username | IMAP Password | IMAP Host | IMAP Port | SMTP Username | SMTP Password | SMTP Host | SMTP Port | Status`

Rules: row 1 frozen, `Status` blank for new rows, `Email` unique lowercase-trimmed, ports numeric, passwords preserve case (no trim). Copy [`examples/sheets-schema.csv`](../examples/sheets-schema.csv).

## Credentials

1. n8n > Credentials > Google Sheets OAuth2, authorize owner/editor of the sheet. Attach to both `Get Sheet Rows` and `Update Status`.
2. Instantly > Settings > API Keys > Create V2 key. In both `Check Exists` and `Add Account`, set header `Authorization: Bearer YOUR_INSTANTLY_API_KEY`. Prefer a Header Auth credential over hardcoding for production.
3. Share the sheet with the OAuth identity.

## Import workflow

Workflows > Import from File > `workflows/instantly-smtp-accounts-bulk-upload.json` > Save. Re-link Google credential, reselect Document/Sheet via list mode, replace both API headers, confirm `active: false`, `executionOrder: v1`.

## Smoke test

Add 2 rows (one new, one duplicate), Execute, expect `Added` for both paths (existing routes via skip), no red nodes. See `04-OPERATIONS.md`.

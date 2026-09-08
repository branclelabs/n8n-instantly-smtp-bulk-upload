# 03 — Instantly v2 API Reference (Uploader Subset)

## Base + auth

`https://api.instantly.ai/api/v2/accounts`, header `Authorization: Bearer <KEY>`, `Content-Type: application/json`. Scopes: `accounts:read` + `accounts:create`. Paid plan or `402`.

## GET check-exists

`GET /api/v2/accounts/{email-lowercased-trimmed}`. 200 + object = exists -> skip. 404 = new -> POST. 401 = bad key, 429 = rate limit.

## POST create — 12 fields

`email` (email, lower), `first_name`, `last_name`, `provider_code: 1` (Custom IMAP/SMTP integer), `imap_username`, `imap_password`, `imap_host`, `imap_port` (int), `smtp_username`, `smtp_password`, `smtp_host`, `smtp_port` (int). `additionalProperties: false` — no extras. See [`examples/sample-payload-post-accounts.json`](../examples/sample-payload-post-accounts.json).

Example cURL in README quickstart pattern; ports must be numbers (`993`/`587`), `provider_code` integer `1` not `"1"`.

## Limits

Shared workspace `100 req/s + 6000 req/min` -> `429`. Sequential `batchSize: 1` + 30s timeout + 3x/2s retry is the throttle. Add Wait 2–5s if 429 persists.

## Errors to Status

`400` validation, `401` key, `402` plan, `404` on GET = expected new, `409` duplicate race -> treat as skip, `422` type, `429` backoff, `5xx` retry then `Failed - ...`.

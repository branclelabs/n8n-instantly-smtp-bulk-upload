# 06 — Security Guide

## Threat model

Sheet holds plaintext IMAP/SMTP passwords. Workflow JSON can leak Sheet IDs, URLs, credential IDs, instance IDs. Executions store row data (`saveData*: all`). API key grants account write.

## Rules

- Never commit real keys, passwords, OAuth JSON, Sheet IDs/URLs, mailbox lists. Export only with `YOUR_INSTANTLY_API_KEY` / `YOUR_GOOGLE_SHEET_ID`.
- Secrets only in n8n Credentials or local `.env` (see `.env.example`).
- Run `npm run sanitize` + `npm run check:secrets` before every commit.
- Node 7 passwords must come from `$json` (sheet), never literals.

## Temp keys & revoke

Issue short-lived Instantly key per bulk load (`bulk-load-YYYY-MM-DD`, 7 days, read+write only), duplicate Header credential, point both HTTP nodes at it, delete + revoke after `Added` verified. Test revoke: `curl` old key must 401.

## Hygiene

Share sheet viewer-by-default, editor only during load. Clear password columns or vault the sheet post-run. Harden n8n: `saveDataSuccessExecution: none`, prune executions (`EXECUTIONS_DATA_MAX_AGE=168`), 2FA, separate keys per env rotated every 90 days. If leaked: revoke in 5 min, rotate mailbox passwords in 15 min, remove shares, new key + smoke test 1 row, post-mortem.

# n8n-instantly-smtp-bulk-upload

> Bulk-create custom SMTP accounts in Instantly API v2 from Google Sheets — skip-if-exists, skip-on-failure, zero sheet writes.

[![n8n](https://img.shields.io/badge/n8n-compatible-EA4B71?logo=n8n&logoColor=white)](https://n8n.io) [![Instantly v2](https://img.shields.io/badge/Instantly-API%20v2-blue)](https://developer.instantly.ai) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## What is this?

A production n8n workflow that reads SMTP account rows from Google Sheets
and bulk-creates them as custom accounts in Instantly. It checks each
account with a per-row lookup, skips accounts that already exist, skips
rows that fail without halting the run, and never writes back to the
sheet — the sheet is read-only input. Verification happens via the
Instantly dashboard count plus the n8n execution log.

Full documentation lives in `docs/` — this README is only a pointer:

- [docs/README.md](docs/README.md) — overview, features, and repository layout
- [docs/GUIDE.md](docs/GUIDE.md) — sheet setup, credentials, and field reference
- [docs/RUNBOOK.md](docs/RUNBOOK.md) — run, verify, retry, and operate in production

## Quickstart

1. Copy CSV headers from `docs/GUIDE.md` into row 1 of your Google Sheet
   (11 columns — there is no `Status` column).
2. In n8n, import `workflows/instantly-smtp-accounts-bulk-upload.json`.
3. Connect credentials: Google Sheets OAuth2; paste the Instantly API key
   into the `Authorization` header of both HTTP nodes.
4. Click Execute, then verify via Instantly → Accounts (dashboard count
   delta) and the n8n execution (created / skipped / failed counts).

> Do not commit real keys or sheet IDs — all credentials and IDs in this repo are placeholders.

## Repository layout

- `workflows/` — canonical n8n workflow JSON (import this)
- `docs/` — full guides and runbook (track the live workflow)

## Contributing

Please open an issue first to discuss changes, and never include secrets in PRs.

## License

MIT — see [LICENSE](LICENSE) for details.

# n8n-instantly-smtp-bulk-upload

> Bulk-create custom SMTP accounts in Instantly API v2 from Google Sheets, with skip-if-exists and status write-back.

[![n8n](https://img.shields.io/badge/n8n-compatible-EA4B71?logo=n8n&logoColor=white)](https://n8n.io) [![Instantly v2](https://img.shields.io/badge/Instantly-API%20v2-blue)](https://developer.instantly.ai) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## What is this?

Import-ready n8n workflow that reads SMTP account rows from Google Sheets and bulk-creates them as custom accounts in Instantly.
It skips accounts that already exist and writes back `Added` / `Failed` status to the sheet.

Full documentation lives in `docs/` — this README is only a pointer:

- [docs/README.md](docs/README.md) — overview, features, and repository layout
- [docs/GUIDE.md](docs/GUIDE.md) — sheet setup, credentials, and field reference
- [docs/RUNBOOK.md](docs/RUNBOOK.md) — run, verify, retry, and operate in production

## Quickstart

1. Copy CSV headers from `docs/GUIDE.md` into row 1 of your Google Sheet.
2. In n8n, import `workflows/instantly-smtp-accounts-bulk-upload.json`.
3. Connect credentials: Google Sheets OAuth2 and Instantly generic header auth.
4. Replace placeholders `YOUR_INSTANTLY_API_KEY` in the Bearer header and `YOUR_GOOGLE_SHEET_ID` in Sheet nodes.
5. Click Execute, then verify new rows show `Added` in the status column.

> Do not commit real keys or sheet IDs — all credentials and IDs in this repo are placeholders.

## Repository layout

- `workflows/` — import-ready n8n workflow JSON
- `docs/` — full guides and runbook

## Contributing

Please open an issue first to discuss changes, and never include secrets in PRs.

## License

MIT — see [LICENSE](LICENSE) for details.

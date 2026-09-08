# Changelog

All notable changes documented here. Format based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), adheres to [SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-09-08

### Added

- Initial sanitized release of `Instantly SMTP Accounts – Bulk Upload` n8n workflow (8 nodes).
- Google Sheets ingestion (blank `Status` only) -> Instantly v2 bulk upload -> `Added` / `Failed` write-back.
- Sanitization (`npm run sanitize`), validation (Ajv + structure), secrets scan.
- Governance: MIT, Contributing, Security, Code of Conduct, `.env.example`.

### Security

- Removed real `GOOGLE_SHEET_ID`, GID, OAuth credential IDs, Instantly key.
- Hardened settings: `saveDataSuccessExecution: none`, `saveManualExecutions: false`.
- Documented secrets handling for keys and SMTP passwords.

[Unreleased]: https://github.com/example/n8n-instantly-smtp-bulk-upload/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/example/n8n-instantly-smtp-bulk-upload/releases/tag/v1.0.0

# Contributing to n8n-instantly-smtp-bulk-upload

Thanks for contributing. This repo contains a sanitized n8n workflow for bulk SMTP account upload to Instantly via API. Read this fully before opening a PR.

## Code of Conduct

By participating you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).

## Getting Started

1. Fork the repo, then clone your fork:
   ```bash
   git clone https://github.com/<you>/n8n-instantly-smtp-bulk-upload.git
   cd n8n-instantly-smtp-bulk-upload
   npm install
   cp .env.example .env
   ```
2. Create a feature branch from `main`:
   ```bash
   git checkout -b feat/<short-scope>
   ```
   Prefixes: `feat/*`, `fix/*`, `docs/*`, `chore/*`, `security/*`.
3. Fill `.env` locally only. Never commit `.env`.

## Conventional Commits (required)

```text
<type>[optional scope]: <short imperative description>
```

Allowed `type`: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `security`, `revert`.

Examples:
```text
feat(instantly): add exponential backoff on 429
fix(sheets): map blank Status rows only
docs(readme): document GID configuration
chore(sanitize): strip sheet IDs from export
```

## Workflow Edit Rules

1. Edit in n8n, export JSON to `workflows/` (LF, 2-space indent).
2. Remove before commit: `credentials`, real `documentId`, Sheet URLs, `gid`, emails, `pinData`, tokens, `id`/`versionId`/`meta.instanceId`.
3. Use placeholders: `YOUR_GOOGLE_SHEET_ID`, `YOUR_SHEET_NAME`, `Bearer YOUR_INSTANTLY_API_KEY`.
4. Keep node `name`, `type`, `typeVersion` stable. Do not reorder gratuitously.
5. Harden `settings`: `saveDataSuccessExecution: none`, `saveManualExecutions: false`, `executionTimeout: 300`.
6. Mandatory checks:
   ```bash
   npm run sanitize
   npm run validate
   npm run check:secrets
   npm run format
   ```

## Pull Request Process

1. Push `feat/*` to your fork, open PR against `main` with Conventional Commits title.
2. CI must pass: `validate`, `check:secrets`, `prettier --check`.
3. Request review. Maintainer squash-merges. Never push directly to `main`.

## No Secrets Policy

NEVER commit: `INSTANTLY_API_KEY`, SMTP passwords, OAuth secrets, service-account JSON, real Sheet IDs/URLs, customer email lists. If leaked: rotate at source, open a `security/*` PR, notify per `SECURITY.md`.

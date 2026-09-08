# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 1.x     | ✅ |
| < 1.0   | ❌ |

## Reporting a Vulnerability

**Do not open a public issue for vulnerabilities.**

- Preferred: GitHub > Security > Report a vulnerability.
- Fallback: email `security@example.com` with subject `[n8n-instantly-smtp-bulk-upload] <summary>`.
- Include: affected file/commit, n8n version, redacted repro, impact.
- Acknowledgement within 72 hours, triage within 7 days.

### 90-Day Disclosure Policy

We aim to ship a fix within 90 days. We coordinate public disclosure after release. Do not disclose or exfiltrate beyond what is necessary to demonstrate the issue.

## Secrets Policy

Never commit or paste in issues/logs:

- `INSTANTLY_API_KEY` / Bearer tokens
- SMTP/IMAP usernames, passwords, App Passwords
- Google OAuth tokens, service-account JSON, credential IDs
- Real `GOOGLE_SHEET_ID`, GID URLs, mailbox lists, CSVs with PII

Rules:

1. Secrets only in n8n Credentials or local untracked `.env` (see `.env.example`).
2. Run before every commit:
   ```bash
   npm run sanitize
   npm run check:secrets
   ```
3. `workflows/*.json` must contain only `YOUR_INSTANTLY_API_KEY` / `YOUR_GOOGLE_SHEET_ID`.
4. If leaked: rotate at source, revoke sessions, open private report, purge history with `git filter-repo`.

## Hardening Guidance

```json
{
  "saveDataErrorExecution": "all",
  "saveDataSuccessExecution": "none",
  "saveManualExecutions": false,
  "executionTimeout": 300,
  "timezone": "UTC"
}
```

- Pin `N8N_VERSION`, test upgrades in staging.
- `EXECUTIONS_DATA_PRUNE=true`, `EXECUTIONS_DATA_MAX_AGE=168` on self-hosted.
- Restrict Sheet sharing to least privilege, rotate Instantly keys every 90 days.

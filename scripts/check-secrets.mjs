#!/usr/bin/env node
/** check-secrets.mjs — fail on real Bearer keys, Sheet IDs, cached URLs, credentials, instanceIds. */
import fs from 'node:fs';
import path from 'node:path';
const CHECKS = [
  { id: 'bearer', re: /Bearer\s+(?!YOUR_INSTANTLY_API_KEY\b)[A-Za-z0-9_\-~.+/=]{10,}/g },
  { id: 'sheet-id', re: /\b1[A-Za-z0-9_-]{43}\b/g },
  { id: 'docs-url', re: /https:\/\/docs\.google\.com\/spreadsheets\/d\//g },
  { id: 'cachedUrl', re: /cachedResultUrl/g },
  { id: 'cachedName', re: /cachedResultName/g },
  { id: 'credentials', re: /"credentials"\s*:\s*\{[^}]*"(id|name)"\s*:/g },
  { id: 'instanceId', re: /"instanceId"\s*:\s*"[a-f0-9]{16,}"/g },
];
const SKIP = new Set(['.git', 'node_modules', 'dist']);
function list(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP.has(e.name)) list(f, out); }
    else if (/\.(json|md|csv|mjs|js|yml|yaml)$/.test(e.name)) out.push(f);
  }
  return out;
}
const root = process.cwd();
const files = list(root);
let findings = [];
for (const f of files) {
  const rel = f.replace(/\\/g, '/');
  if (rel.includes('scripts/')) continue;
  const txt = fs.readFileSync(f, 'utf8');
  txt.split('\n').forEach((line, i) => {
    for (const c of CHECKS) {
      c.re.lastIndex = 0;
      if (c.re.test(line)) findings.push(`${path.relative(root, f)}:${i + 1} [${c.id}]`);
    }
  });
}
if (findings.length) { console.error(`FAIL: ${findings.length} secrets`); findings.forEach(f => console.error(` - ${f}`)); process.exit(1); }
console.log(`PASS: no secrets in ${files.length} files.`);

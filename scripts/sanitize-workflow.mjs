#!/usr/bin/env node
/**
 * sanitize-workflow.mjs
 * Strips credentials, real Sheet IDs/URLs, Bearer keys, instance IDs.
 * Usage: node scripts/sanitize-workflow.mjs [--in <path>] [--out <path>] [--check]
 */
import fs from 'node:fs';
import path from 'node:path';

const PLACEHOLDER_KEY = 'Bearer YOUR_INSTANTLY_API_KEY';
const PLACEHOLDER_DOC = 'YOUR_GOOGLE_SHEET_ID';
const PLACEHOLDER_SHEET = 'YOUR_SHEET_NAME';
const PLACEHOLDER_URL = 'https://docs.google.com/spreadsheets/d/YOUR_GOOGLE_SHEET_ID/edit';
const SHEET_ID_RE = /\b1[A-Za-z0-9_-]{43}\b/g;
const DOCS_URL_RE = /https:\/\/docs\.google\.com\/spreadsheets\/d\/[A-Za-z0-9_-]+[^\s"'`\\]*/g;
const BEARER_REAL_RE = /Bearer\s+(?!YOUR_INSTANTLY_API_KEY\b)[A-Za-z0-9_\-~.+/=]{10,}/g;
const INSTANCE_ID_RE = /\b[a-f0-9]{64}\b/g;

function parseArgs(argv) {
  const args = { in: null, out: null, check: false, help: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') args.check = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--in' && argv[i + 1]) args.in = argv[++i];
    else if (a === '--out' && argv[i + 1]) args.out = argv[++i];
    else if (!a.startsWith('--') && !args.in) args.in = a;
    else if (!a.startsWith('--') && !args.out) args.out = a;
  }
  return args;
}
function defaultPath() {
  const c = [path.resolve(process.cwd(), 'workflows/instantly-smtp-accounts-bulk-upload.json'), path.resolve(process.cwd(), 'Instantly SMTP Accounts – Bulk Upload.json')];
  for (const p of c) if (fs.existsSync(p)) return p;
  return c[0];
}
function sanitize(workflow) {
  const issues = [];
  const data = JSON.parse(JSON.stringify(workflow));
  if (data.id !== undefined) { delete data.id; issues.push('stripped workflow id'); }
  if (data.versionId !== undefined) { delete data.versionId; issues.push('stripped versionId'); }
  if (data.meta?.instanceId) { delete data.meta.instanceId; issues.push('stripped instanceId'); }
  for (const node of data.nodes || []) {
    const where = `node "${node.name}"`;
    if (node.credentials) { delete node.credentials; issues.push(`${where}: stripped credentials`); }
    const p = node.parameters || {};
    if (p.documentId && typeof p.documentId === 'object') {
      const hadCache = ('cachedResultName' in p.documentId) || ('cachedResultUrl' in p.documentId);
      delete p.documentId.cachedResultName; delete p.documentId.cachedResultUrl;
      if (hadCache) issues.push(`${where}: stripped cached sheet reference`);
      if (p.documentId.value !== PLACEHOLDER_DOC) { p.documentId.value = PLACEHOLDER_DOC; p.documentId.mode = 'list'; issues.push(`${where}: placeholder Sheet ID`); }
    }
    if (p.sheetName && typeof p.sheetName === 'object') {
      delete p.sheetName.cachedResultName; delete p.sheetName.cachedResultUrl;
      if (p.sheetName.value !== PLACEHOLDER_SHEET) { p.sheetName.value = PLACEHOLDER_SHEET; p.sheetName.mode = 'list'; }
    }
    for (const h of p.headerParameters?.parameters || []) {
      if (/bearer/i.test(h.name || '') && h.value !== PLACEHOLDER_KEY) { h.value = PLACEHOLDER_KEY; issues.push(`${where}: placeholder Bearer key`); }
    }
  }
  const walk = (v, where) => {
    if (typeof v === 'string') {
      let o = v;
      if (DOCS_URL_RE.test(o)) { o = o.replace(DOCS_URL_RE, PLACEHOLDER_URL); issues.push(`${where}: replaced docs URL`); }
      DOCS_URL_RE.lastIndex = 0;
      if (SHEET_ID_RE.test(o)) { o = o.replace(SHEET_ID_RE, PLACEHOLDER_DOC); issues.push(`${where}: replaced Sheet ID`); }
      SHEET_ID_RE.lastIndex = 0;
      if (BEARER_REAL_RE.test(o)) { o = o.replace(BEARER_REAL_RE, PLACEHOLDER_KEY); issues.push(`${where}: replaced Bearer key`); }
      BEARER_REAL_RE.lastIndex = 0;
      return o;
    }
    if (Array.isArray(v)) return v.map((x, i) => walk(x, `${where}[${i}]`));
    if (v && typeof v === 'object') {
      delete v.cachedResultUrl; delete v.cachedResultName;
      for (const [k, val] of Object.entries(v)) {
        if (k === 'instanceId' && typeof val === 'string') { delete v[k]; issues.push(`${where}: stripped instanceId`); }
        else v[k] = walk(val, `${where}.${k}`);
      }
      return v;
    }
    return v;
  };
  walk(data, 'workflow');
  return { data, issues: [...new Set(issues)] };
}
const args = parseArgs(process.argv);
const inPath = path.resolve(args.in || defaultPath());
const outPath = path.resolve(args.out || args.in || defaultPath());
if (!fs.existsSync(inPath)) { console.error(`Not found: ${inPath}`); process.exit(1); }
const wf = JSON.parse(fs.readFileSync(inPath, 'utf8'));
const { data, issues } = sanitize(wf);
if (args.check) {
  if (issues.length) { console.error(`FAIL: ${issues.length} issue(s)`); issues.forEach(i => console.error(` - ${i}`)); process.exit(1); }
  console.log('PASS: workflow sanitized.');
} else {
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2) + '\n');
  console.log(`Sanitized -> ${outPath} (${issues.length} changes)`);
  issues.forEach(i => console.log(` - ${i}`));
}

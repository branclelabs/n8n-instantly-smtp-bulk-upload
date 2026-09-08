#!/usr/bin/env node
/**
 * validate-workflow.mjs — 8 nodes, typeVersions, loop-back, no secrets.
 * Usage: node scripts/validate-workflow.mjs [--in <path>] [--check]
 */
import fs from 'node:fs';
import path from 'node:path';
const PLACEHOLDER_KEY = 'Bearer YOUR_INSTANTLY_API_KEY';
const EXPECTED = {
  'Start Manually': { type: 'n8n-nodes-base.manualTrigger', typeVersion: 1 },
  'Get Sheet Rows': { type: 'n8n-nodes-base.googleSheets', typeVersion: 4.7 },
  'Keep Blanks Only': { type: 'n8n-nodes-base.filter', typeVersion: 2.3 },
  'Loop Each Row': { type: 'n8n-nodes-base.splitInBatches', typeVersion: 3 },
  'Check Exists': { type: 'n8n-nodes-base.httpRequest', typeVersion: 4.5 },
  'Skip Existing': { type: 'n8n-nodes-base.if', typeVersion: 2.3 },
  'Add Account': { type: 'n8n-nodes-base.httpRequest', typeVersion: 4.5 },
  'Update Status': { type: 'n8n-nodes-base.googleSheets', typeVersion: 4.7 },
};
const BEARER_REAL_RE = /Bearer\s+(?!YOUR_INSTANTLY_API_KEY\b)[A-Za-z0-9_\-~.+/=]{10,}/;
const SHEET_ID_RE = /\b1[A-Za-z0-9_-]{43}\b/;
const arg = process.argv.includes('--in') ? process.argv[process.argv.indexOf('--in') + 1] : null;
const inPath = path.resolve(arg || 'workflows/instantly-smtp-accounts-bulk-upload.json');
const raw = fs.readFileSync(inPath, 'utf8');
const wf = JSON.parse(raw);
const errors = [];
const byName = new Map((wf.nodes || []).map(n => [n.name, n]));
if ((wf.nodes || []).length !== 8) errors.push(`expected 8 nodes, found ${(wf.nodes || []).length}`);
for (const [name, exp] of Object.entries(EXPECTED)) {
  const n = byName.get(name);
  if (!n) errors.push(`missing node "${name}"`);
  else {
    if (n.type !== exp.type) errors.push(`"${name}" type ${n.type} != ${exp.type}`);
    if (Number(n.typeVersion) !== exp.typeVersion) errors.push(`"${name}" version ${n.typeVersion} != ${exp.typeVersion}`);
  }
}
const hasEdge = (s, t) => (wf.connections?.[s]?.main || []).flat().some(c => c?.node === t);
for (const [f, t] of [['Start Manually', 'Get Sheet Rows'], ['Get Sheet Rows', 'Keep Blanks Only'], ['Keep Blanks Only', 'Loop Each Row'], ['Loop Each Row', 'Check Exists'], ['Check Exists', 'Skip Existing'], ['Add Account', 'Update Status'], ['Update Status', 'Loop Each Row']]) {
  if (!hasEdge(f, t)) errors.push(`missing edge ${f} -> ${t}`);
}
if (!hasEdge('Skip Existing', 'Update Status')) errors.push('missing Skip Existing -> Update Status');
if (!hasEdge('Skip Existing', 'Add Account')) errors.push('missing Skip Existing -> Add Account');
for (const n of wf.nodes || []) if (n.credentials && Object.keys(n.credentials).length) errors.push(`"${n.name}" has credentials`);
if (raw.includes('cachedResultUrl') || raw.includes('cachedResultName')) errors.push('cachedResult leftovers');
if (raw.includes('docs.google.com')) errors.push('docs.google.com URL present');
if (SHEET_ID_RE.test(raw)) errors.push('raw Sheet ID present');
if (wf?.meta?.instanceId) errors.push('meta.instanceId present');
if (BEARER_REAL_RE.test(raw)) errors.push('real Bearer key present');
const body = byName.get('Add Account')?.parameters?.jsonBody || '';
if (!body.includes('provider_code') || !/provider_code:\s*1\b/.test(body)) errors.push('Add Account provider_code must be numeric 1');
if (!body.includes('imap_port') || !body.includes('smtp_port') || !/Number\(/.test(body)) errors.push('Add Account ports must use Number()');
if (errors.length) { console.error(`FAIL: ${errors.length}`); errors.forEach(e => console.error(` - ${e}`)); process.exit(1); }
console.log('PASS: 8 nodes, versions, loop-back, no secrets.');

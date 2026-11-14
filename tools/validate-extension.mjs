#!/usr/bin/env node
/**
 * Aegis Ad Blocker — static validation harness.
 *
 * Chrome silently ignores invalid static rules in packed extensions, so we
 * refuse to pack an extension that would lose rules at install time.
 *
 * Checks:
 *   1. manifest.json — schema sanity, referenced files exist, permissions sane
 *   2. DNR rulesets — id/priority uniqueness & ranges, action types, condition
 *      keys, urlFilter grammar, RE2-compilable regexFilter (via re2js), domain
 *      validation, resourceTypes enum, allowAllRequests preconditions
 *   3. Extension pages — no inline scripts/styles/handlers (MV3 CSP)
 *   4. Scriptlets bundle — parses as JS, contains engine markers
 *
 * Usage: node tools/validate-extension.mjs
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { RE2JS } = require('re2js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'extension');

let failures = 0;
let checks = 0;
const fail = (msg) => { failures++; console.error('  ✗ ' + msg); };
const ok = (msg) => { checks++; if (process.env.VERBOSE) console.log('  ✓ ' + msg); };

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (e) { fail(`invalid JSON: ${path.relative(ROOT, file)} — ${e.message}`); return null; }
}

/* ---------------------------------------------------------- 1. manifest */
console.log('\n[1/4] manifest.json');
const manifestPath = path.join(EXT, 'manifest.json');
const manifest = readJson(manifestPath);
if (!manifest) process.exit(1);

const needKeys = ['manifest_version', 'name', 'version', 'description', 'permissions', 'background', 'content_scripts', 'declarative_net_request'];
for (const key of needKeys) {
  if (!(key in manifest)) fail(`manifest missing key: ${key}`);
}
if (manifest.manifest_version !== 3) fail('manifest_version must be 3');
if (!/^\d+\.\d+\.\d+$/.test(manifest.version || '')) fail('version must be semver-ish');

for (const iconPath of Object.values(manifest.icons || {})) {
  if (!existsSync(path.join(EXT, iconPath))) fail(`missing icon: ${iconPath}`);
}
for (const p of Object.values(manifest.action?.default_icon || {})) {
  if (!existsSync(path.join(EXT, p))) fail(`missing action icon: ${p}`);
}
if (manifest.action?.default_popup && !existsSync(path.join(EXT, manifest.action.default_popup))) fail('missing popup');
if (manifest.options_page && !existsSync(path.join(EXT, manifest.options_page))) fail('missing options page');
if (!existsSync(path.join(EXT, manifest.background?.service_worker || ''))) fail('missing service worker');
for (const cs of manifest.content_scripts || []) {
  for (const js of cs.js || []) {
    if (!existsSync(path.join(EXT, js))) fail(`missing content script: ${js}`);
  }
}
if (!(manifest.permissions || []).includes('declarativeNetRequest')) fail('permission declarativeNetRequest required');
const hostPerms = manifest.host_permissions || [];
if (hostPerms.some((h) => h === '<all_urls>' || h === '*://*/*')) {
  fail('host_permissions <all_urls> would trigger scary warnings; keep updates host-scoped or drop');
}
ok('manifest structure OK');

/* ---------------------------------------------------- 2. DNR rulesets */
console.log('\n[2/4] declarativeNetRequest rulesets');
const VALID_ACTIONS = new Set(['block', 'allow', 'allowAllRequests', 'upgradeScheme', 'redirect', 'modifyHeaders']);
const VALID_TYPES = new Set(['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'webtransport', 'webbundle', 'other']);
const VALID_DOMAIN_TYPES = new Set(['firstParty', 'thirdParty']);
const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;
const URLFILTER_FORBIDDEN = /[\x00-\x20]/;

let totalRules = 0;
let totalRegex = 0;
for (const res of manifest.declarative_net_request.rule_resources || []) {
  if (!res.id || !res.path) { fail('rule_resource missing id/path'); continue; }
  const file = path.join(EXT, res.path);
  if (!existsSync(file)) { fail(`missing ruleset: ${res.path}`); continue; }
  const sizeMB = (statSync(file).size / 1048576).toFixed(1);
  const rules = readJson(file);
  if (!Array.isArray(rules)) { fail(`${res.path}: not a JSON array`); continue; }
  const ids = new Set();
  let regexCount = 0;
  for (const [i, rule] of rules.entries()) {
    const where = `${res.id} rule #${i}`;
    if (!Number.isInteger(rule.id) || rule.id < 1) fail(`${where}: bad id`);
    if (ids.has(rule.id)) fail(`${where}: duplicate id ${rule.id}`);
    ids.add(rule.id);
    if (!Number.isInteger(rule.priority) || rule.priority < 1) fail(`${where}: bad priority`);
    if (!rule.action || !VALID_ACTIONS.has(rule.action.type)) fail(`${where}: bad action ${rule.action?.type}`);
    const c = rule.condition;
    if (!c || typeof c !== 'object') { fail(`${where}: missing condition`); continue; }
    const hasUrl = typeof c.urlFilter === 'string';
    const hasRegex = typeof c.regexFilter !== 'string' ? false : c.regexFilter.length > 0;
    if (!hasUrl && !hasRegex) fail(`${where}: condition needs urlFilter or regexFilter`);
    if (hasUrl && hasRegex) fail(`${where}: cannot have both urlFilter and regexFilter`);
    if (hasUrl) {
      if (URLFILTER_FORBIDDEN.test(c.urlFilter)) fail(`${where}: urlFilter has whitespace/control chars: ${JSON.stringify(c.urlFilter)}`);
      const pipes = (c.urlFilter.match(/\|/g) || []).length;
      const domainAnchor = c.urlFilter.startsWith('||');
      if (domainAnchor && pipes > 2) fail(`${where}: bad domain anchor`);
      if (!domainAnchor && pipes > ((c.urlFilter.startsWith('|') ? 1 : 0) + (c.urlFilter.endsWith('|') ? 1 : 0))) fail(`${where}: pipe in middle`);
      if (c.urlFilter.length > 512) fail(`${where}: urlFilter too long`);
    }
    if (hasRegex) {
      regexCount++;
      try { RE2JS.compile(c.regexFilter); }
      catch (e) { fail(`${where}: regexFilter not RE2-compatible: ${e.message}`); }
    }
    if (c.domainType && !VALID_DOMAIN_TYPES.has(c.domainType)) fail(`${where}: bad domainType`);
    for (const key of ['domains', 'excludedDomains', 'initiatorDomains', 'requestDomains', 'excludedRequestDomains']) {
      if (c[key] !== undefined) {
        if (!Array.isArray(c[key])) { fail(`${where}: ${key} must be an array`); continue; }
        for (const d of c[key]) {
          if (typeof d !== 'string' || !DOMAIN_RE.test(d) || d.length > 253) fail(`${where}: invalid domain in ${key}: ${JSON.stringify(d)}`);
        }
      }
    }
    if (c.resourceTypes !== undefined) {
      if (!Array.isArray(c.resourceTypes) || c.resourceTypes.length === 0) fail(`${where}: resourceTypes empty`);
      for (const t of c.resourceTypes || []) if (!VALID_TYPES.has(t)) fail(`${where}: bad resourceType ${t}`);
      if (rule.action.type === 'allowAllRequests') {
        const okKinds = c.resourceTypes.every((t) => t === 'main_frame' || t === 'sub_frame');
        if (!okKinds) fail(`${where}: allowAllRequests requires main_frame/sub_frame resourceTypes`);
      }
    } else if (rule.action.type === 'allowAllRequests') {
      fail(`${where}: allowAllRequests requires resourceTypes`);
    }
    if (failures > 40) { console.error('\nToo many failures — aborting ruleset validation.'); process.exit(1); }
  }
  totalRules += rules.length;
  totalRegex += regexCount;
  console.log(`  • ${res.id}: ${rules.length.toLocaleString()} rules (${regexCount} regex, ${sizeMB} MB)`);
  ok(`${res.path}`);
}
if (totalRegex > 1000) fail(`total regex rules ${totalRegex} exceeds Chrome's 1000-rule regex budget`);
console.log(`  Total static rules: ${totalRules.toLocaleString()} (guaranteed budget: 30,000 — overflow is managed at runtime via getAvailableStaticRuleCount())`);

/* --------------------------------------------- 3. MV3 page CSP hygiene */
console.log('\n[3/4] extension pages — no inline code');
const htmlFiles = [];
(function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.html')) htmlFiles.push(full);
  }
})(EXT);
for (const file of htmlFiles) {
  const html = readFileSync(file, 'utf8');
  const rel = path.relative(ROOT, file);
  if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(html)) fail(`${rel}: inline <script> block (MV3 CSP forbids)`);
  if (/<style[\s>]/i.test(html)) fail(`${rel}: inline <style> block (MV3 CSP forbids)`);
  if (/\son(error|load|click|change|input|submit|focus|mouseover)\s*=/i.test(html)) fail(`${rel}: inline event handler attribute`);
}
ok('pages are inline-free');

/* ------------------------------------- 4. scriptlets bundle smoke check */
console.log('\n[4/4] generated scriptlets bundle');
const scriptletsPath = path.join(EXT, 'content', 'scriptlets-main.js');
if (!existsSync(scriptletsPath)) fail('missing generated content/scriptlets-main.js — run `npm run build`');
else {
  const js = readFileSync(scriptletsPath, 'utf8');
  for (const marker of ['AUTO-GENERATED', 'LISTS', 'runAll', 'set-cookie', 'abort-on-property-read']) {
    if (!js.includes(marker)) fail(`scriptlets-main.js missing marker: ${marker}`);
  }
  // balance check — parse with node to be sure it is valid JS
  try { new Function(js); ok('scriptlets-main.js parses'); }
  catch (e) { fail(`scriptlets-main.js syntax error: ${e.message}`); }
}

console.log('');
if (failures) {
  console.error(`VALIDATION FAILED — ${failures} problem(s) found.\n`);
  process.exit(1);
} else {
  console.log(`Validation passed (all checks green).\n`);
}

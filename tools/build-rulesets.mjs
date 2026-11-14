#!/usr/bin/env node
/**
 * Aegis Ad Blocker — build step.
 *
 * Reads the bundled EasyList / EasyPrivacy / Fanboy's Annoyance lists from
 * filters/*.txt, compiles them with extension/shared/filter-compiler.mjs and writes:
 *
 *   extension/rulesets/<name>.json          DNR static rulesets (manifest "rule_resources")
 *   extension/resources/<name>.cosmetic.json  element-hiding data per list
 *   extension/resources/scriptlets.js       generated MAIN-world scriptlet engine + rules
 *   build/report.json                       compilation statistics (gitignored)
 *
 * Usage: node tools/build-rulesets.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  compileFilters,
  buildCosmeticIndex,
} from '../extension/shared/filter-compiler.mjs';

// re2js is a pure-JS RE2 implementation — used ONLY to prove every regexFilter
// we emit is compilable by Chrome's RE2 engine before the ruleset is packed.
const require = createRequire(import.meta.url);
let RE2JS = null;
try { ({ RE2JS } = require('re2js')); } catch { console.warn('re2js not installed; skipping deep regex validation (npm install)'); }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILTERS = path.join(ROOT, 'filters');
const OUT_RULESETS = path.join(ROOT, 'extension', 'rulesets');
const OUT_RES = path.join(ROOT, 'extension', 'resources');
const OUT_REPORT = path.join(ROOT, 'build');

mkdirSync(OUT_RULESETS, { recursive: true });
mkdirSync(OUT_RES, { recursive: true });
mkdirSync(OUT_REPORT, { recursive: true });

const LISTS = [
  { id: 'easylist', file: 'easylist.txt' },
  { id: 'easyprivacy', file: 'easyprivacy.txt' },
  { id: 'fanboy_annoyance', file: 'fanboy-annoyance.txt' },
];

// Deterministic snapshot date — rebuilding from the same inputs yields byte-identical artifacts.
let SNAPSHOT = 'unknown';
try { SNAPSHOT = readFileSync(path.join(FILTERS, 'SNAPSHOT.txt'), 'utf8').trim() || 'unknown'; } catch { /* keep unknown */ }
const report = { generatedAt: SNAPSHOT, lists: {}, totals: {} };
const scriptletBundles = {};
const cosmeticBundles = {};
const maxStaticRulesPerList = 100000; // Chrome's guaranteed floor is 30k enabled rules; count is reported and handled at runtime

for (const { id, file } of LISTS) {
  const text = readFileSync(path.join(FILTERS, file), 'utf8');
  console.log(`\n=== Compiling ${id} (${(text.length / 1024).toFixed(0)} KiB) ===`);
  const compiled = compileFilters(text, { startId: 1, maxRules: maxStaticRulesPerList });
  const { networkRules: rawNetworkRules, stats } = compiled;
  const networkRules = rawNetworkRules;

  // Deep-validate regexFilter rules against RE2 before shipping the ruleset.
  let droppedRegex = 0;
  const validated = networkRules.filter((rule) => {
    if (!rule.condition.regexFilter) return true;
    if (!RE2JS) return true;
    try { RE2JS.compile(rule.condition.regexFilter); return true; }
    catch { droppedRegex++; return false; }
  });
  if (droppedRegex) console.log(`  dropped ${droppedRegex} RE2-incompatible regex rules at validation`);

  const dnrPath = path.join(OUT_RULESETS, `${id}.json`);
  validated.forEach((r, i) => { r.id = i + 1; });
  writeFileSync(dnrPath, JSON.stringify(validated));
  const cosmetic = buildCosmeticIndex(compiled);
  writeFileSync(path.join(OUT_RES, `${id}.cosmetic.json`), JSON.stringify(cosmetic));
  cosmeticBundles[id] = cosmetic;
  scriptletBundles[id] = compiled.scriptlets;

  const s = stats;
  console.log(`  network: ${validated.length} DNR rules (block ${s.networkBlock}, allow ${s.networkAllow}, allowAll ${s.allowAllRequests}, redirect-as-block ${s.redirectAsBlock})`);
  console.log(`  cosmetic: ${s.cosmeticGeneric} generic + ${s.cosmeticSpecific} specific selectors, ${s.cosmeticExceptions} exceptions, ${s.cosmeticSkippedProcedural} procedural skipped, ${s.cosmeticSkippedInvalid} invalid skipped`);
  console.log(`  scriptlets: ${s.scriptlets} rules (${s.scriptletUnmatch} unmatch), regex skipped: ${s.regexSkipped}`);
  console.log(`  skipped detail:`, s.skipped);

  report.lists[id] = {
    inputBytes: text.length,
    dnrRules: validated.length,
    cosmetic: {
      generic: s.cosmeticGeneric,
      specific: s.cosmeticSpecific,
      exceptions: s.cosmeticExceptions,
      skippedProcedural: s.cosmeticSkippedProcedural,
      skippedInvalid: s.cosmeticSkippedInvalid,
      perDomainCount: Object.keys(cosmetic.perDomain).length,
    },
    scriptlets: compiled.scriptlets.length,
    stats: s,
  };
}

// Total static rule count across enabled rulesets (Chrome guarantees >= 30,000)
const totalDnr = Object.values(report.lists).reduce((a, l) => a + l.dnrRules, 0);
report.totals = { dnrRules: totalDnr };
console.log(`\nTOTAL DNR rules across all lists: ${totalDnr} (Chrome guaranteed minimum: 30000)`);
if (totalDnr > 30000) {
  console.warn('WARNING: exceeds the 30,000 guaranteed static-rule budget. Disable the');
  console.warn('fanboy_annoyance ruleset by default or trim lists before publishing.');
}

// ------- Generate MAIN-world scriptlet engine + rules bundle -------
const engineHeader = `/* AUTO-GENERATED by tools/build-rulesets.mjs — do not edit.
 * MAIN-world scriptlet runner injected at document_start.
 * Implements the most common uBO/ABP anti-adblock & cookie-consent scriptlets.
 */
'use strict';
(() => {
  const LISTS = `;
const footer = `;
  const isEnabled = (listId) => !window.__AEGIS__ || !window.__AEGIS__.enabledLists || window.__AEGIS__.enabledLists[listId] !== false;
  const disabled = () =>
    (document.documentElement && document.documentElement.getAttribute('data-aegis-disabled') === '1') ||
    (window.__AEGIS__ && window.__AEGIS__.disabled === true);

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const d = event.data;
    if (d && d.source === 'aegis' && d.type === 'settings') {
      window.__AEGIS__ = { disabled: d.enabled === false, enabledLists: d.lists || {} };
    }
  });

  function domainMatches(list, hostname) {
    hostname = hostname.toLowerCase();
    const parts = hostname.split('.');
    const candidates = [];
    for (let i = 0; i < parts.length; i++) {
      const d = parts.slice(i).join('.');
      if (d.includes('.')) candidates.push(d);
      else if (parts.length === 1) candidates.push(d);
    }
    const inc = list.include || [];
    const exc = list.exclude || [];
    let target = inc.length === 0;
    for (const d of inc) if (candidates.includes(d)) { target = true; break; }
    if (!target) return false;
    for (const d of exc) if (candidates.includes(d)) return false;
    return true;
  }

  function resolveCookies(name) {
    return document.cookie.split(';').map((c) => c.trim()).filter(Boolean)
      .map((c) => { const i = c.indexOf('='); return { name: decodeURIComponent(c.slice(0, i)), value: c.slice(i + 1) }; })
      .filter((c) => !name || c.name === name);
  }
  function setCookie(name, value, days) {
    try {
      const maxAge = (days && Number(days) > 0 ? Number(days) : 365) * 86400;
      let str = encodeURIComponent(name) + '=' + encodeURIComponent(value == null ? '' : value) + ';path=/;max-age=' + maxAge + ';SameSite=Lax';
      if (location.protocol === 'https:') str += ';Secure';
      document.cookie = str;
    } catch (_) { /* ignore */ }
  }
  function deleteCookie(name) {
    try { document.cookie = encodeURIComponent(name) + '=;path=/;max-age=0'; } catch (_) { /* ignore */ }
  }

  function removeCookiesMatching(pattern) {
    let predicate = () => true;
    if (pattern) {
      const asRegex = pattern.length > 2 && pattern.startsWith('/') && pattern.endsWith('/');
      if (asRegex) {
        let re = null;
        try { re = new RegExp(pattern.slice(1, -1)); } catch (_) { re = null; }
        predicate = (n) => (re ? re.test(n) : false);
      } else predicate = (n) => n === pattern;
    }
    for (const c of resolveCookies()) if (predicate(c.name)) deleteCookie(c.name);
  }

  const IMMEDIATE = new Set(['set-constant', 'set', 'abort-on-property-read', 'set-local-storage-item', 'set-session-storage-item', 'set-cookie', 'trusted-set-cookie']);

  const handlers = {
    'set-constant': (args) => {
      const target = args[0];
      const value = parseConstantValue(args[1]);
      defineWindowProperty(target, value);
    },
    set: (args) => handlers['set-constant'](args),
    'set-local-storage-item': (args) => { try { if (String(args[1]) === '$remove$') localStorage.removeItem(String(args[0])); else localStorage.setItem(String(args[0]), String(args[1] ?? '')); } catch (_) {} },
    'set-session-storage-item': (args) => { try { if (String(args[1]) === '$remove$') sessionStorage.removeItem(String(args[0])); else sessionStorage.setItem(String(args[0]), String(args[1] ?? '')); } catch (_) {} },
    'set-cookie': (args) => setCookie(String(args[0]), args[1] == null ? '' : String(args[1]), args[2]),
    'trusted-set-cookie': (args) => setCookie(String(args[0]), args[1] == null ? '' : String(args[1]), args[2]),
    'remove-cookie': (args) => removeCookiesMatching(args[0] ? String(args[0]) : undefined),
    'cookie-remover': (args) => removeCookiesMatching(args[0] ? String(args[0]) : undefined),
    'abort-on-property-read': (args) => {
      const target = String(args[0] || '');
      if (!target) return;
      const chain = target.split('.');
      const prop = chain.pop();
      let obj = window;
      for (const part of chain) { if (obj && typeof obj === 'object') obj = obj[part]; else { obj = null; break; } }
      if (!obj) return;
      try {
        Object.defineProperty(obj, prop, {
          configurable: true,
          set() { /* silently swallow writes */ },
          get() { throw new ReferenceError('[aegis] blocked access to ' + target); },
        });
      } catch (_) { /* ignore */ }
    },
    'abort-on-property-write': (args) => {
      const target = String(args[0] || '');
      if (!target) return;
      const chain = target.split('.');
      const prop = chain.pop();
      let obj = window;
      for (const part of chain) { if (obj && typeof obj === 'object') obj = obj[part]; else { obj = null; break; } }
      if (!obj) return;
      try {
        Object.defineProperty(obj, prop, {
          configurable: true,
          get() { return undefined; },
          set() { throw new ReferenceError('[aegis] blocked write to ' + target); },
        });
      } catch (_) { /* ignore */ }
    },
    'json-prune': (args) => {
      const removals = args.map(String).filter(Boolean);
      if (!removals.length) return;
      const origParse = JSON.parse;
      const prune = (node, depth) => {
        if (!node || typeof node !== 'object' || depth > 8) return;
        for (const key of Object.keys(node)) {
          if (removals.includes(key)) { try { delete node[key]; } catch (_) {} }
          else prune(node[key], depth + 1);
        }
      };
      JSON.parse = function (text, reviver) {
        const result = origParse.call(this, text, reviver);
        try { prune(result, 0); } catch (_) {}
        return result;
      };
    },
    'remove-class': (args) => {
      const cls = String(args[0] || '');
      if (!cls) return;
      const purge = () => { try { for (const el of document.querySelectorAll('.' + CSS.escape(cls))) el.classList.remove(cls); } catch (_) {} };
      if (document.readyState !== 'loading') purge();
      else document.addEventListener('DOMContentLoaded', purge, { once: true });
    },
  };

  function parseConstantValue(v) {
    if (v === undefined) return true;
    const s = String(v);
    if (s === 'undefined') return undefined;
    if (s === 'null') return null;
    if (s === 'true') return true;
    if (s === 'false') return false;
    if (s === 'emptyObj') return {};
    if (s === 'emptyArr') return [];
    const n = Number(s);
    if (!Number.isNaN(n) && s.trim() !== '') return n;
    // strip surrounding quotes if any
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
    return s;
  }

  function defineWindowProperty(target, value, depth) {
    depth = depth || 0;
    if (!target) return;
    const chain = String(target).split('.');
    const prop = chain.pop();
    let obj = window;
    for (const part of chain) {
      if (obj == null || (typeof obj !== 'object' && typeof obj !== 'function')) return;
      obj = obj[part];
      if (obj == null && depth < 4) {
        // create intermediate namespace so the set sticks
        try { obj = {}; } catch (_) { return; }
      }
    }
    if (!obj) return;
    try {
      Object.defineProperty(obj, prop, {
        configurable: true,
        get() { return value; },
        set() { /* swallow */ },
      });
    } catch (_) { /* ignore */ }
  }

  function runAll() {
    if (disabled()) return;
    const hostname = location.hostname;
    const executed = new Set();
    for (const listEntry of LISTS) {
      if (!isEnabled(listEntry.id)) continue;
      for (const rule of listEntry.rules) {
        if (!domainMatches(rule, hostname)) continue;
        const handler = handlers[rule.name];
        if (!handler) continue;
        const key = rule.name + JSON.stringify(rule.args);
        if (executed.has(key)) continue;
        executed.add(key);
        try { handler(rule.args); } catch (_) { /* ignore */ }
      }
    }
  }

  runAll();
})();
`;

const listEntries = Object.entries(scriptletBundles).map(([id, rules]) => ({
  id,
  rules: rules.map((r) => ({ include: r.include, exclude: r.exclude, name: r.name, args: r.args })),
}));
const scriptletJs = engineHeader + JSON.stringify(listEntries) + '\n' + footer;
writeFileSync(path.join(ROOT, 'extension', 'content', 'scriptlets-main.js'), scriptletJs);
console.log(`\nscriptlets-main.js: ${(scriptletJs.length / 1024).toFixed(0)} KiB, ${listEntries.reduce((a, l) => a + l.rules.length, 0)} rules`);

writeFileSync(path.join(ROOT, 'extension', 'resources', 'build-meta.json'), JSON.stringify({
  builtAt: report.generatedAt,
  lists: Object.fromEntries(Object.entries(report.lists).map(([id, l]) => [id, { dnrRules: l.dnrRules, cosmeticSelectors: l.cosmetic.generic + l.cosmetic.specific, exceptions: l.cosmetic.exceptions }])),
}, null, 2));

writeFileSync(path.join(OUT_REPORT, 'report.json'), JSON.stringify(report, null, 2));
console.log('\nReport written to build/report.json');

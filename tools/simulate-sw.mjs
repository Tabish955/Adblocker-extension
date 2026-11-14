#!/usr/bin/env node
/**
 * Aegis Ad Blocker — in-memory service-worker simulation.
 *
 * Mocks the chrome.* extension APIs and exercises the service worker's real
 * code paths: install, message handling, per-site allowlisting (DNR dynamic
 * rules), list toggling and custom-filter compilation.
 *
 * Usage: node tools/simulate-sw.mjs
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'extension');

const store = new Map();
let dynamicRules = [];
let enabledRulesets = ['easylist', 'easyprivacy', 'fanboy_annoyance'];
const listeners = {};

globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        if (key === undefined || key === null) return Object.fromEntries(store);
        if (typeof key === 'string') return store.has(key) ? { [key]: store.get(key) } : {};
        if (Array.isArray(key)) {
          const out = {};
          for (const k of key) if (store.has(k)) out[k] = store.get(k);
          return out;
        }
        const out = {};
        for (const [k, d] of Object.entries(key)) out[k] = store.has(k) ? store.get(k) : d;
        return out;
      },
      async set(obj) { for (const [k, v] of Object.entries(obj)) store.set(k, v); },
      async remove(keys) { for (const k of [].concat(keys)) store.delete(k); },
    },
  },
  declarativeNetRequest: {
    async getEnabledRulesets() { return [...enabledRulesets]; },
    async updateEnabledRulesets({ enableRulesetIds = [], disableRulesetIds = [] } = {}) {
      enabledRulesets = enabledRulesets.filter((x) => !disableRulesetIds.includes(x));
      for (const id of enableRulesetIds) if (!enabledRulesets.includes(id)) enabledRulesets.push(id);
    },
    async getAvailableStaticRuleCount() { return 50000; },
    async updateDynamicRules({ addRules = [], removeRuleIds = [] } = {}) {
      dynamicRules = dynamicRules.filter((r) => !removeRuleIds.includes(r.id));
      for (const rule of addRules) dynamicRules.push(rule);
    },
    async getDynamicRules() { return [...dynamicRules]; },
    async setActionCountAsBadgeText() {},
  },
  runtime: {
    onMessage: { addListener: (fn) => { listeners.message = fn; } },
    onInstalled: { addListener: (fn) => { listeners.installed = fn; } },
    onStartup: { addListener: (fn) => { listeners.startup = fn; } },
    getURL: (p) => 'file://' + path.join(EXT, p),
    getManifest: () => JSON.parse(readFileSync(path.join(EXT, 'manifest.json'), 'utf8')),
    lastError: null,
  },
  action: { async setBadgeBackgroundColor() {} },
};

globalThis.fetch = async (url) => {
  const file = String(url).replace(/^file:\/\//, '');
  const data = readFileSync(file, 'utf8');
  return { ok: true, json: async () => JSON.parse(data), text: async () => data };
};

function send(type, payload = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), 5000);
    listeners.message({ type, ...payload }, {}, (resp) => {
      clearTimeout(timer);
      resolve(resp);
    });
  });
}

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push(['PASS', name]);
    console.log('  ✓ ' + name);
  } catch (e) {
    results.push(['FAIL', name]);
    console.error('  ✗ ' + name + ' — ' + (e && e.message));
  }
}

// Load service worker (registers listeners)
await import(pathToFileURL(path.join(EXT, 'background', 'service-worker.js')).href);

console.log('\nAegis service-worker simulation\n');

await test('onInstalled completes and seeds defaults', async () => {
  await listeners.installed({});
  const state = await send('getState');
  assert.equal(state.settings.enabled, true);
  assert.deepEqual(state.settings.lists, { easylist: true, easyprivacy: true, fanboy_annoyance: false });
  assert.ok(Array.isArray(state.enabledRulesets));
  assert.ok(state.builtinLists.length === 3);
  assert.ok(state.buildMeta && state.buildMeta.lists.easylist.dnrRules > 1000, 'build meta exposed');
});

await test('resolveForHost: example.com gets a large cosmetic set', async () => {
  const res = await send('getCosmetics', { hostname: 'www.example.com' });
  assert.equal(res.enabled, true);
  assert.ok(res.selectors.length > 10000, `expected >10k selectors, got ${res.selectors.length}`);
  assert.ok(Array.isArray(res.procedural));
});

await test('bootstrap reports protection state', async () => {
  const res = await send('bootstrap', { hostname: 'example.org' });
  assert.equal(res.enabled, true);
  assert.equal(res.siteDisabled, false);
});

await test('per-site pause: cosmetic disabled + DNR allowAllRequests rule', async () => {
  const before = dynamicRules.length;
  const res = await send('setSiteDisabled', { hostname: 'example.com', disabled: true });
  assert.ok(res.siteDisabled['example.com']);
  assert.equal(dynamicRules.length, before + 1);
  const rule = dynamicRules.find((r) => r.condition?.domains?.includes('example.com'));
  assert.equal(rule.action.type, 'allowAllRequests');
  assert.equal(rule.priority, 10);
  // subdomain must inherit the pause
  const res2 = await send('getCosmetics', { hostname: 'news.example.com' });
  assert.equal(res2.enabled, false);
});

await test('per-site resume: dynamic rule removed', async () => {
  await send('setSiteDisabled', { hostname: 'example.com', disabled: false });
  assert.equal(dynamicRules.filter((r) => r.condition?.domains?.includes('example.com')).length, 0);
  const res = await send('getCosmetics', { hostname: 'news.example.com' });
  assert.equal(res.enabled, true);
});

await test('list toggle off disables static ruleset + settings', async () => {
  const res = await send('setListEnabled', { listId: 'easyprivacy', enabled: false });
  assert.equal(res.ok, true);
  assert.ok(!enabledRulesets.includes('easyprivacy'));
  assert.equal(res.settings.lists.easyprivacy, false);
  const back = await send('setListEnabled', { listId: 'easyprivacy', enabled: true });
  assert.equal(back.ok, true);
  assert.ok(enabledRulesets.includes('easyprivacy'));
});

await test('unknown list toggle is rejected gracefully', async () => {
  const res = await send('setListEnabled', { listId: 'nope', enabled: true });
  assert.equal(res.ok, false);
});

await test('cosmetic filtering toggle zeroes selector output', async () => {
  await send('toggleCosmeticFiltering', { enabled: false });
  const res = await send('getCosmetics', { hostname: 'example.com' });
  assert.equal(res.selectors.length, 0);
  await send('toggleCosmeticFiltering', { enabled: true });
});

await test('master switch disables everything', async () => {
  await send('setEnabled', { enabled: false });
  const res = await send('getCosmetics', { hostname: 'example.com' });
  assert.equal(res.enabled, false);
  assert.equal(res.selectors.length, 0);
  const boot = await send('bootstrap', { hostname: 'example.com' });
  assert.equal(boot.enabled, false);
  await send('setEnabled', { enabled: true });
});

await test('custom filters compile into dynamic rules with safe actions', async () => {
  const res = await send('applyCustomFilters', {
    text: [
      '||ads.test^',
      '||ads2.test^$script,third-party',
      '@@||ok.test^$document,important',
      '@@||cdn.test^$script,stylesheet',
      '||banner.test^$image',
      'this is not a rule with spaces$unknownthing=1',
      '! just a comment',
      '/badregex[/$script',
    ].join('\n'),
  });
  assert.equal(res.ok, true);
  assert.ok(res.applied >= 4, `expected >=4 applied, got ${JSON.stringify(res)}`);
  const blockAds = dynamicRules.find((r) => r.condition.urlFilter === '||ads.test^');
  assert.equal(blockAds.action.type, 'block');
  assert.equal(blockAds.priority, 100);
  const allowAll = dynamicRules.find((r) => r.condition.urlFilter === '||ok.test^');
  assert.equal(allowAll.action.type, 'allowAllRequests');
  const framed = dynamicRules.find((r) => r.condition.urlFilter === '||cdn.test^' && r.action.type === 'allow');
  assert.ok(framed, 'mixed framed/non-framed exception becomes plain allow');
  const allowFrame = dynamicRules.find((r) => r.action.type === 'allowAllRequests' && r.condition.urlFilter === '||cdn.test^');
  assert.ok(!allowFrame, 'cdn.test has no frame-only part (script/stylesheet only)');
  const img = dynamicRules.find((r) => r.condition.urlFilter === '||banner.test^');
  assert.deepEqual(img.condition.resourceTypes, ['image']);
  // cleanup
  const res2 = await send('applyCustomFilters', { text: '' });
  assert.equal(res2.applied, 0);
  assert.equal(dynamicRules.filter((r) => r.id >= 1001 && r.id < 9001).length, 0);
});

await test('custom filters with only comments applies zero rules quietly', async () => {
  const res = await send('applyCustomFilters', { text: '! nothing\n! here\n' });
  assert.equal(res.ok, true);
  assert.equal(res.applied, 0);
});

await test('resetDefaults restores all lists and clears state', async () => {
  await send('setSiteDisabled', { hostname: 'x.example.net', disabled: true });
  await send('resetDefaults');
  const state = await send('getState');
  assert.equal(state.settings.enabled, true);
  assert.deepEqual(state.settings.siteDisabled, {});
  assert.deepEqual(enabledRulesets.sort(), ['easylist', 'easyprivacy', 'fanboy_annoyance']);
});

await test('onStartup quota enforcer keeps rulesets enabled', async () => {
  enabledRulesets = ['easylist', 'easyprivacy', 'fanboy_annoyance'];
  await listeners.startup({});
  assert.deepEqual([...enabledRulesets].sort(), ['easylist', 'easyprivacy', 'fanboy_annoyance']);
});

const failed = results.filter(([r]) => r === 'FAIL').length;
console.log(`\n${results.length - failed}/${results.length} checks passed\n`);
process.exit(failed ? 1 : 0);

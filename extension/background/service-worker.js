/**
 * Aegis Ad Blocker — background service worker (MV3, ES module).
 *
 * Responsibilities:
 *  - Hold/serve settings (chrome.storage.local, key "aegis.settings")
 *  - Initialise DNR (badge counter, static ruleset quota safeguard)
 *  - Resolve cosmetic + procedural rules per hostname for content scripts
 *  - Issue per-site "allowAllRequests" dynamic rules when protection is paused on a site
 *  - Compile & apply user's custom filters (dynamic DNR rules, safe actions only)
 */
import {
  resolveCosmeticSelectorsSplit,
  resolveProcedural,
  resolveScriptlets,
  compileFilters,
} from '../shared/filter-compiler.mjs';

const SETTINGS_KEY = 'aegis.settings';
const CUSTOM_RULE_BASE = 1001;      // custom filters: 1001..9000
const SITE_ALLOW_BASE = 10001;      // per-site allowAllRequests: 10001..10999
const MAX_CUSTOM_RULES = 8000;

const BUILTIN_LISTS = [
  { id: 'easylist', label: 'EasyList', description: 'Blocks ads and advertising infrastructure', cosmetic: '../resources/easylist.cosmetic.json' },
  { id: 'easyprivacy', label: 'EasyPrivacy', description: 'Blocks trackers, analytics and telemetry', cosmetic: '../resources/easyprivacy.cosmetic.json' },
  { id: 'fanboy_annoyance', label: "Fanboy's Annoyance List", description: 'Blocks cookie consent nags, notifications and newsletter popups', cosmetic: '../resources/fanboy_annoyance.cosmetic.json' },
];

const DEFAULT_SETTINGS = {
  enabled: true,
  lists: { easylist: true, easyprivacy: true, fanboy_annoyance: false },
  cosmeticFiltering: true,
  proceduralCosmetic: true,
  scriptletInjection: true,
  siteDisabled: {},
  customFiltersText: '',
  quotaDisabled: [], // rulesets Chrome could not enable (static-rule quota), surfaced in Options
};

/* ---------------------------------------------------------------- settings */
async function loadSettings() {
  try {
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    const s = stored[SETTINGS_KEY] || {};
    return {
      ...DEFAULT_SETTINGS,
      ...s,
      lists: { ...DEFAULT_SETTINGS.lists, ...(s.lists || {}) },
      siteDisabled: { ...(s.siteDisabled || {}) },
      quotaDisabled: Array.isArray(s.quotaDisabled) ? s.quotaDisabled : [],
    };
  } catch (_) {
    return { ...DEFAULT_SETTINGS };
  }
}

async function saveSettings(patch) {
  const current = await loadSettings();
  const next = {
    ...current,
    ...patch,
    lists: { ...current.lists, ...(patch.lists || {}) },
    siteDisabled: patch.siteDisabled ? { ...patch.siteDisabled } : current.siteDisabled,
  };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

/* ------------------------------------------------------- DNR rulesets      */
async function getEnabledRulesets() {
  try {
    return await chrome.declarativeNetRequest.getEnabledRulesets();
  } catch (_) {
    return [];
  }
}

/**
 * Guarantee the highest-priority rulesets stay enabled even when the global
 * static-rule quota is tight. Chrome guarantees >= 30,000 static rules per
 * extension; if the browser cannot enable everything (other extensions may
 * consume the pool), we keep easylist > easyprivacy > fanboy_annoyance.
 */
async function enforceRulesetQuota() {
  const wanted = BUILTIN_LISTS.map((l) => l.id);
  let enabled = await getEnabledRulesets();
  const missing = wanted.filter((id) => !enabled.includes(id));
  if (missing.length === 0) return;

  // Try to free room by disabling lower-priority rulesets that are enabled
  // only because we want the higher-priority ones more.
  const priority = [...wanted].reverse(); // annoyance first to sacrifice
  try { await chrome.declarativeNetRequest.getAvailableStaticRuleCount(); } catch (_) { return; }

  for (const id of missing) {
    // sacrifice enabled lower-priority rulesets until our target can be enabled
    for (const victim of priority) {
      if (victim === id) continue;
      if (!enabled.includes(victim)) continue;
      if (wanted.indexOf(victim) < wanted.indexOf(id)) continue; // never sacrifice higher priority
      try {
        await chrome.declarativeNetRequest.updateEnabledRulesets({ disableRulesetIds: [victim] });
        enabled = enabled.filter((e) => e !== victim);
        break;
      } catch (_) { /* keep trying */ }
    }
    try {
      await chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: [id] });
      enabled = [...enabled, id];
    } catch (_) {
      const s = await loadSettings();
      const quotaDisabled = Array.from(new Set([...s.quotaDisabled, id]));
      await saveSettings({ quotaDisabled });
    }
  }
}

/* ---------------------------------------------------------- cosmetic data  */
const cosmeticCache = new Map();

async function loadCosmeticData(listId) {
  if (cosmeticCache.has(listId)) return cosmeticCache.get(listId);
  const def = BUILTIN_LISTS.find((l) => l.id === listId);
  if (!def) return null;
  try {
    const url = chrome.runtime.getURL(def.cosmetic.replace(/^\.\.\//, ''));
    const res = await fetch(url);
    const data = await res.json();
    cosmeticCache.set(listId, data);
    return data;
  } catch (_) {
    cosmeticCache.set(listId, null);
    return null;
  }
}

/** Domain suffix match: is `hostname` equal to or a subdomain of `domain`? */
function hostMatches(hostname, domain) {
  return hostname === domain || hostname.endsWith('.' + domain);
}

function isSiteDisabled(settings, hostname) {
  const h = (hostname || '').toLowerCase();
  for (const disabled of Object.keys(settings.siteDisabled)) {
    if (disabled && hostMatches(h, disabled)) return true;
  }
  return false;
}

async function resolveForHost(hostname) {
  const settings = await loadSettings();
  const result = {
    enabled: settings.enabled && !isSiteDisabled(settings, hostname),
    selectors: [],          // union (backwards compat): specific ++ generic
    specificSelectors: [],  // site-specific — safe to inject at document_start
    genericSelectors: [],   // ~45k generic rules — injected lazily after load
    procedural: [],
    scriptletsEnabled: false,
    enabledLists: {},
  };
  if (!settings.enabled) return result;
  result.enabledLists = { ...settings.lists };
  result.scriptletsEnabled = settings.scriptletInjection;

  if (!settings.enabled || isSiteDisabled(settings, hostname)) return result;

  const aggregate = new Set();
  const genericAgg = new Set();
  const specificAgg = new Set();
  const procedural = [];
  for (const list of BUILTIN_LISTS) {
    if (!settings.lists[list.id]) continue;
    const data = await loadCosmeticData(list.id);
    if (!data) continue;
    if (settings.cosmeticFiltering) {
      const { generic, specific } = resolveCosmeticSelectorsSplit(data, hostname);
      for (const sel of generic) genericAgg.add(sel);
      for (const sel of specific) specificAgg.add(sel);
      for (const sel of generic) aggregate.add(sel);
      for (const sel of specific) aggregate.add(sel);
    }
    if (settings.proceduralCosmetic && data.procedural) {
      procedural.push(...resolveProcedural(data, hostname));
    }
  }
  result.selectors = [...aggregate];
  result.specificSelectors = [...specificAgg];
  result.genericSelectors = [...genericAgg];
  result.procedural = procedural;
  return result;
}

/* ----------------------------------------------------- per-site allow DNR  */
async function getSiteAllowMap() {
  const s = await chrome.storage.local.get('aegis.siteAllowIds');
  return s['aegis.siteAllowIds'] || {};
}
async function setSiteAllowMap(map) {
  await chrome.storage.local.set({ 'aegis.siteAllowIds': map });
}

async function applySiteAllowRule(hostname, disabled) {
  const site = (hostname || '').toLowerCase();
  if (!site) return;
  const map = await getSiteAllowMap();
  const existingId = map[site];
  if (disabled) {
    if (existingId) return; // already applied
    const id = SITE_ALLOW_BASE + (hashDomain(site) % 900);
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({
        addRules: [{
          id,
          priority: 10,
          action: { type: 'allowAllRequests' },
          condition: { domains: [site], resourceTypes: ['main_frame', 'sub_frame'] },
        }],
      });
      map[site] = id;
      await setSiteAllowMap(map);
    } catch (_) { /* dynamic rule budget exhausted — cosmetic/scriptlets still pause */ }
  } else if (existingId) {
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [existingId] });
    } catch (_) { /* rule may not exist; clean map anyway */ }
    delete map[site];
    await setSiteAllowMap(map);
  }
}

function hashDomain(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}

/* ---------------------------------------------------------- custom filters */
async function applyCustomFilters(text) {
  const settings = await loadSettings();
  // Remove all existing custom rules first
  try {
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    const customIds = existing.filter((r) => r.id >= CUSTOM_RULE_BASE && r.id < CUSTOM_RULE_BASE + MAX_CUSTOM_RULES).map((r) => r.id);
    if (customIds.length) {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: customIds });
    }
  } catch (_) { /* tolerate */ }

  const trimmed = (text || '').trim();
  if (!trimmed) {
    await saveSettings({ customFiltersText: '' });
    return { applied: 0, skipped: 0 };
  }

  const { networkRules, stats } = compileFilters(trimmed, { startId: CUSTOM_RULE_BASE, maxRules: MAX_CUSTOM_RULES });
  // Custom rules get top priority (user intent wins).
  const dynamic = networkRules.slice(0, MAX_CUSTOM_RULES).map((r, i) => ({
    ...r,
    id: CUSTOM_RULE_BASE + i,
    priority: 100,
  }));
  let applied = 0;
  if (dynamic.length) {
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({ addRules: dynamic });
      applied = dynamic.length;
    } catch (_) {
      // Retry in halves if the dynamic budget is tight
      const half = Math.floor(dynamic.length / 2);
      try {
        await chrome.declarativeNetRequest.updateDynamicRules({ addRules: dynamic.slice(0, half) });
        applied = half;
      } catch (_2) { /* give up quietly; settings still saved */ }
    }
  }
  await saveSettings({ customFiltersText: text });
  const skipped = Object.values(stats.skipped).reduce((a, b) => a + b, 0) + stats.regexSkipped + stats.cosmeticSkippedProcedural + stats.cosmeticSkippedInvalid;
  return { applied, skipped };
}

/* --------------------------------------------------------------- messages  */
const handlers = {
  async getState() {
    const settings = await loadSettings();
    const enabledRulesets = await getEnabledRulesets();
    let available = null;
    try { available = await chrome.declarativeNetRequest.getAvailableStaticRuleCount(); } catch (_) { /* older chrome */ }
    let buildMeta = null;
    try {
      const res = await fetch(chrome.runtime.getURL('resources/build-meta.json'));
      buildMeta = await res.json();
    } catch (_) { /* optional */ }
    return { settings, enabledRulesets, availableStaticRuleCount: available, buildMeta, builtinLists: BUILTIN_LISTS.map(({ id, label, description }) => ({ id, label, description })) };
  },

  async getCosmetics({ hostname }) {
    return resolveForHost(hostname);
  },

  async bootstrap({ hostname }) {
    const settings = await loadSettings();
    const disabled = isSiteDisabled(settings, hostname);
    return {
      enabled: settings.enabled && !disabled,
      siteDisabled: disabled,
      scriptletsEnabled: settings.enabled && settings.scriptletInjection && !disabled,
      lists: settings.lists,
    };
  },

  async setEnabled({ enabled }) {
    const s = await saveSettings({ enabled: !!enabled });
    return { ok: true, settings: s };
  },

  async setListEnabled({ listId, enabled }) {
    if (!BUILTIN_LISTS.some((l) => l.id === listId)) return { ok: false, error: 'unknown-list' };
    try {
      await chrome.declarativeNetRequest.updateEnabledRulesets(
        enabled ? { enableRulesetIds: [listId] } : { disableRulesetIds: [listId] },
      );
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    }
    const s = await saveSettings({ lists: { [listId]: !!enabled }, quotaDisabled: (await loadSettings()).quotaDisabled.filter((id) => id !== listId) });
    return { ok: true, settings: s };
  },

  async setSiteDisabled({ hostname, disabled }) {
    const site = (hostname || '').toLowerCase();
    const settings = await loadSettings();
    const siteDisabled = { ...settings.siteDisabled };
    if (disabled) siteDisabled[site] = true; else delete siteDisabled[site];
    await saveSettings({ siteDisabled });
    await applySiteAllowRule(site, !!disabled);
    return { ok: true, siteDisabled };
  },

  async removeSiteDisabled({ hostname }) {
    return handlers.setSiteDisabled({ hostname, disabled: false });
  },

  async toggleCosmeticFiltering({ enabled }) {
    const s = await saveSettings({ cosmeticFiltering: !!enabled });
    return { ok: true, settings: s };
  },
  async toggleProceduralCosmetic({ enabled }) {
    const s = await saveSettings({ proceduralCosmetic: !!enabled });
    return { ok: true, settings: s };
  },
  async toggleScriptletInjection({ enabled }) {
    const s = await saveSettings({ scriptletInjection: !!enabled });
    return { ok: true, settings: s };
  },

  async applyCustomFilters({ text }) {
    const result = await applyCustomFilters(text);
    return { ok: true, ...result };
  },

  async resetDefaults() {
    await chrome.storage.local.set({ [SETTINGS_KEY]: DEFAULT_SETTINGS });
    // re-enable all builtin rulesets
    try {
      await chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: BUILTIN_LISTS.map((l) => l.id) });
    } catch (_) { /* tolerate */ }
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = msg && handlers[msg.type];
  if (!handler) { sendResponse({ ok: false, error: 'unknown-message' }); return false; }
  handler(msg).then(
    (result) => sendResponse(result ?? { ok: true }),
    (err) => sendResponse({ ok: false, error: String(err && err.message || err) }),
  );
  return true; // async response
});

/* -------------------------------------------------------------- startup    */
chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(SETTINGS_KEY);
  if (!existing[SETTINGS_KEY]) {
    await chrome.storage.local.set({ [SETTINGS_KEY]: DEFAULT_SETTINGS });
  }
  try { await chrome.declarativeNetRequest.setActionCountAsBadgeText(true); } catch (_) { /* not supported everywhere */ }
  try { await chrome.action.setBadgeBackgroundColor({ color: '#10b981' }); } catch (_) { /* tolerate */ }
  await enforceRulesetQuota();
});

chrome.runtime.onStartup.addListener(async () => {
  try { await chrome.declarativeNetRequest.setActionCountAsBadgeText(true); } catch (_) { /* tolerate */ }
  try { await chrome.action.setBadgeBackgroundColor({ color: '#10b981' }); } catch (_) { /* tolerate */ }
  await enforceRulesetQuota();
});

/* Aegis Ad Blocker — options controller. External script (MV3 CSP). */
'use strict';

const $ = (id) => document.getElementById(id);

const el = {
  masterToggle: $('masterToggle'),
  cosmeticToggle: $('cosmeticToggle'),
  proceduralToggle: $('proceduralToggle'),
  scriptletToggle: $('scriptletToggle'),
  listsContainer: $('listsContainer'),
  listsTotalNote: $('listsTotalNote'),
  quotaWarning: $('quotaWarning'),
  customFilters: $('customFilters'),
  applyCustom: $('applyCustom'),
  customResult: $('customResult'),
  pausedSites: $('pausedSites'),
  pausedEmpty: $('pausedEmpty'),
  resetAll: $('resetAll'),
  bundleInfo: $('bundleInfo'),
  versionBadge: $('versionBadge'),
  toast: $('toast'),
};

const SWATCH = { easylist: 'swatch-easylist', easyprivacy: 'swatch-easyprivacy', fanboy_annoyance: 'swatch-fanboy' };

function sendMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (response) => {
      if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
      resolve(response);
    });
  });
}

let toastTimer = null;
function toast(text) {
  el.toast.textContent = text;
  el.toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('visible'), 2600);
}

const formatNumber = (n) => Number(n || 0).toLocaleString('en-US');

function renderLists(state) {
  const s = state.settings;
  const meta = state.buildMeta?.lists || {};
  let total = 0;
  let active = 0;
  el.listsContainer.textContent = '';

  for (const list of state.builtinLists || []) {
    const enabled = !!s.lists[list.id] && !!s.enabled;
    const m = meta[list.id] || { dnrRules: 0, cosmeticSelectors: 0 };
    if (enabled) { total += m.dnrRules; active += 1; }

    const card = document.createElement('div');
    card.className = 'list-card' + (enabled ? ' enabled' : '');
    card.dataset.list = list.id;

    const toggleWrap = document.createElement('label');
    toggleWrap.className = 'switch';
    toggleWrap.style.marginTop = '2px';
    toggleWrap.innerHTML = `<input type="checkbox" class="list-toggle" data-list="${list.id}" ${s.lists[list.id] ? 'checked' : ''} aria-label="Toggle ${list.label}" /><span class="track"><span class="thumb"></span></span>`;

    const info = document.createElement('div');
    info.className = 'list-info';
    const nameP = document.createElement('p');
    nameP.className = 'list-name';
    nameP.innerHTML = `<span class="list-swatch ${SWATCH[list.id] || ''}"></span>`;
    nameP.appendChild(document.createTextNode(list.label));
    const desc = document.createElement('p');
    desc.className = 'list-desc';
    desc.textContent = list.description;
    const stats = document.createElement('p');
    stats.className = 'list-stats';
    stats.textContent = `${formatNumber(m.dnrRules)} network rules · ${formatNumber(m.cosmeticSelectors)} cosmetic selectors`;
    info.append(nameP, desc, stats);

    card.append(toggleWrap, info);
    el.listsContainer.appendChild(card);
  }

  el.listsTotalNote.textContent = `${active} of ${(state.builtinLists || []).length} lists · ${formatNumber(total)} rules`;
  const quotaDisabled = s.quotaDisabled || [];
  if (quotaDisabled.length) {
    el.quotaWarning.hidden = false;
    el.quotaWarning.textContent = `Your browser could not enable: ${quotaDisabled.join(', ')} (its static-rule budget is shared with other extensions). Required lists were kept active with priority: EasyList → EasyPrivacy → Fanboy.`;
  } else {
    el.quotaWarning.hidden = true;
  }
}

function renderPausedSites(state) {
  const sites = Object.keys(state.settings.siteDisabled || {}).sort();
  el.pausedSites.textContent = '';
  el.pausedEmpty.hidden = sites.length !== 0;
  for (const site of sites) {
    const li = document.createElement('li');
    li.className = 'paused-row';
    const host = document.createElement('span');
    host.className = 'paused-host';
    host.textContent = site;
    const btn = document.createElement('button');
    btn.className = 'paused-remove';
    btn.type = 'button';
    btn.textContent = '×';
    btn.title = `Re-enable protection on ${site}`;
    btn.setAttribute('aria-label', `Re-enable protection on ${site}`);
    btn.addEventListener('click', async () => {
      await sendMessage({ type: 'removeSiteDisabled', hostname: site });
      toast(`Protection re-enabled on ${site}`);
      await refresh();
    });
    li.append(host, btn);
    el.pausedSites.appendChild(li);
  }
}

async function refresh() {
  const state = await sendMessage({ type: 'getState' });
  if (!state?.settings) { toast('Could not load settings'); return; }
  const s = state.settings;

  el.masterToggle.checked = !!s.enabled;
  el.cosmeticToggle.checked = !!s.cosmeticFiltering;
  el.proceduralToggle.checked = !!s.proceduralCosmetic;
  el.scriptletToggle.checked = !!s.scriptletInjection;
  el.customFilters.value = s.customFiltersText || '';

  renderLists(state);
  renderPausedSites(state);

  const version = chrome.runtime.getManifest()?.version || '';
  el.versionBadge.textContent = 'v' + version;
  const builtAt = state.buildMeta?.builtAt ? new Date(state.buildMeta.builtAt) : null;
  el.bundleInfo.textContent = builtAt
    ? `Lists bundled with this build: EasyList, EasyPrivacy & Fanboy's Annoyance (compiled ${builtAt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}).`
    : 'Lists are bundled with this build.';
}

el.masterToggle.addEventListener('change', async () => {
  await sendMessage({ type: 'setEnabled', enabled: el.masterToggle.checked });
  toast(el.masterToggle.checked ? 'Protection enabled' : 'Protection paused');
  await refresh();
});
el.cosmeticToggle.addEventListener('change', async () => {
  await sendMessage({ type: 'toggleCosmeticFiltering', enabled: el.cosmeticToggle.checked });
  toast('Cosmetic filtering ' + (el.cosmeticToggle.checked ? 'enabled' : 'disabled'));
});
el.proceduralToggle.addEventListener('change', async () => {
  await sendMessage({ type: 'toggleProceduralCosmetic', enabled: el.proceduralToggle.checked });
  toast('Text-match hiding ' + (el.proceduralToggle.checked ? 'enabled' : 'disabled'));
});
el.scriptletToggle.addEventListener('change', async () => {
  await sendMessage({ type: 'toggleScriptletInjection', enabled: el.scriptletToggle.checked });
  toast('Anti-adblock scriptlets ' + (el.scriptletToggle.checked ? 'enabled' : 'disabled'));
});

el.listsContainer.addEventListener('change', async (event) => {
  const input = event.target.closest('.list-toggle');
  if (!input) return;
  const listId = input.dataset.list;
  const enabled = input.checked;
  const res = await sendMessage({ type: 'setListEnabled', listId, enabled });
  if (res?.ok === false) {
    input.checked = !enabled;
    toast('Could not ' + (enabled ? 'enable' : 'disable') + ' list: ' + (res.error || 'unknown error'));
    return;
  }
  toast(enabled ? 'List enabled' : 'List disabled');
  await refresh();
});

el.applyCustom.addEventListener('click', async () => {
  el.applyCustom.disabled = true;
  el.customResult.textContent = 'Compiling…';
  el.customResult.className = 'custom-result';
  const res = await sendMessage({ type: 'applyCustomFilters', text: el.customFilters.value });
  el.applyCustom.disabled = false;
  if (res?.ok === false) {
    el.customResult.textContent = 'Failed: ' + (res.error || 'unknown error');
    el.customResult.className = 'custom-result err';
    return;
  }
  el.customResult.textContent = `Applied ${res.applied} rule(s)` + (res.skipped ? ` · skipped ${res.skipped} unsupported line(s)` : '');
  el.customResult.className = 'custom-result ok';
  await refresh();
});

el.resetAll.addEventListener('click', async () => {
  const confirmed = window.confirm('Reset every Aegis setting to defaults? Your custom filters and paused sites will be cleared.\n\n(Static rulesets and bundled lists are not affected.)');
  if (!confirmed) return;
  await sendMessage({ type: 'resetDefaults' });
  toast('Settings reset to defaults');
  await refresh();
});

refresh();

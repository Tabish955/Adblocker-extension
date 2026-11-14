/* Aegis Ad Blocker — popup controller. External script (MV3 CSP). */
'use strict';

const $ = (id) => document.getElementById(id);

const el = {
  masterToggle: $('masterToggle'),
  siteHost: $('siteHost'),
  siteHint: $('siteHint'),
  siteToggle: $('siteToggle'),
  statusCard: $('statusCard'),
  statusIcon: $('statusIcon'),
  statusTitle: $('statusTitle'),
  statusSub: $('statusSub'),
  blockedCount: $('blockedCount'),
  ruleCount: $('ruleCount'),
  listsActive: $('listsActive'),
  listsList: $('listsList'),
  openOptions: $('openOptions'),
  version: $('version'),
};

const ICONS = {
  on: '<svg viewBox="0 0 48 48" role="img" aria-label="Shield active"><defs><linearGradient id="pa" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2dd4bf"/><stop offset="1" stop-color="#10b981"/></linearGradient></defs><path fill="url(#pa)" d="M24 2 L43 11 V24 C43 36.5 36 44.5 24 47 C12 44.5 5 36.5 5 24 V11 Z"/><path fill="none" stroke="#04241c" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round" d="M15.5 24.5 L21.5 30.5 L33 18"/></svg>',
  off: '<svg viewBox="0 0 48 48" role="img" aria-label="Shield paused"><path fill="#26324e" d="M24 2 L43 11 V24 C43 36.5 36 44.5 24 47 C12 44.5 5 36.5 5 24 V11 Z"/><g stroke="#fb7185" stroke-width="3.2" stroke-linecap="round"><path d="M18 18 L30 30"/><path d="M30 18 L18 30"/></g></svg>',
  sitePaused: '<svg viewBox="0 0 48 48" role="img" aria-label="Paused on this site"><path fill="#3a3416" d="M24 2 L43 11 V24 C43 36.5 36 44.5 24 47 C12 44.5 5 36.5 5 24 V11 Z"/><g fill="#facc15"><rect x="17" y="16" width="4.6" height="16" rx="1.4"/><rect x="26.4" y="16" width="4.6" height="16" rx="1.4"/></g></svg>',
  unavailable: '<svg viewBox="0 0 48 48" role="img" aria-label="Unavailable"><path fill="#26324e" d="M24 2 L43 11 V24 C43 36.5 36 44.5 24 47 C12 44.5 5 36.5 5 24 V11 Z"/><circle cx="24" cy="22" r="7" fill="none" stroke="#8fa4c7" stroke-width="2.6"/><path d="M24 28.5 V36" stroke="#8fa4c7" stroke-width="2.6" stroke-linecap="round"/></svg>',
};

function sendMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (response) => {
      if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
      resolve(response);
    });
  });
}

function setStatus(state, title, sub) {
  el.statusCard.dataset.state = state;
  el.statusIcon.innerHTML = ICONS[state] || ICONS.on;
  el.statusTitle.textContent = title;
  el.statusSub.textContent = sub;
}

function formatNumber(n) {
  return Number(n || 0).toLocaleString('en-US');
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch (_) { return ''; }
}

function isBrowsable(url) {
  return /^(https?|file):\/\//i.test(url || '');
}

let activeTab = null;
let activeHost = '';
let current = null; // last getState

function render() {
  const s = current?.settings;
  if (!s) return;
  const masterOn = !!s.enabled;
  el.masterToggle.checked = masterOn;

  const sitePaused = activeHost ? !!s.siteDisabled[activeHost] : false;
  el.siteToggle.checked = !sitePaused;
  el.siteToggle.disabled = !activeHost || !masterOn;

  if (!isBrowsable(activeTab?.url)) {
    el.siteHost.textContent = 'Browser page';
    el.siteHint.textContent = 'Aegis cannot run on this page';
    setStatus('unavailable', 'Unavailable here', 'Browser and Web Store pages cannot be filtered.');
  } else if (!masterOn) {
    setStatus('off', 'Aegis is off', 'Flip the switch above to resume protection.');
  } else if (sitePaused) {
    setStatus('site-paused', 'Paused on this site', `Ads and trackers are allowed on ${activeHost}.`);
  } else {
    setStatus('on', 'Protection active', 'Ads, trackers and annoyances are being blocked.');
  }

  el.siteHint.textContent = sitePaused ? 'Paused — ads allowed here' : (masterOn ? 'Protection is enabled here' : 'Resume Aegis to protect this site');

  // lists summary
  const meta = current?.buildMeta?.lists || {};
  let totalRules = 0;
  let active = 0;
  el.listsList.textContent = '';
  for (const list of current.builtinLists || []) {
    const enabled = masterOn && !!s.lists[list.id];
    const count = meta[list.id]?.dnrRules || 0;
    if (enabled) { active += 1; totalRules += count; }
    const li = document.createElement('li');
    li.className = 'list-row' + (enabled ? '' : ' off');
    li.innerHTML = `<span class="list-dot"></span><span class="list-name"></span><span class="list-count">${enabled ? formatNumber(count) + ' rules' : 'off'}</span>`;
    li.querySelector('.list-name').textContent = list.label;
    el.listsList.appendChild(li);
  }
  el.ruleCount.textContent = formatNumber(totalRules);
  el.listsActive.textContent = `${active} / ${(current.builtinLists || []).length}`;
}

async function refreshBlockedCount() {
  if (!activeTab?.id) { el.blockedCount.textContent = '—'; return; }
  try {
    const res = await chrome.declarativeNetRequest.getMatchedRules({ tabId: activeTab.id });
    const n = (res?.rulesMatched || []).length;
    el.blockedCount.textContent = formatNumber(n);
  } catch (_) {
    el.blockedCount.textContent = '—'; // needs activeTab grant; fall back silently
  }
}

async function init() {
  el.version.textContent = 'v' + (chrome.runtime.getManifest()?.version || '');

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tabs && tabs[0];
  activeHost = activeTab?.url ? hostOf(activeTab.url) : '';
  el.siteHost.textContent = activeHost || 'this page';
  el.siteHost.title = activeHost;

  current = await sendMessage({ type: 'getState' });
  if (current?.ok === false || !current?.settings) {
    setStatus('unavailable', 'Something went wrong', current?.error || 'Could not reach the background service.');
    return;
  }
  render();
  refreshBlockedCount();

  el.masterToggle.addEventListener('change', async () => {
    const enabled = el.masterToggle.checked;
    el.masterToggle.disabled = true;
    const res = await sendMessage({ type: 'setEnabled', enabled });
    if (res?.settings) current.settings = res.settings;
    el.masterToggle.disabled = false;
    render();
  });

  el.siteToggle.addEventListener('change', async () => {
    if (!activeHost) return;
    const enabled = el.siteToggle.checked; // checked == protected
    el.siteToggle.disabled = true;
    const res = await sendMessage({ type: 'setSiteDisabled', hostname: activeHost, disabled: !enabled });
    if (res?.siteDisabled) current.settings.siteDisabled = res.siteDisabled;
    el.siteToggle.disabled = false;
    render();
  });

  el.openOptions.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });
}

init().catch(() => {
  setStatus('unavailable', 'Something went wrong', 'Aegis failed to initialise. Try reloading the extension.');
});

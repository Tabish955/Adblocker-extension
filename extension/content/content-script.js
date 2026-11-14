/**
 * Aegis Ad Blocker — ISOLATED content script (document_start).
 *
 * - Asks the service worker for the effective cosmetic/procedural rules for this host
 * - Injects a display:none stylesheet (chunked, one rule per chunk)
 * - Evaluates procedural `:has-text()` rules against the DOM (cookie banners etc.)
 * - Mirrors the protection state onto documentElement.dataset for the MAIN-world
 *   scriptlet runner, and re-asserts it after late DOM writes.
 */
(function aegisContentScript() {
  'use strict';
  const host = location.hostname;
  if (!host) return;

  const CHUNK = 400; // selectors per CSS rule to stay well under parser limits

  function sendMessage(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (response) => {
          // Swallow "extension context invalidated" after updates/reloads.
          if (chrome.runtime.lastError) return resolve(null);
          resolve(response);
        });
      } catch (_) {
        resolve(null);
      }
    });
  }

  function injectHideCss(selectors) {
    if (!selectors.length) return;
    const style = document.createElement('style');
    style.setAttribute('data-aegis', 'cosmetic');
    const parts = [];
    for (let i = 0; i < selectors.length; i += CHUNK) {
      parts.push(selectors.slice(i, i + CHUNK).join(',') + '{display:none!important}');
    }
    style.textContent = parts.join('\n');
    (document.head || document.documentElement).appendChild(style);
  }

  /* ------------------------------------------------ procedural :has-text */
  function elementMatchesText(el, texts) {
    let content = el.textContent || '';
    if (content.length > 6000) return false; // avoid scanning whole-page containers
    content = content.toLowerCase();
    for (const t of texts) {
      if (!content.includes(String(t).toLowerCase())) return false;
    }
    return true;
  }

  function applyProcedural(rules) {
    if (!rules || !rules.length) return;
    const active = rules
      .map((r) => ({ base: r.base, texts: r.texts || [] }))
      .filter((r) => r.base && r.texts.length);
    if (!active.length) return;

    const run = () => {
      for (const rule of active) {
        let nodes;
        try { nodes = document.querySelectorAll(rule.base); } catch (_) { continue; }
        for (const el of nodes) {
          if (el.hasAttribute('data-aegis-procedural-hidden')) continue;
          if (!elementMatchesText(el, rule.texts)) continue;
          el.style.setProperty('display', 'none', 'important');
          el.setAttribute('data-aegis-procedural-hidden', '1');
        }
      }
    };

    run();
    // Re-apply as the page mutates (cookie banners often render late). Debounced.
    let scheduled = false;
    const observer = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      setTimeout(() => { scheduled = false; run(); }, 400);
    });
    const startObserving = () => {
      try {
        observer.observe(document.documentElement || document, { childList: true, subtree: true });
      } catch (_) { /* document not ready yet */ }
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => { run(); startObserving(); }, { once: true });
    } else {
      startObserving();
    }
  }

  function broadcastState(state) {
    const disabled = !state.enabled;
    try {
      if (document.documentElement) {
        if (disabled) document.documentElement.setAttribute('data-aegis-disabled', '1');
        else document.documentElement.removeAttribute('data-aegis-disabled');
      }
    } catch (_) { /* ignore */ }
    try {
      window.postMessage({ source: 'aegis', type: 'settings', enabled: !!state.enabled, lists: state.enabledLists || {} }, '*');
    } catch (_) { /* ignore */ }
  }

  (async () => {
    const bootstrap = await sendMessage({ type: 'bootstrap', hostname: host });
    if (!bootstrap) return;
    broadcastState({ enabled: bootstrap.enabled, enabledLists: bootstrap.lists });
    if (!bootstrap.enabled) return;

    const resolved = await sendMessage({ type: 'getCosmetics', hostname: host });
    if (!resolved || !resolved.enabled) return;

    injectHideCss(resolved.selectors || []);
    if (resolved.procedural && resolved.procedural.length) applyProcedural(resolved.procedural);
  })().catch(() => { /* never break the page */ });
})();

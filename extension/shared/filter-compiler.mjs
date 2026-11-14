/**
 * Aegis Ad Blocker — filter compiler
 * ==================================
 * Compiles Adblock Plus / uBlock Origin syntax filter lists into:
 *   1. Chrome `declarativeNetRequest` (DNR) rules  — for network request blocking
 *   2. Cosmetic filtering data (element hiding)    — for content-script CSS injection
 *   3. Scriptlet injection data (anti-adblock)     — for MAIN-world content script
 *
 * Pure ES module, no Node APIs — also imported by the service worker at runtime
 * to compile user-supplied/custom filters.
 *
 * Supported network rule options (ABP + uBO aliases):
 *   third-party/~third-party, 1p/3p, domain=/from= (with ~exclusions),
 *   script|image|stylesheet|font|media|websocket|xmlhttprequest/xhr/css|
 *   subdocument/frame/iframe|document/doc|object|object-subrequest|dtd|ping|csp_report|other,
 *   important, badfilter, match-case, generichide/genericblock/elemhide (cosmetic side effects),
 *   redirect= (degraded to plain block), all.
 *
 * Deliberately NOT supported (rules are skipped and counted in stats):
 *   csp=, rewrite=, webrtc, sitekey=, header/permissions, object-subrequest is mapped
 *   to object, popup (never maps to main_frame blocking), $removeparam (blocking would
 *   break pages and URL rewriting is an "unsafe" action requiring host access).
 *
 * DNR permission model: we build with the plain "declarativeNetRequest" permission
 * (no <all_urls> host access), so only "safe" actions are allowed:
 *   block / allow / allowAllRequests / upgradeScheme.
 */

const RESOURCE_TYPE_MAP = {
  script: 'script',
  image: 'image',
  stylesheet: 'stylesheet',
  css: 'stylesheet',
  font: 'font',
  media: 'media',
  websocket: 'websocket',
  xmlhttprequest: 'xmlhttprequest',
  xhr: 'xmlhttprequest',
  xml: 'xmlhttprequest',
  ping: 'ping',
  csp_report: 'csp_report',
  'csp-report': 'csp_report',
  object: 'object',
  'object-subrequest': 'object',
  subdocument: 'sub_frame',
  sub_frame: 'sub_frame',
  frame: 'sub_frame',
  iframe: 'sub_frame',
  document: 'main_frame',
  doc: 'main_frame',
  main_frame: 'main_frame',
  other: 'other',
  dtd: 'other',
  webtransport: 'webtransport',
  webbundle: 'webbundle',
};

const MAX_URLFILTER_LENGTH = 512;
const MAX_SELECTOR_LENGTH = 2048;

function splitTopLevel(input, sep) {
  const seps = Array.isArray(sep) ? sep : [sep];
  const parts = [];
  let cur = '';
  let depth = 0;
  let quote = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      else if (ch === '\\' && i + 1 < input.length) { cur += input[++i]; }
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (seps.includes(ch) && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.length) parts.push(cur);
  return parts;
}

function unquote(s) {
  const t = s.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

function isValidDomain(d) {
  if (!d || d.length > 253) return false;
  const labels = d.split('.');
  if (labels.some((l) => l.length === 0 || l.length > 63)) return false;
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/.test(d);
}

function isAscii(s) {
  return /^[\x20-\x7E]*$/.test(s);
}

function parseDomainList(value) {
  const include = [];
  const exclude = [];
  // Cosmetic/scriptlet domain lists are COMMA-separated ("a.com,b.com##.ad");
  // network $domains use PIPE. A domain label can contain neither, so split
  // on both — otherwise the whole comma blob becomes one invalid domain and
  // the rule silently degrades into a generic one (this hid <html> everywhere).
  for (const raw of splitTopLevel(value || '', ['|', ','])) {
    let d = raw.trim().toLowerCase();
    if (!d) continue;
    let excluded = false;
    if (d.startsWith('~')) { excluded = true; d = d.slice(1); }
    if (d.startsWith('||')) d = d.slice(2);
    if (!isValidDomain(d)) continue;
    (excluded ? exclude : include).push(d);
  }
  return { include, exclude };
}

function splitOptions(line) {
  const idx = line.lastIndexOf('$');
  if (idx === -1) return [line, []];
  const optsRaw = line.slice(idx + 1);
  if (/^[a-z0-9\-~,=.*_|]+$/i.test(optsRaw)) {
    return [line.slice(0, idx), optsRaw.split(',').map((o) => o.trim().toLowerCase()).filter(Boolean)];
  }
  // Option-like but contains values we cannot express (e.g. $csp=default-src 'self' ...).
  // The line is an option-annotated rule we must drop — NOT a pattern containing '$'.
  if (/(^|,)\s*(csp|rewrite|header|permissions|method|to|from|referrer|referrer|sitekey|removeparam|upgrade|redirect-rule)\s*(=|,|$)/i.test(optsRaw)
      || /[\s'":]/.test(optsRaw) && /(^|,)\s*[a-z-]+=/i.test(optsRaw)) {
    return [null, null];
  }
  return [line, []];
}

function splitResourceAndFlags(option) {
  const eq = option.indexOf('=');
  if (eq === -1) return { key: option, value: undefined };
  return { key: option.slice(0, eq), value: option.slice(eq + 1) };
}

function convertUboOption(key) {
  const map = {
    xhr: 'xmlhttprequest',
    '~xhr': '~xmlhttprequest',
    css: 'stylesheet',
    '~css': '~stylesheet',
    '1p': '~third-party',
    '~1p': 'third-party',
    '3p': 'third-party',
    '~3p': '~third-party',
    frame: 'subdocument',
    '~frame': '~subdocument',
    doc: 'document',
    '~doc': '~document',
    ghide: 'generichide',
    xml: 'xmlhttprequest',
    '~xml': '~xmlhttprequest',
    iframe: 'subdocument',
    '~iframe': '~subdocument',
    subdoc: 'subdocument',
    '~subdoc': '~subdocument',
    from: 'domain',
    'into': 'to',
  };
  return map[key] || key;
}

function parseLine(rawLine) {
  const line = rawLine.trim();
  if (!line || line.startsWith('!') || line.startsWith('[')) return null;
  const result = { raw: rawLine, exception: false };

  let body = line;
  if (body.startsWith('@@')) { result.exception = true; body = body.slice(2); }

  // ---------- Scriptlets (uBO + ABP syntax) ----------
  const scriptletMatch = body.match(/^([^#]*)#%#\/\/scriptlet\((.*)\)$/) ||
    body.match(/^([^#]*)##\+js\((.*)\)$/);
  if (scriptletMatch) {
    const domains = parseDomainList(scriptletMatch[1]);
    const parts = splitTopLevel(scriptletMatch[2], ',');
    const name = unquote(parts[0] || '').trim();
    const args = parts.slice(1).map(unquote);
    result.type = 'scriptlet';
    result.domains = domains;
    result.name = name;
    result.args = args;
    return result;
  }
  if (/#@\+js\(|#@%#\/\/scriptlet\(/.test(body)) {
    result.type = 'scriptlet-unmatch';
    return result;
  }

  // ---------- Procedural cosmetic (unsupported) ----------
  const procedural = body.match(/^([^#]*?)#(@?)(?:\?|\$)#(.+)$/);
  if (procedural) {
    result.type = 'procedural';
    result.domains = parseDomainList(procedural[1]);
    result.unhide = procedural[2] === '@';
    result.rawProcedural = procedural[3].trim();
    return result;
  }

  // ---------- Cosmetic (element hiding) ----------
  // Note: the selector itself may legitimately start with '#' (element id, e.g. "domain###my-id")
  const cosmetic = body.match(/^([^#]*?)#(@?)#(.+)$/);
  if (cosmetic) {
    const sel = cosmetic[3].trim();
    // ABP "inline script" hiding rules (#%#) handled above; anything else with '{' is CSS injection — unsupported
    if (sel.includes('{')) { result.type = 'procedural'; result.domains = parseDomainList(cosmetic[1]); return result; }
    result.type = 'cosmetic';
    result.domains = parseDomainList(cosmetic[1]);
    result.selector = sel;
    result.unhide = cosmetic[2] === '@';
    return result;
  }

  // ---------- Regex network rules ----------
  if (body.startsWith('/')) {
    result.type = 'regex';
    return result;
  }

  // ---------- Network rule ----------
  const [pattern, optionsRaw] = splitOptions(body);
  if (pattern === null) {
    result.type = 'unsupported';
    return result;
  }
  result.type = 'network';
  result.pattern = pattern;
  result.optionsRaw = optionsRaw;
  return result;
}

function normalizeForBadFilter(line) {
  let exception = false;
  let body = line.trim();
  if (body.startsWith('@@')) { exception = true; body = body.slice(2); }
  const idx = body.lastIndexOf('$');
  let pattern = body, opts = [];
  if (idx !== -1 && /^[a-z0-9\-~,=.*_|]+$/i.test(body.slice(idx + 1))) {
    pattern = body.slice(0, idx);
    opts = body.slice(idx + 1).split(',');
  }
  opts = opts
    .map((o) => o.trim().toLowerCase())
    .filter((o) => o && o !== 'badfilter')
    .sort();
  return (exception ? '@@' : '') + pattern + (opts.length ? '$' + opts.join(',') : '');
}

const PROCEDURAL_MARKERS = [
  ':has-text(', ':contains(', ':matches-css(', ':matches-attr(', ':matches-property(',
  ':xpath(', ':upward(', ':nth-ancestor(', ':remove(', ':style(', ':-abp-', ':if(',
  ':watch-attr(', ':min-text-length(', ':others(', ':has(', ':not(', ':is(', ':where(',
  ':matches-path(', ':matches-href(', ':matches-host(', ':matches-selector(',
];

// A cosmetic rule that could hide the root element is never acceptable:
// it whites out the entire page. (EasyList contains "aads.com,...##HTML";
// with the comma-separator bug it used to become a generic rule.)
const ROOT_SELECTORS = new Set(['html', 'body', '*']);
export function isRootSelector(sel) {
  if (!sel) return false;
  return sel.split(',').some((part) => ROOT_SELECTORS.has(part.trim().toLowerCase()));
}

// Counted-repetition cost model for Chrome's 2KB RE2 program memory limit.
// Chrome expands x{n} or x{n,} into n copies; we estimate each counted rep
// with its upper bound (lower bound when unbounded) and reject rules whose
// worst single rep or total expansion is implausibly large. This mirrors
// the runtime warnings DNR emits for oversized regexFilter rules.
export function regexRepCost(re) {
  let worst = 0, total = 0;
  const rep = /\{(\d+)(?:,(\d*))?\}/g;
  let m;
  while ((m = rep.exec(re)) !== null) {
    const lo = parseInt(m[1], 10);
    let cost;
    if (m[2] === undefined) cost = lo;          // {n}
    else if (m[2] === '') cost = lo;            // {n,} — n copies then a star
    else cost = parseInt(m[2], 10);             // {n,m} — m copies worst case
    total += cost;
    if (cost > worst) worst = cost;
  }
  return { worst, total };
}

export function regexFitsChromeBudget(re) {
  const { worst, total } = regexRepCost(re);
  return worst < 15 && total < 60;
}

function isPlausibleSelector(sel) {
  if (!sel || sel.length > MAX_SELECTOR_LENGTH) return false;
  // Braces and '<' could break out of the <style> context; control chars are never valid.
  if (/[{}<\x00-\x1f]/.test(sel)) return false;
  for (const marker of PROCEDURAL_MARKERS) {
    if (sel.includes(marker)) return false;
  }
  let p = 0, b = 0;
  let q = null;
  for (let i = 0; i < sel.length; i++) {
    const ch = sel[i];
    if (q) { if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; continue; }
    if (ch === '(') p++;
    else if (ch === ')') p--;
    else if (ch === '[') b++;
    else if (ch === ']') b--;
    if (p < 0 || b < 0) return false;
  }
  if (p !== 0 || b !== 0 || q) return false;
  return true;
}

const HAS_TEXT_TAIL_RE = /^(.*?):(?:has-text|contains)\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)\s*$/;

/**
 * Try to interpret a procedural cosmetic rule as "base CSS selector + :has-text() predicates".
 * Returns { base, texts[] } or null when unsupported.
 */
export function parseProceduralHasText(sel) {
  const texts = [];
  let rest = sel.trim();
  for (let i = 0; i < 4; i++) {
    const m = rest.match(HAS_TEXT_TAIL_RE);
    if (!m) break;
    const text = (m[2] ?? m[3] ?? m[4] ?? '').trim();
    if (text) texts.push(text);
    rest = m[1].trim();
  }
  if (!texts.length || !rest) return null;
  if (/:has-text|:contains|:matches-css|:-abp-|:style|:upward|:nth-ancestor|:xpath|:if\(|:watch-attr|:min-text-length|:others|:has\(|:not\(|:is\(|:where\(/.test(rest)) return null;
  if (!isPlausibleSelector(rest)) return null;
  return { base: rest, texts };
}

export function isRE2Compatible(re) {
  if (!re || re.length > 400) return false;
  if (/\\[1-9]/.test(re)) return false;            // backreferences
  if (/\(\?(?:[=!<]|>|')/.test(re)) return false; // lookahead/behind, atomic, PCRE named groups
  if (/[+*?}]\+/.test(re)) return false;          // possessive quantifiers
  let paren = 0, cls = 0;
  for (let i = 0; i < re.length; i++) {
    const ch = re[i];
    if (ch === '[' && re[i - 1] !== '\\') cls++;
    else if (ch === ']' && re[i - 1] !== '\\') cls--;
    else if (cls === 0) {
      if (ch === '(' && re[i - 1] !== '\\') paren++;
      else if (ch === ')' && re[i - 1] !== '\\') paren--;
    }
    if (paren < 0 || cls < 0) return false;
  }
  if (paren !== 0 || cls !== 0) return false;
  return true;
}

/**
 * Build one DNR rule from a parsed network/regex line.
 * Returns { rule } or { rule: null, genericHideDomain } for $generichide exceptions.
 */
function buildNetworkRule(parsed, stats, skip, dnrId, seenRuleKeys, regexFilter) {
  const opts = parsed.optionsRaw.map(convertUboOption);
  let domainType;
  let initiatorDomains = [];
  let excludedDomains = [];
  let resourceTypes = [];
  let allTypes = false;
  let important = false;
  let matchCase = false;
  let generichide = false;
  let skipRule = false;
  let otherOption = false;
  let redirectDegraded = false;

  for (const rawOpt of opts) {
    if (!rawOpt) continue;
    let negated = false;
    let o = rawOpt;
    if (o.startsWith('~')) { negated = true; o = o.slice(1); }
    const { key, value } = splitResourceAndFlags(o);

    switch (key) {
      case 'third-party':
        domainType = negated ? 'firstParty' : 'thirdParty';
        break;
      case 'domain': {
        const { include, exclude } = parseDomainList(value || '');
        initiatorDomains = initiatorDomains.concat(include);
        excludedDomains = excludedDomains.concat(exclude);
        break;
      }
      case 'important': important = true; break;
      case 'match-case': matchCase = true; break;
      case 'badfilter': break;
      case 'generichide':
      case 'genericblock':
      case 'elemhide':
        if (parsed.exception) generichide = true;
        break;
      case 'all':
        allTypes = !negated;
        if (negated) skipRule = true;
        break;
      case 'popup':
        skip('popup'); skipRule = true; break;
      case 'csp': case 'rewrite': case 'webrtc': case 'header': case 'permissions':
      case 'referrer': case 'referrer': case 'sitekey': case 'method': case 'to':
      case 'upgrade': // $upgrade handled implicitly by DNR? no - skip to be safe
        skip('unsupported-option-' + key); skipRule = true; break;
      case 'removeparam':
      case 'remove-param':
        skip('removeparam-needs-host-access'); skipRule = true; break;
      case 'redirect':
        // Safe degrade under plain "declarativeNetRequest" permission
        redirectDegraded = true;
        break;
      case 'redirect-rule':
        skip('redirect-rule'); skipRule = true; break;
      case 'empty': case 'mp4': case 'mediasrc': case 'media-source':
        skip('unsupported-option-' + key); skipRule = true; break;
      case 'other-when-tab':
        break;
      default: {
        const mapped = RESOURCE_TYPE_MAP[key];
        if (mapped) {
          if (!negated) resourceTypes.push(mapped);
        } else if (['collapse', 'match-case-insensitive'].includes(key)) {
          // harmless no-ops
        } else {
          otherOption = key;
        }
      }
    }
  }

  if (skipRule) return { rules: [] };
  if (otherOption) { skip('unknown-option-' + otherOption); return { rules: [] }; }

  resourceTypes = [...new Set(resourceTypes)];
  if (!allTypes && resourceTypes.length === 0) {
    if (generichide && parsed.exception) {
      const m = (parsed.pattern || '').match(/^\|\|([a-z0-9.-]+)\^?$/i);
      return { rules: [], genericHideDomain: m ? m[1] : null };
    }
    resourceTypes = undefined;
  }

  let priority = parsed.exception ? 2 : 1;
  if (important) priority += 2;

  const condition = regexFilter ? { regexFilter } : { urlFilter: parsed.pattern };
  if (domainType) condition.domainType = domainType;
  if (resourceTypes && resourceTypes.length) condition.resourceTypes = resourceTypes;
  if (initiatorDomains.length) condition.domains = [...new Set(initiatorDomains)].slice(0, 1000);
  if (excludedDomains.length) condition.excludedDomains = [...new Set(excludedDomains)].slice(0, 1000);

  const rules = [];
  const makeRule = (action, cond, prio) => ({ id: 0, priority: prio, action, condition: cond });
  const push = (action, cond, prio) => {
    const key = JSON.stringify([action, cond, prio]);
    if (seenRuleKeys.has(key)) { skip('duplicate'); return; }
    seenRuleKeys.add(key);
    rules.push(makeRule(action, cond, prio));
  };

  if (parsed.exception) {
    const frameTypes = (resourceTypes || []).filter((t) => t === 'main_frame' || t === 'sub_frame');
    const otherTypes = (resourceTypes || []).filter((t) => t !== 'main_frame' && t !== 'sub_frame');
    if (frameTypes.length > 0) {
      // "Allow everything initiated by these documents" — allowAllRequests must carry only frame types
      const cond = { ...condition, resourceTypes: frameTypes };
      push({ type: 'allowAllRequests' }, cond, priority);
    }
    if (otherTypes.length > 0) {
      // The remaining resource types as a plain allow exception
      const cond = { ...condition, resourceTypes: otherTypes };
      push({ type: 'allow' }, cond, priority);
    }
    if (!resourceTypes || resourceTypes.length === 0) {
      push({ type: 'allow' }, condition, priority);
    }
  } else {
    push({ type: 'block' }, condition, priority);
  }

  if (rules.length === 0) return { rules: [] };
  const first = rules[0];
  return {
    rules,
    redirectDegraded,
    isAllowAllRequests: rules.some((r) => r.action.type === 'allowAllRequests'),
  };
}

export function compileFilters(text, { startId = 1, maxRules = 100000, regexBudget = 900 } = {}) {
  const stats = {
    totalLines: 0,
    networkBlock: 0,
    networkAllow: 0,
    allowAllRequests: 0,
    redirectAsBlock: 0,
    skipped: {},
    cosmeticGeneric: 0,
    cosmeticSpecific: 0,
    cosmeticExceptions: 0,
    cosmeticSkippedProcedural: 0,
    cosmeticSkippedInvalid: 0,
    cosmeticRootBlocked: 0,
    scriptlets: 0,
    scriptletUnmatch: 0,
    proceduralHasText: 0,
    regexSkipped: 0,
    regexIncluded: 0,
    badfilter: 0,
  };
  const skip = (reason) => { stats.skipped[reason] = (stats.skipped[reason] || 0) + 1; };

  // ------- Pass 1: badfilter collection -------
  const badfilterKeys = new Set();
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || !line.includes('badfilter')) continue;
    const optPart = line.split('$')[1];
    if (!optPart) continue;
    const opts = optPart.split(',').map((s) => s.trim().toLowerCase());
    if (opts.includes('badfilter')) badfilterKeys.add(normalizeForBadFilter(line));
  }

  // ------- Pass 2: compile -------
  const networkRules = [];
  let dnrId = startId;
  let regexCount = 0;
  const cosmeticHides = [];
  const cosmeticExceptions = [];
  const proceduralHides = [];
  const scriptlets = [];
  const genericHideExcludes = [];
  const seenRuleKeys = new Set();

  for (const rawLine of text.split('\n')) {
    stats.totalLines++;
    const parsed = parseLine(rawLine);
    if (!parsed) continue;
    if (badfilterKeys.has(normalizeForBadFilter(rawLine))) continue;

    switch (parsed.type) {
      case 'procedural': {
        if (parsed.unhide) { stats.scriptletUnmatch++; continue; }
        const parsedProc = parseProceduralHasText(parsed.rawProcedural || '');
        if (parsedProc) {
          proceduralHides.push({ include: parsed.domains.include, exclude: parsed.domains.exclude, ...parsedProc });
          stats.proceduralHasText++;
        } else {
          stats.cosmeticSkippedProcedural++;
        }
        continue;
      }
      case 'scriptlet-unmatch': stats.scriptletUnmatch++; continue;
      case 'scriptlet':
        if (!parsed.name) { skip('scriptlet-no-name'); continue; }
        scriptlets.push({ ...parsed.domains, name: parsed.name, args: parsed.args });
        stats.scriptlets++;
        continue;
      case 'cosmetic': {
        const sel = parsed.selector;
        if (!isPlausibleSelector(sel)) {
          if (/:has-text|:-abp-|:contains|:style|:upward|:nth-ancestor/.test(sel)) stats.cosmeticSkippedProcedural++;
          else stats.cosmeticSkippedInvalid++;
          continue;
        }
        const entry = { include: parsed.domains.include, exclude: parsed.domains.exclude, selector: sel };
        if (parsed.unhide) { cosmeticExceptions.push(entry); stats.cosmeticExceptions++; }
        else {
          cosmeticHides.push(entry);
          if (entry.include.length === 0) stats.cosmeticGeneric++; else stats.cosmeticSpecific++;
        }
        continue;
      }
      case 'regex': break; // handled below
      case 'network': break;
      case 'unsupported': skip('unsupported-option-syntax'); continue;
      default: skip('unknown-type'); continue;
    }

    if (networkRules.length >= maxRules) { skip('max-rules-cap'); continue; }

    if (parsed.type === 'regex') {
      if (regexCount >= regexBudget) { skip('regex-budget'); continue; }
      const body = parsed.raw.trim();
      const optIdx = body.lastIndexOf('$');
      let reBody = body, reOpts = [];
      if (optIdx !== -1) {
        const [, opts] = splitOptions(body);
        if (opts === null) { stats.regexSkipped++; continue; }
        if (/^[a-z0-9\-~,=.*_|]+$/i.test(body.slice(optIdx + 1))) {
          reBody = body.slice(0, optIdx);
          reOpts = opts;
        }
      }
      const m = reBody.match(/^\/((?:[^\\/]|\\.)*)\/([a-z]*)$/s);
      if (!m) { stats.regexSkipped++; continue; }
      const re = m[1];
      if (!isRE2Compatible(re)) { stats.regexSkipped++; continue; }
      if (!regexFitsChromeBudget(re)) { skip('regex-program-too-large'); stats.regexSkipped++; continue; }
      const synth = {
        raw: parsed.raw, exception: parsed.exception, type: 'network',
        pattern: undefined, optionsRaw: reOpts,
      };
      const { rules, isAllowAllRequests, redirectDegraded } = buildNetworkRule(synth, stats, skip, dnrId, seenRuleKeys, re);
      if (!rules.length) continue;
      for (const rule of rules) { rule.id = dnrId++; networkRules.push(rule); }
      regexCount++;
      stats.regexIncluded++;
      for (const rule of rules) {
        if (rule.action.type === 'block') stats.networkBlock++; else stats.networkAllow++;
      }
      if (isAllowAllRequests) stats.allowAllRequests++;
      if (redirectDegraded) stats.redirectAsBlock++;
      continue;
    }

    // ------- plain urlFilter rule -------
    const pattern = parsed.pattern;
    if (!pattern || !isAscii(pattern)) { skip('pattern-non-ascii'); continue; }
    if (/[\s]/.test(pattern)) { skip('pattern-whitespace'); continue; }
    if (pattern.length > MAX_URLFILTER_LENGTH) { skip('pattern-too-long'); continue; }
    const pipeCount = (pattern.match(/\|/g) || []).length;
    const domainAnchor = pattern.startsWith('||');
    const edgePipes =
      (pattern.startsWith('|') && !pattern.startsWith('||') ? 1 : 0) +
      (pattern.endsWith('|') ? 1 : 0);
    if (domainAnchor && pipeCount > 2) { skip('bad-anchor'); continue; }
    if (!domainAnchor && pipeCount > edgePipes) { skip('pipe-in-middle'); continue; }

    const { rules, genericHideDomain, isAllowAllRequests, redirectDegraded } =
      buildNetworkRule(parsed, stats, skip, dnrId, seenRuleKeys, null);

    if (genericHideDomain !== undefined) {
      if (genericHideDomain) genericHideExcludes.push(genericHideDomain);
      else skip('generichide-unanchored');
      continue;
    }
    if (!rules || !rules.length) continue;
    for (const rule of rules) { rule.id = dnrId++; networkRules.push(rule); }
    for (const rule of rules) {
      if (rule.action.type === 'block') stats.networkBlock++; else stats.networkAllow++;
    }
    if (isAllowAllRequests) stats.allowAllRequests++;
    if (redirectDegraded) stats.redirectAsBlock++;
  }

  return {
    networkRules,
    cosmeticHides,
    cosmeticExceptions,
    proceduralHides,
    genericHideExcludes,
    scriptlets,
    stats,
  };
}

/**
 * Build the per-list cosmetic lookup structure used at runtime.
 */
export function buildCosmeticIndex(compiled) {
  const generic = new Set();
  const genericExcluded = new Set();
  const perDomain = new Map();
  const perDomainExcluded = new Map();
  const addTo = (map, key, value) => {
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(value);
  };
  for (const h of compiled.cosmeticHides) {
    if (isRootSelector(h.selector)) { compiled.stats.cosmeticRootBlocked = (compiled.stats.cosmeticRootBlocked || 0) + 1; continue; }
    if (h.include.length > 0) {
      for (const d of h.include) addTo(perDomain, d, h.selector);
      for (const d of h.exclude) addTo(perDomainExcluded, d, h.selector);
    } else if (h.exclude.length > 0) {
      generic.add(h.selector);
      for (const d of h.exclude) addTo(perDomainExcluded, d, h.selector);
    } else {
      generic.add(h.selector);
    }
  }
  for (const h of compiled.cosmeticExceptions) {
    if (h.include.length === 0) genericExcluded.add(h.selector);
    else for (const d of h.include) addTo(perDomainExcluded, d, h.selector);
  }
  // procedural (:has-text) rules
  const procGeneric = [];
  const procPerDomain = new Map();
  const addProc = (map, key, entry) => { if (!map.has(key)) map.set(key, []); map.get(key).push(entry); };
  for (const h of compiled.proceduralHides || []) {
    if (h.include.length > 0) {
      for (const d of h.include) addProc(procPerDomain, d, { base: h.base, texts: h.texts });
    } else {
      procGeneric.push({ base: h.base, texts: h.texts });
    }
  }
  const procFinal = {};
  for (const [k, v] of procPerDomain) procFinal[k] = v;

  const finalize = (map) => {
    const out = {};
    for (const [k, v] of map) out[k] = [...v];
    return out;
  };
  return {
    generic: [...generic],
    genericExcluded: [...genericExcluded],
    perDomain: finalize(perDomain),
    perDomainExcluded: finalize(perDomainExcluded),
    genericHideDisabledDomains: [...new Set(compiled.genericHideExcludes)],
    procedural: { generic: procGeneric, perDomain: procFinal },
    stats: compiled.stats,
  };
}

function hostDomains(hostname) {
  hostname = (hostname || '').toLowerCase();
  const domains = [];
  const parts = hostname.split('.');
  for (let i = 0; i < parts.length; i++) {
    const d = parts.slice(i).join('.');
    if (d.includes('.')) domains.push(d);
    else if (parts.length === 1) domains.push(d);
    if (d.split('.').length === 2) break;
  }
  return domains;
}

export function resolveCosmeticSelectorsSplit(index, hostname) {
  const domains = hostDomains(hostname);
  const excluded = new Set(index.genericExcluded);
  const generic = new Set(index.generic);
  const specific = new Set();
  const disabledDomains = new Set(index.genericHideDisabledDomains || []);

  let disableGeneric = false;
  for (const d of domains) {
    if (disabledDomains.has(d)) disableGeneric = true;
    for (const s of index.perDomain[d] || []) specific.add(s);
    for (const s of index.perDomainExcluded[d] || []) excluded.add(s);
  }
  for (const s of [...generic]) if (isRootSelector(s)) generic.delete(s);
  for (const s of [...specific]) if (isRootSelector(s)) specific.delete(s);
  if (disableGeneric) generic.clear();
  for (const s of excluded) { generic.delete(s); specific.delete(s); }
  // A selector excluded anywhere must not survive in either bucket.
  for (const s of excluded) specific.delete(s);
  return { generic: [...generic], specific: [...specific] };
}

export function resolveCosmeticSelectors(index, hostname) {
  const { generic, specific } = resolveCosmeticSelectorsSplit(index, hostname);
  return [...specific, ...generic];
}

export function resolveProcedural(index, hostname) {
  hostname = (hostname || '').toLowerCase();
  const parts = hostname.split('.');
  const domains = [];
  for (let i = 0; i < parts.length; i++) {
    const d = parts.slice(i).join('.');
    if (d.includes('.')) domains.push(d);
    else if (parts.length === 1) domains.push(d);
    if (d.split('.').length === 2) break;
  }
  const out = [...((index.procedural && index.procedural.generic) || [])];
  const seen = new Set(out.map((e) => e.base + '|' + e.texts.join(',')));
  for (const d of domains) {
    for (const e of (index.procedural && index.procedural.perDomain[d]) || []) {
      const k = e.base + '|' + e.texts.join(',');
      if (!seen.has(k)) { seen.add(k); out.push(e); }
    }
  }
  return out;
}

export function resolveScriptlets(scriptlets, hostname) {
  hostname = (hostname || '').toLowerCase();
  const parts = hostname.split('.');
  const domainSet = new Set();
  for (let i = 0; i < parts.length; i++) {
    const d = parts.slice(i).join('.');
    if (d.includes('.')) domainSet.add(d);
    else if (parts.length === 1) domainSet.add(d);
  }
  const out = [];
  for (const s of scriptlets) {
    const inc = s.include || [];
    const exc = s.exclude || [];
    let target = inc.length === 0;
    for (const d of inc) if (domainSet.has(d)) { target = true; break; }
    if (!target) continue;
    let blocked = false;
    for (const d of exc) if (domainSet.has(d)) { blocked = true; break; }
    if (blocked) continue;
    out.push({ name: s.name, args: s.args });
  }
  return out;
}

export function lineBadfilterKey(rawLine) {
  return normalizeForBadFilter(rawLine);
}

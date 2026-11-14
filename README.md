# Aegis Ad Blocker

**A fast, open-source ad, tracker and cookie-annoyance blocker for Chromium
browsers (Chrome, Brave, Edge, Vivaldi, Opera). Manifest V3, `declarativeNetRequest`,
no accounts, no cloud, no browsing history.**

> Built as a fully working, publishable ad blocker — EasyList + EasyPrivacy +
> Fanboy's Annoyance compiled offline into Chrome's native filtering engine —
> not a toy proof-of-concept.

---

## v1.0.2 — blank-page & Chrome regex hardening

- **Root-cause fix for the blank white page.** Cosmetic domain lists
  ("a.com,b.com##selector") are comma-separated in upstream syntax, but the
  compiler split them on `|` only — so every multi-domain hide rule was one
  invalid domain and collapsed into the *generic* bucket. Among them:
  `aads.com,...##HTML`, which hid the root `<html>` element on every site.
  Domain lists are now split on both separators, root-hiding selectors
  (`html`, `body`, `*`) are rejected at build time and at runtime, and the
  validator fails the build if one ever ships again.
- **Chrome 2KB regex-program limit.** DNR silently skips regex rules whose
  compiled RE2 program exceeds 2KB (you saw the console warnings for
  easylist 44342–44347 / easyprivacy 10892). The compiler now drops any
  regex whose counted repetitions could exceed the budget, and the validator
  rejects violators. Builds are warning-free.
- Rebuilt artifacts: 105,133 DNR rules, cosmetic counts corrected
  (easylist 13,778 generic + 15,574 host-specific; fanboy 27,271 generic +
  40,714 host-specific — the inflated "generic" bucket was the bug's twin).

## v1.0.1 — performance & overblocking fixes

- **Two-phase cosmetic injection.** Site-specific selectors apply at
  `document_start`; the ~45k generic selectors are now injected after
  `window.load` during an idle period, so first paint is never blocked by
  a giant stylesheet.
- **Fanboy's Annoyance now ships disabled by default** (enable it in Options
  or with the popup list toggle). It hides cookie walls and newsletter
  nags aggressively and was the main source of "important things got
  blocked" reports, and its ~30k generic selectors doubled page-load cost.
- Per-list DNR enablement in the manifest matches the new default.

## Is this achievable?

**Yes — with one honest caveat.** An extension can legitimately reproduce the
user-facing behaviour of Brave's content blocker: network-level blocking,
element hiding, anti-adblock defusing and per-site control. What Brave has that
no extension can have is *browser-level* integration (native DNS-rewriting
proxy, CNAME uncloaking, native HTTPS-upgrade, deep renderer hooks, pervasive
implementation below the extension APIs). Everything else is achievable today,
and this repository does it.

| Capability | Brave (browser) | Aegis (this extension) |
| --- | --- | --- |
| Network request blocking | ✅ native | ✅ `declarativeNetRequest` (EasyList/EasyPrivacy/Fanboy, compiled) |
| Element hiding (cosmetic filters) | ✅ | ✅ EasyList/Fanboy cosmetic rules |
| `:has-text()` procedural hiding (cookie walls) | ✅ | ✅ implemented |
| Site-specific rules | ✅ | ✅ |
| Exception rules (`@@`, `$document`, `$generichide`) | ✅ | ✅ |
| Anti-adblock scriptlets | ✅ | ✅ core set (set-constant, abort-on-property-read, set-cookie, set-local-storage-item, cookie-remover, json-prune, remove-class) |
| Cookie-consent defusing | ✅ | ✅ (Fanboy's Annoyance list) |
| Per-site pause, master switch, badge counter | ✅ | ✅ |
| Auto-updated lists between releases | ✅ | ⚠️ lists refresh with extension updates (see [Roadmap](#roadmap)) |
| CNAME uncloaking (first-party trackers) | ✅ | ❌ not possible from an extension |
| Native HTTPS-upgrading / DNS-level filtering | ✅ | ❌ not possible from an extension |
| `$redirect=noop` stub substitution | ✅ | ⚠️ degrades to plain block (safe-action DNR only) |
| `$removeparam` URL rewriting | ✅ | ⚠️ skipped (needs host-modifying permission) |
| `$csp` injection | ✅ | ❌ skipped |

So: **a like-for-like blocker is achievable and this repo is it; a byte-for-byte
Brave replacement is not, and never will be, in extension form.**

---

## Features

- **Ad blocking** — EasyList network rules (49k rules) compiled to DNR
- **Tracker blocking** — EasyPrivacy (53k rules)
- **Annoyance removal** — Fanboy's Annoyance List, uBO flavour: cookie consent
  banners, newsletter prompts, push notifications (2.4k network rules + 30k
  cosmetic selectors + 2.7k scriptlets)
- **Cosmetic filtering** — 46k+ element-hiding selectors, generic +
  site-specific, with exceptions (`#@#`) support
- **Procedural cosmetic filtering** — `:has-text(...)` rules for cookie walls
  and consent banners (623 rules), re-evaluated on DOM mutations
- **Anti-adblock scriptlets** — MAIN-world runner implementing the most-used
  scriptlets in the bundled lists (2,746 rules)
- **`@@` exception rules**, incl. `$document,important` → `allowAllRequests`
  and `$generichide` site-wide cosmetic opt-outs
- **Per-site pause** (toolbar popup), **master switch**, **per-list toggles**,
  **custom user filters** (compiled at runtime), badge counter via
  `setActionCountAsBadgeText()`
- **Fully offline / private** — no telemetry, no accounts, no fingerprinting,
  no remote code. The extension phones home to *nobody*.
- **Static validation + in-memory simulation** of the whole service worker in
  CI-style checks (`npm test`)

## Install (load unpacked)

```bash
git clone https://github.com/Tabish955/Adblocker-extension.git
cd Adblocker-extension
```

The repo ships ready-to-load build artifacts (rulesets, compiled cosmetic
data, generated scriptlet bundle). No build step is required to try it:

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right)
3. **Load unpacked** → select the `extension/` folder
4. Pin Aegis to the toolbar — you're blocking ads

Brave/Edge: same steps at `brave://extensions` / `edge://extensions`.

## Rebuilding the filter database

```bash
npm install        # re2js (regex pre-validation) — dev only
npm run build      # filters/*.txt -> rulesets, cosmetic indexes, scriptlets bundle
npm test           # validate-extension.mjs + simulate-sw.mjs
npm run pack       # zip extension/ -> dist/ (needs `zip`)
```

`filters/README.md` documents how the bundled lists were assembled and how to
refresh them from upstream (EasyList repo).

## How it works

```
┌─────────────────────────────── build time ───────────────────────────────┐
│ filters/easylist.txt  ─┐                                                  │
│ filters/easyprivacy.txt ─┼─► extension/shared/filter-compiler.mjs          │
│ filters/fanboy-annoyance ┘   (ABP/uBO syntax → DNR + cosmetics + scriptlets)│
│                                │            │              │               │
│                    extension/rulesets/*.json  resources/*.cosmetic.json     │
│                                          content/scriptlets-main.js        │
└───────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────── run time ─────────────────────────────────┐
│ Chrome DNR engine ──► blocks network requests natively (49k+53k+2k rules) │
│                                                                          │
│ content-script.js (ISOLATED, document_start)                             │
│   └─► asks service worker for selectors matching this host               │
│       ├─► injects display:none stylesheet                                │
│       └─► evaluates :has-text() rules on DOM mutations                   │
│                                                                          │
│ scriptlets-main.js (MAIN world, document_start)                          │
│   └─► runs anti-adblock scriptlet rules matched by hostname              │
│                                                                          │
│ service-worker.js                                                        │
│   ├─► answers cosmetic/procedural queries per hostname                   │
│   ├─► per-site pause → dynamic allowAllRequests DNR rule                 │
│   ├─► custom user filters → dynamic DNR rules (priority 100)             │
│   └─► badge counter + static-ruleset quota safeguard                     │
└───────────────────────────────────────────────────────────────────────────┘
```

**Why Manifest V3 + `declarativeNetRequest`?** Chrome no longer allows
`webRequestBlocking` for regular extensions. DNR evaluates rules in the
rendering pipeline itself — faster than any JS interception and with zero
access to request contents. The price is expressiveness, which is why the
compiler validates every rule against Chrome's published constraints (and the
build refuses to ship a broken ruleset — packed extensions silently ignore
invalid static rules, so we check them ourselves).

**Static-rule budget.** Chrome guarantees each extension ≥30k static rules;
Aegis ships ~105k across three rulesets. This works in practice (the pool is
shared globally across extensions and §128+ Chrome doesn't count disabled
extensions), and the service worker additionally enforces priority
(`easylist` > `easyprivacy` > `fanboy_annoyance`) via
`getAvailableStaticRuleCount()` if a browser ever reports quota pressure.
Fanboy can be toggled off in Options — Aegis stays fully functional.

## Limitations (honest list)

1. **Popup `$popup` rules are skipped** (2,919 in EasyList) — DNR cannot
   distinguish popups from top-level navigations; Chrome's built-in pop-up
   blocker covers part of this.
2. **`$redirect=noop.js` degrades to block** — safe DNR actions only. Pages
   awaiting a stub response may hit their own error handlers.
3. **Procedural cosmetics are `:has-text()`-only.** `:style()`,
   `:matches-css()`, `:upward()`, `:xpath()` etc. are skipped (1,169 rules).
4. **Anti-adblock coverage is not total.** We implement the ~10 most-used
   scriptlets; exotic ones (`json-edit`, `aost`, `norafif`…) are ignored.
   AdGuard and uBO still win on the hardest anti-adblock sites.
5. **Lists refresh with extension updates.** MV3 static rulesets cannot be
   replaced by downloaded ones at full size (30k dynamic-rule cap), so Aegis
   doesn't pretend to live-update. Store updates ship new lists transparently.
6. **GIF/WebP banner detection heuristics don't exist in DNR** — we rely on
   the lists' URL patterns like everyone else.
7. **First-party tracker CNAME uncloaking is impossible** from an extension.
8. **Badge counter** relies on Chrome's `setActionCountAsBadgeText()` and is
   approximate by design.

## Roadmap

- Firefox port (MV2 with blocking `webRequest` — full uBO-grade engine via
  `@cliqz/adblocker`, MPL-2.0) — the architecture here (shared compiler +
  per-platform shims) is designed for it
- More scriptlets: `json-edit`, `prevent-setTimeout`, `no-fetch-if`
- Element picker (click-to-block-this-element)
- Optional remote list refresh via dynamic rules (top-N rules subset)
- Optional `declarativeNetRequestWithHostAccess` build for `$redirect`/`$removeparam` fidelity
- Scheduled list-update alarms once (3) is viable

## Contributing

Bugs (broken sites welcome): open an issue with the URL and the filter line
suspected. PRs: keep `npm test` green; regenerate `extension/rulesets/*` with
`npm run build` when changing the compiler.

## License & credits

Aegis code: **MIT** (`LICENSE`). Filter lists belong to their authors — see
`NOTICE.md` and `filters/README.md`.

Credit where due: the EasyList project (lists), AdGuard & uBlock Origin
(public filter syntax semantics we compile), Chrome's declarativeNetRequest
docs, and every maintainer who keeps the open lists alive.

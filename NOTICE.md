# Third-party notices & attribution

Aegis Ad Blocker (MIT-licensed, see LICENSE) bundles or derives content from
the following third-party projects and filter lists. Each remains the property
of its authors and is used under its own terms.

## Filter lists (bundled in `filters/`, compiled into `extension/rulesets/` and `extension/resources/`)

| List | Source | Maintainers |
| --- | --- | --- |
| **EasyList** | https://github.com/easylist/easylist | The EasyList authors (Fanboy/ryanbr, MonztA, Khrin, Yuki2718 et al.) |
| **EasyPrivacy** | https://github.com/easylist/easylist | The EasyList authors |
| **Fanboy's Annoyance List** | https://github.com/easylist/easylist (`fanboy-addon/`) | Fanboy (a.k.a. ryanbr) et al. |

The bundled snapshots were assembled from the EasyList monorepo's `master`
branch using the project's official build templates
(`easylist.template`, `easyprivacy.template`, `fanboy-annoyance-uBO.template`),
with the `uBO` flavour of the Annoyance list (includes scriptlets and
uBO-specific cosmetic rules). See `filters/README.md` for provenance and how
to refresh them.

The EasyList project distributes its lists free of charge for use in ad
blockers. We comply with their attribution requirements by crediting the
project here and in the extension's Options → About page. The lists are data,
not code, and remain under their authors' terms.

## Blocking engine & approach

- **Network blocking** uses Chrome's `declarativeNetRequest` API. No code from
  Brave, uBlock Origin or AdGuard is copied into this repository.
- The filter syntax accepted by `extension/shared/filter-compiler.mjs` is the
  public, documented Adblock Plus / uBlock Origin filter syntax. ACCEPTED
  OPTION SEMANTICS were cross-checked against the public documentation of
  AdGuard, ABP and uBO.
- **Scriptlet behaviour** (`set-cookie`, `set-local-storage-item`,
  `set-session-storage-item`, `set-constant`, `abort-on-property-read`,
  `abort-on-property-write`, `cookie-remover`/`remove-cookie`, `json-prune`,
  `remove-class`) is a clean-room implementation of behaviour described in the
  uBlock Origin and AdGuard scriptlet documentation. No GPL/MPL source code
  was copied.
- The idea of compiling filter lists to `declarativeNetRequest` rulesets at
  build time is used by several open-source projects (including uBlock Origin
  Lite and AdGuard's MV3 extension); the implementation here is original.
- **re2js** (dev dependency, build-time only) — pure-JS RE2 engine used to
  pre-validate `regexFilter` rules. MPL-2.0 / Apache-2.0. See its package page.

## Trademarks

Brave, uBlock Origin, AdGuard, Ghostery, Chrome and EasyList are trademarks of
their respective owners. Their use here is for nominative, descriptive
purposes only and does not imply endorsement.

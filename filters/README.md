# Bundled filter lists (provenance & refresh)

This directory contains the raw filter lists shipped with Aegis, assembled
from the EasyList monorepo. They are **data**, not source code; see
`../NOTICE.md` for attribution.

## Files

| File | Assembled from | Template |
| --- | --- | --- |
| `easylist.txt` | `easylist/`, `easylist_adult/` | `easylist.template` |
| `easyprivacy.txt` | `easyprivacy/` (incl. `*_cname_*` tracker lists) | `easyprivacy.template` |
| `fanboy-annoyance.txt` | `fanboy-addon/` (uBO flavour) + `easylist_cookie/` | `fanboy-annoyance-uBO.template` |

Upstream repository: https://github.com/easylist/easylist

The snapshots were taken on **2026-11-14** from the `master` branch (date recorded in `SNAPSHOT.txt`, used for reproducible rebuilds).
`fanboy-annoyance.txt` deliberately uses the **uBO flavour** of the template,
because Aegis implements the scriptlets needed to run those rules
(`set-cookie`, `set-local-storage-item`, …) and the
`##+js(…)` cosmetic rules would be dead weight in the ABP flavour.

## How the files are reassembled

The upstream repo ships component files plus `*.template` manifests that list
which components form each distributable list (`%include easylist:<path>%`).
Reassembly is a simple concatenation in the template's include order — do not
hand-edit the assembled files. To refresh:

```bash
curl -L -o /tmp/easylist.tar.gz https://codeload.github.com/easylist/easylist/tar.gz/refs/heads/master
mkdir -p /tmp/easylist-src && tar -xzf /tmp/easylist.tar.gz -C /tmp/easylist-src

python3 - <<'PY'
# Same logic that produced the shipped files
import re, pathlib
src = pathlib.Path('/tmp/easylist-src/easylist-master')
out = pathlib.Path('filters')
include_re = re.compile(r'^%include easylist:([^%]+)%$')

def expand(template, outname, title):
    parts = [f"[Adblock Plus 2.0]\n! Title: {title}\n\n"]
    for tline in (src / template).read_text(encoding='utf-8', errors='replace').splitlines():
        m = include_re.match(tline.strip())
        if m:
            inc = src / m.group(1).strip()
            parts.append(inc.read_text(encoding='utf-8', errors='replace'))
        elif not tline.startswith('%include'):
            parts.append(tline + '\n')
    (out / outname).write_text(''.join(parts), encoding='utf-8')

expand('easylist.template', 'easylist.txt', 'EasyList (bundled)')
expand('easyprivacy.template', 'easyprivacy.txt', 'EasyPrivacy (bundled)')
expand('fanboy-annoyance-uBO.template', 'fanboy-annoyance.txt', "Fanboy's Annoyance List (uBO flavour, bundled)")
PY

npm run build    # recompile rulesets, cosmetic indexes and the scriptlet bundle
npm run validate # sanity-check everything Chrome will check (and more)
```

## Licence

The lists belong to their authors and are redistributed here in unmodified
(assembled) form for use in blocking. See `../NOTICE.md` and
https://easylist.to/ for details. If you redistribute Aegis, keep the
attribution intact.

"""Shared naming and cross-file reference resolution.

Two file-node qualified-name schemes coexist so a single graph can hold both a
Python/JS *call graph* and a plain *file dependency graph* without either
interfering with the other:

- **Code files** (`.py .js .jsx .mjs .cjs .ts .tsx`) get a **dotted,
  extension-stripped** qualified name (``src/app/util.js`` -> ``src.app.util``).
  This is the shape the resolver's cascade (imports -> self -> same-module ->
  unique) already understands, so JS/TS reuse it verbatim.
- **Everything else** (HTML, CSS, JSON, YAML, TOML, XML, config) keeps its
  **repo-relative POSIX path with extension** as the qualified name
  (``index.html``, ``styles/site.css``, ``package.json``). These only ever appear
  as file->file ``IMPORTS`` targets, which resolve by exact match and never touch
  the dotted cascade.

Because *every* extractor computes the qualified name of a referenced file through
`file_qname` here, cross-type links line up: an HTML ``<script src="app.js">``
computes ``app`` (matching the JS file node) while ``<link href="a.css">``
computes ``a.css`` (matching the CSS file node).

Nothing here touches the filesystem: references resolve to *candidate* qualified
names purely by path arithmetic, and the resolver decides later (by existence in
the graph) whether a candidate is in-project.
"""

from __future__ import annotations

import posixpath
import re
from typing import Optional

# Extensions treated as "code" (dotted module qnames). Keep in sync with the
# language registry; adding a code language here makes its files resolvable as
# dotted modules by the resolver cascade.
CODE_EXTS = frozenset(
    {".py", ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"}
)

# A trailing path segment with one of these names denotes the package/directory
# itself, so it is dropped from the dotted module name (Python ``__init__``,
# Node ``index``). This makes ``pkg/__init__.py`` and ``dir/index.js`` resolve to
# ``pkg`` / ``dir``, matching how each ecosystem imports them.
_INDEX_NAMES = frozenset({"__init__", "index"})

_SCHEME_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9+.\-]*:")


def _dotify(path_no_ext: str) -> str:
    parts = [seg for seg in path_no_ext.split("/") if seg]
    if len(parts) > 1 and parts[-1] in _INDEX_NAMES:
        parts = parts[:-1]
    return ".".join(parts)


def file_qname(rel_path: str) -> str:
    """Qualified name of a *file* node from its repo-relative path.

    Dotted-and-extension-stripped for code files, path-with-extension otherwise
    (see module docstring).
    """
    rel = rel_path.replace("\\", "/").lstrip("/")
    root, ext = posixpath.splitext(rel)
    if ext.lower() in CODE_EXTS:
        return _dotify(root)
    return rel


def _clean_ref(ref: str) -> str:
    return ref.strip().strip("'").strip('"').strip()


def is_external(ref: str) -> bool:
    """True for anything that is not an in-repo file path.

    Absolute URLs (``https://``), protocol-relative (``//cdn...``), and any other
    URI scheme (``data:``, ``mailto:``, ``tel:``) are external.
    """
    r = _clean_ref(ref)
    return r.startswith("//") or bool(_SCHEME_RE.match(r))


# Back-compat internal alias.
_is_external = is_external


def _resolve_path(from_rel: str, ref: str) -> Optional[str]:
    """Resolve a reference to a normalized repo-relative POSIX path, or None.

    Returns None for external URLs, pure anchors, and anything that escapes the
    repo root (``../`` above the top). A leading ``/`` is treated as
    repo-root-relative (as a web server would serve it).
    """
    if _is_external(ref):
        return None
    r = _clean_ref(ref).split("?", 1)[0].split("#", 1)[0].strip()
    if not r:
        return None
    if r.startswith("/"):
        joined = posixpath.normpath(r.lstrip("/"))
    else:
        base = posixpath.dirname(from_rel.replace("\\", "/"))
        joined = posixpath.normpath(posixpath.join(base, r) if base else r)
    joined = joined.replace("\\", "/")
    if joined == "." or joined == ".." or joined.startswith("../"):
        return None
    return joined


def resolve_ref(from_rel: str, ref: str) -> Optional[str]:
    """Resolve an HTML/CSS ``src``/``href``/``@import`` to a repo-relative path.

    Bare references (``styles.css``) are relative to the referring file's
    directory. The caller passes the result through `file_qname` to get the
    ``IMPORTS`` destination. Returns None for external/unresolvable refs.
    """
    return _resolve_path(from_rel, ref)


def js_import_module(from_rel: str, ref: str) -> Optional[str]:
    """Resolve a JS/TS import specifier to a destination qualified name, or None.

    - Bare specifiers (``react``, ``lodash/fp``) are npm packages -> None
      (the caller records them as external imports).
    - Relative/rooted code modules (``./utils``, ``../lib/x.js``) -> dotted module
      qname, dropping the extension and a trailing ``index``.
    - Relative asset imports (``./theme.css``, ``./data.json``) -> the asset's
      path-with-extension qname, so a bundler-style ``import './x.css'`` links to
      the real CSS/JSON file node.
    """
    r = _clean_ref(ref)
    if not r:
        return None
    if not (r.startswith(".") or r.startswith("/")):
        return None  # bare npm specifier -> external
    path = _resolve_path(from_rel, r)
    if path is None:
        return None
    root, ext = posixpath.splitext(path)
    if ext and ext.lower() not in CODE_EXTS:
        return file_qname(path)  # asset import -> reference the file node directly
    return _dotify(root)  # code module -> dotted, ext + trailing index stripped

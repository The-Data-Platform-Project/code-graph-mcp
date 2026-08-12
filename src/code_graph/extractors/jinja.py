"""Jinja template extraction (regex pass, no grammar).

The HTML grammar treats ``{% ... %}``/``{{ ... }}`` as text, so template lineage
and macros are invisible to a pure-HTML parse. This layer scans the raw source
for the constructs that carry structure and turns them into graph elements:

- ``{% extends "base.html" %}`` / ``{% include "p/_x.html" %}`` and
  ``{% import/from "macros.html" ... %}`` -> ``IMPORTS`` edges (kind ``template``).
  Template names are resolved against the template *root*, which we don't know
  here, so — exactly like absolute ``/static`` asset paths — the target is left
  for the resolver's uniqueness-gated trailing-path match.
- ``{% macro password_field(...) %}`` -> a ``Function`` node
  (``<template>.password_field``), so `search_symbol` finds it and
  `get_callers` answers "which templates use this macro".
- Uses of a *known* macro binding (``{{ password_field() }}``,
  ``{{ m.password_field() }}``, ``{% call password_field() %}``) -> ``CALLS``
  edges. Only bindings introduced by imports/aliases or local ``{% macro %}``
  defs count, so template globals like ``url_for(...)`` don't create noise.

Called by the HTML extractor for every ``.html``/``.htm``/``.jinja`` file; on a
template with no Jinja tags it simply finds nothing.
"""

from __future__ import annotations

import re

from ..models import (
    EDGE_CALLS,
    EDGE_CONTAINS,
    EDGE_IMPORTS,
    KIND_FUNCTION,
    Edge,
    Import,
    Node,
)
from ..naming import file_qname, resolve_ref

_COMMENT = re.compile(r"\{#.*?#\}", re.S)
_TAG = re.compile(r"\{%[-+]?\s*(.*?)\s*[-+]?%\}", re.S)
_EXPR = re.compile(r"\{\{[-+]?\s*(.*?)\s*[-+]?\}\}", re.S)

_EXTENDS = re.compile(r'^extends\s+["\'](.+?)["\']')
_INCLUDE = re.compile(r'^include\s+["\'](.+?)["\']')
_IMPORT = re.compile(r'^import\s+["\'](.+?)["\']\s+as\s+(\w+)')
_FROM = re.compile(r'^from\s+["\'](.+?)["\']\s+import\s+(.+)$', re.S)
_MACRO = re.compile(r"^macro\s+([A-Za-z_]\w*)\s*\(")
_CALL_HEAD = re.compile(r"([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*\(")
_IMPORT_NAME = re.compile(r"^(\w+)(?:\s+as\s+(\w+))?$")

# Statement keywords that are definitions/imports, not macro uses.
_SKIP_KEYWORDS = frozenset({"macro", "from", "import", "extends", "include"})


def has_jinja(source: str) -> bool:
    return "{%" in source or "{{" in source or "{#" in source


def scan_jinja(source: str, file_path: str) -> tuple[list[Node], list[Edge], list[Import]]:
    nodes: list[Node] = []
    edges: list[Edge] = []
    imports: list[Import] = []
    if not has_jinja(source):
        return nodes, edges, imports

    qname = file_qname(file_path)
    # Blank out comments while preserving offsets/newlines (macro-def line numbers).
    text = _COMMENT.sub(lambda m: re.sub(r"[^\n]", " ", m.group(0)), source)

    bindings: set[str] = set()  # names that denote a macro (imports/aliases/local defs)

    def add_template_dep(ref: str) -> None:
        ref = ref.strip()
        if not ref:
            return
        guess = resolve_ref(file_path, ref)
        target = file_qname(guess) if guess else ref
        imports.append(Import(file_path, ref, target, "template"))
        edges.append(Edge(EDGE_IMPORTS, qname, target, ref, file_path, 0))

    # --- pass 1: template deps, macro defs, and macro bindings ---
    for m in _TAG.finditer(text):
        body = m.group(1).strip()
        if not body:
            continue
        keyword = body.split(None, 1)[0]
        if keyword == "extends":
            mm = _EXTENDS.match(body)
            if mm:
                add_template_dep(mm.group(1))
        elif keyword == "include":
            mm = _INCLUDE.match(body)
            if mm:
                add_template_dep(mm.group(1))
        elif keyword == "import":
            mm = _IMPORT.match(body)
            if mm:
                add_template_dep(mm.group(1))
                bindings.add(mm.group(2))  # `import "x" as m` -> alias m
        elif keyword == "from":
            mm = _FROM.match(body)
            if mm:
                add_template_dep(mm.group(1))
                bindings.update(_import_names(mm.group(2)))
        elif keyword == "macro":
            mm = _MACRO.match(body)
            if mm:
                name = mm.group(1)
                line = text.count("\n", 0, m.start()) + 1
                mqname = f"{qname}.{name}"
                nodes.append(
                    Node(KIND_FUNCTION, name, mqname, file_path, line, line, f"macro {name}")
                )
                edges.append(Edge(EDGE_CONTAINS, qname, mqname, mqname, file_path, 1))
                bindings.add(name)

    if not bindings:
        return nodes, _dedupe_edges(edges), _dedupe_imports(imports)

    # --- pass 2: uses of known macro bindings ---
    seen_calls: set[str] = set()

    def scan_region(region: str) -> None:
        for cm in _CALL_HEAD.finditer(region):
            dotted = cm.group(1)
            if dotted in seen_calls:
                continue
            if dotted.split(".", 1)[0] in bindings or dotted in bindings:
                seen_calls.add(dotted)
                edges.append(Edge(EDGE_CALLS, qname, dotted, dotted, file_path, 0))

    for m in _EXPR.finditer(text):
        scan_region(m.group(1))
    for m in _TAG.finditer(text):
        body = m.group(1).strip()
        if not body:
            continue
        if body.split(None, 1)[0] in _SKIP_KEYWORDS:
            continue  # don't read a macro def line as a self-call, skip imports
        scan_region(body)

    return nodes, _dedupe_edges(edges), _dedupe_imports(imports)


def _import_names(spec: str) -> list[str]:
    spec = re.sub(r"\s+with(out)?\s+context\s*$", "", spec.strip())
    names = []
    for part in spec.split(","):
        mm = _IMPORT_NAME.match(part.strip())
        if mm:
            names.append(mm.group(2) or mm.group(1))  # alias if present, else name
    return names


def _dedupe_edges(edges: list[Edge]) -> list[Edge]:
    seen: set[tuple] = set()
    out = []
    for e in edges:
        key = (e.edge_type, e.src_qname, e.dst_raw)
        if key not in seen:
            seen.add(key)
            out.append(e)
    return out


def _dedupe_imports(imports: list[Import]) -> list[Import]:
    seen: set[tuple] = set()
    out = []
    for im in imports:
        key = (im.file_path, im.local_name)
        if key not in seen:
            seen.add(key)
            out.append(im)
    return out

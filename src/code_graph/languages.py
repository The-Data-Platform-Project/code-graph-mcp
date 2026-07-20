"""File -> grammar/extractor registry.

Adding a language is a small, local change: install its `tree-sitter-<lang>`
wheel (if it needs a grammar), add it to requirements, and append one
`LanguageSpec` entry here pointing at an extractor. Nothing else in the pipeline
needs to know about languages.

A spec may be **grammar-less** (`grammar_module is None`): the indexer then calls
the extractor with `tree=None`. This backs the generic config-file fallback and
any format we index by presence/heuristics rather than a full parse (JSON's
`package.json` handling, arbitrary `.ini`/dotfiles, `Dockerfile`, ...).

Some grammars expose their `Language` under a non-default symbol (TypeScript ships
`language_typescript`/`language_tsx`); `LanguageSpec.language_symbol` names it.

Lookups are keyed by exact basename first (so extensionless files like
`Dockerfile` and dotfiles like `.gitignore` are supported) and then by extension.
Parsers/extractors are built lazily and cached per spec, so importing this module
is cheap and grammars that are never exercised cost nothing.
"""

from __future__ import annotations

import importlib
import posixpath
from dataclasses import dataclass
from typing import Callable, Optional

from tree_sitter import Language, Parser

from .extractors.base import Extractor
from .extractors.css import CssExtractor
from .extractors.generic import GenericFileExtractor
from .extractors.html import HtmlExtractor
from .extractors.javascript import JavaScriptExtractor
from .extractors.json import JsonExtractor
from .extractors.python import PythonExtractor
from .extractors.yaml import YamlExtractor


@dataclass(frozen=True)
class LanguageSpec:
    name: str  # unique; keys the parser/extractor caches
    grammar_module: Optional[str]  # PyPI binding module, or None for grammar-less
    extractor_factory: Callable[[], Extractor]
    language_symbol: str = "language"  # grammar attribute returning the Language


# Reusable specs (referenced by several extensions).
_JS = LanguageSpec("javascript", "tree_sitter_javascript", JavaScriptExtractor)
_TS = LanguageSpec(
    "typescript", "tree_sitter_typescript", JavaScriptExtractor, "language_typescript"
)
_TSX = LanguageSpec(
    "tsx", "tree_sitter_typescript", JavaScriptExtractor, "language_tsx"
)
_GENERIC = LanguageSpec("generic", None, GenericFileExtractor)


# Extension registry (keys are lowercase, leading dot). One entry per extension.
_REGISTRY: dict[str, LanguageSpec] = {
    ".py": LanguageSpec("python", "tree_sitter_python", PythonExtractor),
    # JavaScript family (tree-sitter-javascript handles JSX too).
    ".js": _JS,
    ".jsx": _JS,
    ".mjs": _JS,
    ".cjs": _JS,
    # TypeScript.
    ".ts": _TS,
    ".tsx": _TSX,
    # Web assets.
    ".html": LanguageSpec("html", "tree_sitter_html", HtmlExtractor),
    ".htm": LanguageSpec("html", "tree_sitter_html", HtmlExtractor),
    ".css": LanguageSpec("css", "tree_sitter_css", CssExtractor),
    # Data / config. JSON is grammar-less (stdlib json for the package.json
    # special case); YAML uses its grammar to read compose `services:`.
    ".json": LanguageSpec("json", None, JsonExtractor),
    ".yaml": LanguageSpec("yaml", "tree_sitter_yaml", YamlExtractor),
    ".yml": LanguageSpec("yaml", "tree_sitter_yaml", YamlExtractor),
    # Config formats indexed as a searchable file node (grammar-less). Structural
    # TOML/XML extraction is a future one-line swap to a grammar-backed spec.
    ".toml": _GENERIC,
    ".xml": _GENERIC,
    ".ini": _GENERIC,
    ".cfg": _GENERIC,
    ".conf": _GENERIC,
    ".properties": _GENERIC,
    ".lock": _GENERIC,
}

# Exact-basename registry: extensionless files and dotfiles the splitext-based
# extension lookup can't see.
_FILENAME_REGISTRY: dict[str, LanguageSpec] = {
    name: _GENERIC
    for name in (
        "Dockerfile",
        "Makefile",
        "makefile",
        "Procfile",
        ".gitignore",
        ".dockerignore",
        ".editorconfig",
        ".npmrc",
        ".prettierrc",
        ".eslintrc",
        ".babelrc",
        ".env",
    )
}

# Lazily-built parsers/extractors keyed by spec name.
_parsers: dict[str, Optional[Parser]] = {}
_extractors: dict[str, Extractor] = {}


def _basename(rel_path: str) -> str:
    return rel_path.replace("\\", "/").rsplit("/", 1)[-1]


def spec_for(rel_path: str) -> Optional[LanguageSpec]:
    """Resolve a repo-relative path to its LanguageSpec, or None if unsupported.

    Exact basename wins over extension so `Dockerfile`/`.gitignore` resolve, and
    the `.env` family (`.env`, `.env.local`, ...) is treated as generic config.
    """
    name = _basename(rel_path)
    spec = _FILENAME_REGISTRY.get(name)
    if spec is not None:
        return spec
    if name == ".env" or name.startswith(".env."):
        return _GENERIC
    ext = posixpath.splitext(name)[1].lower()
    return _REGISTRY.get(ext) if ext else None


def is_supported(rel_path: str) -> bool:
    return spec_for(rel_path) is not None


def _build_parser(spec: LanguageSpec) -> Optional[Parser]:
    if spec.grammar_module is None:
        return None
    grammar = importlib.import_module(spec.grammar_module)
    language = Language(getattr(grammar, spec.language_symbol)())
    return Parser(language)


def parser_for(spec: LanguageSpec) -> Optional[Parser]:
    """The (cached) parser for a spec.

    Returns None for grammar-less specs and, defensively, when a declared grammar
    wheel cannot be imported/loaded — so a partial install degrades to skipping
    those files rather than aborting a whole-repo index. The failure is cached so
    it is not retried for every file.
    """
    if spec.name not in _parsers:
        try:
            _parsers[spec.name] = _build_parser(spec)
        except Exception:
            _parsers[spec.name] = None
    return _parsers[spec.name]


def extractor_for(spec: LanguageSpec) -> Extractor:
    """The (cached) extractor for a spec."""
    extractor = _extractors.get(spec.name)
    if extractor is None:
        extractor = spec.extractor_factory()
        _extractors[spec.name] = extractor
    return extractor


# -- Back-compat helpers (accept a bare extension or a path) ----------------
def _spec_from_key(key: str) -> Optional[LanguageSpec]:
    # A bare extension like ".py" has no basename to match; treat it as a path.
    return spec_for("x" + key) if key.startswith(".") and "/" not in key else spec_for(key)


def get_parser(key: str) -> Optional[Parser]:
    spec = _spec_from_key(key)
    return parser_for(spec) if spec is not None else None


def get_extractor(key: str) -> Optional[Extractor]:
    spec = _spec_from_key(key)
    return extractor_for(spec) if spec is not None else None

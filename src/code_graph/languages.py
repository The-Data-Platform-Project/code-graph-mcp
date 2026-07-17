"""Extension -> grammar/extractor registry.

Adding a language is a one-line change: install its `tree-sitter-<lang>` wheel,
add it to requirements, and append one `LanguageSpec` entry here pointing at an
extractor. Nothing else in the pipeline needs to know about languages.

The tree-sitter `Language` and `Parser` objects are built lazily and cached the
first time a language is used, so importing this module is cheap and grammars
that are never exercised cost nothing.
"""

from __future__ import annotations

import importlib
from dataclasses import dataclass
from typing import Callable, Optional

from tree_sitter import Language, Parser

from .extractors.base import Extractor
from .extractors.python import PythonExtractor


@dataclass(frozen=True)
class LanguageSpec:
    name: str
    grammar_module: str  # PyPI binding module, e.g. "tree_sitter_python"
    extractor_factory: Callable[[], Extractor]


# The single source of truth. One entry per supported language.
# NOTE: keys are lowercase file extensions including the leading dot.
_REGISTRY: dict[str, LanguageSpec] = {
    ".py": LanguageSpec(
        name="python",
        grammar_module="tree_sitter_python",
        extractor_factory=PythonExtractor,
    ),
    # To add e.g. JavaScript later:
    #   ".js": LanguageSpec("javascript", "tree_sitter_javascript", JsExtractor),
}

# Lazily-built parsers/extractors keyed by extension.
_parsers: dict[str, Parser] = {}
_extractors: dict[str, Extractor] = {}


def is_supported(extension: str) -> bool:
    return extension.lower() in _REGISTRY


def supported_extensions() -> tuple[str, ...]:
    return tuple(_REGISTRY.keys())


def _build_parser(spec: LanguageSpec) -> Parser:
    grammar = importlib.import_module(spec.grammar_module)
    language = Language(grammar.language())
    return Parser(language)


def get_parser(extension: str) -> Optional[Parser]:
    ext = extension.lower()
    spec = _REGISTRY.get(ext)
    if spec is None:
        return None
    parser = _parsers.get(ext)
    if parser is None:
        parser = _build_parser(spec)
        _parsers[ext] = parser
    return parser


def get_extractor(extension: str) -> Optional[Extractor]:
    ext = extension.lower()
    spec = _REGISTRY.get(ext)
    if spec is None:
        return None
    extractor = _extractors.get(ext)
    if extractor is None:
        extractor = spec.extractor_factory()
        _extractors[ext] = extractor
    return extractor

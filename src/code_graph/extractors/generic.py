"""Generic grammar-less extractor.

The broad-coverage fallback for config formats we index by *presence* rather than
by parsing a grammar (`.ini`, `.toml`, `.xml`, `.env`, `Dockerfile`, `Makefile`,
dotfiles, ...). It emits a single `Config` file node so the file is searchable,
snippet-able, and a valid dependency target — no tree required.

Richer, format-specific extraction (structural TOML/XML, etc.) can later replace
a `_GENERIC` registry entry with a grammar-backed spec without touching anything
else.
"""

from __future__ import annotations

from typing import Optional

from tree_sitter import Tree

from ..models import KIND_CONFIG, FileResult, Node
from ..naming import file_qname
from .base import Extractor


class GenericFileExtractor(Extractor):
    def extract(
        self, tree: Optional[Tree], source: bytes, file_path: str
    ) -> FileResult:
        node = Node(
            kind=KIND_CONFIG,
            name=file_path.rsplit("/", 1)[-1],
            qualified_name=file_qname(file_path),
            file_path=file_path,
            start_line=1,
            end_line=source.count(b"\n") + 1,
            signature=None,
        )
        return FileResult(nodes=[node], edges=[], imports=[])

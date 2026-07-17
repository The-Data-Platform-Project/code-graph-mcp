"""Lightweight value types shared across the extractor, indexer and resolver.

These are deliberately plain dataclasses of strings and ints — no parse-tree
references are ever held here, so a batch of them stays small and is trivially
discardable after it is flushed to SQLite.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

# --- Node kinds ------------------------------------------------------------
KIND_FILE = "File"
KIND_CLASS = "Class"
KIND_FUNCTION = "Function"
KIND_METHOD = "Method"
KIND_INTERFACE = "Interface"

# --- Edge types ------------------------------------------------------------
EDGE_CONTAINS = "CONTAINS"
EDGE_IMPORTS = "IMPORTS"
EDGE_CALLS = "CALLS"
EDGE_INHERITS = "INHERITS"
EDGE_IMPLEMENTS = "IMPLEMENTS"
EDGE_USES_TYPE = "USES_TYPE"

# Edge types whose destination is a raw symbol string that must be resolved to
# a real node after the whole repo is indexed. CONTAINS/IMPORTS are known at
# extraction time and never go through the resolution cascade.
RESOLVABLE_EDGES = (EDGE_CALLS, EDGE_INHERITS, EDGE_IMPLEMENTS, EDGE_USES_TYPE)


@dataclass(slots=True)
class Node:
    kind: str
    name: str
    qualified_name: str
    file_path: str  # repo-relative, POSIX separators
    start_line: int
    end_line: int
    signature: Optional[str] = None


@dataclass(slots=True)
class Edge:
    edge_type: str
    src_qname: str
    dst_qname: str  # resolved qname, or the raw callee/base string until resolved
    dst_raw: str  # original raw string as it appeared in source
    src_file: str  # repo-relative file of the source node
    resolved: int = 0  # 1 once dst_qname points at a real in-graph node


@dataclass(slots=True)
class Import:
    file_path: str  # repo-relative, POSIX separators
    local_name: str  # the name bound in the importing file's namespace
    target: str  # fully-qualified import target (module or module.symbol)
    kind: str  # "module" or "symbol"


@dataclass(slots=True)
class FileResult:
    """Everything extracted from a single source file."""

    nodes: list[Node]
    edges: list[Edge]
    imports: list[Import]

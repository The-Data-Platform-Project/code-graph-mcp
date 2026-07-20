"""JSON extractor (grammar-less).

Emits a `Config` file node for any ``.json``. For ``package.json`` it additionally
records each declared npm dependency as an *external* import, so
``get_dependencies("package.json")`` lists a project's third-party packages. The
JSON is read with the standard library (the data is already in memory); no
tree-sitter grammar is needed.
"""

from __future__ import annotations

import json
from typing import Optional

from tree_sitter import Tree

from ..models import EDGE_IMPORTS, KIND_CONFIG, Edge, FileResult, Import, Node
from ..naming import file_qname
from .base import Extractor

_DEP_SECTIONS = (
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
)


class JsonExtractor(Extractor):
    def extract(
        self, tree: Optional[Tree], source: bytes, file_path: str
    ) -> FileResult:
        qname = file_qname(file_path)
        nodes = [
            Node(
                kind=KIND_CONFIG,
                name=file_path.rsplit("/", 1)[-1],
                qualified_name=qname,
                file_path=file_path,
                start_line=1,
                end_line=source.count(b"\n") + 1,
                signature=None,
            )
        ]
        edges: list[Edge] = []
        imports: list[Import] = []

        if file_path.rsplit("/", 1)[-1] == "package.json":
            for name in _package_deps(source):
                imports.append(Import(file_path, name, name, "external"))
                edges.append(Edge(EDGE_IMPORTS, qname, name, name, file_path, 0))

        return FileResult(nodes=nodes, edges=edges, imports=imports)


def _package_deps(source: bytes) -> list[str]:
    try:
        data = json.loads(source.decode("utf-8", "replace"))
    except (ValueError, UnicodeError):
        return []
    if not isinstance(data, dict):
        return []
    names: list[str] = []
    seen: set[str] = set()
    for section in _DEP_SECTIONS:
        block = data.get(section)
        if isinstance(block, dict):
            for name in block:
                if isinstance(name, str) and name not in seen:
                    seen.add(name)
                    names.append(name)
    return names

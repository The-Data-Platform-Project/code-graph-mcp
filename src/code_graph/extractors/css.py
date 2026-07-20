"""CSS extractor.

Emits a File node plus one dependency edge per ``@import`` (both
``@import "x.css"`` and ``@import url("x.css")`` forms) so stylesheet-to-stylesheet
dependencies join the graph. Selector/rule-level nodes are intentionally omitted
(lightweight; a future addition).
"""

from __future__ import annotations

from typing import Optional

from tree_sitter import Node as TSNode
from tree_sitter import Tree

from ..models import EDGE_IMPORTS, KIND_FILE, Edge, FileResult, Import, Node
from ..naming import file_qname, is_external, resolve_ref
from .base import Extractor


class CssExtractor(Extractor):
    def extract(self, tree: Tree, source: bytes, file_path: str) -> FileResult:
        nodes: list[Node] = []
        edges: list[Edge] = []
        imports: list[Import] = []

        def text(node: TSNode) -> str:
            return source[node.start_byte : node.end_byte].decode("utf-8", "replace")

        qname = file_qname(file_path)
        nodes.append(
            Node(
                kind=KIND_FILE,
                name=file_path.rsplit("/", 1)[-1],
                qualified_name=qname,
                file_path=file_path,
                start_line=1,
                end_line=source.count(b"\n") + 1,
                signature=None,
            )
        )

        def add_ref(ref: str) -> None:
            ref = ref.strip().strip("'").strip('"').strip()
            if not ref:
                return
            if is_external(ref):
                imports.append(Import(file_path, ref, ref, "external"))
                edges.append(Edge(EDGE_IMPORTS, qname, ref, ref, file_path, 0))
                return
            path = resolve_ref(file_path, ref)
            if path is None:
                return
            target = file_qname(path)
            imports.append(Import(file_path, ref, target, "asset"))
            edges.append(Edge(EDGE_IMPORTS, qname, target, ref, file_path, 0))

        # Walk to each @import and take its first string/plain value as the target.
        stack = [tree.root_node]
        while stack:
            n = stack.pop()
            if n.type == "import_statement":
                val = _first_value(n)
                if val is not None:
                    add_ref(text(val))
            for i in range(n.named_child_count):
                stack.append(n.named_child(i))

        return _dedupe(FileResult(nodes=nodes, edges=edges, imports=imports))


def _first_value(node: TSNode) -> Optional[TSNode]:
    """First string_value/plain_value under an import_statement (unwraps url())."""
    stack = [node]
    while stack:
        n = stack.pop(0)
        if n.type in ("string_value", "plain_value"):
            return n
        for i in range(n.named_child_count):
            stack.append(n.named_child(i))
    return None


def _dedupe(result: FileResult) -> FileResult:
    seen_edges: set[tuple] = set()
    edges = []
    for e in result.edges:
        key = (e.edge_type, e.src_qname, e.dst_raw)
        if key not in seen_edges:
            seen_edges.add(key)
            edges.append(e)
    seen_imports: set[tuple] = set()
    imports = []
    for im in result.imports:
        key = (im.file_path, im.local_name)
        if key not in seen_imports:
            seen_imports.add(key)
            imports.append(im)
    return FileResult(nodes=result.nodes, edges=edges, imports=imports)

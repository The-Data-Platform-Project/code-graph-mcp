"""HTML extractor.

Emits a File node plus the page's *dependency* edges: every ``src``/``href``
attribute that points at an in-repo file (``<script src>``, ``<link href>``,
``<a href>``, ``<img src>``, ...) becomes an IMPORTS edge to that file's node,
and external URLs (CDNs) are recorded as honest external dependencies. Inline
``<script>``/``<style>`` bodies are not sub-noded (lightweight by design).

Because the destination qualified name is computed with `naming.file_qname`, a
``<script src="app.js">`` links to the JS *module* node (`app`) and a
``<link href="css/site.css">`` links to the CSS *file* node (`css/site.css`),
tying the page into the same dependency graph as the code.
"""

from __future__ import annotations

from typing import Optional

from tree_sitter import Node as TSNode
from tree_sitter import Tree

from ..models import EDGE_IMPORTS, KIND_FILE, Edge, FileResult, Import, Node
from ..naming import file_qname, is_external, resolve_ref
from .base import Extractor

# Attributes whose value is a URL/path to another resource.
_REF_ATTRS = frozenset({"src", "href"})


class HtmlExtractor(Extractor):
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
            if not ref:
                return
            if is_external(ref):
                imports.append(Import(file_path, ref, ref, "external"))
                edges.append(Edge(EDGE_IMPORTS, qname, ref, ref, file_path, 0))
                return
            path = resolve_ref(file_path, ref)
            if path is None:
                return  # anchor, or escapes the repo
            target = file_qname(path)
            imports.append(Import(file_path, ref, target, "asset"))
            edges.append(Edge(EDGE_IMPORTS, qname, target, ref, file_path, 0))

        # A flat scan over every `attribute` node catches src/href on ordinary
        # elements as well as inside <script>/<link>/<style> start tags.
        stack = [tree.root_node]
        while stack:
            n = stack.pop()
            if n.type == "attribute":
                name, value = _attr(n, text)
                if name in _REF_ATTRS and value is not None:
                    add_ref(value)
            for i in range(n.named_child_count):
                stack.append(n.named_child(i))

        return _dedupe(FileResult(nodes=nodes, edges=edges, imports=imports))


def _attr(node: TSNode, text) -> tuple[Optional[str], Optional[str]]:
    name: Optional[str] = None
    value: Optional[str] = None
    for i in range(node.named_child_count):
        ch = node.named_child(i)
        if ch.type == "attribute_name":
            name = text(ch).lower()
        elif ch.type == "quoted_attribute_value":
            inner = None
            for j in range(ch.named_child_count):
                if ch.named_child(j).type == "attribute_value":
                    inner = ch.named_child(j)
                    break
            value = text(inner) if inner is not None else text(ch).strip("\"'")
        elif ch.type == "attribute_value":
            value = text(ch)
    return name, value


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

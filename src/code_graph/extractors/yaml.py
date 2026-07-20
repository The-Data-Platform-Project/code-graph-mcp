"""YAML extractor.

Emits a `Config` file node for any ``.yaml``/``.yml``. For a Docker Compose file
(``docker-compose.yml``, ``compose.yaml``, ...) it additionally emits a `Service`
node per entry under top-level ``services:`` (CONTAINS from the file) and a
service->service dependency (IMPORTS) for each ``depends_on`` entry, so the
service topology is queryable (``search_symbol`` finds services;
``get_dependencies`` lists what each service waits on).

Generic YAML is left as a file node only (lightweight; no key-by-key graphing).
"""

from __future__ import annotations

from collections import deque
from typing import Optional

from tree_sitter import Node as TSNode
from tree_sitter import Tree

from ..models import (
    EDGE_CONTAINS,
    EDGE_IMPORTS,
    KIND_CONFIG,
    KIND_SERVICE,
    Edge,
    FileResult,
    Import,
    Node,
)
from ..naming import file_qname
from .base import Extractor

_COMPOSE_FILES = frozenset(
    {"docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"}
)
_MAPPINGS = ("block_mapping", "flow_mapping")
_SEQUENCES = ("block_sequence", "flow_sequence")
_SCALARS = frozenset(
    {
        "plain_scalar", "string_scalar", "single_quote_scalar",
        "double_quote_scalar", "integer_scalar", "float_scalar",
        "boolean_scalar", "null_scalar", "block_scalar",
    }
)


class YamlExtractor(Extractor):
    def extract(self, tree: Tree, source: bytes, file_path: str) -> FileResult:
        def text(node: TSNode) -> str:
            return source[node.start_byte : node.end_byte].decode("utf-8", "replace")

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

        if file_path.rsplit("/", 1)[-1] in _COMPOSE_FILES:
            services_val = _child_value(tree.root_node, "services", text)
            svc_map = _to_mapping(services_val) if services_val else None
            for pair in _pairs(svc_map):
                name = _leaf_scalar(pair.child_by_field_name("key"), text)
                if not name:
                    continue
                svc_qname = f"{qname}::{name}"
                nodes.append(
                    Node(
                        kind=KIND_SERVICE,
                        name=name,
                        qualified_name=svc_qname,
                        file_path=file_path,
                        start_line=pair.start_point[0] + 1,
                        end_line=pair.end_point[0] + 1,
                        signature=None,
                    )
                )
                edges.append(
                    Edge(EDGE_CONTAINS, qname, svc_qname, svc_qname, file_path, 1)
                )
                for dep in _depends_on(pair.child_by_field_name("value"), text):
                    dep_qname = f"{qname}::{dep}"
                    edges.append(
                        Edge(EDGE_IMPORTS, svc_qname, dep_qname, dep, file_path, 0)
                    )
                    imports.append(
                        Import(file_path, f"{name}->{dep}", dep_qname, "service")
                    )

        return FileResult(nodes=nodes, edges=edges, imports=imports)


# --- tree-sitter-yaml navigation (defensive; unknown shapes -> skip) --------
def _to_mapping(node: Optional[TSNode]) -> Optional[TSNode]:
    """Shallowest block/flow mapping at or under `node` (BFS)."""
    if node is None:
        return None
    q = deque([node])
    while q:
        n = q.popleft()
        if n.type in _MAPPINGS:
            return n
        for i in range(n.named_child_count):
            q.append(n.named_child(i))
    return None


def _pairs(mapping: Optional[TSNode]):
    if mapping is None:
        return
    for i in range(mapping.named_child_count):
        ch = mapping.named_child(i)
        if ch.type in ("block_mapping_pair", "flow_pair"):
            yield ch


def _child_value(root: TSNode, key: str, text) -> Optional[TSNode]:
    """Value node of the top-level mapping pair named `key`."""
    for pair in _pairs(_to_mapping(root)):
        if _leaf_scalar(pair.child_by_field_name("key"), text) == key:
            return pair.child_by_field_name("value")
    return None


def _depends_on(service_value: Optional[TSNode], text) -> list[str]:
    m = _to_mapping(service_value)
    if m is None:
        return []
    dep_val: Optional[TSNode] = None
    for pair in _pairs(m):
        if _leaf_scalar(pair.child_by_field_name("key"), text) == "depends_on":
            dep_val = pair.child_by_field_name("value")
            break
    if dep_val is None:
        return []
    seq = _find(dep_val, _SEQUENCES)
    names: list[str] = []
    if seq is not None:  # short form: a list of service names
        for i in range(seq.named_child_count):
            nm = _leaf_scalar(seq.named_child(i), text)
            if nm:
                names.append(nm)
    else:  # long form: a mapping keyed by service name
        for pair in _pairs(_to_mapping(dep_val)):
            nm = _leaf_scalar(pair.child_by_field_name("key"), text)
            if nm:
                names.append(nm)
    # de-dup, preserve order
    out: list[str] = []
    for n in names:
        if n not in out:
            out.append(n)
    return out


def _find(node: Optional[TSNode], types) -> Optional[TSNode]:
    if node is None:
        return None
    q = deque([node])
    while q:
        n = q.popleft()
        if n.type in types:
            return n
        for i in range(n.named_child_count):
            q.append(n.named_child(i))
    return None


def _leaf_scalar(node: Optional[TSNode], text) -> Optional[str]:
    """Drill to the first scalar leaf under `node`, stripped of quotes."""
    if node is None:
        return None
    q = deque([node])
    while q:
        n = q.popleft()
        if n.type in _SCALARS:
            return text(n).strip().strip("'").strip('"').strip()
        for i in range(n.named_child_count):
            q.append(n.named_child(i))
    return text(node).strip().strip("'").strip('"').strip() or None

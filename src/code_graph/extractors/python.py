"""Python extractor.

Turns a tree-sitter-python parse tree into File/Class/Function/Method nodes and
CONTAINS/IMPORTS/CALLS/INHERITS/USES_TYPE edges. Call/inherit/type destinations
are emitted as *raw* symbol strings (e.g. "self.method", "os.path.join",
"Widget"); the resolver later maps them to real nodes via the graduated cascade.

The walk is structural recursion over definition/block boundaries only — its
depth tracks source nesting (rarely more than a few dozen), never file length —
while expression bodies are scanned iteratively. Nothing from the tree is
retained past `extract`.
"""

from __future__ import annotations

from tree_sitter import Node as TSNode
from tree_sitter import Tree

from ..models import (
    EDGE_CALLS,
    EDGE_CONTAINS,
    EDGE_IMPORTS,
    EDGE_INHERITS,
    EDGE_USES_TYPE,
    KIND_CLASS,
    KIND_FILE,
    KIND_FUNCTION,
    KIND_METHOD,
    Edge,
    FileResult,
    Import,
    Node,
)
from ..naming import file_qname
from .base import Extractor

# Builtin type names not worth recording as USES_TYPE edges: they never resolve
# to a project node and would swamp the graph with noise. Project-defined and
# typing/library types are still recorded (and left honestly unresolved).
_BUILTIN_TYPES = frozenset(
    {
        "str", "int", "float", "bool", "bytes", "bytearray", "complex",
        "list", "dict", "tuple", "set", "frozenset", "object", "type",
        "None", "Any", "None", "memoryview", "range", "slice",
    }
)

_MAX_SIG_LEN = 500


class PythonExtractor(Extractor):
    def extract(self, tree: Tree, source: bytes, file_path: str) -> FileResult:
        nodes: list[Node] = []
        edges: list[Edge] = []
        imports: list[Import] = []

        def text(node: TSNode) -> str:
            return source[node.start_byte : node.end_byte].decode("utf-8", "replace")

        def one_line(node: TSNode | None) -> str:
            return " ".join(text(node).split()) if node is not None else ""

        module_qname = self.module_qname(file_path)
        pkg_parts = self.package_parts(file_path, module_qname)

        # ---- File node ----------------------------------------------------
        end_line = source.count(b"\n") + 1
        nodes.append(
            Node(
                kind=KIND_FILE,
                name=module_qname.split(".")[-1] if module_qname else file_path,
                qualified_name=module_qname,
                file_path=file_path,
                start_line=1,
                end_line=end_line,
                signature=None,
            )
        )

        # ---- helpers ------------------------------------------------------
        def qn(container: str, name: str) -> str:
            return f"{container}.{name}" if container else name

        def record_imports(stmt: TSNode) -> None:
            if stmt.type == "import_statement":
                for i in range(stmt.named_child_count):
                    nm = stmt.named_child(i)
                    if nm.type == "dotted_name":
                        dotted = text(nm)
                        bound = dotted.split(".")[0]
                        imports.append(Import(file_path, bound, bound, "module"))
                        edges.append(
                            Edge(EDGE_IMPORTS, module_qname, dotted, bound, file_path, 0)
                        )
                    elif nm.type == "aliased_import":
                        inner = nm.child_by_field_name("name")
                        alias = nm.child_by_field_name("alias")
                        if inner is None or alias is None:
                            continue
                        dotted = text(inner)
                        a = text(alias)
                        imports.append(Import(file_path, a, dotted, "module"))
                        edges.append(
                            Edge(EDGE_IMPORTS, module_qname, dotted, a, file_path, 0)
                        )
            elif stmt.type == "import_from_statement":
                mod_node = stmt.child_by_field_name("module_name")
                base_module = self._from_module(mod_node, pkg_parts, text)
                for i in range(stmt.named_child_count):
                    nm = stmt.named_child(i)
                    if nm is mod_node:
                        continue
                    if nm.type == "wildcard_import":
                        continue  # cannot track names bound by `import *`
                    if nm.type == "dotted_name":
                        sym = text(nm)
                        bound = sym.split(".")[0]
                        target = f"{base_module}.{sym}" if base_module else sym
                        imports.append(Import(file_path, bound, target, "symbol"))
                        edges.append(
                            Edge(EDGE_IMPORTS, module_qname, target, bound, file_path, 0)
                        )
                    elif nm.type == "aliased_import":
                        inner = nm.child_by_field_name("name")
                        alias = nm.child_by_field_name("alias")
                        if inner is None or alias is None:
                            continue
                        sym = text(inner)
                        a = text(alias)
                        target = f"{base_module}.{sym}" if base_module else sym
                        imports.append(Import(file_path, a, target, "symbol"))
                        edges.append(
                            Edge(EDGE_IMPORTS, module_qname, target, a, file_path, 0)
                        )

        def emit_types(owner_qname: str, root: TSNode | None) -> None:
            if root is None:
                return
            for tnode in _find_types(root):
                for name in _type_names(tnode, text):
                    if name and name not in _BUILTIN_TYPES:
                        edges.append(
                            Edge(EDGE_USES_TYPE, owner_qname, name, name, file_path, 0)
                        )

        def scan_calls(root: TSNode, src_qname: str) -> None:
            stack = [root]
            while stack:
                n = stack.pop()
                t = n.type
                # New scopes are handled by their own walk; don't attribute their
                # calls to the enclosing definition.
                if t in (
                    "function_definition",
                    "class_definition",
                    "decorated_definition",
                    "lambda",
                ):
                    continue
                if t == "call":
                    fn = n.child_by_field_name("function")
                    if fn is not None and fn.type in ("identifier", "attribute"):
                        raw = one_line(fn)
                        if raw:
                            edges.append(
                                Edge(EDGE_CALLS, src_qname, raw, raw, file_path, 0)
                            )
                for i in range(n.named_child_count):
                    stack.append(n.named_child(i))

        def handle_function(
            defn: TSNode, container: str, in_class: bool
        ) -> None:
            name_node = defn.child_by_field_name("name")
            if name_node is None:
                return
            name = text(name_node)
            qname = qn(container, name)
            params = defn.child_by_field_name("parameters")
            ret = defn.child_by_field_name("return_type")
            is_async = defn.child_count > 0 and defn.child(0).type == "async"
            sig = ("async def " if is_async else "def ") + name + (one_line(params) or "()")
            if ret is not None:
                sig += " -> " + one_line(ret)
            nodes.append(
                Node(
                    kind=KIND_METHOD if in_class else KIND_FUNCTION,
                    name=name,
                    qualified_name=qname,
                    file_path=file_path,
                    start_line=defn.start_point[0] + 1,
                    end_line=defn.end_point[0] + 1,
                    signature=sig[:_MAX_SIG_LEN],
                )
            )
            edges.append(Edge(EDGE_CONTAINS, container, qname, qname, file_path, 1))
            emit_types(qname, params)
            emit_types(qname, ret)
            body = defn.child_by_field_name("body")
            if body is not None:
                walk(body, qname, in_class_body=False)

        def handle_class(defn: TSNode, container: str) -> None:
            name_node = defn.child_by_field_name("name")
            if name_node is None:
                return
            name = text(name_node)
            qname = qn(container, name)
            supers = defn.child_by_field_name("superclasses")
            sig = "class " + name + (one_line(supers) if supers is not None else "")
            nodes.append(
                Node(
                    kind=KIND_CLASS,
                    name=name,
                    qualified_name=qname,
                    file_path=file_path,
                    start_line=defn.start_point[0] + 1,
                    end_line=defn.end_point[0] + 1,
                    signature=sig[:_MAX_SIG_LEN],
                )
            )
            edges.append(Edge(EDGE_CONTAINS, container, qname, qname, file_path, 1))
            if supers is not None:
                for i in range(supers.named_child_count):
                    base = supers.named_child(i)
                    if base.type in ("identifier", "attribute"):
                        raw = one_line(base)
                        edges.append(
                            Edge(EDGE_INHERITS, qname, raw, raw, file_path, 0)
                        )
            body = defn.child_by_field_name("body")
            if body is not None:
                walk(body, qname, in_class_body=True)

        def walk(block: TSNode, container: str, in_class_body: bool) -> None:
            for i in range(block.named_child_count):
                stmt = block.named_child(i)
                t = stmt.type
                if t in ("import_statement", "import_from_statement"):
                    record_imports(stmt)
                elif t == "function_definition":
                    handle_function(stmt, container, in_class_body)
                elif t == "class_definition":
                    handle_class(stmt, container)
                elif t == "decorated_definition":
                    defn = stmt.child_by_field_name("definition")
                    if defn is None:
                        continue
                    if defn.type == "function_definition":
                        handle_function(defn, container, in_class_body)
                    elif defn.type == "class_definition":
                        handle_class(defn, container)
                else:
                    if in_class_body:
                        emit_types(container, stmt)  # annotated class attributes
                    scan_calls(stmt, container)

        walk(tree.root_node, module_qname, in_class_body=False)
        return _dedupe(FileResult(nodes=nodes, edges=edges, imports=imports))

    # -- path -> module qualified name -------------------------------------
    @staticmethod
    def module_qname(file_path: str) -> str:
        # Delegates to the shared scheme so Python and every other code language
        # agree on how a file path becomes a dotted module name.
        return file_qname(file_path)

    @staticmethod
    def package_parts(file_path: str, module_qname: str) -> list[str]:
        is_init = file_path.rsplit("/", 1)[-1] == "__init__.py"
        parts = module_qname.split(".") if module_qname else []
        return parts if is_init else parts[:-1]

    @staticmethod
    def _from_module(mod_node, pkg_parts, text) -> str:
        if mod_node is None:
            return ""
        if mod_node.type == "relative_import":
            level = 0
            tail = ""
            for i in range(mod_node.child_count):
                c = mod_node.child(i)
                if c.type == "import_prefix":
                    level = text(c).count(".")
                elif c.type == "dotted_name":
                    tail = text(c)
            up = level - 1
            base = pkg_parts[: len(pkg_parts) - up] if up <= len(pkg_parts) else []
            parts = list(base)
            if tail:
                parts.extend(tail.split("."))
            return ".".join(parts)
        return text(mod_node)


def _find_types(root: TSNode) -> list[TSNode]:
    found: list[TSNode] = []
    stack = [root]
    while stack:
        n = stack.pop()
        if n.type == "type":
            found.append(n)
        for i in range(n.named_child_count):
            stack.append(n.named_child(i))
    return found


def _type_names(type_node: TSNode, text) -> set[str]:
    names: set[str] = set()
    stack = [type_node]
    while stack:
        n = stack.pop()
        t = n.type
        if t == "identifier":
            names.add(text(n))
        elif t == "attribute":
            names.add(" ".join(text(n).split()))
            continue  # keep dotted type whole
        for i in range(n.named_child_count):
            stack.append(n.named_child(i))
    return names


def _dedupe(result: FileResult) -> FileResult:
    seen_nodes: set[tuple] = set()
    unique_nodes: list[Node] = []
    for nd in result.nodes:
        key = (nd.kind, nd.qualified_name, nd.start_line)
        if key not in seen_nodes:
            seen_nodes.add(key)
            unique_nodes.append(nd)

    seen_edges: set[tuple] = set()
    unique_edges: list[Edge] = []
    for e in result.edges:
        key = (e.edge_type, e.src_qname, e.dst_raw)
        if key not in seen_edges:
            seen_edges.add(key)
            unique_edges.append(e)

    seen_imports: set[tuple] = set()
    unique_imports: list[Import] = []
    for im in result.imports:
        key = (im.file_path, im.local_name)
        if key not in seen_imports:
            seen_imports.add(key)
            unique_imports.append(im)

    return FileResult(nodes=unique_nodes, edges=unique_edges, imports=unique_imports)

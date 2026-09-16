"""JavaScript / TypeScript extractor.

Turns a tree-sitter-javascript or tree-sitter-typescript parse tree into
File/Function/Method/Class/Interface nodes and
CONTAINS/IMPORTS/CALLS/INHERITS/IMPLEMENTS edges. The same extractor drives JS,
JSX, TS and TSX — it keys off grammar node-type names, and the differences
(interfaces, `implements`) simply don't appear in JS trees.

Qualified names are dotted and extension-stripped (via `naming.file_qname`), the
same shape the Python extractor uses, so the resolver's cascade resolves JS/TS
calls and inheritance with no language-specific logic. Import *targets* are
computed by path arithmetic (`naming.js_import_module`): a relative specifier
becomes the imported module's dotted qname, a bare specifier is recorded as an
external dependency.

As with the Python extractor, nothing from the tree is retained past `extract`:
the walk recurses over definition boundaries and scans expression bodies
iteratively.
"""

from __future__ import annotations

from typing import Optional

from tree_sitter import Node as TSNode
from tree_sitter import Tree

from ..models import (
    EDGE_CALLS,
    EDGE_CONTAINS,
    EDGE_IMPLEMENTS,
    EDGE_IMPORTS,
    EDGE_INHERITS,
    KIND_CLASS,
    KIND_FILE,
    KIND_FUNCTION,
    KIND_INTERFACE,
    KIND_METHOD,
    Edge,
    FileResult,
    Import,
    Node,
)
from ..naming import file_qname, js_import_module
from .base import Extractor

_MAX_SIG_LEN = 500

# Node types that open a new lexical scope: their inner calls belong to them, not
# to the enclosing definition, so call-scanning stops at their boundary.
_NEW_SCOPES = frozenset(
    {
        "function_declaration",
        "generator_function_declaration",
        "function_expression",
        "generator_function",
        "arrow_function",
        "class_declaration",
        "abstract_class_declaration",
        "class",
        "class_expression",
        "method_definition",
    }
)

_FUNC_VALUES = frozenset(
    {"arrow_function", "function_expression", "generator_function", "function"}
)
_CLASS_DECLS = frozenset({"class_declaration", "abstract_class_declaration"})
# Anonymous class expressions in expression position: skipped by `scan` (rare;
# named `const X = class {}` is handled by handle_lexical instead).
_ANON_CLASS_SCOPES = frozenset({"class", "class_expression"})


class JavaScriptExtractor(Extractor):
    def extract(self, tree: Tree, source: bytes, file_path: str) -> FileResult:
        nodes: list[Node] = []
        edges: list[Edge] = []
        imports: list[Import] = []

        def text(node: TSNode) -> str:
            return source[node.start_byte : node.end_byte].decode("utf-8", "replace")

        def one_line(node: Optional[TSNode]) -> str:
            return " ".join(text(node).split()) if node is not None else ""

        module_qname = file_qname(file_path)

        # ---- File node ----------------------------------------------------
        nodes.append(
            Node(
                kind=KIND_FILE,
                name=module_qname.split(".")[-1] if module_qname else file_path,
                qualified_name=module_qname,
                file_path=file_path,
                start_line=1,
                end_line=source.count(b"\n") + 1,
                signature=None,
            )
        )

        def qn(container: str, name: str) -> str:
            return f"{container}.{name}" if container else name

        # ---- imports ------------------------------------------------------
        def add_dep(local_name: str, specifier: str, imported: Optional[str]) -> None:
            """Record one import. `imported` is a named symbol or None (module/side effect)."""
            module = js_import_module(file_path, specifier)
            if module is None:
                # Bare npm specifier / external URL: honest external dependency.
                imports.append(Import(file_path, local_name, specifier, "external"))
                edges.append(
                    Edge(EDGE_IMPORTS, module_qname, specifier, specifier, file_path, 0)
                )
                return
            if imported is not None:
                target = f"{module}.{imported}"
                kind = "symbol"
            else:
                target = module
                kind = "module"
            imports.append(Import(file_path, local_name, target, kind))
            edges.append(Edge(EDGE_IMPORTS, module_qname, target, local_name, file_path, 0))

        def record_import_statement(stmt: TSNode) -> None:
            source_node = stmt.child_by_field_name("source")
            specifier = _string_value(source_node, text) if source_node else None
            if not specifier:
                return
            clause = _first_child_of_type(stmt, "import_clause")
            if clause is None:
                # `import './x'` side-effect import (e.g. CSS/JS with effects).
                add_dep(specifier, specifier, None)
                return
            saw = False
            for ch in _named_children(clause):
                if ch.type == "identifier":  # default import
                    add_dep(text(ch), specifier, None)
                    saw = True
                elif ch.type == "namespace_import":
                    ident = _first_child_of_type(ch, "identifier")
                    add_dep(text(ident) if ident else specifier, specifier, None)
                    saw = True
                elif ch.type == "named_imports":
                    for spec in _named_children(ch):
                        if spec.type != "import_specifier":
                            continue
                        name_node = spec.child_by_field_name("name")
                        alias_node = spec.child_by_field_name("alias")
                        if name_node is None:
                            continue
                        imported = text(name_node)
                        local = text(alias_node) if alias_node else imported
                        add_dep(local, specifier, imported)
                        saw = True
            if not saw:
                add_dep(specifier, specifier, None)

        def record_export_from(stmt: TSNode) -> None:
            # `export { x } from './y'` / `export * from './y'`: a dependency.
            source_node = stmt.child_by_field_name("source")
            specifier = _string_value(source_node, text) if source_node else None
            if specifier:
                add_dep(specifier, specifier, None)

        def maybe_require(value: TSNode, local_name: str) -> bool:
            """`const x = require('./y')` -> module import. Returns True if handled."""
            if value.type != "call_expression":
                return False
            fn = value.child_by_field_name("function")
            if fn is None or fn.type != "identifier" or text(fn) != "require":
                return False
            args = value.child_by_field_name("arguments")
            spec_node = _first_child_of_type(args, "string") if args else None
            specifier = _string_value(spec_node, text) if spec_node else None
            if specifier:
                add_dep(local_name, specifier, None)
            return True

        # ---- traversal: definitions + calls -------------------------------
        # Named functions/classes open a new container; anonymous function
        # scopes (IIFEs, callbacks) are *transparent* — their contents attribute
        # to the nearest named container. This mirrors the Python walk, so an
        # IIFE-wrapped module still contributes its functions as real nodes.
        def walk_statements(block: TSNode, container: str) -> None:
            for i in range(block.named_child_count):
                dispatch(block.named_child(i), container)

        def handle_anon_scope(fn: TSNode, container: str) -> None:
            body = fn.child_by_field_name("body")
            if body is None:
                return
            if body.type == "statement_block":
                walk_statements(body, container)
            else:  # concise arrow body: () => expr
                scan(body, container)

        def scan(root: TSNode, container: str) -> None:
            """Attribute calls under `root` to `container`, descending through
            anonymous function scopes so IIFE/callback bodies are not lost."""
            stack = [root]
            while stack:
                n = stack.pop()
                t = n.type
                if t in _FUNC_VALUES:  # anonymous function/arrow: transparent
                    handle_anon_scope(n, container)
                    continue
                if t in _ANON_CLASS_SCOPES:  # anonymous class expression: skip
                    continue
                if t == "call_expression":
                    fn = n.child_by_field_name("function")
                    if fn is not None and fn.type in ("identifier", "member_expression"):
                        raw = one_line(fn)
                        if raw:
                            edges.append(
                                Edge(EDGE_CALLS, container, raw, raw, file_path, 0)
                            )
                    elif fn is not None and fn.type == "import":
                        args = n.child_by_field_name("arguments")
                        spec_node = _first_child_of_type(args, "string") if args else None
                        specifier = _string_value(spec_node, text) if spec_node else None
                        if specifier:
                            add_dep(specifier, specifier, None)
                for i in range(n.named_child_count):
                    stack.append(n.named_child(i))

        # ---- definitions --------------------------------------------------
        def handle_function(
            defn: TSNode, name: str, container: str, in_class: bool,
            params: Optional[TSNode], body: Optional[TSNode], sig_prefix: str,
        ) -> None:
            qname = qn(container, name)
            sig = (sig_prefix + name + (one_line(params) or "()"))[:_MAX_SIG_LEN]
            nodes.append(
                Node(
                    kind=KIND_METHOD if in_class else KIND_FUNCTION,
                    name=name,
                    qualified_name=qname,
                    file_path=file_path,
                    start_line=defn.start_point[0] + 1,
                    end_line=defn.end_point[0] + 1,
                    signature=sig,
                )
            )
            edges.append(Edge(EDGE_CONTAINS, container, qname, qname, file_path, 1))
            if body is not None:
                if body.type == "statement_block":
                    walk_statements(body, qname)  # recurse for nested defs + calls
                else:  # expression-bodied arrow: () => expr
                    scan(body, qname)

        def handle_class(defn: TSNode, container: str) -> None:
            name_node = defn.child_by_field_name("name")
            if name_node is None:
                return
            name = text(name_node)
            qname = qn(container, name)
            nodes.append(
                Node(
                    kind=KIND_CLASS,
                    name=name,
                    qualified_name=qname,
                    file_path=file_path,
                    start_line=defn.start_point[0] + 1,
                    end_line=defn.end_point[0] + 1,
                    signature=("class " + name)[:_MAX_SIG_LEN],
                )
            )
            edges.append(Edge(EDGE_CONTAINS, container, qname, qname, file_path, 1))
            _emit_heritage(defn, qname, edges, file_path, one_line)
            body = defn.child_by_field_name("body")
            if body is not None:
                walk_class_body(body, qname)

        def handle_interface(defn: TSNode, container: str) -> None:
            name_node = defn.child_by_field_name("name")
            if name_node is None:
                return
            name = text(name_node)
            qname = qn(container, name)
            nodes.append(
                Node(
                    kind=KIND_INTERFACE,
                    name=name,
                    qualified_name=qname,
                    file_path=file_path,
                    start_line=defn.start_point[0] + 1,
                    end_line=defn.end_point[0] + 1,
                    signature=("interface " + name)[:_MAX_SIG_LEN],
                )
            )
            edges.append(Edge(EDGE_CONTAINS, container, qname, qname, file_path, 1))
            _emit_heritage(defn, qname, edges, file_path, one_line)

        def handle_lexical(stmt: TSNode, container: str) -> None:
            handled_any = False
            for decl in _named_children(stmt):
                if decl.type != "variable_declarator":
                    continue
                name_node = decl.child_by_field_name("name")
                value = decl.child_by_field_name("value")
                if name_node is None or name_node.type != "identifier":
                    if value is not None:
                        scan(value, container)
                    continue
                local = text(name_node)
                if value is None:
                    continue
                if maybe_require(value, local):
                    handled_any = True
                    continue
                if value.type in _FUNC_VALUES:
                    params = value.child_by_field_name("parameters")
                    body = value.child_by_field_name("body")
                    handle_function(
                        decl, local, container, False, params, body, "const "
                    )
                    handled_any = True
                elif value.type in ("class", "class_expression"):
                    # `const X = class extends Y {}`
                    qname = qn(container, local)
                    nodes.append(
                        Node(
                            kind=KIND_CLASS, name=local, qualified_name=qname,
                            file_path=file_path, start_line=decl.start_point[0] + 1,
                            end_line=decl.end_point[0] + 1,
                            signature=("class " + local)[:_MAX_SIG_LEN],
                        )
                    )
                    edges.append(Edge(EDGE_CONTAINS, container, qname, qname, file_path, 1))
                    _emit_heritage(value, qname, edges, file_path, one_line)
                    body = value.child_by_field_name("body")
                    if body is not None:
                        walk_class_body(body, qname)
                    handled_any = True
                else:
                    scan(value, container)
            return handled_any

        def dispatch(stmt: TSNode, container: str) -> None:
            t = stmt.type
            if t == "import_statement":
                record_import_statement(stmt)
            elif t == "export_statement":
                if stmt.child_by_field_name("source") is not None:
                    record_export_from(stmt)
                inner = stmt.child_by_field_name("declaration")
                if inner is None:
                    # `export default <expr>` / `export { ... }`
                    val = stmt.child_by_field_name("value")
                    if val is not None:
                        if val.type in _FUNC_VALUES:
                            handle_function(
                                val, "default", container, False,
                                val.child_by_field_name("parameters"),
                                val.child_by_field_name("body"), "export default ",
                            )
                        else:
                            scan(val, container)
                else:
                    dispatch(inner, container)
            elif t in ("function_declaration", "generator_function_declaration"):
                name_node = stmt.child_by_field_name("name")
                if name_node is not None:
                    handle_function(
                        stmt, text(name_node), container, False,
                        stmt.child_by_field_name("parameters"),
                        stmt.child_by_field_name("body"), "function ",
                    )
            elif t in _CLASS_DECLS:
                handle_class(stmt, container)
            elif t == "interface_declaration":
                handle_interface(stmt, container)
            elif t in ("lexical_declaration", "variable_declaration"):
                handle_lexical(stmt, container)
            else:
                scan(stmt, container)

        def walk_class_body(body: TSNode, container: str) -> None:
            for member in _named_children(body):
                if member.type == "method_definition":
                    name_node = member.child_by_field_name("name")
                    if name_node is None:
                        continue
                    handle_function(
                        member, text(name_node), container, True,
                        member.child_by_field_name("parameters"),
                        member.child_by_field_name("body"), "",
                    )
                # field initializers may contain calls attributed to the class
                elif member.type in ("field_definition", "public_field_definition"):
                    value = member.child_by_field_name("value")
                    if value is not None and value.type not in _NEW_SCOPES:
                        scan(value, container)

        for i in range(tree.root_node.named_child_count):
            dispatch(tree.root_node.named_child(i), module_qname)

        return _dedupe(FileResult(nodes=nodes, edges=edges, imports=imports))


# --- module-level helpers --------------------------------------------------
def _named_children(node: Optional[TSNode]) -> list[TSNode]:
    if node is None:
        return []
    return [node.named_child(i) for i in range(node.named_child_count)]


def _first_child_of_type(node: Optional[TSNode], type_name: str) -> Optional[TSNode]:
    if node is None:
        return None
    for i in range(node.named_child_count):
        ch = node.named_child(i)
        if ch.type == type_name:
            return ch
    return None


def _string_value(node: Optional[TSNode], text) -> Optional[str]:
    """The literal value of a `string` node, without quotes."""
    if node is None:
        return None
    frag = _first_child_of_type(node, "string_fragment")
    if frag is not None:
        return text(frag)
    raw = text(node).strip()
    if len(raw) >= 2 and raw[0] in "\"'`":
        return raw[1:-1]
    return raw or None


def _emit_heritage(defn: TSNode, qname: str, edges, file_path: str, one_line) -> None:
    """Emit INHERITS (extends) and IMPLEMENTS edges for a class/interface."""
    heritage = _first_child_of_type(defn, "class_heritage")
    # Interfaces put `extends` in an extends_type_clause directly under the node.
    scopes = [heritage] if heritage is not None else []
    scopes += [
        defn.named_child(i)
        for i in range(defn.named_child_count)
        if defn.named_child(i).type in ("extends_clause", "implements_clause",
                                        "extends_type_clause")
    ]
    for scope in scopes:
        if scope is None:
            continue
        for child in _named_children(scope):
            _emit_heritage_scope(child, qname, edges, file_path, one_line)
        # JS `class A extends B` places B directly inside class_heritage.
        if scope.type == "class_heritage":
            for child in _named_children(scope):
                if child.type in ("identifier", "member_expression"):
                    raw = one_line(child)
                    if raw:
                        edges.append(Edge(EDGE_INHERITS, qname, raw, raw, file_path, 0))


def _emit_heritage_scope(node: TSNode, qname: str, edges, file_path: str, one_line) -> None:
    if node.type == "extends_clause" or node.type == "extends_type_clause":
        for name in _heritage_names(node, one_line):
            edges.append(Edge(EDGE_INHERITS, qname, name, name, file_path, 0))
    elif node.type == "implements_clause":
        for name in _heritage_names(node, one_line):
            edges.append(Edge(EDGE_IMPLEMENTS, qname, name, name, file_path, 0))


def _heritage_names(clause: TSNode, one_line) -> list[str]:
    names: list[str] = []
    for i in range(clause.named_child_count):
        ch = clause.named_child(i)
        if ch.type in (
            "identifier", "member_expression", "type_identifier",
            "generic_type", "nested_type_identifier",
        ):
            raw = one_line(ch)
            # For `Foo<T>` keep just `Foo`.
            raw = raw.split("<", 1)[0].strip()
            if raw:
                names.append(raw)
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

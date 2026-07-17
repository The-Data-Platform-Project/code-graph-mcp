"""Unit tests for the Python extractor against known source."""

from __future__ import annotations

from code_graph.extractors.python import PythonExtractor
from code_graph.languages import get_parser
from code_graph.models import (
    EDGE_CALLS,
    EDGE_CONTAINS,
    EDGE_INHERITS,
    KIND_CLASS,
    KIND_FILE,
    KIND_FUNCTION,
    KIND_METHOD,
)

SRC = b'''\
import os
import os.path as osp
from collections import OrderedDict
from .sibling import thing as t


class Animal:
    def speak(self):
        return "..."


class Dog(Animal):
    def speak(self):
        return bark()


def bark():
    return "woof"
'''


def _extract(path="pkg/mod.py", src=SRC):
    parser = get_parser(".py")
    tree = parser.parse(src)
    return PythonExtractor().extract(tree, src, path)


def test_file_node_and_module_qname():
    res = _extract()
    files = [n for n in res.nodes if n.kind == KIND_FILE]
    assert len(files) == 1
    assert files[0].qualified_name == "pkg.mod"


def test_classes_and_methods():
    res = _extract()
    classes = {n.qualified_name for n in res.nodes if n.kind == KIND_CLASS}
    methods = {n.qualified_name for n in res.nodes if n.kind == KIND_METHOD}
    funcs = {n.qualified_name for n in res.nodes if n.kind == KIND_FUNCTION}
    assert classes == {"pkg.mod.Animal", "pkg.mod.Dog"}
    assert "pkg.mod.Dog.speak" in methods
    assert "pkg.mod.bark" in funcs


def test_contains_edges_nesting():
    res = _extract()
    contains = {(e.src_qname, e.dst_qname) for e in res.edges if e.edge_type == EDGE_CONTAINS}
    assert ("pkg.mod", "pkg.mod.Dog") in contains
    assert ("pkg.mod.Dog", "pkg.mod.Dog.speak") in contains


def test_inherits_edge_raw():
    res = _extract()
    inh = {(e.src_qname, e.dst_raw) for e in res.edges if e.edge_type == EDGE_INHERITS}
    assert ("pkg.mod.Dog", "Animal") in inh


def test_calls_raw_captured():
    res = _extract()
    calls = {(e.src_qname, e.dst_raw) for e in res.edges if e.edge_type == EDGE_CALLS}
    assert ("pkg.mod.Dog.speak", "bark") in calls


def test_import_map_targets():
    res = _extract()
    by_local = {im.local_name: im for im in res.imports}
    assert by_local["os"].target == "os"
    assert by_local["osp"].target == "os.path"
    assert by_local["OrderedDict"].target == "collections.OrderedDict"
    # relative import resolved against the package of pkg.mod -> pkg
    assert by_local["t"].target == "pkg.sibling.thing"


def test_signature_present():
    res = _extract()
    speak = next(n for n in res.nodes if n.qualified_name == "pkg.mod.Dog.speak")
    assert speak.signature and speak.signature.startswith("def speak(self)")


def test_async_and_return_type():
    src = b"async def fetch(x: int) -> str:\n    return await go()\n"
    res = _extract("m.py", src)
    fn = next(n for n in res.nodes if n.qualified_name == "m.fetch")
    assert fn.signature.startswith("async def fetch")
    assert "-> str" in fn.signature

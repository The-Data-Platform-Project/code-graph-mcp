"""Extractor interface.

An extractor turns a parsed tree for a single file into a `FileResult`
(nodes, edges, imports). It must never retain the tree, source bytes, or any
node references past the `extract` call — the indexer discards the tree
immediately afterwards, and holding references would defeat the one-file-at-a-time
memory discipline.
"""

from __future__ import annotations

from abc import ABC, abstractmethod

from tree_sitter import Tree

from ..models import FileResult


class Extractor(ABC):
    @abstractmethod
    def extract(self, tree: Tree, source: bytes, file_path: str) -> FileResult:
        """Extract graph elements from one parsed file.

        Args:
            tree: the parsed tree-sitter tree for this file.
            source: the raw file bytes the tree was parsed from.
            file_path: repo-relative path with POSIX separators.
        """
        raise NotImplementedError

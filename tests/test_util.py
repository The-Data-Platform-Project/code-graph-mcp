"""Path-confinement and pattern-translation unit tests."""

from __future__ import annotations

from pathlib import Path

import pytest

from code_graph.util import like_pattern, safe_join


def test_safe_join_allows_within(tmp_path: Path):
    (tmp_path / "repo").mkdir()
    assert safe_join(tmp_path, "repo") == (tmp_path / "repo").resolve()


def test_safe_join_blocks_traversal(tmp_path: Path):
    with pytest.raises(ValueError):
        safe_join(tmp_path, "../../etc/passwd")


def test_safe_join_blocks_absolute_escape(tmp_path: Path):
    with pytest.raises(ValueError):
        safe_join(tmp_path, "/etc")


def test_like_pattern_substring():
    assert like_pattern("run") == "%run%"


def test_like_pattern_wildcards():
    assert like_pattern("get_*") == "get\\_%"
    assert like_pattern("a?c") == "a_c"


def test_like_pattern_escapes_metachars():
    assert like_pattern("50%") == "%50\\%%"

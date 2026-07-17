"""Small shared utilities."""

from __future__ import annotations

from pathlib import Path


def safe_join(root: Path, *parts: str) -> Path:
    """Join `parts` onto `root` and confine the result within `root`.

    Guards `index_repository`/`get_code_snippet` against path traversal
    (`../../etc`) and symlink escapes out of the read-only workspaces mount.
    Raises ValueError if the resolved path is not inside `root`.
    """
    root_resolved = Path(root).resolve()
    candidate = (root_resolved.joinpath(*parts)).resolve()
    if candidate != root_resolved and root_resolved not in candidate.parents:
        raise ValueError(f"path escapes workspaces root: {'/'.join(parts)!r}")
    return candidate


def like_pattern(pattern: str) -> str:
    """Translate a user glob-ish pattern into a SQL LIKE pattern.

    `*` and `?` become `%`/`_`. A pattern with no wildcards is treated as a
    substring match. Existing LIKE metacharacters are escaped (ESCAPE '\\').
    """
    if pattern == "":
        return "%"
    escaped = pattern.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    has_wildcard = "*" in pattern or "?" in pattern
    translated = escaped.replace("*", "%").replace("?", "_")
    return translated if has_wildcard else f"%{translated}%"

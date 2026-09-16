"""Shared structured logging setup."""

import structlog


def get_logger(name: str):
    """Return a structured logger bound to `name`."""
    return structlog.get_logger(name)

"""Retry helper shared by the services."""

import time


def with_retry(fn, attempts: int = 3, delay: float = 0.1):
    """Call `fn`, retrying transient failures up to `attempts` times."""
    for attempt in range(attempts):
        try:
            return fn()
        except Exception:
            if attempt == attempts - 1:
                raise
            time.sleep(delay)

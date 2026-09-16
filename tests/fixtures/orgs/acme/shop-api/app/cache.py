"""Redis-backed response cache."""

import os

import redis

client = redis.Redis.from_url(os.getenv("REDIS_URL", "redis://cache:6379/0"))


def cached_total(order_id: str):
    """Return the cached order total, if one was stored."""
    return client.get(f"order:{order_id}:total")

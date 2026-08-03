"""
Redis-backed response cache for LLM calls + RAG queries.
Shared across processes/instances (unlike the old in-memory LRU), and survives
restarts within its TTL. Same get/set/clear/stats interface as before, so
call sites in llm.py, design_service.py, rag.py, routes.py are unchanged.
"""
import hashlib
import os
import redis

REDIS_URL = os.getenv("REDIS_URL", "")

if not REDIS_URL:
    raise RuntimeError("REDIS_URL is not set. Add it to backend/.env")

_redis = redis.from_url(REDIS_URL, decode_responses=True)

_LLM_TTL_SECONDS = 60 * 10   # 10 minutes
_RAG_TTL_SECONDS = 60 * 15  # 15 minutes


class _RedisCache:
    """LLM response cache, keyed by provider:model:prompt text."""

    def __init__(self, prefix: str, ttl: int):
        self._prefix = prefix
        self._ttl = ttl

    def _make_key(self, text: str, provider: str, model: str) -> str:
        raw = f"{provider}:{model}:{text}"
        digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()
        return f"{self._prefix}:{digest}"

    def get(self, text: str, provider: str, model: str):
        return _redis.get(self._make_key(text, provider, model))

    def set(self, text: str, provider: str, model: str, value: str) -> None:
        _redis.set(self._make_key(text, provider, model), value, ex=self._ttl)

    def clear(self) -> None:
        for key in _redis.scan_iter(match=f"{self._prefix}:*"):
            _redis.delete(key)

    def stats(self) -> dict:
        size = sum(1 for _ in _redis.scan_iter(match=f"{self._prefix}:*"))
        return {"size": size, "ttl_s": self._ttl, "backend": "redis"}


class _SimpleRedisKVCache:
    """Single-key cache for intermediate results (e.g. RAG queries)."""

    def __init__(self, prefix: str, ttl: int):
        self._prefix = prefix
        self._ttl = ttl

    def _key(self, text: str) -> str:
        digest = hashlib.sha256(text.encode()).hexdigest()
        return f"{self._prefix}:{digest}"

    def get(self, text: str):
        return _redis.get(self._key(text))

    def set(self, text: str, value: str) -> None:
        _redis.set(self._key(text), value, ex=self._ttl)


# ── Redis cache for LLM responses ─────────────────────────────────────────────
response_cache = _RedisCache(prefix="llmcache", ttl=_LLM_TTL_SECONDS)

# ── Redis cache for RAG/vector-search results ─────────────────────────────────
rag_cache = _SimpleRedisKVCache(prefix="ragcache", ttl=_RAG_TTL_SECONDS)

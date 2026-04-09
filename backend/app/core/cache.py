"""
In-memory LRU response cache for LLM calls.
Saves tokens + latency by skipping the LLM entirely for repeated identical queries.
"""
import hashlib
import time
from collections import OrderedDict
from typing import Optional

# ─── Config ───────────────────────────────────────────────────────────────────
_MAX_ENTRIES = 200          # max cached items
_TTL_SECONDS = 60 * 10     # 10 minutes — stale after this
# ──────────────────────────────────────────────────────────────────────────────

class _LRUCache:
    def __init__(self, maxsize: int, ttl: int):
        self._cache: OrderedDict[str, tuple] = OrderedDict()
        self._maxsize = maxsize
        self._ttl = ttl

    def _make_key(self, text: str, provider: str, model: str) -> str:
        raw = f"{provider}:{model}:{text}"
        return hashlib.sha256(raw.encode()).hexdigest()

    def get(self, text: str, provider: str, model: str) -> Optional[str]:
        key = self._make_key(text, provider, model)
        entry = self._cache.get(key)
        if entry is None:
            return None
        value, ts = entry
        if time.time() - ts > self._ttl:
            del self._cache[key]
            return None
        # Move to end (most-recently-used)
        self._cache.move_to_end(key)
        return value

    def set(self, text: str, provider: str, model: str, value: str) -> None:
        key = self._make_key(text, provider, model)
        self._cache[key] = (value, time.time())
        self._cache.move_to_end(key)
        if len(self._cache) > self._maxsize:
            self._cache.popitem(last=False)  # evict oldest

    def clear(self) -> None:
        self._cache.clear()

    def stats(self) -> dict:
        return {"size": len(self._cache), "maxsize": self._maxsize, "ttl_s": self._ttl}


# Singleton — import and use directly
response_cache = _LRUCache(maxsize=_MAX_ENTRIES, ttl=_TTL_SECONDS)

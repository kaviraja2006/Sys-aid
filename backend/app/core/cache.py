"""
In-memory LRU response cache for LLM calls.
Saves tokens + latency by skipping the LLM entirely for repeated identical queries.
"""
import hashlib
import time
from collections import OrderedDict
from typing import Optional

# ─── Config ───────────────────────────────────────────────────────────────────
_MAX_ENTRIES = 500          # increased cache size for LLM responses
_TTL_SECONDS = 60 * 10     # 10 minutes — stale after this
# ──────────────────────────────────────────────────────────────────────────────

class _LRUCache:
    def __init__(self, maxsize: int, ttl: int):
        self._cache: OrderedDict[str, tuple] = OrderedDict()
        self._maxsize = maxsize
        self._ttl = ttl

    def _make_key(self, text: str, provider: str, model: str) -> str:
        raw = f"{provider}:{model}:{text}"
        return hashlib.sha256(raw.encode('utf-8')).hexdigest()

    def get(self, text: str, provider: str, model: str) -> Optional[str]:
        key = self._make_key(text, provider, model)
        entry = self._cache.get(key)
        if entry is None:
            return None
        value, ts = entry
        if time.time() - ts > self._ttl:
            del self._cache[key]
            return None
        self._cache.move_to_end(key)
        return value

    def set(self, text: str, provider: str, model: str, value: str) -> None:
        key = self._make_key(text, provider, model)
        self._cache[key] = (value, time.time())
        self._cache.move_to_end(key)
        if len(self._cache) > self._maxsize:
            self._cache.popitem(last=False)

    def clear(self) -> None:
        self._cache.clear()

    def stats(self) -> dict:
        return {"size": len(self._cache), "maxsize": self._maxsize, "ttl_s": self._ttl}


# ── LRU cache for LLM responses ───────────────────────────────────────────────
response_cache = _LRUCache(maxsize=_MAX_ENTRIES, ttl=_TTL_SECONDS)


class _SimpleKVCache:
    """
    Lightweight key→value cache for intermediate results (e.g. RAG queries).
    Single key, no provider/model dimension needed.
    """
    def __init__(self, maxsize: int = 500, ttl: int = 300):
        self._cache: OrderedDict[str, tuple] = OrderedDict()
        self._maxsize = maxsize
        self._ttl = ttl

    def _key(self, text: str) -> str:
        return hashlib.sha256(text.encode()).hexdigest()

    def get(self, text: str) -> Optional[str]:
        key = self._key(text)
        entry = self._cache.get(key)
        if not entry:
            return None
        value, ts = entry
        if time.time() - ts > self._ttl:
            del self._cache[key]
            return None
        self._cache.move_to_end(key)
        return value

    def set(self, text: str, value: str) -> None:
        key = self._key(text)
        self._cache[key] = (value, time.time())
        self._cache.move_to_end(key)
        if len(self._cache) > self._maxsize:
            self._cache.popitem(last=False)


# ── LRU cache for RAG/vector-search results ───────────────────────────────────
# Avoids re-running sentence-transformer embedding on repeated identical queries
rag_cache = _SimpleKVCache(maxsize=2000, ttl=900)  # 15‑minute TTL

"""
Local pytest convenience only.

app.core.cache hard-requires REDIS_URL at import time (fails closed if
unset — correct for production, see cache.py). But that guard also fires
transitively for pure-function unit tests that never touch the cache at
all: importing app.services.design_service pulls in app.core.llm, which
pulls in app.core.cache, so even test_simulation.py's math-only tests
couldn't be collected without a real Redis reachable.

os.environ.setdefault only fills the gap when nothing set it already, so
CI's real redis/postgres service containers (.github/workflows/ci.yml)
still take priority. This file is only ever loaded by pytest — never by
uvicorn/app.main — so it changes nothing about how the app actually runs.
"""
import os

os.environ.setdefault("REDIS_URL", "redis://localhost:6379")

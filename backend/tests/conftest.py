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
import asyncio
import os

import pytest

os.environ.setdefault("REDIS_URL", "redis://localhost:6379")


@pytest.fixture(autouse=True)
def _dispose_async_db_engine():
    """Dispose app.core.db's module-level async engine after every test.

    test_app_startup.py's DB tests each call asyncio.run(_run()) — every
    call spins up and tears down its own event loop. app.core.db.engine is
    a singleton whose asyncpg connections are bound to whichever loop was
    running when they were checked out; once returned to the pool they get
    handed to the *next* test's brand-new loop, where pool_pre_ping's ping
    fails closed with "RuntimeError: unable to perform operation on
    <TCPTransport ...>; the handler is closed" (uvloop) — a flaky,
    order-dependent CI failure that has nothing to do with the code under
    test. Disposing the pool after each test forces a fresh connection
    (and thus a fresh event-loop binding) next time. A no-op for every
    other test file, since only app.core.db importing tests are affected.
    """
    yield
    if os.getenv("DATABASE_URL"):
        from app.core.db import engine

        asyncio.run(engine.dispose())

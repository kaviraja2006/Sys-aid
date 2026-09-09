"""
Startup / auth / persistence smoke test.

Every other test file in this suite only exercises pure functions
(design_service's JSON repair, history windowing, simulation math) — none
of them ever import app.main, so a change that breaks the app's actual
boot sequence (an Alembic migration, main.py's lifespan, the auth/session
DB path) could land and still show a fully green CI. This file is the one
thing here that boots the real app against a real Postgres and exercises
the persistence path end to end.

Requires DATABASE_URL + REDIS_URL pointing at live services — see the
`postgres`/`redis` service containers in .github/workflows/ci.yml. Skipped
locally when DATABASE_URL isn't set, so `pytest` still runs the rest of the
suite with no services up, same as before this file existed.
"""
import asyncio
import os
from datetime import datetime, timedelta, timezone

import pytest

pytestmark = pytest.mark.skipif(
    not os.getenv("DATABASE_URL"),
    reason="requires a live DATABASE_URL (see .github/workflows/ci.yml's postgres service)",
)


def test_app_boots_and_health_check_is_public():
    """The app's lifespan runs `alembic upgrade head` against a real
    Postgres here — the first real-database exercise of the baseline
    migration (it was authored and verified against SQLite; a schema or
    driver mismatch that only shows up against real Postgres surfaces
    right here, before this ever reaches a deploy)."""
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as client:
        resp = client.get("/health")
        assert resp.status_code == 200
        assert resp.json()["status"] == "ok"


def test_auth_me_requires_a_session():
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as client:
        resp = client.get("/auth/me")
        assert resp.status_code == 401


def test_session_hash_lookup_round_trip():
    """Creates a real user + session against Postgres, then confirms the
    session is looked up correctly and stored hashed, never as the raw
    bearer token — the property auth.py's hashing rollout depends on."""
    from app.core.auth import _hash_token, _lookup_session, create_session
    from app.core.db import async_session_maker
    from app.models.db_models import User

    async def _run():
        async with async_session_maker() as db:
            user = User(google_sub="ci-smoke-test-sub-1", email="ci1@example.test", name="CI Smoke Test")
            db.add(user)
            await db.commit()
            await db.refresh(user)
            user_id = user.id

        raw_token = await create_session(user_id)

        async with async_session_maker() as db:
            db_session = await _lookup_session(db, raw_token)
            assert db_session is not None
            assert db_session.user_id == user_id
            assert db_session.token == _hash_token(raw_token)
            assert db_session.token != raw_token  # never stored raw

    asyncio.run(_run())


def test_cleanup_expired_sessions_deletes_expired_rows():
    """Exercises cleanup_expired_sessions() (main.py's background sweep)
    against a real expired row, confirming both the query and the schema
    it depends on (sessions.expires_at) are correct."""
    from app.core.auth import _hash_token, cleanup_expired_sessions
    from app.core.db import async_session_maker
    from app.models.db_models import Session as DbSession
    from app.models.db_models import User

    async def _run():
        async with async_session_maker() as db:
            user = User(google_sub="ci-smoke-test-sub-2", email="ci2@example.test", name="CI Smoke Test 2")
            db.add(user)
            await db.commit()
            await db.refresh(user)

            db.add(DbSession(
                token=_hash_token("already-expired-token"),
                user_id=user.id,
                expires_at=datetime.now(timezone.utc) - timedelta(days=1),
            ))
            await db.commit()

        deleted = await cleanup_expired_sessions()
        assert deleted >= 1

    asyncio.run(_run())

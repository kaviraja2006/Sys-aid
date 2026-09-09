"""
Async SQLAlchemy engine/session for Postgres.
Replaces the old aiosqlite file-based storage in app/api/chats.py.
"""
import asyncio
import os
from pathlib import Path

from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession

DATABASE_URL = os.getenv("DATABASE_URL", "")

if not DATABASE_URL:
    raise RuntimeError(
        "DATABASE_URL is not set. Add it to backend/.env, "
        "e.g. postgresql+asyncpg://user:pass@host:5432/dbname "
        "(asyncpg is the driver installed in requirements.txt; +psycopg will "
        "not work here)"
    )

engine = create_async_engine(DATABASE_URL, pool_pre_ping=True)
async_session_maker = async_sessionmaker(engine, expire_on_commit=False)

_ALEMBIC_INI = Path(__file__).resolve().parents[2] / "alembic.ini"


async def init_models():
    """Bring the database up to the latest Alembic migration (alembic/versions/).
    Schema used to be created ad hoc via Base.metadata.create_all() — that
    had no history, no rollback, and would silently drift from whatever the
    models said on any given deploy. Alembic's migration_history is now the
    single source of truth; changing a model means adding a migration
    (`alembic revision --autogenerate -m "..."`), not just editing db_models.py.

    Runs via asyncio.to_thread because Alembic's own async migration runner
    calls asyncio.run() internally, which cannot be called from inside the
    event loop this coroutine is already running in (FastAPI's lifespan).
    """
    from alembic.config import Config
    from alembic import command

    cfg = Config(str(_ALEMBIC_INI))
    cfg.set_main_option("script_location", str(_ALEMBIC_INI.parent / "alembic"))
    await asyncio.to_thread(command.upgrade, cfg, "head")


async def get_session() -> AsyncSession:
    async with async_session_maker() as session:
        yield session

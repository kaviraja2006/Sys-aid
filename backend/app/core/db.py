"""
Async SQLAlchemy engine/session for Postgres.
Replaces the old aiosqlite file-based storage in app/api/chats.py.
"""
import asyncio
import logging
import os
from pathlib import Path

from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession

logger = logging.getLogger(__name__)

DATABASE_URL = os.getenv("DATABASE_URL", "")

if DATABASE_URL:
    if DATABASE_URL.startswith("postgres://"):
        DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql+asyncpg://", 1)
    elif DATABASE_URL.startswith("postgresql://"):
        DATABASE_URL = DATABASE_URL.replace("postgresql://", "postgresql+asyncpg://", 1)

if not DATABASE_URL:
    raise RuntimeError(
        "DATABASE_URL is not set. Add it to backend/.env, "
        "e.g. postgresql+asyncpg://user:pass@host:5432/dbname "
        "(asyncpg is the driver installed in requirements.txt; +psycopg will "
        "not work here)"
    )

# Engine configuration for asyncpg with Supabase / connection poolers:
# - pool_recycle=300: drops idle connections after 5 min before cloud firewalls kill them.
# - pool_timeout=30: bounds pool checkout waits.
# - connect_args={"statement_cache_size": 0}: REQUIRED when using connection poolers
#   (Supavisor / PgBouncer in transaction mode) to prevent prepared statement collisions.
_engine_connect_args = {}
if "asyncpg" in DATABASE_URL:
    _engine_connect_args["statement_cache_size"] = 0

engine = create_async_engine(
    DATABASE_URL,
    pool_pre_ping=True,
    pool_recycle=300,
    pool_timeout=30,
    connect_args=_engine_connect_args,
)
async_session_maker = async_sessionmaker(engine, expire_on_commit=False)

_ALEMBIC_INI = Path(__file__).resolve().parents[2] / "alembic.ini"
_models_initialized = False


async def init_models(max_retries: int = 4, initial_delay: float = 2.0) -> bool:
    """Bring the database up to the latest Alembic migration (alembic/versions/).
    Schema used to be created ad hoc via Base.metadata.create_all() — that
    had no history, no rollback, and would silently drift from whatever the
    models said on any given deploy. Alembic's migration_history is now the
    single source of truth; changing a model means adding a migration
    (`alembic revision --autogenerate -m "..."`), not just editing db_models.py.

    Runs via asyncio.to_thread because Alembic's own async migration runner
    calls asyncio.run() internally, which cannot be called from inside the
    event loop this coroutine is already running in (FastAPI's lifespan).

    Retries with exponential backoff so cold-starting or waking databases
    (e.g. Supabase wake-up or transient network blips) don't crash startup.
    """
    global _models_initialized
    if _models_initialized:
        return True

    from alembic.config import Config
    from alembic import command

    cfg = Config(str(_ALEMBIC_INI))
    cfg.set_main_option("script_location", str(_ALEMBIC_INI.parent / "alembic"))

    delay = initial_delay
    last_exc = None

    for attempt in range(1, max_retries + 1):
        try:
            logger.info("Applying database migrations via Alembic (attempt %d/%d)...", attempt, max_retries)
            await asyncio.to_thread(command.upgrade, cfg, "head")
            logger.info("Database migrations applied successfully.")
            _models_initialized = True
            return True
        except Exception as exc:
            last_exc = exc
            err_msg = str(exc)
            if "tenant/user" in err_msg or "ENOTFOUND" in err_msg:
                logger.warning(
                    "Database migration attempt %d/%d failed: Supabase tenant/user not found. "
                    "This usually indicates your Supabase project is PAUSED (free tier 7-day idle pause) "
                    "or the project ref / region in DATABASE_URL is incorrect. "
                    "Check https://supabase.com/dashboard",
                    attempt,
                    max_retries,
                )
            else:
                logger.warning(
                    "Database migration attempt %d/%d failed: %s",
                    attempt,
                    max_retries,
                    exc,
                )

            if attempt < max_retries:
                logger.info("Retrying database migration in %.1f seconds...", delay)
                await asyncio.sleep(delay)
                delay = min(delay * 2, 15.0)

    logger.critical(
        "CRITICAL: Failed to run database migrations after %d attempts: %s\n"
        "If using Supabase, please verify that your project is active (not PAUSED) "
        "at https://supabase.com/dashboard",
        max_retries,
        last_exc,
    )
    if os.getenv("STRICT_DB_STARTUP", "false").strip().lower() in ("true", "1"):
        raise last_exc

    return False


async def get_session() -> AsyncSession:
    async with async_session_maker() as session:
        yield session

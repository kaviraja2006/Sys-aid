"""
Structured logging setup.

Every backend diagnostic — startup, RAG indexing, LLM errors, session
cleanup — used to go through bare print(). Fine at small scale, but with no
levels there was no way to filter startup noise from an actual error once
this runs anywhere with real log volume, and no way to turn verbosity up or
down without editing code.
"""
import logging
import os

_LOG_FORMAT = "%(asctime)s %(levelname)-8s %(name)s: %(message)s"


def setup_logging() -> None:
    level_name = os.getenv("LOG_LEVEL", "INFO").strip().upper()
    level = getattr(logging, level_name, logging.INFO)

    root = logging.getLogger()
    if root.handlers:
        # Already configured — e.g. re-imported under a test runner or a
        # reload. Don't add a second handler, which would print every line
        # twice.
        root.setLevel(level)
        return

    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter(_LOG_FORMAT))
    root.addHandler(handler)
    root.setLevel(level)

    # These libraries are chatty at INFO/DEBUG in a way that isn't useful
    # signal for this app's own logs. Keep them at WARNING unless LOG_LEVEL
    # is set even more permissively than that.
    for noisy_logger in ("httpx", "httpcore", "chromadb"):
        logging.getLogger(noisy_logger).setLevel(max(level, logging.WARNING))

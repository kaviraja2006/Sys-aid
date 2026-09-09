# SysAid — Production Readiness Checklist

Tracks every problem found in the `/review` audit (see the published report). Fixed items are commit `1cc62b5`. Everything below is being completed in this pass, one item at a time, each verified before moving to the next.

## Already fixed (commit 1cc62b5)

- [x] Cache-hit SSE path sent a bare graph object instead of `{"final": ...}`, rendering as `"[object Object]"` — `design_service.py`
- [x] Unparsed/broken LLM output was cached and replayed for 10 minutes — `design_service.py`
- [x] Duplicate `/health` route shadowed the public one, breaking Docker's `HEALTHCHECK` — `routes.py`
- [x] Raw exception text streamed as if it were assistant chat text — `chat_service.py` + frontend
- [x] `.env.example` missing `DATABASE_URL`/`REDIS_URL`/`GOOGLE_CLIENT_ID`, stale `GOOGLE_API_KEY` name
- [x] `db.py` startup error pointed at the wrong Postgres driver (`+psycopg` vs installed `+asyncpg`)
- [x] Dead `get_client_id`/cookie-signing code removed — `security.py`
- [x] `/simulate` was missing the rate limit every sibling route has
- [x] Stray `backend/package-lock.json` deleted
- [x] `Procfile` cleaned of pasted local dev commands
- [x] Unused `itsdangerous` dependency removed

## This pass

- [x] Verify the NVIDIA model IDs in the pending `llm.py` edit are real NIM catalog entries — confirmed against NVIDIA's own docs.api.nvidia.com reference pages, no fix needed
- [x] Remove the stray `"Gemini 3.1 Pro (Low)"` alias key — `llm.py`
- [x] Rate limiting was keyed by client IP, but on Render (and any reverse-proxy deploy) uvicorn ignores `X-Forwarded-For` by default — every request's "IP" was actually the proxy hop, so **all users shared one rate-limit bucket**. Fixed via `--proxy-headers --forwarded-allow-ips='*'` on both the Procfile and Dockerfile CMD (safe: the app is only ever reached through the platform's own proxy)
- [x] Session tokens hashed at rest — `auth.py`'s `_lookup_session` checks the hash first, falls back to a raw match for pre-existing rows and upgrades them in place, so no forced logout
- [x] Expired-session cleanup — `cleanup_expired_sessions()` in `auth.py`, run every `SESSION_CLEANUP_INTERVAL_SECONDS` (default 6h) from a cancellable background task in `main.py`'s lifespan
- [x] Alembic adopted — baseline migration generated from `db_models.py`, verified with a real upgrade+downgrade cycle against a throwaway DB; `db.py`'s `init_models()` now runs `alembic upgrade head` (via `asyncio.to_thread`, since Alembic's own runner calls `asyncio.run()` and can't nest inside FastAPI's lifespan loop) instead of `create_all`
- [ ] RAG knowledge base scoped per user (multi-tenant ingestion + query)
- [ ] CI: add a Postgres service container + a real startup/auth smoke test
- [ ] Frontend: code-split the chat panel's heavy deps (markdown/syntax-highlighter/settings) via `React.lazy`
- [ ] Structured logging: replace `print()` with the `logging` module across the backend

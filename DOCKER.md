# Docker (full stack)

`docker-compose.yml` runs the whole app: Postgres, Redis, the FastAPI backend,
and the React frontend behind nginx.

## Prerequisites

- Docker Desktop (or Docker Engine + Compose v2)
- `backend/.env` filled in from `backend/.env.example` — the API keys
  (`LLM_PROVIDER`, `*_API_KEY`, `GOOGLE_CLIENT_ID`, etc.) come from this file.
  `DATABASE_URL` and `REDIS_URL` in it are ignored by compose — it points the
  containers at the `postgres`/`redis` services instead.

## Run it

```bash
docker compose up -d --build
```

- Frontend: http://localhost:3000
- Backend: http://localhost:8000 (`/health` for a liveness check)
- Postgres / Redis are internal-only (no host port published) — reach them at
  `postgres:5432` / `redis:6379` from other containers, or add a port mapping
  locally if you need to inspect them from the host.

Alembic migrations run automatically on backend startup (see
`app/core/db.py::init_models`).

## Frontend build-time vars

Vite inlines `VITE_*` vars at build time, so they're passed as build args, not
runtime env vars. Override the defaults via a root `.env` file (read by
`docker compose` for `${...}` interpolation) or `--build-arg`:

```bash
VITE_API_URL=http://localhost:8000 docker compose up -d --build frontend
```

If the frontend is served from somewhere other than `localhost:3000`, set
`VITE_API_URL` to wherever the backend is actually reachable from the
browser — the in-network `backend` service name won't resolve client-side.

## Other useful commands

```bash
docker compose logs -f backend      # tail backend logs
docker compose ps                   # container + healthcheck status
docker compose down                 # stop everything
docker compose down -v              # also wipe postgres/redis/backend data volumes
docker compose up -d --build backend  # rebuild+restart just one service
```

## Ports

Override the published host ports via env vars if 3000/8000 are taken:

```bash
BACKEND_PORT=8080 FRONTEND_PORT=3001 docker compose up -d --build
```

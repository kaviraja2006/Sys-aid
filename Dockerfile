FROM python:3.11-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements and install Python dependencies
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application
COPY backend/ .

# Create necessary directories (chats now live in Postgres; chroma_db_v2 is
# the RAG vector store's on-disk cache — see app/core/rag.py)
RUN mkdir -p app/data/chroma_db_v2

# Health check — reads $PORT the same way the CMD below does, so this still
# probes the right port on platforms (Render, etc.) that assign one dynamically.
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD sh -c 'curl -f http://localhost:${PORT:-8000}/health || exit 1'

# Run the application.
# Shell form (not exec-form CMD) so ${PORT:-8000} actually expands — Render
# and similar platforms set $PORT dynamically and expect the container to
# bind to it; hardcoding 8000 only works if PORT happens to be pinned to
# match in the platform's dashboard, which silently breaks on drift.
#
# --forwarded-allow-ips='*' trusts X-Forwarded-For from whatever connects
# directly to this process. Safe only because the container is never
# reachable except through the platform's own reverse proxy (Render/etc.) —
# without it, uvicorn's default (trust only 127.0.0.1) means every request's
# "client IP" is the proxy hop, so slowapi's per-IP rate limiting collapses
# into one shared bucket for the entire user base.
CMD uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000} --proxy-headers --forwarded-allow-ips=*

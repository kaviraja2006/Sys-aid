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

# Create necessary directories
RUN mkdir -p app/data/chats app/data/chroma_db

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8000/health || exit 1

# Run the application.
# --forwarded-allow-ips='*' trusts X-Forwarded-For from whatever connects
# directly to this process. Safe only because the container is never
# reachable except through the platform's own reverse proxy (Render/etc.) —
# without it, uvicorn's default (trust only 127.0.0.1) means every request's
# "client IP" is the proxy hop, so slowapi's per-IP rate limiting collapses
# into one shared bucket for the entire user base.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips=*"]

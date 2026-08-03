import os
from slowapi import Limiter
from slowapi.util import get_remote_address

# Redis-backed storage so rate limits are enforced consistently across
# multiple worker processes/instances, not per-process like the old default.
REDIS_URL = os.getenv("REDIS_URL", "")

limiter = Limiter(
    key_func=get_remote_address,
    storage_uri=REDIS_URL or None,
)

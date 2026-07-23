import sys
import asyncio
if sys.platform != "win32":
    try:
        import uvloop
        uvloop.install()
    except ImportError:
        pass
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import ORJSONResponse
from app.api import routes, chats
from app.core.llm import stop_ollama as _stop_ollama, close_http_client, _warmup
from app.core.rag import RAG_ENABLED
from contextlib import asynccontextmanager
import os
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from app.core.limiter import limiter


@asynccontextmanager
async def lifespan(app: FastAPI):
    # ── Startup ──────────────────────────────────────────────────────────────
    # Pre-warm litellm internals so the first real user request hits a hot path.
    # This runs in the background — server is ready immediately, warmup finishes
    # within a few seconds behind the scenes.
    asyncio.create_task(_warmup())

    # RAG (ChromaDB + the ONNX embedding model) is NOT initialized here.
    # Loading the embedding model costs real memory, so it's deferred until
    # the first search/ingest call actually needs it (see app.core.rag),
    # and only runs at all when RAG_ENABLED=true.
    if not RAG_ENABLED:
        print("RAG disabled (set RAG_ENABLED=true to enable). Skipping embedding model load.")

    if not os.getenv("BACKEND_API_KEY"):
        if os.getenv("ENVIRONMENT", "development").strip().lower() == "production":
            raise RuntimeError(
                "BACKEND_API_KEY is not set. Refusing to start with ENVIRONMENT=production "
                "and auth disabled on all protected routes. Set BACKEND_API_KEY or unset "
                "ENVIRONMENT to run without auth in local development."
            )
        print("WARNING: BACKEND_API_KEY is not set - all protected routes are running with auth DISABLED.")

    # Initialize chat database
    await chats.init_db()
    
    print("SysAid AI: server ready. LLM pre-warm running in background...")

    yield  # ← app runs here

    # ── Shutdown ─────────────────────────────────────────────────────────────
    print("Shutting down — closing HTTP pool and any local LLM processes...")
    await close_http_client()
    _stop_ollama()


app = FastAPI(title="SysAid AI", lifespan=lifespan, default_response_class=ORJSONResponse)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# Allowed origins
# Support both `ALLOWED_ORIGINS` (current) and `CORS_ORIGINS` (legacy/docs) env vars.
allowed_origins_str = (
    os.getenv("ALLOWED_ORIGINS")
    or os.getenv("CORS_ORIGINS")
    or "http://localhost:5173,http://127.0.0.1:5173,https://sys-aid.netlify.app"
)
origins = [origin.strip() for origin in allowed_origins_str.split(",") if origin.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(routes.router)
app.include_router(chats.router, prefix="/chats")


@app.get("/")
def root():
    return {"msg": "SysAid running"}


@app.get("/health")
def health():
    """Health check endpoint for monitoring (no auth required)."""
    from app.core.rag import _rag_available
    return {
        "status": "ok",
        "rag_available": _rag_available
    }


@app.get("/health/cors")
def health_cors(request: Request):
    """Debug endpoint to verify deployed CORS configuration."""
    return {
        "request_origin": request.headers.get("origin"),
        "allowed_origins": origins,
    }

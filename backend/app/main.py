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
from app.core.rag import init_rag
from contextlib import asynccontextmanager
import os
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded


@asynccontextmanager
async def lifespan(app: FastAPI):
    # ── Startup ──────────────────────────────────────────────────────────────
    # Pre-warm litellm internals so the first real user request hits a hot path.
    # This runs in the background — server is ready immediately, warmup finishes
    # within a few seconds behind the scenes.
    asyncio.create_task(_warmup())
    
    # Initialize RAG and Vector DB without blocking event loop
    # Wrapped in try-catch so app continues even if RAG fails
    try:
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, init_rag)
    except Exception as e:
        print(f"⚠️  RAG initialization failed: {str(e)}")
        print("App will continue without RAG support")
    
    # Initialize chat database
    await chats.init_db()
    
    print("SysAid AI: server ready. LLM pre-warm and RAG initialized in background...")

    yield  # ← app runs here

    # ── Shutdown ─────────────────────────────────────────────────────────────
    print("Shutting down — closing HTTP pool and any local LLM processes...")
    await close_http_client()
    _stop_ollama()


limiter = Limiter(key_func=get_remote_address)
app = FastAPI(title="SysAid AI", lifespan=lifespan, default_response_class=ORJSONResponse)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# Allowed origins
allowed_origins_str = os.getenv("ALLOWED_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173")
origins = [origin.strip() for origin in allowed_origins_str.split(",")]

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

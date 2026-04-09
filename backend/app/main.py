from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.api import routes, chats
from app.core.llm import stop_ollama as _stop_ollama, close_http_client, _warmup
from contextlib import asynccontextmanager
import asyncio


@asynccontextmanager
async def lifespan(app: FastAPI):
    # ── Startup ──────────────────────────────────────────────────────────────
    # Pre-warm litellm internals so the first real user request hits a hot path.
    # This runs in the background — server is ready immediately, warmup finishes
    # within a few seconds behind the scenes.
    asyncio.create_task(_warmup())
    print("SysAid AI: server ready. LLM pre-warm running in background...")

    yield  # ← app runs here

    # ── Shutdown ─────────────────────────────────────────────────────────────
    print("Shutting down — closing HTTP pool and any local LLM processes...")
    await close_http_client()
    _stop_ollama()


app = FastAPI(title="SysAid AI", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(routes.router)
app.include_router(chats.router, prefix="/chats")


@app.get("/")
def root():
    return {"msg": "SysAid running"}

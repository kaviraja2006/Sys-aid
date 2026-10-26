from fastapi import APIRouter, Body, Request, UploadFile, File, Depends, HTTPException
from fastapi.responses import StreamingResponse
from app.services.design_service import generate_design_stream
from app.services.simulation_service import simulate_system
from app.services.improve_service import improve_design
from app.services.chat_service import handle_chat_stream
from app.services.review_service import review_architecture
from app.models.schema import GenerateRequest, SimulationInput, ImproveRequest
from app.models.db_models import User
from app.core.cache import response_cache
from app.core.rag import ingest_document
from app.core.llm import call_llm, HEALTH_TIMEOUT_SECONDS
from app.core.security import get_api_key
from app.core.auth import get_current_user, get_current_user_optional
from app.core.limiter import limiter

router = APIRouter(dependencies=[Depends(get_api_key)])


_SSE_HEADERS = {
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",   # disables nginx proxy buffering
    "Connection": "keep-alive",
}


@router.post("/chat")
@limiter.limit("10/minute")
async def chat_endpoint(request: Request, req: GenerateRequest, user: User | None = Depends(get_current_user_optional)):
    return StreamingResponse(
        handle_chat_stream(
            req.prompt, req.chat_history, req, user_id=user.id if user else None,
            current_design=req.current_design,
        ),
        media_type="text/event-stream",
        headers=_SSE_HEADERS,
    )


@router.post("/generate-board")
@limiter.limit("10/minute")
async def generate_board_endpoint(request: Request, req: GenerateRequest, user: User | None = Depends(get_current_user_optional)):
    from app.services.design_service import generate_design_stream
    return StreamingResponse(
        generate_design_stream(
            req.prompt, req.current_design, req.chat_history, req, req.documentation,
            user_id=user.id if user else None,
        ),
        media_type="text/event-stream",
        headers=_SSE_HEADERS,
    )


@router.post("/simulate")
@limiter.limit("10/minute")
async def simulate(request: Request, req: SimulationInput):
    return simulate_system(req)


@router.post("/improve")
@limiter.limit("10/minute")
async def improve(request: Request, req: ImproveRequest):
    return await improve_design(req)


@router.post("/review")
@limiter.limit("10/minute")
async def review(request: Request, req: GenerateRequest):
    """Review an architecture design and return scores + improvement suggestions."""
    nodes = req.current_design.get("nodes", []) if req.current_design else []
    edges = req.current_design.get("edges", []) if req.current_design else []
    
    result = await review_architecture(
        nodes=nodes,
        edges=edges,
        provider=req.provider if req else "ollama",
        api_key=req.api_key if req else "",
        model_name=req.model_name if req else "",
        api_url=req.api_url if req else "",
    )
    return result


# NOTE: no /health here — main.py already registers a public, no-auth
# /health at the same path with identical output. A second one on this
# API-key-gated router used to shadow it (FastAPI matches routes in
# registration order, and this router's routes are added first), which broke
# Docker's/the platform's health check the moment BACKEND_API_KEY was set.

# ── Cache management endpoints ────────────────────────────────────────────────

@router.get("/cache/stats")
async def cache_stats():
    """Returns current LRU response cache statistics."""
    return response_cache.stats()


@router.post("/cache/clear")
async def cache_clear():
    """Clears the LRU response cache manually."""
    response_cache.clear()
    return {"status": "cleared"}

import time
import httpx
from app.core.llm import call_llm, HEALTH_TIMEOUT_SECONDS, _resolve_api_key, OLLAMA_URL

_MODELS_CACHE = {}  # key -> (timestamp, [models])
_MODELS_CACHE_TTL = 300  # 5 minutes


async def _fetch_provider_models(provider: str, api_key: str, api_url: str):
    provider = (provider or "").strip().lower()
    resolved_key = _resolve_api_key(provider, api_key)
    if resolved_key == "dummy-key":
        resolved_key = ""

    if provider == "openrouter":
        headers = {
            "HTTP-Referer": "http://localhost:5173",
            "X-Title": "SysAid Architect",
        }
        if resolved_key:
            headers["Authorization"] = f"Bearer {resolved_key}"
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get("https://openrouter.ai/api/v1/models", headers=headers)
            if resp.status_code == 200:
                data = resp.json().get("data", [])
                models = []
                for m in data:
                    mid = m.get("id", "")
                    name = m.get("name") or mid
                    ctx = m.get("context_length")
                    pricing = m.get("pricing", {})
                    is_free = ":free" in mid or (pricing.get("prompt") == "0" and pricing.get("completion") == "0")
                    models.append({
                        "id": mid,
                        "name": name,
                        "context_length": ctx,
                        "is_free": is_free,
                    })
                models.sort(key=lambda x: (not x["is_free"], x["name"].lower()))
                return models
            raise RuntimeError(f"OpenRouter returned status {resp.status_code}: {resp.text[:120]}")

    elif provider == "nvidia":
        headers = {}
        if resolved_key:
            headers["Authorization"] = f"Bearer {resolved_key}"
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get("https://integrate.api.nvidia.com/v1/models", headers=headers)
            if resp.status_code == 200:
                data = resp.json().get("data", [])
                models = [{"id": m["id"], "name": m.get("id")} for m in data if m.get("id")]
                models.sort(key=lambda x: x["id"].lower())
                return models
            raise RuntimeError(f"NVIDIA API returned status {resp.status_code}: {resp.text[:120]}")

    elif provider == "openai":
        headers = {}
        if resolved_key:
            headers["Authorization"] = f"Bearer {resolved_key}"
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get("https://api.openai.com/v1/models", headers=headers)
            if resp.status_code == 200:
                data = resp.json().get("data", [])
                chat_ids = [m["id"] for m in data if any(k in m["id"] for k in ("gpt-4", "gpt-3.5", "o1", "o3", "chat"))]
                chat_ids.sort()
                return [{"id": mid, "name": mid} for mid in chat_ids]
            raise RuntimeError(f"OpenAI API returned status {resp.status_code}: {resp.text[:120]}")

    elif provider == "ollama":
        base = api_url.rstrip("/") if api_url else OLLAMA_URL
        async with httpx.AsyncClient(timeout=6.0) as client:
            resp = await client.get(f"{base}/api/tags")
            if resp.status_code == 200:
                data = resp.json().get("models", [])
                return [{"id": m.get("name") or m.get("model"), "name": m.get("name")} for m in data]
            raise RuntimeError(f"Ollama returned status {resp.status_code}")

    elif provider == "gemini":
        if resolved_key:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get(f"https://generativelanguage.googleapis.com/v1beta/models?key={resolved_key}")
                if resp.status_code == 200:
                    data = resp.json().get("models", [])
                    models = []
                    for m in data:
                        mid = m.get("name", "").replace("models/", "")
                        if "generateContent" in m.get("supportedGenerationMethods", []):
                            models.append({"id": mid, "name": m.get("displayName") or mid})
                    if models:
                        return models
        return [
            {"id": "gemini-2.0-flash", "name": "Gemini 2.0 Flash"},
            {"id": "gemini-1.5-flash", "name": "Gemini 1.5 Flash"},
            {"id": "gemini-1.5-pro", "name": "Gemini 1.5 Pro"},
        ]

    elif provider == "anthropic":
        return [
            {"id": "claude-3-7-sonnet-20250219", "name": "Claude 3.7 Sonnet"},
            {"id": "claude-3-5-sonnet-20241022", "name": "Claude 3.5 Sonnet"},
            {"id": "claude-3-5-haiku-20241022", "name": "Claude 3.5 Haiku"},
            {"id": "claude-3-haiku-20240307", "name": "Claude 3 Haiku"},
            {"id": "claude-3-opus-20240229", "name": "Claude 3 Opus"},
        ]

    elif provider == "openai-compatible":
        if api_url:
            base = api_url.rstrip("/")
            for sfx in ("/chat/completions", "/completions"):
                if base.endswith(sfx):
                    base = base[:-len(sfx)]
            headers = {"Authorization": f"Bearer {resolved_key}"} if resolved_key else {}
            async with httpx.AsyncClient(timeout=8.0) as client:
                for endpoint in (f"{base}/models", f"{base}/v1/models"):
                    try:
                        resp = await client.get(endpoint, headers=headers)
                        if resp.status_code == 200:
                            data = resp.json().get("data", [])
                            return [{"id": m["id"], "name": m.get("name", m["id"])} for m in data if m.get("id")]
                    except Exception:
                        continue
        return []

    return []


@router.post("/models")
async def get_models_endpoint(req: dict = Body(...)):
    provider = req.get("provider", "").strip().lower()
    api_key = req.get("api_key", "").strip()
    api_url = req.get("api_url", "").strip()

    cache_key = f"{provider}:{api_key[-8:] if api_key else ''}:{api_url}"
    cached = _MODELS_CACHE.get(cache_key)
    now = time.time()
    if cached and (now - cached[0] < _MODELS_CACHE_TTL):
        return {"status": "ok", "models": cached[1]}

    try:
        models = await _fetch_provider_models(provider, api_key, api_url)
        _MODELS_CACHE[cache_key] = (now, models)
        return {"status": "ok", "models": models}
    except Exception as e:
        # Fall back to empty or cached
        return {"status": "error", "message": str(e), "models": []}


@router.post("/health/llm")
async def health_llm(req: dict = Body(...)):
    provider = req.get("provider", "ollama")
    api_key = req.get("api_key", "")
    model_name = req.get("model_name", "")
    api_url = req.get("api_url", "")
    try:
        # Use 16 tokens so reasoning and modern models don't fail length checks
        await call_llm(
            "Respond with 'OK'.",
            provider=provider,
            api_key=api_key,
            model_name=model_name,
            api_url=api_url,
            max_tokens=16,
            timeout_seconds=HEALTH_TIMEOUT_SECONDS,
            use_cache=False,
        )
        return {"status": "ok"}
    except Exception as e:
        raise HTTPException(status_code=502, detail={"status": "error", "message": str(e)})

MAX_UPLOAD_BYTES = 5 * 1024 * 1024  # 5 MB


@router.post("/upload-knowledge")
@limiter.limit("10/minute")
async def upload_knowledge(request: Request, file: UploadFile = File(...), user: User = Depends(get_current_user)):
    content = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="File too large (max 5 MB)")
    text = content.decode('utf-8', errors='ignore')
    ingest_document(text, file.filename, user_id=user.id)
    return {"status": "success", "filename": file.filename}

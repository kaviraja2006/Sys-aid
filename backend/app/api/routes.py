from fastapi import APIRouter, Body, Request, UploadFile, File, Depends, HTTPException
from fastapi.responses import StreamingResponse
from app.services.design_service import generate_design_stream
from app.services.simulation_service import simulate_system
from app.services.improve_service import improve_design
from app.services.chat_service import handle_chat_stream
from app.services.review_service import review_architecture
from app.models.schema import GenerateRequest, SimulationInput, ImproveRequest
from app.core.cache import response_cache
from app.core.rag import ingest_document
from app.core.llm import call_llm, HEALTH_TIMEOUT_SECONDS
from app.core.security import get_api_key
from app.core.limiter import limiter

router = APIRouter(dependencies=[Depends(get_api_key)])


_SSE_HEADERS = {
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",   # disables nginx proxy buffering
    "Connection": "keep-alive",
}


@router.post("/chat")
@limiter.limit("10/minute")
async def chat_endpoint(request: Request, req: GenerateRequest):
    return StreamingResponse(
        handle_chat_stream(req.prompt, req.chat_history, req),
        media_type="text/event-stream",
        headers=_SSE_HEADERS,
    )


@router.post("/generate-board")
@limiter.limit("10/minute")
async def generate_board_endpoint(request: Request, req: GenerateRequest):
    from app.services.design_service import generate_design_stream
    return StreamingResponse(
        generate_design_stream(req.prompt, req.current_design, req.chat_history, req),
        media_type="text/event-stream",
        headers=_SSE_HEADERS,
    )


@router.post("/simulate")
async def simulate(req: SimulationInput):
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


@router.get("/health")
async def health_check():
    """Check if backend is running and RAG is available."""
    from app.core.rag import _rag_available
    
    return {
        "status": "ok",
        "rag_available": _rag_available
    }


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

@router.post("/health/llm")
async def health_llm(req: dict = Body(...)):
    provider = req.get("provider", "ollama")
    api_key = req.get("api_key", "")
    model_name = req.get("model_name", "")
    api_url = req.get("api_url", "")
    try:
        await call_llm(
            "ping",
            provider=provider,
            api_key=api_key,
            model_name=model_name,
            api_url=api_url,
            max_tokens=1,
            timeout_seconds=HEALTH_TIMEOUT_SECONDS,
            use_cache=False,
        )
        return {"status": "ok"}
    except Exception as e:
        raise HTTPException(status_code=502, detail={"status": "error", "message": str(e)})

MAX_UPLOAD_BYTES = 5 * 1024 * 1024  # 5 MB


@router.post("/upload-knowledge")
@limiter.limit("10/minute")
async def upload_knowledge(request: Request, file: UploadFile = File(...)):
    content = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="File too large (max 5 MB)")
    text = content.decode('utf-8', errors='ignore')
    ingest_document(text, file.filename)
    return {"status": "success", "filename": file.filename}

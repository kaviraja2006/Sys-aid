from fastapi import APIRouter, Body, UploadFile, File, Depends
from fastapi.responses import StreamingResponse
from app.services.design_service import generate_design_stream
from app.services.simulation_service import simulate_system
from app.services.improve_service import improve_design
from app.services.chat_service import handle_chat_stream
from app.services.review_service import review_architecture
from app.models.schema import GenerateRequest
from app.core.cache import response_cache
from app.core.rag import ingest_document
from app.core.security import get_api_key
import litellm

router = APIRouter(dependencies=[Depends(get_api_key)])


_SSE_HEADERS = {
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",   # disables nginx proxy buffering
    "Connection": "keep-alive",
}


@router.post("/chat")
async def chat_endpoint(req: GenerateRequest):
    return StreamingResponse(
        handle_chat_stream(req.prompt, req.chat_history, req),
        media_type="text/event-stream",
        headers=_SSE_HEADERS,
    )


@router.post("/generate-board")
async def generate_board_endpoint(req: GenerateRequest):
    from app.services.design_service import generate_design_stream
    return StreamingResponse(
        generate_design_stream(req.prompt, req.current_design, req.chat_history, req),
        media_type="text/event-stream",
        headers=_SSE_HEADERS,
    )


@router.post("/simulate")
async def simulate(data: dict):
    return simulate_system(data)


@router.post("/improve")
async def improve(data: dict):
    return await improve_design(data)


@router.post("/review")
async def review(req: GenerateRequest):
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
        if provider == "ollama":
            model = f"ollama/{model_name or 'llama3'}"
        else:
            model = f"{provider}/{model_name}"
            
        kwargs = {
            "model": model,
            "messages": [{"role": "user", "content": "ping"}],
            "api_key": api_key or "dummy-key",
            "max_tokens": 1
        }
        if api_url:
            kwargs["api_base"] = api_url
            
        await litellm.acompletion(**kwargs)
        return {"status": "ok"}
    except Exception as e:
        return {"status": "error", "message": str(e)}

@router.post("/upload-knowledge")
async def upload_knowledge(file: UploadFile = File(...)):
    content = await file.read()
    text = content.decode('utf-8', errors='ignore')
    ingest_document(text, file.filename)
    return {"status": "success", "filename": file.filename}

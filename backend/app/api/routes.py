from fastapi import APIRouter, Body
from fastapi.responses import StreamingResponse
from app.services.design_service import generate_design
from app.services.simulation_service import simulate_system
from app.services.improve_service import improve_design
from app.services.chat_service import handle_chat_stream
from app.models.schema import GenerateRequest
from app.core.cache import response_cache

router = APIRouter()


@router.post("/chat")
async def chat_endpoint(req: GenerateRequest):
    return StreamingResponse(
        handle_chat_stream(req.prompt, req.chat_history, req),
        media_type="text/event-stream",
    )


@router.post("/generate-board")
async def generate_board_endpoint(req: GenerateRequest):
    return await generate_design(req.prompt, req.current_design, req.chat_history, req)


@router.post("/simulate")
async def simulate(data: dict):
    return simulate_system(data)


@router.post("/improve")
async def improve(data: dict):
    return await improve_design(data)


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

"""
Improve service — lean prompt, structured input.

✅ Optimization 5 — compressed system instruction
✅ Optimization 6 — structured JSON input instead of raw dump
✅ Optimization 8 — pre-filter: only send bottlenecked nodes to LLM
"""
import json
from app.core.llm import call_llm
from app.models.schema import ImproveRequest


def _compress_design(req: ImproveRequest) -> dict:
    """
    ✅ Optimization 8 — do backend work, not LLM work.
    Extract only the bottlenecked nodes and minimal edge list.
    The LLM only needs to reason about the problem areas, not the full graph.
    """
    sim = req.simulation_output

    overloaded_ids = {b.node_id for b in sim.bottlenecks if b.overloaded}

    # Only send overloaded nodes; if none, fall back to all nodes (truncated)
    all_nodes = req.design.nodes
    relevant = [n for n in all_nodes if n.id in overloaded_ids] or all_nodes[:8]

    node_summary = [
        {"id": n.id, "label": n.label, "limit": n.limit}
        for n in relevant
    ]

    return {
        "overloaded_nodes": node_summary,
        "bottlenecks": [b.dict() for b in sim.bottlenecks],
        "system_overloaded": sim.overloaded,
        "latency_ms": sim.system_latency_estimate_ms,
    }


async def improve_design(req: ImproveRequest):
    compact = _compress_design(req)

    # ✅ Optimization 5 — short, action-oriented prompt
    prompt = (
        "Fix system design bottlenecks. Suggest specific component upgrades, "
        "scaling strategies, or topology changes. Be concise.\n\n"
        + json.dumps(compact, separators=(",", ":"))
    )

    response = await call_llm(
        prompt,
        provider=req.provider or "ollama",
        api_key=req.api_key or "",
        model_name=req.model_name or "",
        api_url=req.api_url or "",
    )
    return {"improved": response}

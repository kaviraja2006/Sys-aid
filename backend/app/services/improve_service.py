"""
Improve service — lean prompt, structured input.

✅ Optimization 5 — compressed system instruction
✅ Optimization 6 — structured JSON input instead of raw dump
✅ Optimization 8 — pre-filter: only send bottlenecked nodes to LLM
"""
import json
from app.core.llm import call_llm


def _compress_design(data: dict) -> dict:
    """
    ✅ Optimization 8 — do backend work, not LLM work.
    Extract only the bottlenecked nodes and minimal edge list.
    The LLM only needs to reason about the problem areas, not the full graph.
    """
    design = data.get("design", {})
    sim = data.get("simulation_output", {})

    overloaded_ids = {
        b["node_id"] for b in sim.get("bottlenecks", []) if b.get("overloaded")
    }

    # Only send overloaded nodes; if none, fall back to all nodes (truncated)
    all_nodes = design.get("nodes", [])
    relevant = [n for n in all_nodes if n.get("id") in overloaded_ids] or all_nodes[:8]

    node_summary = [
        {"id": n["id"], "label": n.get("label", n.get("id")), "limit": n.get("limit")}
        for n in relevant
    ]

    return {
        "overloaded_nodes": node_summary,
        "bottlenecks": sim.get("bottlenecks", []),
        "system_overloaded": sim.get("overloaded", False),
        "latency_ms": sim.get("system_latency_estimate_ms", 0),
    }


async def improve_design(data: dict):
    compact = _compress_design(data)

    # ✅ Optimization 5 — short, action-oriented prompt
    prompt = (
        "Fix system design bottlenecks. Suggest specific component upgrades, "
        "scaling strategies, or topology changes. Be concise.\n\n"
        + json.dumps(compact, separators=(",", ":"))
    )

    response = await call_llm(
        prompt,
        provider=data.get("provider", "ollama"),
        api_key=data.get("api_key", ""),
        model_name=data.get("model_name", ""),
        api_url=data.get("api_url", ""),
    )
    return {"improved": response}

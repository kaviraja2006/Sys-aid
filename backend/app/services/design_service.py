"""
Generate-board service.
Produces a valid React Flow JSON graph from a user description.
"""
import json
import re
from app.core.llm import call_llm
from app.core.rag import search_knowledge
from typing import Optional, Dict, Any, List

# ── System prompt ─────────────────────────────────────────────────────────────
# Rules:
#  • Use double-quoted keys/values in the example — models mirror the style
#  • Be explicit: "valid JSON only", "no markdown", "no explanation"
#  • Keep it short — fewer input tokens = faster response
_SYSTEM = (
    'You are a system architecture expert. '
    'Respond with ONLY a single valid JSON object — no markdown, no explanation, no code fences. '
    'The JSON must have exactly two keys: "nodes" and "edges". '
    'Each node: {"id":"string","type":"archNode","data":{"label":"string","description":"string","systemType":"string"}} '
    'systemType must be one of: database, server, client, cloud, cache, default. '
    'Each edge: {"id":"string","source":"nodeId","target":"nodeId","label":"string","type":"smoothstep","animated":true} '
    'Every node must be connected via at least one edge. '
    'Edge source and target must exactly match existing node ids. '
    'Output raw JSON only. First character must be "{".'
)

def _summarise_design(design: Optional[Dict[str, Any]]) -> Optional[Dict]:
    """Send only ids + labels of existing nodes — not the full node objects."""
    if not design or not design.get("nodes"):
        return None
    return {
        "nodes": [
            {"id": n["id"], "label": n.get("data", {}).get("label", "")}
            for n in design["nodes"]
        ],
        "edges": [
            {"src": e["source"], "tgt": e["target"]}
            for e in design.get("edges", [])
        ],
    }


def _trim_history(history: Optional[List[Dict]]) -> List[Dict]:
    """Keep only last 4 turns, strip metadata."""
    if not history:
        return []
    return [
        {"role": m.get("role", "user"), "text": str(m.get("text", ""))[:300]}
        for m in history[-4:]
    ]


def _extract_json(raw: str) -> str:
    """
    Extract the raw JSON string from the model response.
    Strip markdown fences and any leading/trailing text.
    """
    s = raw.strip()

    # 1. Strip markdown fences: ```json ... ``` or ``` ... ```
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", s)
    if fence:
        s = fence.group(1).strip()
    else:
        # 2. Slice from first { to last }
        start = s.find("{")
        end = s.rfind("}") + 1
        if start >= 0 and end > start:
            s = s[start:end]

    return s


def _repair_json(s: str) -> str:
    """
    Apply targeted repairs to common LLM JSON failures.
    Run AFTER extraction, BEFORE json.loads().
    """
    # Remove JS single-line and block comments
    s = re.sub(r"//[^\n]*", "", s)
    s = re.sub(r"/\*.*?\*/", "", s, flags=re.DOTALL)

    # Fix Python booleans and None → JSON equivalents
    s = re.sub(r"\bTrue\b", "true", s)
    s = re.sub(r"\bFalse\b", "false", s)
    s = re.sub(r"\bNone\b", "null", s)

    # Fix single-quoted keys: 'key': → "key":
    s = re.sub(r"'([^'\n]+)'(\s*:)", r'"\1"\2', s)
    # Fix single-quoted string values: : 'value' → : "value"
    s = re.sub(r"(:\s*)'([^'\n]*)'", r'\1"\2"', s)

    # Add missing commas between adjacent objects in an array:  }  {  →  },  {
    s = re.sub(r"}\s*\n(\s*){", r"},\n\1{", s)
    # Add missing commas between adjacent arrays: ]  [  → ],  [
    s = re.sub(r"]\s*\n(\s*)\[", r"],\n\1[", s)
    # Add missing commas between adjacent quoted strings on separate lines: "x"\n"y" → "x","y"
    s = re.sub(r'"\s*\n(\s*)"', r'",\n\1"', s)

    # Remove trailing commas before } or ]
    s = re.sub(r",(\s*[}\]])", r"\1", s)

    return s


def _safe_parse(raw: str) -> dict:
    """
    Multi-stage JSON parser. Tries increasingly aggressive fixes until one works.
    Raises json.JSONDecodeError only when all stages fail.
    """
    import ast

    # Stage 1: extract then parse as-is
    extracted = _extract_json(raw)
    try:
        return json.loads(extracted)
    except json.JSONDecodeError:
        pass

    # Stage 2: apply targeted repairs then parse
    repaired = _repair_json(extracted)
    try:
        return json.loads(repaired)
    except json.JSONDecodeError:
        pass

    # Stage 3: ast.literal_eval — handles single-quoted dicts, trailing commas,
    # Python-style booleans. Works even when json.loads completely fails.
    try:
        # Swap JSON booleans to Python style for ast
        ast_str = repaired.replace("true", "True").replace("false", "False").replace("null", "None")
        result = ast.literal_eval(ast_str)
        if isinstance(result, dict):
            # Round-trip through json to normalise types (True→true etc.)
            return json.loads(json.dumps(result))
    except Exception:
        pass

    # All stages failed
    raise json.JSONDecodeError(
        f"All parsing stages failed. Raw start: {raw[:100]!r}", raw, 0
    )


async def generate_design(
    user_prompt: str,
    current_design: Optional[Dict[str, Any]] = None,
    chat_history: Optional[List[Dict[str, str]]] = None,
    req_config: Any = None,
):
    payload: Dict[str, Any] = {"request": user_prompt}

    # Fetch context from knowledge base
    context = search_knowledge(user_prompt)
    if context:
        payload["knowledge_base_context"] = context

    history = _trim_history(chat_history)
    if history:
        payload["history"] = history

    summarised = _summarise_design(current_design)
    if summarised:
        payload["existing_design"] = summarised
        payload["instruction"] = "Update existing design. Keep node ids. Apply changes only."
    else:
        payload["instruction"] = "Create a new design graph."

    prompt = _SYSTEM + "\n\n" + json.dumps(payload, separators=(",", ":"))

    response = ""
    try:
        response = await call_llm(
            prompt,
            provider=req_config.provider if req_config else "ollama",
            api_key=req_config.api_key if req_config else "",
            model_name=req_config.model_name if req_config else "",
            api_url=req_config.api_url if req_config else "",
            max_tokens=2048,
        )
        return _safe_parse(response)

    except json.JSONDecodeError as e:
        print(f"[design_service] JSON parse failed: {e}")
        print(f"[design_service] Raw response: {response[:600]}")
        return {
            "error": f"Model returned invalid JSON: {e}",
            "hint": "Try rephrasing, or switch to a more capable model (e.g. llama-3.3-70b-instruct for NVIDIA).",
            "raw_response": response[:300],
        }
    except Exception as e:
        return {"error": str(e), "raw_response": response[:300]}

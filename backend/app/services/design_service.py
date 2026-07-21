"""
Generate-board service.
Produces a valid React Flow JSON graph from a user description.
"""
import json
import re
import asyncio
from app.core.llm import call_llm
from app.core.rag import search_knowledge_async
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
    'The chat history is a running discussion where the user may add, remove, or revise '
    'components over several turns — always resolve to the LATEST decision on each point, '
    'not earlier ones that were later changed or rejected. '
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


from app.core.history import trim_history as _window_recent_history, build_summary_prefix


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


def _salvage_truncated(s: str) -> Optional[str]:
    """
    Last-resort repair for output truncated mid-stream (the model ran out of
    its token budget before finishing — common for large designs sent with a
    full chat history). Walks the text tracking string/bracket state, remembers
    the last point where a complete array element had just closed, cuts there,
    and closes whatever brackets were still open. This drops only the one
    incomplete trailing element instead of failing the whole graph.
    """
    stack = []
    in_string = False
    escape = False
    last_safe_cut = None

    for i, ch in enumerate(s):
        if escape:
            escape = False
            continue
        if ch == "\\" and in_string:
            escape = True
            continue
        if ch == '"':
            in_string = not in_string
            continue
        if in_string:
            continue

        if ch in "{[":
            stack.append(ch)
        elif ch in "}]":
            if stack:
                stack.pop()
            # Right after closing a bracket, if the parent is still an open
            # array, we're at a boundary between array elements — safe to cut.
            if stack and stack[-1] == "[":
                last_safe_cut = i + 1

    if last_safe_cut is None or not stack:
        return None

    closers = {"{": "}", "[": "]"}
    return s[:last_safe_cut] + "".join(closers[b] for b in reversed(stack))


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

    # Stage 4: truncation salvage — output was cut off mid-array by the token
    # budget. Recover whatever complete nodes/edges were emitted rather than
    # failing the whole draw.
    salvaged = _salvage_truncated(repaired)
    if salvaged:
        try:
            return json.loads(salvaged)
        except json.JSONDecodeError:
            pass

    # All stages failed
    raise json.JSONDecodeError(
        f"All parsing stages failed. Raw start: {raw[:100]!r}", raw, 0
    )


async def generate_design_stream(
    user_prompt: str,
    current_design: Optional[Dict[str, Any]] = None,
    chat_history: Optional[List[Dict[str, str]]] = None,
    req_config: Any = None,
):
    from app.core.llm import call_llm_stream
    from app.core.cache import response_cache
    import hashlib

    payload: Dict[str, Any] = {"request": user_prompt}

    # Fetch context from knowledge base, but do not let vector search dominate
    # graph generation latency.
    try:
        context = await asyncio.wait_for(search_knowledge_async(user_prompt, n_results=2), timeout=1.2)
    except asyncio.TimeoutError:
        context = ""
    if context:
        payload["knowledge_base_context"] = context

    # Summarize older turns so nothing from a long discussion is lost,
    # while keeping the most recent turns verbatim for fidelity.
    summary = build_summary_prefix(chat_history)
    if summary:
        payload["earlier_discussion_summary"] = summary["content"]

    recent = _window_recent_history(chat_history)
    if recent:
        payload["history"] = recent

    summarised = _summarise_design(current_design)
    if summarised:
        payload["existing_design"] = summarised
        payload["instruction"] = "Update existing design. Keep node ids. Apply changes only."
    else:
        payload["instruction"] = "Create a new design graph."

    prompt_text = json.dumps(payload, separators=(",", ":"))

    provider = req_config.provider if req_config else "ollama"
    model_name = req_config.model_name if req_config else ""
    api_key = req_config.api_key if req_config else ""
    api_url = req_config.api_url if req_config else ""

    # Custom cache key including design hash
    cache_payload = prompt_text + str(hashlib.md5(json.dumps(summarised or {}).encode()).hexdigest())
    cached = response_cache.get(cache_payload, provider, model_name)
    if cached:
        # If cached, yield it immediately as a single large chunk
        yield f"data: {cached}\n\n"
        yield "data: [DONE]\n\n"
        return

    full_response = ""
    try:
        # Use call_llm_stream with system_prompt
        stream = call_llm_stream(
            prompt=prompt_text,
            chat_history=[], # We already put history in payload
            system_prompt=_SYSTEM,
            provider=provider,
            api_key=api_key,
            model_name=model_name,
            api_url=api_url,
            max_tokens=3200,
            stop=[],
            timeout_seconds=60,
        )
        
        async for chunk in stream:
            if isinstance(chunk, str) and chunk.strip().startswith('[Error:'):
                error_text = chunk.strip()
                yield f"data: {json.dumps({ 'error': error_text })}\n\n"
                yield "data: [DONE]\n\n"
                return

            full_response += chunk
            # Wrap as SSE
            yield f"data: {json.dumps(chunk)}\n\n"

        # Try to parse/repair into strict JSON for the client.
        # If repair succeeds, send the canonical JSON as a distinct "final" event —
        # NOT a plain chunk — so the client replaces its accumulated buffer instead
        # of appending, which would concatenate raw+canonical into invalid JSON.
        try:
            parsed = _safe_parse(full_response)
            canonical = json.dumps(parsed, ensure_ascii=False, separators=(",", ":"))
            yield f"data: {json.dumps({'final': canonical})}\n\n"
            full_response = canonical
        except Exception:
            # If repair fails, fall back to raw output; client may still recover.
            pass

        # End of stream marker
        yield "data: [DONE]\n\n"

        # Save to cache after streaming is complete
        # Only cache if it looks like valid JSON
        if "{" in full_response and "}" in full_response:
            response_cache.set(cache_payload, provider, model_name, full_response)
            
    except Exception as e:
        yield f"data: {json.dumps({ 'error': str(e) })}\n\n"
        yield "data: [DONE]\n\n"

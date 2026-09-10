"""
Chat service — optimized streaming.

✅ Optimization 5 — ultra-compressed system prompt (under 30 tokens)
✅ Optimization 3 — history windowing + summarization handled by history.py
✅ Optimization 4 — max_tokens capped (but high enough to avoid mid-answer truncation) in call_llm_stream
"""
from app.core.llm import call_llm_stream
from app.core.rag import search_knowledge_async
from typing import Optional, Dict, List, Any

import asyncio
import json
import logging

logger = logging.getLogger(__name__)

# ✅ Optimization 5 — 9 words vs the original 30+ word verbose persona
_SYSTEM = "You are a senior software architect. Answer concisely but completely, using well-structured Markdown. Use headings, bullet points, and code blocks where appropriate. Never output raw JSON. Always finish your answer — never stop mid-sentence or mid-list."


async def handle_chat_stream(
    user_prompt: str,
    chat_history: Optional[List[Dict[str, Any]]] = None,
    req_config: Optional[Any] = None,
    user_id: Optional[str] = None,
    current_design: Optional[Dict[str, Any]] = None,
):
    # Keep chat snappy: use RAG only if it is ready almost immediately.
    try:
        context = await asyncio.wait_for(
            search_knowledge_async(user_prompt, n_results=1, user_id=user_id), timeout=0.6
        )
    except asyncio.TimeoutError:
        context = ""
    prompt_to_use = f"{user_prompt}\n\n[Context]:\n{context}" if context else user_prompt
    
    ai_text = ""
    try:
        async for chunk in call_llm_stream(
            prompt_to_use,
            chat_history=chat_history,
            system_prompt=_SYSTEM,
            provider=req_config.provider if req_config else "ollama",
            api_key=req_config.api_key if req_config else "",
            model_name=req_config.model_name if req_config else "",
            api_url=req_config.api_url if req_config else "",
            max_tokens=3072,  # High enough that a detailed architecture write-up finishes on its own
        ):
            ai_text += chunk
            # Format as Server-Sent Event with JSON escaping to preserve newlines
            yield f"data: {json.dumps(chunk)}\n\n"
    except Exception as e:
        # Wrap as {"error": ...} — a bare string chunk is indistinguishable
        # from real assistant text on the client, so a raised exception (bad
        # key, timeout, provider outage) used to render as if the model had
        # said it.
        yield f"data: {json.dumps({'error': str(e)})}\n\n"
        yield "data: [DONE]\n\n"
        return

    # Signal that the visible reply is complete *before* the (much slower)
    # design sync below runs, so the frontend can re-enable chat input right
    # away instead of reading it as a hang for the extra 5-50s the sync can
    # take — the design sync keeps running in the background either way.
    yield f"data: {json.dumps({'text_done': True})}\n\n"

    # Keep the canvas's design graph in sync with the conversation turn by
    # turn — every add/replace/remove the user and AI settle on here gets
    # folded in now, so "Draw Board" at the end is finalizing an already-
    # current design instead of building the whole thing from scratch in one
    # slow, error-prone pass. Best-effort: a failed sync here never fails the
    # chat turn itself, since the assistant's reply already streamed fine.
    try:
        from app.services.design_service import update_design_from_turn
        # Cap what's sent — a long markdown write-up (up to max_tokens=3072
        # worth) only needs to contribute the components/relationships it
        # names, not its full prose, to keep this pass fast.
        updated = await update_design_from_turn(user_prompt, ai_text[:4000], current_design, req_config)
        if updated is not None:
            canonical = json.dumps(updated, ensure_ascii=False, separators=(",", ":"))
            yield f"data: {json.dumps({'design': canonical})}\n\n"
    except Exception as e:
        logger.warning("Design sync after chat turn failed: %s", e)

    yield "data: [DONE]\n\n"

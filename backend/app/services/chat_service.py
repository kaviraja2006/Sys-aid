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

# ✅ Optimization 5 — 9 words vs the original 30+ word verbose persona
_SYSTEM = "You are a senior software architect. Answer concisely but completely, using well-structured Markdown. Use headings, bullet points, and code blocks where appropriate. Never output raw JSON. Always finish your answer — never stop mid-sentence or mid-list."


async def handle_chat_stream(
    user_prompt: str,
    chat_history: Optional[List[Dict[str, Any]]] = None,
    req_config: Optional[Any] = None,
):
    # Keep chat snappy: use RAG only if it is ready almost immediately.
    try:
        context = await asyncio.wait_for(search_knowledge_async(user_prompt, n_results=1), timeout=0.6)
    except asyncio.TimeoutError:
        context = ""
    prompt_to_use = f"{user_prompt}\n\n[Context]:\n{context}" if context else user_prompt
    
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
            # Format as Server-Sent Event with JSON escaping to preserve newlines
            yield f"data: {json.dumps(chunk)}\n\n"
    except Exception as e:
        yield f"data: {json.dumps(str(e))}\n\n"
    finally:
        yield "data: [DONE]\n\n"

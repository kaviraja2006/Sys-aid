"""
Chat service — optimized streaming.

✅ Optimization 5 — ultra-compressed system prompt (under 30 tokens)
✅ Optimization 3 — history windowing + summarization handled by history.py
✅ Optimization 4 — max_tokens=512 enforced in call_llm_stream
"""
from app.core.llm import call_llm_stream
from typing import Optional, Dict, List, Any

# ✅ Optimization 5 — 9 words vs the original 30+ word verbose persona
_SYSTEM = "Senior software architect. Answer concisely. Never output raw JSON in chat."


async def handle_chat_stream(
    user_prompt: str,
    chat_history: Optional[List[Dict[str, Any]]] = None,
    req_config: Optional[Any] = None,
):
    # history windowing + summary injection is handled inside call_llm_stream → history.py
    async for chunk in call_llm_stream(
        user_prompt,
        chat_history=chat_history,
        system_prompt=_SYSTEM,
        provider=req_config.provider if req_config else "ollama",
        api_key=req_config.api_key if req_config else "",
        model_name=req_config.model_name if req_config else "",
        api_url=req_config.api_url if req_config else "",
    ):
        yield chunk

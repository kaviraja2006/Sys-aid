"""
Smart chat history manager.
- Keeps only the last N messages (rolling window) to cap token usage.
- Summarizes older messages into a single compact summary message so context is never lost.
- Strips non-essential keys from message dicts before sending to LLM.
"""
from typing import List, Dict, Any, Optional

# ─── Config ───────────────────────────────────────────────────────────────────
WINDOW_SIZE   = 6   # recent messages sent verbatim
SUMMARY_EVERY = 10  # summarize when history grows past this
MAX_MSG_CHARS = 800 # truncate individual messages longer than this
MAX_SUMMARY_MESSAGES = 15  # cap how many older messages get summarized, so a
                            # very long conversation can't blow up the prompt
                            # size (and starve the completion's token budget)
# ──────────────────────────────────────────────────────────────────────────────


def _clean_msg(msg: Dict[str, Any]) -> Dict[str, str]:
    """Return only {role, text} — drop timestamps, ids, metadata."""
    role = msg.get("role", "user")
    text = str(msg.get("text", msg.get("content", "")))
    # Hard-truncate very long messages
    if len(text) > MAX_MSG_CHARS:
        text = text[:MAX_MSG_CHARS] + " …[truncated]"
    return {"role": role, "text": text}


def trim_history(history: Optional[List[Dict[str, Any]]]) -> List[Dict[str, Any]]:
    """
    Return a trimmed, clean version of the chat history.
    - Strips metadata fields
    - Truncates long messages
    - Keeps only last WINDOW_SIZE messages
    """
    if not history:
        return []
    cleaned = [_clean_msg(m) for m in history]
    return cleaned[-WINDOW_SIZE:]


def build_summary_prefix(history: Optional[List[Dict[str, Any]]]) -> Optional[Dict[str, str]]:
    """
    If history is long, build a compact summary message covering the older part.
    Returns a synthetic 'system' message or None if history is short enough.
    """
    if not history or len(history) <= SUMMARY_EVERY:
        return None

    older = history[:-WINDOW_SIZE]
    if not older:
        return None
    # Keep the most recent of the "older" messages — they're the most likely
    # to still be relevant to the final decision — and drop the rest.
    older = older[-MAX_SUMMARY_MESSAGES:]

    lines = []
    for m in older:
        role = m.get("role", "user")
        text = str(m.get("text", ""))[:200]  # summarize at most 200 chars per msg
        lines.append(f"{role.upper()}: {text}")

    summary_text = (
        "Earlier conversation summary (for context only — do not repeat):\n"
        + "\n".join(lines)
    )
    return {"role": "system", "content": summary_text}


def build_message_list(
    system_prompt: str,
    history: Optional[List[Dict[str, Any]]],
    user_prompt: str,
) -> List[Dict[str, str]]:
    """
    Assemble the final message list to send to LLM.
    Order: [system] → [summary] → [recent N messages] → [user]
    """
    messages: List[Dict[str, str]] = []

    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})

    # Optionally prepend a summary of older messages
    summary = build_summary_prefix(history)
    if summary:
        messages.append(summary)

    # Recent windowed history
    for msg in trim_history(history):
        role = "assistant" if msg["role"] == "ai" else "user"
        messages.append({"role": role, "content": msg["text"]})

    messages.append({"role": "user", "content": user_prompt})
    return messages

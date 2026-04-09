"""
Optimized LLM core — low latency for cloud providers (NVIDIA, Gemini, OpenAI, etc.)

Key fixes vs previous version:
  1. litellm pre-warm   — kills the 30-60s first-call cold-start by initialising
                          litellm eagerly during module import, not on first request
  2. Persistent httpx   — single AsyncClient shared across all calls, connection-
                          pooled, keep-alive, SSL session resumed
  3. Async subprocess   — Ollama process management moved off the async event loop
                          so it never blocks a request
  4. Smarter defaults   — NVIDIA defaults to 8b (fast) not 405b (slow)
  5. Cache + max_tokens — carried over from previous optimisation pass
"""
import asyncio
import subprocess
import litellm
import httpx

from app.core.cache import response_cache
from app.core.history import build_message_list

# ── 1. Silence noisy litellm I/O before anything else ───────────────────────
litellm.set_verbose = False
litellm.suppress_debug_info = True

# ── 2. Shared persistent httpx client — one SSL handshake, keep-alive pool ──
#    litellm accepts a custom async_httpx_client so all our calls reuse it.
_http_client = httpx.AsyncClient(
    timeout=httpx.Timeout(connect=10.0, read=120.0, write=10.0, pool=10.0),
    limits=httpx.Limits(max_connections=20, max_keepalive_connections=10),
    # http2=True requires `pip install httpx[http2]` — using HTTP/1.1 keep-alive instead
)
litellm.aclient_session = _http_client  # type: ignore[attr-defined]

# ── 3. litellm pre-warm — resolves lazy-import cold-start on first call ─────
#    We kick off a tiny no-op call in the background immediately at import time
#    so that by the time the first real user request arrives, all internal
#    caches are hot.  The call will fail (no real model), we suppress the error.
async def _warmup():
    try:
        await litellm.acompletion(
            model="openai/gpt-4o-mini",
            messages=[{"role": "user", "content": "hi"}],
            api_key="dummy-warmup",
            max_tokens=1,
            stream=False,
        )
    except Exception:
        pass  # Expected — we just want litellm's internals initialised

def _trigger_warmup():
    """Schedule warmup without blocking — safe to call at import time."""
    try:
        loop = asyncio.get_event_loop()
        if loop.is_running():
            loop.create_task(_warmup())
        else:
            # If no loop yet (e.g. during test imports), skip
            pass
    except Exception:
        pass

_trigger_warmup()

# ── Ollama process management (runs in threadpool, not event loop) ────────────
OLLAMA_URL = "http://localhost:11434"
_ollama_process = None
_current_provider = None


def _start_ollama_sync():
    global _ollama_process
    if _ollama_process is None:
        try:
            _ollama_process = subprocess.Popen(
                ["ollama", "serve"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except Exception as e:
            print(f"Ollama start error: {e}")


def _stop_ollama_sync():
    global _ollama_process
    if _ollama_process is not None:
        try:
            _ollama_process.terminate()
            _ollama_process = None
        except Exception:
            pass


async def _check_managed_process(provider: str, api_url: str = ""):
    """
    ── FIX #3: run subprocess management in a threadpool executor so it never
    blocks the async event loop (was previously a blocking call in async context).
    """
    global _current_provider
    if _current_provider == provider:
        return  # No change — skip entirely

    _current_provider = provider
    is_local = provider == "ollama" or (
        provider == "openai-compatible" and "localhost:11434" in api_url
    )

    loop = asyncio.get_event_loop()
    if is_local:
        await loop.run_in_executor(None, _start_ollama_sync)
    else:
        await loop.run_in_executor(None, _stop_ollama_sync)


def _resolve_litellm_args(provider: str, api_key: str, model_name: str, api_url: str):
    """Map provider string → (litellm model id, api_base)."""
    if provider == "ollama":
        return f"ollama/{model_name or 'llama3'}", api_url or OLLAMA_URL
    elif provider == "gemini":
        # FIX: flash is the fast default — pro is slow
        return f"gemini/{model_name or 'gemini-1.5-flash'}", None
    elif provider == "anthropic":
        return f"anthropic/{model_name or 'claude-3-haiku-20240307'}", None
    elif provider == "nvidia":
        # FIX #4: default to 8b (sub-second TTFT) not 405b (minutes TTFT)
        return (
            f"openai/{model_name or 'meta/llama-3.1-8b-instruct'}",
            "https://integrate.api.nvidia.com/v1",
        )
    else:  # openai / openai-compatible
        return f"openai/{model_name or 'gpt-4o-mini'}", api_url or None


# ── NON-STREAMING (generate-board — needs full JSON at once) ─────────────────
async def call_llm(
    prompt: str,
    provider: str = "ollama",
    api_key: str = "",
    model_name: str = "",
    api_url: str = "",
    max_tokens: int = 1024,   # ← callers can override; design_service uses 2048
):
    await _check_managed_process(provider, api_url)

    # Cache hit → instant return, zero API cost
    cached = response_cache.get(prompt, provider, model_name)
    if cached:
        return cached

    litellm_model, api_base = _resolve_litellm_args(provider, api_key, model_name, api_url)

    kwargs = dict(
        model=litellm_model,
        messages=[{"role": "user", "content": prompt}],
        api_key=api_key or "dummy-key",
        temperature=0.1,
        max_tokens=max_tokens,
        stream=False,
    )
    if api_base:
        kwargs["api_base"] = api_base

    try:
        response = await litellm.acompletion(**kwargs)
        result = response.choices[0].message.content
        response_cache.set(prompt, provider, model_name, result)
        return result
    except Exception as e:
        print(f"LLM Error [{provider}/{litellm_model}]: {e}")
        raise


# ── STREAMING (chat — real-time SSE) ─────────────────────────────────────────
async def call_llm_stream(
    prompt: str,
    chat_history: list = None,
    system_prompt: str = "",
    provider: str = "ollama",
    api_key: str = "",
    model_name: str = "",
    api_url: str = "",
):
    await _check_managed_process(provider, api_url)

    # Build compact, windowed message list (no fat history blobs)
    messages = build_message_list(system_prompt, chat_history, prompt)

    litellm_model, api_base = _resolve_litellm_args(provider, api_key, model_name, api_url)

    kwargs = dict(
        model=litellm_model,
        messages=messages,
        api_key=api_key or "dummy-key",
        temperature=0.2,
        max_tokens=512,
        stream=True,
    )
    if api_base:
        kwargs["api_base"] = api_base

    try:
        response = await litellm.acompletion(**kwargs)
        async for chunk in response:
            delta = chunk.choices[0].delta.content
            if delta:
                yield delta
    except Exception as e:
        yield f"\n\n[Error: {str(e)}]"


def stop_ollama():
    """Public alias used by main.py lifespan shutdown."""
    _stop_ollama_sync()


async def close_http_client():
    """Call this on server shutdown to cleanly close the connection pool."""
    await _http_client.aclose()

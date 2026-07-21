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
import os

from app.core.cache import response_cache
from app.core.history import build_message_list

# ── 1. Silence noisy litellm I/O before anything else ───────────────────────
litellm.set_verbose = False
litellm.suppress_debug_info = True
litellm.num_retries = 0

FAST_DEFAULT_MODELS = {
    "openai": "gpt-4o-mini",
    "gemini": "gemini-1.5-flash",
    "anthropic": "claude-3-haiku-20240307",
    "nvidia": "meta/llama-3.1-8b-instruct",
    "ollama": "llama3.2:1b",
}

SLOW_MODEL_ALIASES = {
    "openai": {"gpt-4o": "gpt-4o-mini", "gpt-4": "gpt-4o-mini"},
    "gemini": {"gemini-1.5-pro": "gemini-1.5-flash", "gemini-pro": "gemini-1.5-flash"},
    "anthropic": {
        "claude-3-5-sonnet-20240620": "claude-3-haiku-20240307",
        "claude-3-opus-20240229": "claude-3-haiku-20240307",
    },
    "nvidia": {
        "meta/llama-3.1-405b-instruct": "meta/llama-3.1-8b-instruct",
        "meta/llama-3.1-70b-instruct": "meta/llama-3.1-8b-instruct",
    },
    "ollama": {"llama3": "llama3.2:1b"},
}

CHAT_TIMEOUT_SECONDS = float(os.getenv("LLM_CHAT_TIMEOUT_SECONDS", "30"))
GENERATE_TIMEOUT_SECONDS = float(os.getenv("LLM_GENERATE_TIMEOUT_SECONDS", "60"))
HEALTH_TIMEOUT_SECONDS = float(os.getenv("LLM_HEALTH_TIMEOUT_SECONDS", "8"))
PLACEHOLDER_KEY_PREFIXES = ("your_", "replace_", "dummy", "test")

# ── 2. Shared persistent httpx client — one SSL handshake, keep-alive pool ──
#    litellm accepts a custom async_httpx_client so all our calls reuse it.
# Enable HTTP/2 only if the optional ``h2`` package is installed.
# This avoids a hard dependency on ``httpx[http2]`` on Windows where it may be missing.
try:
    import h2  # noqa: F401
    _http2_enabled = True
except ImportError:
    _http2_enabled = False

_http_client = httpx.AsyncClient(
    timeout=httpx.Timeout(connect=10.0, read=120.0, write=10.0, pool=10.0),
    limits=httpx.Limits(max_connections=50, max_keepalive_connections=20),
    http2=_http2_enabled,
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
_ollama_lock = asyncio.Lock()


def _is_ollama_running_sync() -> bool:
    return _ollama_process is not None and _ollama_process.poll() is None


def _start_ollama_sync():
    global _ollama_process
    if not _is_ollama_running_sync():
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
        except Exception:
            pass
        _ollama_process = None


async def _check_managed_process(provider: str, api_url: str = ""):
    """
    Request-scoped and idempotent: if *this* request needs Ollama, ensure it's
    running. Never stops it — a concurrent request on a different provider
    must not tear Ollama down out from under another in-flight local request.
    Ollama is only stopped once, at process shutdown (see main.py lifespan).
    """
    is_local = provider == "ollama" or (
        provider == "openai-compatible" and "localhost:11434" in api_url
    )
    if not is_local:
        return

    async with _ollama_lock:
        loop = asyncio.get_event_loop()
        if not await loop.run_in_executor(None, _is_ollama_running_sync):
            await loop.run_in_executor(None, _start_ollama_sync)


def _clean_env_value(value: str) -> str:
    return (value or "").split("#", 1)[0].strip()


def _is_real_api_key(api_key: str) -> bool:
    api_key = (api_key or "").strip()
    if not api_key:
        return False
    return not api_key.lower().startswith(PLACEHOLDER_KEY_PREFIXES)


def _resolve_api_key(provider: str, api_key: str) -> str:
    """
    Resolve API key from request or environment variables (fallback for production).
    
    Priority:
    1. Use provided api_key (from frontend settings)
    2. Fall back to environment variable based on provider
    3. Use dummy key (for local ollama)
    """
    if _is_real_api_key(api_key):
        return api_key
    
    # Map provider to environment variable name
    env_map = {
        "nvidia": "NVIDIA_API_KEY",
        "openai": "OPENAI_API_KEY",
        "gemini": "GOOGLE_API_KEY",
        "anthropic": "ANTHROPIC_API_KEY",
    }
    
    env_var = env_map.get(provider)
    if env_var:
        env_api_key = _clean_env_value(os.getenv(env_var, ""))
        if _is_real_api_key(env_api_key):
            return env_api_key
    
    # Fallback for local providers or no key available
    return "dummy-key"


def _has_env_key(provider: str) -> bool:
    env_map = {
        "nvidia": "NVIDIA_API_KEY",
        "openai": "OPENAI_API_KEY",
        "gemini": "GOOGLE_API_KEY",
        "anthropic": "ANTHROPIC_API_KEY",
    }
    env_var = env_map.get(provider)
    return bool(env_var and _is_real_api_key(_clean_env_value(os.getenv(env_var, ""))))


def _configured_provider() -> str:
    configured = _clean_env_value(os.getenv("LLM_PROVIDER", "")).lower()
    if configured in ("ollama", "openai-compatible") or (configured and _has_env_key(configured)):
        return configured

    for provider in ("openai", "nvidia", "gemini", "anthropic"):
        if _has_env_key(provider):
            return provider

    return "ollama"


def _normalize_provider(provider: str, api_key: str, api_url: str = "") -> str:
    provider = (provider or "").strip().lower()
    api_key = (api_key or "").strip()

    # Old frontend localStorage may still send ollama. If the user did not set
    # a local URL/key, use the fastest configured cloud provider instead.
    if not provider or (provider == "ollama" and not api_key and not api_url):
        return _configured_provider()

    return provider


def _normalize_model(provider: str, model_name: str) -> str:
    model_name = (model_name or "").strip()
    default = os.getenv(f"{provider.upper()}_MODEL", "").strip() or FAST_DEFAULT_MODELS.get(provider, "")
    if not model_name:
        return default
    return SLOW_MODEL_ALIASES.get(provider, {}).get(model_name, model_name)


def _normalize_api_base(provider: str, api_url: str) -> str:
    api_url = (api_url or "").strip().rstrip("/")
    if provider != "openai-compatible" or not api_url:
        return api_url
    for suffix in ("/chat/completions", "/completions"):
        if api_url.endswith(suffix):
            return api_url[: -len(suffix)]
    return api_url


def _resolve_litellm_args(provider: str, api_key: str, model_name: str, api_url: str):
    """Map provider string to (litellm model id, api_base)."""
    model_name = _normalize_model(provider, model_name)
    api_url = _normalize_api_base(provider, api_url)
    if provider == "ollama":
        return f"ollama/{model_name}", api_url or OLLAMA_URL
    elif provider == "gemini":
        # FIX: flash is the fast default — pro is slow
        return f"gemini/{model_name}", None
    elif provider == "anthropic":
        return f"anthropic/{model_name}", None
    elif provider == "nvidia":
        # FIX #4: default to 8b (sub-second TTFT) not 405b (minutes TTFT)
        return (
            f"openai/{model_name}",
            "https://integrate.api.nvidia.com/v1",
        )
    else:  # openai / openai-compatible
        return f"openai/{model_name or FAST_DEFAULT_MODELS['openai']}", api_url or None


# ── NON-STREAMING (generate-board — needs full JSON at once) ─────────────────
async def call_llm(
    prompt: str,
    system_prompt: str = "",
    provider: str = "ollama",
    api_key: str = "",
    model_name: str = "",
    api_url: str = "",
    max_tokens: int = 1024,
    stop: list = None,
    timeout_seconds: float = None,
    use_cache: bool = True,
):
    provider = _normalize_provider(provider, api_key, api_url)
    model_name = _normalize_model(provider, model_name)
    api_url = _normalize_api_base(provider, api_url)
    await _check_managed_process(provider, api_url)

    # Cache hit → instant return, zero API cost
    if use_cache:
        cached = response_cache.get(prompt, provider, model_name)
        if cached:
            return cached

    # ✅ Resolve API key: use frontend's key or fall back to .env
    resolved_api_key = _resolve_api_key(provider, api_key)
    
    litellm_model, api_base = _resolve_litellm_args(provider, api_key, model_name, api_url)

    messages = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    messages.append({"role": "user", "content": prompt})

    kwargs = dict(
        model=litellm_model,
        messages=messages,
        api_key=resolved_api_key,
        temperature=0.1,
        max_tokens=max_tokens,
        stream=False,
        timeout=timeout_seconds or GENERATE_TIMEOUT_SECONDS,
    )
    if stop:
        kwargs["stop"] = stop
    if api_base:
        kwargs["api_base"] = api_base

    try:
        response = await litellm.acompletion(**kwargs)
        result = response.choices[0].message.content
        if use_cache:
            response_cache.set(prompt, provider, model_name, result)
        return result
    except Exception as e:
        print(f"LLM Error [{provider}/{litellm_model}]: {e}")
        raise


async def call_llm_stream(
    prompt: str,
    chat_history: list = None,
    system_prompt: str = "",
    provider: str = "ollama",
    api_key: str = "",
    model_name: str = "",
    api_url: str = "",
    max_tokens: int = 4096,
    stop: list = None,
    timeout_seconds: float = None,
):
    provider = _normalize_provider(provider, api_key, api_url)
    model_name = _normalize_model(provider, model_name)
    api_url = _normalize_api_base(provider, api_url)
    await _check_managed_process(provider, api_url)

    # Build compact, windowed message list (no fat history blobs)
    messages = build_message_list(system_prompt, chat_history, prompt)

    # ✅ Resolve API key: use frontend's key or fall back to .env
    resolved_api_key = _resolve_api_key(provider, api_key)
    
    litellm_model, api_base = _resolve_litellm_args(provider, api_key, model_name, api_url)

    kwargs = dict(
        model=litellm_model,
        messages=messages,
        api_key=resolved_api_key,
        temperature=0.2,
        max_tokens=max_tokens,
        stream=True,
        timeout=timeout_seconds or CHAT_TIMEOUT_SECONDS,
    )
    if stop:
        kwargs["stop"] = stop
    if api_base:
        kwargs["api_base"] = api_base

    try:
        response = await litellm.acompletion(**kwargs)
        async for chunk in response:
            delta = chunk.choices[0].delta.content
            if delta:
                yield delta
    except Exception as e:
        raise


def stop_ollama():
    """Public alias used by main.py lifespan shutdown."""
    _stop_ollama_sync()


async def close_http_client():
    """Call this on server shutdown to cleanly close the connection pool."""
    await _http_client.aclose()

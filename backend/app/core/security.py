import hmac
import hashlib
import os
import secrets
from fastapi import Security, HTTPException, Request, Response, status
from fastapi.security.api_key import APIKeyHeader

API_KEY = os.getenv("BACKEND_API_KEY")
API_KEY_NAME = "X-API-Key"

api_key_header = APIKeyHeader(name=API_KEY_NAME, auto_error=False)

async def get_api_key(api_key_header: str = Security(api_key_header)):
    if not API_KEY:
        # If no key is configured in backend, allow all (or reject all, depending on security stance)
        # We will allow all if not configured to prevent breaking local dev without .env
        return None

    if api_key_header == API_KEY:
        return api_key_header

    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN, detail="Could not validate credentials"
    )


# ── Per-browser client identity (cookie) ────────────────────────────────────
# Not a login system — just a signed, server-issued opaque ID that scopes a
# browser's chat sessions to itself, so the shared X-API-Key alone can't be
# used to read/delete anyone else's chats.
COOKIE_SECRET = os.getenv("COOKIE_SECRET") or API_KEY or "dev-insecure-cookie-secret"
CLIENT_ID_COOKIE = "client_id"


def _sign(value: str) -> str:
    return hmac.new(COOKIE_SECRET.encode(), value.encode(), hashlib.sha256).hexdigest()


def _make_cookie_value(client_id: str) -> str:
    return f"{client_id}.{_sign(client_id)}"


def _verify_cookie_value(cookie_value: str) -> str | None:
    try:
        client_id, signature = cookie_value.rsplit(".", 1)
    except ValueError:
        return None
    if not hmac.compare_digest(signature, _sign(client_id)):
        return None
    return client_id


async def get_client_id(request: Request, response: Response) -> str:
    cookie_value = request.cookies.get(CLIENT_ID_COOKIE)
    client_id = _verify_cookie_value(cookie_value) if cookie_value else None

    if not client_id:
        client_id = secrets.token_urlsafe(24)
        response.set_cookie(
            key=CLIENT_ID_COOKIE,
            value=_make_cookie_value(client_id),
            httponly=True,
            samesite="none",
            secure=request.url.scheme == "https",
            max_age=60 * 60 * 24 * 365,
        )

    return client_id

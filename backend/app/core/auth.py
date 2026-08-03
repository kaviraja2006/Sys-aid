"""
Google Sign-In auth.
Frontend uses Google Identity Services to get an ID token, sends it to
POST /auth/google. We verify it with Google, upsert the user, and issue an
opaque server-side session token (stored in Postgres, handed to the browser
as an httpOnly cookie). No passwords are ever stored.
"""
import os
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import Request, Response, HTTPException, status
from google.oauth2 import id_token as google_id_token
from google.auth.transport import requests as google_requests
from sqlalchemy import select

from app.core.db import async_session_maker
from app.models.db_models import User, Session as DbSession

GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "")
SESSION_COOKIE = "session_token"
SESSION_TTL_DAYS = 30

_google_request = google_requests.Request()


def verify_google_token(credential: str) -> dict:
    """Verify a Google ID token and return its claims. Raises HTTPException on failure."""
    if not GOOGLE_CLIENT_ID:
        raise HTTPException(status_code=500, detail="GOOGLE_CLIENT_ID not configured on server")
    try:
        claims = google_id_token.verify_oauth2_token(
            credential, _google_request, GOOGLE_CLIENT_ID
        )
    except ValueError as e:
        raise HTTPException(status_code=401, detail=f"Invalid Google token: {e}")
    return claims


async def get_or_create_user(claims: dict) -> User:
    google_sub = claims["sub"]
    async with async_session_maker() as db:
        result = await db.execute(select(User).where(User.google_sub == google_sub))
        user = result.scalar_one_or_none()
        if user:
            return user
        user = User(
            google_sub=google_sub,
            email=claims.get("email", ""),
            name=claims.get("name", ""),
            picture=claims.get("picture", ""),
        )
        db.add(user)
        await db.commit()
        await db.refresh(user)
        return user


async def create_session(user_id: str) -> str:
    token = secrets.token_urlsafe(32)
    expires_at = datetime.now(timezone.utc) + timedelta(days=SESSION_TTL_DAYS)
    async with async_session_maker() as db:
        db.add(DbSession(token=token, user_id=user_id, expires_at=expires_at))
        await db.commit()
    return token


def set_session_cookie(response: Response, token: str, request: Request) -> None:
    is_https = request.url.scheme == "https"
    response.set_cookie(
        key=SESSION_COOKIE,
        value=token,
        httponly=True,
        samesite="none" if is_https else "lax",
        secure=is_https,
        max_age=60 * 60 * 24 * SESSION_TTL_DAYS,
    )


async def get_current_user(request: Request) -> User:
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")

    async with async_session_maker() as db:
        result = await db.execute(select(DbSession).where(DbSession.token == token))
        db_session = result.scalar_one_or_none()
        if not db_session or db_session.expires_at < datetime.now(timezone.utc):
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Session expired or invalid")

        result = await db.execute(select(User).where(User.id == db_session.user_id))
        user = result.scalar_one_or_none()
        if not user:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
        return user


async def delete_session(request: Request, response: Response) -> None:
    token = request.cookies.get(SESSION_COOKIE)
    if token:
        async with async_session_maker() as db:
            result = await db.execute(select(DbSession).where(DbSession.token == token))
            db_session = result.scalar_one_or_none()
            if db_session:
                await db.delete(db_session)
                await db.commit()
    response.delete_cookie(SESSION_COOKIE)

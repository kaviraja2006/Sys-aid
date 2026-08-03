from fastapi import APIRouter, HTTPException, Depends, Request
from typing import List
from sqlalchemy import select, delete

from app.models.schema import ChatSession as ChatSessionSchema
from app.models.db_models import ChatSession, User
from app.core.db import async_session_maker
from app.core.security import get_api_key
from app.core.auth import get_current_user
from app.core.limiter import limiter

router = APIRouter(dependencies=[Depends(get_api_key)])


@router.get("/", response_model=List[dict])
async def list_chats(user: User = Depends(get_current_user)):
    async with async_session_maker() as db:
        result = await db.execute(
            select(ChatSession.id, ChatSession.title, ChatSession.updated_at)
            .where(ChatSession.user_id == user.id)
            .order_by(ChatSession.updated_at.desc())
        )
        return [{"id": r.id, "title": r.title, "updated_at": r.updated_at} for r in result]


@router.get("/{chat_id}")
async def get_chat(chat_id: str, user: User = Depends(get_current_user)):
    async with async_session_maker() as db:
        result = await db.execute(
            select(ChatSession).where(ChatSession.id == chat_id, ChatSession.user_id == user.id)
        )
        row = result.scalar_one_or_none()
        if not row:
            raise HTTPException(status_code=404, detail="Chat not found")
        return row.data


@router.post("/")
@limiter.limit("10/minute")
async def save_chat(request: Request, session: ChatSessionSchema, user: User = Depends(get_current_user)):
    session_dict = session.dict()
    async with async_session_maker() as db:
        result = await db.execute(
            select(ChatSession).where(ChatSession.id == session.id, ChatSession.user_id == user.id)
        )
        row = result.scalar_one_or_none()
        if row:
            row.title = session.title
            row.updated_at = session.updated_at
            row.data = session_dict
        else:
            db.add(ChatSession(
                id=session.id,
                user_id=user.id,
                title=session.title,
                updated_at=session.updated_at,
                data=session_dict,
            ))
        await db.commit()
    return {"status": "success", "id": session.id}


@router.delete("/{chat_id}")
async def delete_chat(chat_id: str, user: User = Depends(get_current_user)):
    async with async_session_maker() as db:
        await db.execute(
            delete(ChatSession).where(ChatSession.id == chat_id, ChatSession.user_id == user.id)
        )
        await db.commit()
    return {"status": "success"}

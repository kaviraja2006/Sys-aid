from fastapi import APIRouter, HTTPException, Depends
import os
import json
import aiosqlite
from typing import List
from app.models.schema import ChatSession
from app.core.security import get_api_key

router = APIRouter(dependencies=[Depends(get_api_key)])

DB_DIR = os.path.join(os.path.dirname(__file__), "..", "data")
DB_PATH = os.path.join(DB_DIR, "sysaid.db")

os.makedirs(DB_DIR, exist_ok=True)

async def init_db():
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute('''
            CREATE TABLE IF NOT EXISTS chat_sessions (
                id TEXT PRIMARY KEY,
                title TEXT,
                updated_at TEXT,
                data TEXT
            )
        ''')
        await db.commit()

@router.get("/", response_model=List[dict])
async def list_chats():
    chats_meta = []
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute('SELECT id, title, updated_at FROM chat_sessions ORDER BY updated_at DESC') as cursor:
            async for row in cursor:
                chats_meta.append(dict(row))
    return chats_meta

@router.get("/{chat_id}")
async def get_chat(chat_id: str):
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute('SELECT data FROM chat_sessions WHERE id = ?', (chat_id,)) as cursor:
            row = await cursor.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Chat not found")
            return json.loads(row[0])

@router.post("/")
async def save_chat(session: ChatSession):
    session_dict = session.dict()
    data_str = json.dumps(session_dict)
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute('''
            INSERT INTO chat_sessions (id, title, updated_at, data)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                title=excluded.title,
                updated_at=excluded.updated_at,
                data=excluded.data
        ''', (session.id, session.title, session.updated_at, data_str))
        await db.commit()
    return {"status": "success", "id": session.id}

@router.delete("/{chat_id}")
async def delete_chat(chat_id: str):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute('DELETE FROM chat_sessions WHERE id = ?', (chat_id,))
        await db.commit()
    return {"status": "success"}

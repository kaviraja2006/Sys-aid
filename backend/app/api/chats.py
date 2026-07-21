from fastapi import APIRouter, HTTPException, Depends, Request
import os
import json
import aiosqlite
from typing import List
from app.models.schema import ChatSession
from app.core.security import get_api_key, get_client_id
from app.core.limiter import limiter

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
                data TEXT,
                client_id TEXT
            )
        ''')
        # Migration for pre-existing DBs created before client_id scoping was added.
        try:
            await db.execute('ALTER TABLE chat_sessions ADD COLUMN client_id TEXT')
        except aiosqlite.OperationalError:
            pass
        await db.execute('CREATE INDEX IF NOT EXISTS idx_chat_sessions_client_id ON chat_sessions(client_id)')
        await db.commit()

@router.get("/", response_model=List[dict])
async def list_chats(client_id: str = Depends(get_client_id)):
    chats_meta = []
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            'SELECT id, title, updated_at FROM chat_sessions WHERE client_id = ? ORDER BY updated_at DESC',
            (client_id,)
        ) as cursor:
            async for row in cursor:
                chats_meta.append(dict(row))
    return chats_meta

@router.get("/{chat_id}")
async def get_chat(chat_id: str, client_id: str = Depends(get_client_id)):
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            'SELECT data FROM chat_sessions WHERE id = ? AND client_id = ?', (chat_id, client_id)
        ) as cursor:
            row = await cursor.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Chat not found")
            return json.loads(row[0])

@router.post("/")
@limiter.limit("10/minute")
async def save_chat(request: Request, session: ChatSession, client_id: str = Depends(get_client_id)):
    session_dict = session.dict()
    data_str = json.dumps(session_dict)
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute('''
            INSERT INTO chat_sessions (id, title, updated_at, data, client_id)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                title=excluded.title,
                updated_at=excluded.updated_at,
                data=excluded.data
            WHERE chat_sessions.client_id = excluded.client_id
        ''', (session.id, session.title, session.updated_at, data_str, client_id))
        await db.commit()
    return {"status": "success", "id": session.id}

@router.delete("/{chat_id}")
async def delete_chat(chat_id: str, client_id: str = Depends(get_client_id)):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute('DELETE FROM chat_sessions WHERE id = ? AND client_id = ?', (chat_id, client_id))
        await db.commit()
    return {"status": "success"}

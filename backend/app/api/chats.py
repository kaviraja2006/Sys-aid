from fastapi import APIRouter, HTTPException
import os
import json
import uuid
from typing import List
from app.models.schema import ChatSession

router = APIRouter()

CHATS_DIR = os.path.join(os.path.dirname(__file__), "..", "data", "chats")

# Ensure directory exists
os.makedirs(CHATS_DIR, exist_ok=True)

@router.get("/", response_model=List[dict])
async def list_chats():
    chats_meta = []
    for filename in os.listdir(CHATS_DIR):
        if filename.endswith(".json"):
            filepath = os.path.join(CHATS_DIR, filename)
            try:
                with open(filepath, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    chats_meta.append({
                        "id": data.get("id"),
                        "title": data.get("title", "Untitled Architecture"),
                        "updated_at": data.get("updated_at", "")
                    })
            except Exception:
                pass
    # Sort descending by date roughly
    chats_meta.sort(key=lambda x: x["updated_at"], reverse=True)
    return chats_meta

@router.get("/{chat_id}")
async def get_chat(chat_id: str):
    filepath = os.path.join(CHATS_DIR, f"{chat_id}.json")
    if not os.path.exists(filepath):
        raise HTTPException(status_code=404, detail="Chat not found")
    
    with open(filepath, "r", encoding="utf-8") as f:
        return json.load(f)

@router.post("/")
async def save_chat(session: ChatSession):
    filepath = os.path.join(CHATS_DIR, f"{session.id}.json")
    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(session.dict(), f)
    return {"status": "success", "id": session.id}

@router.delete("/{chat_id}")
async def delete_chat(chat_id: str):
    filepath = os.path.join(CHATS_DIR, f"{chat_id}.json")
    if os.path.exists(filepath):
        os.remove(filepath)
    return {"status": "success"}

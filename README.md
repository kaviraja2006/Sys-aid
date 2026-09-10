# SysAid AI — System Architecture Designer

An AI-powered system design tool that lets you chat with an LLM to brainstorm,
design, and visually render software architecture diagrams in real-time.

## Features

- 💬 **Conversational AI** — Discuss system design via streaming chat
- 🎨 **Auto-draw boards** — Generate React Flow architecture diagrams from conversation
- 🔁 **Live simulation** — Simulate load and detect bottlenecks
- 🛠 **Multi-provider LLM support** — NVIDIA NIM, Google Gemini, OpenAI, Anthropic, Ollama (local)
- 💾 **Session history** — Save and reload past architecture sessions

## Tech Stack

| Layer | Tech |
|-------|------|
| Frontend | React + Vite + React Flow |
| Backend | FastAPI + litellm |
| LLM Routing | litellm (multi-provider) |
| Local LLM | Ollama |

## Quick Start

### 1. Backend

```bash
cd backend
python -m venv venv
venv\Scripts\activate        # Windows
pip install -r requirements.txt
uvicorn app.main:app --reload
```

Schema is managed by [Alembic](https://alembic.sqlalchemy.org/) (`backend/alembic/`), not `create_all` — the app runs `alembic upgrade head` automatically on startup (see `app/core/db.py`), so a fresh `DATABASE_URL` is brought up to date with no manual step. Changed a model in `app/models/db_models.py`? Generate a migration for it:

```bash
cd backend
alembic revision --autogenerate -m "describe the change"
# review the generated file in alembic/versions/, then commit it
```

### 2. Frontend

```bash
cd frontend
npm install
npm run dev
```

### 3. Configure your LLM

Click the ⚙️ Settings icon in the chat panel and enter your preferred provider + API key.

Supported providers:
- **NVIDIA NIM** — fast, recommended (model: `meta/llama-3.1-8b-instruct`)
- **Google Gemini** — free tier available (model: `gemini-2.0-flash`)
- **OpenAI** — (model: `gpt-4o-mini`)
- **Anthropic Claude** — (model: `claude-3-haiku-20240307`)
- **Ollama** — fully local & free

## Project Structure

```
Sys-aid/
├── backend/
│   ├── app/
│   │   ├── api/          # FastAPI routes
│   │   ├── core/         # LLM, cache, history management
│   │   ├── services/     # Business logic (chat, design, improve)
│   │   ├── models/       # Pydantic schemas
│   │   └── data/         # Saved chat sessions (local)
│   └── requirements.txt
└── frontend/
    └── src/
        ├── ChatPanel.jsx
        ├── GraphBoard.jsx
        └── ArchitectureNode.jsx
```

## License

MIT

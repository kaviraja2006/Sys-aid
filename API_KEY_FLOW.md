# 🔐 API Key Configuration - How It Works

## Current System Flow

Your app supports **BOTH** ways of providing API keys:

### **Way 1: Frontend Settings Panel (Development/User Custom)**
```
User enters API key in Settings ⚙️ 
           ↓
Frontend saves to localStorage
           ↓
Frontend sends with each chat message
           ↓
Backend receives in GenerateRequest
           ↓
Backend uses it to call LLM provider
```

### **Way 2: Backend .env File (Production)**
```
Backend started on Render
           ↓
Reads .env file (LLM_PROVIDER, NVIDIA_API_KEY, etc.)
           ↓
Frontend doesn't provide API key (or leaves it empty)
           ↓
Backend falls back to .env values
           ↓
Backend uses environment variables to call LLM provider
```

---

## Code Flow Verification ✅

### Frontend → Backend (ChatPanel.jsx)
```javascript
// Line 202-210 in ChatPanel.jsx
const payload = {
  prompt: textToSend,
  chat_history: getChatHistory(),
  ...llmConfig  // ← Includes: provider, api_key, model_name, api_url
};

// Send with API key in both body AND header
const response = await fetch(`${API_URL}/chat`, {
  method: 'POST',
  headers: {
    'X-API-Key': llmConfig.api_key || import.meta.env.VITE_BACKEND_API_KEY || ''
  },
  body: JSON.stringify(payload)  // ← API key inside payload too
});
```

### Backend Request Model (schema.py)
```python
class GenerateRequest(BaseModel):
    prompt: str
    current_design: Optional[Dict[str, Any]] = None
    chat_history: Optional[List[Dict[str, Any]]] = None
    
    # ✅ These 4 fields receive from frontend
    provider: Optional[str] = "ollama"
    api_key: Optional[str] = ""           # User's API key
    model_name: Optional[str] = "llama3"
    api_url: Optional[str] = ""
```

### Backend Chat Service (chat_service.py)
```python
async def handle_chat_stream(
    user_prompt: str,
    chat_history: Optional[List[Dict[str, Any]]] = None,
    req_config: Optional[Any] = None,
):
    # ✅ Passes frontend's API key to LLM service
    async for chunk in call_llm_stream(
        prompt_to_use,
        chat_history=chat_history,
        system_prompt=_SYSTEM,
        provider=req_config.provider if req_config else "ollama",
        api_key=req_config.api_key if req_config else "",  # ← FROM FRONTEND
        model_name=req_config.model_name if req_config else "",
        api_url=req_config.api_url if req_config else "",
        max_tokens=512,
    ):
        yield f"data: {json.dumps(chunk)}\n\n"
```

### Backend LLM Core (llm.py)
```python
async def call_llm_stream(
    prompt: str,
    chat_history: list = None,
    system_prompt: str = "",
    provider: str = "ollama",
    api_key: str = "",  # ← Receives API key from above
    model_name: str = "",
    api_url: str = "",
    max_tokens: int = 4096,
    stop: list = None,
):
    litellm_model, api_base = _resolve_litellm_args(provider, api_key, model_name, api_url)
    
    kwargs = dict(
        model=litellm_model,
        messages=messages,
        api_key=api_key or "dummy-key",  # ← Uses API key with litellm
        temperature=0.2,
        max_tokens=max_tokens,
        stream=True,
    )
    
    response = await litellm.acompletion(**kwargs)  # ✅ API key sent to provider
```

---

## How It Works in Practice

### Scenario 1: Development (Using Frontend Settings)
1. ✅ User clicks ⚙️ Settings in frontend
2. ✅ User enters: `NVIDIA`, `NVIDIA_API_KEY=xxx123`
3. ✅ Frontend saves to browser localStorage
4. ✅ User sends a message
5. ✅ Frontend sends: `{ prompt: "...", provider: "nvidia", api_key: "xxx123", ... }`
6. ✅ Backend receives and passes to litellm
7. ✅ litellm uses `api_key` to call NVIDIA NIM API
8. ✅ Response streams back to frontend ✨

### Scenario 2: Production on Render (Using .env)
1. ✅ Render backend starts and loads `.env` file
2. ✅ `.env` contains: `LLM_PROVIDER=nvidia`, `NVIDIA_API_KEY=xxx123`
3. ✅ Frontend doesn't provide API key (or leaves empty)
4. ✅ User sends a message
5. ✅ Frontend sends: `{ prompt: "...", provider: "", api_key: "", ... }`
6. ✅ Backend should read from `.env` variables (THIS NEEDS CODE UPDATE)
7. ✅ Backend passes `.env` API key to litellm
8. ✅ Response streams back ✨

---

## ⚠️ Current Limitation & Fix Needed

**Right now**, the backend doesn't automatically read from `.env` if frontend doesn't provide a key.

**Before deployment to Render**, add this fallback to `backend/app/core/llm.py`:

```python
import os

def call_llm_stream(
    prompt: str,
    chat_history: list = None,
    system_prompt: str = "",
    provider: str = "ollama",
    api_key: str = "",  # From frontend
    model_name: str = "",
    api_url: str = "",
    max_tokens: int = 4096,
    stop: list = None,
):
    # ✅ NEW: Fall back to environment variables if frontend doesn't provide
    if not api_key or api_key == "":
        # Map provider to env var name
        env_key_map = {
            "nvidia": "NVIDIA_API_KEY",
            "openai": "OPENAI_API_KEY",
            "gemini": "GOOGLE_API_KEY",
            "anthropic": "ANTHROPIC_API_KEY",
        }
        env_var = env_key_map.get(provider)
        if env_var:
            api_key = os.getenv(env_var, "")
    
    # If still no key, use dummy (for local ollama)
    api_key = api_key or "dummy-key"
    
    # ... rest of the function
```

---

## Summary ✅

**Will it work in both ways?**

| Method | Status | Details |
|--------|--------|---------|
| Frontend Settings Panel | ✅ **YES** | User enters key → sent with each request → works now |
| Backend .env File | ⚠️ **NEEDS FIX** | Code doesn't read .env fallback yet (see fix above) |

**Before you deploy to Render:**
1. Add the fallback code above to `backend/app/core/llm.py`
2. Set environment variables in Render dashboard
3. Test both: with frontend key + without frontend key

---

## Test It Now (Local)

```bash
# Terminal 1: Backend
cd backend
set NVIDIA_API_KEY=your_key_here  # Windows
python -m uvicorn app.main:app --reload

# Terminal 2: Frontend  
cd frontend
npm run dev
```

**Test 1 - Frontend Settings:**
- Go to http://localhost:5173
- Settings ⚙️ → Enter API key
- Send message → Should work ✅

**Test 2 - Backend .env (after fix):**
- Keep API key in env variable
- Clear frontend settings (remove API key)
- Send message → Should still work ✅

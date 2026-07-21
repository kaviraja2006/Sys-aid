# SysAid — Full-Stack Audit

**Scope:** Complete read of all backend (`backend/app/**`, 20 files) and frontend (`frontend/src/**`, 15 files) source, plus Docker/deploy configs, dependency manifests, and git-tracked data. **This is an analysis-only pass — zero code was changed.** Every issue below cites the exact file/line evidence it's based on. Fixes are proposed but not applied; a follow-up pass should implement whichever the team approves.

---

# Executive Summary

| Area | Score /100 | Why |
|---|---|---|
| **Overall project health** | **58** | Functional, thoughtfully optimized LLM plumbing, but real security/access-control gaps and zero test/CI safety net |
| Architecture | 65 | Clean service/route separation; some dead abstractions (unused Pydantic models, unused rate limiter) |
| Performance | 72 | Genuinely well-optimized LLM path (caching, connection pooling, history windowing) — best part of the codebase |
| Security | 35 | No real authorization model, no rate limiting in effect, user chat data committed to git, broken-access-control on chat history |
| Frontend | 60 | Reasonable React patterns (memoization, windowed streaming) but one broken feature (axios/fetch API mismatch) and no code splitting |
| Backend | 62 | Solid async design; validation bypassed on 2 of 6 routes; unscoped data access |
| Database | 55 | ChromaDB re-ingestion logic is smart; SQLite chat store has no per-user scoping, and DB files are committed to git |
| Scalability | 45 | Global mutable state (`_current_provider`) breaks under concurrent multi-user load; in-memory caches don't survive multi-instance deploys |
| Maintainability | 60 | Small, readable files; no tests at all is the biggest maintainability risk |
| Developer Experience | 55 | No CI, no tests, duplicate Dockerfiles, stray dependency artifacts create confusion |

---

# Issues Found

### ISSUE-01 — Chat history has no access control (IDOR); any caller can read/delete anyone's sessions
- **Severity:** Critical
- **Category:** Security / Authorization
- **Location:** `backend/app/api/chats.py:28-68` (`list_chats`, `get_chat`, `delete_chat`)
- **Description:** `GET /chats/`, `GET /chats/{id}`, and `DELETE /chats/{id}` are gated only by the single shared `X-API-Key` (`Depends(get_api_key)`), which is a static, org-wide secret embedded in the frontend build (`frontend/src/config/api.js:12`, `VITE_BACKEND_API_KEY`). There is no per-user/session ownership check — any request holding that one key (or none, if `BACKEND_API_KEY` is unset, see ISSUE-02) can list, read, and delete **every** stored chat session, including other users'.
- **Root Cause:** The API-key dependency was designed as a coarse "is this our frontend" gate, not as per-user auth. `ChatSession` (`backend/app/models/schema.py:52-58`) has no `owner`/`user_id` field, and no query in `chats.py` filters by one.
- **Impact:** Full cross-tenant data exposure and destructive access (delete) if the shared key ever leaks (it ships in the client bundle) or is simply reused by multiple people.
- **Old Implementation:** Single shared API key with no per-record ownership.
- **New Implementation (recommended):** Add a per-browser/user identifier (e.g., a signed random `client_id` cookie set server-side) and filter all three queries (`SELECT ... WHERE id = ? AND client_id = ?`, etc.) by it. This is a schema + 3-endpoint change, not a full auth system.
- **Expected Improvement:** Eliminates cross-user data leakage entirely.
- **Status:** Recommended, not applied.

### ISSUE-02 — API key auth silently disables itself when unset ("fail open")
- **Severity:** High
- **Category:** Security / Authentication
- **Location:** `backend/app/core/security.py:10-14`
- **Description:** `if not API_KEY: return None` — if `BACKEND_API_KEY` is not set in the deployment environment, **every** protected route (`chat`, `generate-board`, `simulate`, `improve`, `review`, all of `/chats`, `/upload-knowledge`) becomes fully open with no warning logged.
- **Root Cause:** Convenience default for local dev leaked into the production code path with no environment differentiation.
- **Impact:** A misconfigured deploy (forgotten env var) silently becomes a fully public LLM proxy + document-ingestion endpoint — high abuse/cost risk, not a hard failure that would get noticed.
- **Old Implementation:** Fail-open with no log line.
- **New Implementation (recommended):** Log a loud warning on startup if `BACKEND_API_KEY` is unset in a non-local environment (e.g., gate on an `ENV=production` flag), and consider failing closed in production.
- **Expected Improvement:** Misconfiguration becomes visible instead of silently exploitable.
- **Status:** Recommended, not applied.

### ISSUE-03 — User chat data and a live ChromaDB file are committed to the git repository
- **Severity:** High
- **Category:** Security / Data hygiene
- **Location:** `backend/app/data/chats/*.json` (13 tracked session files including `test1.json`), `backend/app/data/chroma_db/chroma.sqlite3` (tracked)
- **Description:** `git ls-files backend/app/data` shows real chat session JSON files and a ChromaDB SQLite file are tracked in version control, even though `.gitignore` (lines 18-28) explicitly excludes `backend/app/data/chroma_db/`, `*.db`, and `*.sqlite3` — the ignore rule was added *after* these files were already committed, so it has no effect on them.
- **Root Cause:** `.gitignore` entries only prevent *new* files from being tracked; already-tracked files must be explicitly `git rm --cached`.
- **Impact:** Anyone with repo access (or a public GitHub clone, if this repo is ever made public) can read real user conversation content and vector-store contents. Repo bloat and history rewrite risk if this needs retroactive removal.
- **Old Implementation:** Files tracked despite matching a later-added ignore rule.
- **New Implementation (recommended):** `git rm -r --cached backend/app/data/chats backend/app/data/chroma_db` (keep the ignore rule going forward); if any of this repo's history is or will be shared publicly, treat committed chat content as exposed and consider it for history scrubbing.
- **Expected Improvement:** Stops future leakage; flags need for retroactive cleanup.
- **Status:** Recommended, not applied (no destructive git history operations performed in this analysis-only pass).

### ISSUE-04 — Rate limiter is configured but applied to zero routes
- **Severity:** High
- **Category:** Security / Performance / Cost control
- **Location:** `backend/app/main.py:60-63` (Limiter instantiated, exception handler registered) vs. `backend/app/api/routes.py` and `backend/app/api/chats.py` (no `@limiter.limit(...)` decorator anywhere — confirmed via repo-wide search, zero matches)
- **Description:** `slowapi`'s `Limiter` is wired into the app (state + exception handler) but never actually applied to any endpoint. All LLM-calling routes (`/chat`, `/generate-board`, `/review`, `/improve`, `/health/llm`) and the unauthenticated-by-default `/upload-knowledge` are completely unthrottled per-client.
- **Root Cause:** Rate limiting was set up as infrastructure but the decorator step was never completed on the actual route handlers.
- **Impact:** A single client can drive unbounded LLM API cost (their own key or the server's fallback `.env` key) and unbounded ChromaDB ingestion load; no protection against basic abuse or accidental client-side retry storms.
- **Old Implementation:** `Limiter` configured, unused.
- **New Implementation (recommended):** Add `@limiter.limit("10/minute")` (tune per route) to `/chat`, `/generate-board`, `/review`, `/improve`, `/upload-knowledge` in `routes.py`, and to `/chats` POST in `chats.py`.
- **Expected Improvement:** Bounds worst-case cost and load per client IP.
- **Status:** Recommended, not applied.

### ISSUE-05 — "Analyze" feature in the node detail sidebar is broken (axios/fetch API mismatch)
- **Severity:** High (functional bug)
- **Category:** Functional Bug / Frontend
- **Location:** `frontend/src/NodeDetailSidebar.jsx:28-45`
- **Description:** `handleAnalyze` calls `api.post('/chat', ...)` — `api` is an **axios** instance (`frontend/src/config/api.js:14`). It then does `if (!response.ok) throw ...` and `response.body.getReader()`. Axios responses do not have `.ok` or a raw `.body.getReader()` stream — those are `fetch` Response properties. Every click on "Get LLM Analysis" will throw inside the `try` block (most likely a `TypeError: response.body.getReader is not a function` or `response.ok` being `undefined`, silently falling through, followed by a hard crash on `.getReader`).
- **Root Cause:** Code was copy-adapted from `ChatPanel.jsx`'s `fetch`-based streaming handler (`ChatPanel.jsx:216-260`) without swapping the API-call mechanism to match.
- **Impact:** The per-node "LLM Analysis" feature is completely non-functional in production today — user sees "Failed to analyze component" every time.
- **Old Implementation:** `api.post(...)` (axios) treated as a `fetch` Response.
- **New Implementation (recommended):** Either switch this call to `fetch(`${API_URL}/chat`, {...})` matching the pattern already used in `ChatPanel.jsx:216-227` (with the `X-API-Key` header), or drop streaming here and use plain `await api.post('/chat', ...)` with a non-streaming variant. Given `/chat` is SSE-only server-side, the `fetch`-based approach is the correct fix.
- **Expected Improvement:** Restores a currently-dead feature.
- **Status:** Recommended, not applied.

### ISSUE-06 — `/simulate` and `/improve` accept raw untyped `dict` bodies despite existing Pydantic schemas
- **Severity:** Medium
- **Category:** API Audit / Validation
- **Location:** `backend/app/api/routes.py:43-50` (`data: dict`) vs. unused `SimulationInput`, `ImproveRequest`, `DesignGraph`, `Node`, `Edge` in `backend/app/models/schema.py:15-50`
- **Description:** Two of six routes bypass FastAPI/Pydantic validation entirely, accepting arbitrary JSON. The schema module already defines the correct shape for both (`SimulationInput`, `ImproveRequest`) but they're dead code — never imported by `routes.py`.
- **Root Cause:** Schemas were defined but the routes were never migrated off placeholder `dict` bodies.
- **Impact:** No 422 validation errors for malformed input; `run_simulation` (`backend/app/core/simulation.py:14-16`) and `_compress_design` (`backend/app/services/improve_service.py:12-39`) do defensive `.get()` calls everywhere to compensate, which is more code than just trusting a validated model would need. Malformed/missing fields fail silently with defaults rather than a clear 422.
- **Old Implementation:** `data: dict` + manual `.get()` extraction.
- **New Implementation (recommended):** Change route signatures to `req: SimulationInput` / `req: ImproveRequest` and let Pydantic validate; simplify the service functions to use attribute access.
- **Expected Improvement:** Clear validation errors instead of silent defaulting; removes ~15 lines of defensive `.get()` chains.
- **Status:** Recommended, not applied.

### ISSUE-07 — Global mutable `_current_provider` is shared across all concurrent requests
- **Severity:** Medium-High
- **Category:** Backend / Concurrency / Scalability
- **Location:** `backend/app/core/llm.py:104-149` (`_current_provider` module global, `_check_managed_process`)
- **Description:** `_current_provider` is a single process-wide variable. Under concurrent requests from different users with different providers (e.g., User A on `ollama`, User B on `openai` at the same moment), whichever request's `_check_managed_process` call runs last wins, and the "skip if unchanged" short-circuit (`if _current_provider == provider: return`) can cause the Ollama process to be started/stopped incorrectly for a request that didn't ask for that change — or skipped entirely for a request that needed it.
- **Root Cause:** State that's really per-request (which provider *this* request wants) was hoisted to module/process scope, presumably to avoid redundant subprocess spawn calls in the common single-user-at-a-time case.
- **Impact:** In any multi-user concurrent scenario, provider/Ollama process management becomes a race condition — a request may silently talk to the wrong backend or fail because Ollama wasn't started when it should have been.
- **Old Implementation:** Process-global `_current_provider` gate.
- **New Implementation (recommended):** Only manage the Ollama subprocess lazily/on-demand inside the ollama branch itself (start if not already running, independent of "last provider used"), removing the cross-request shared-state dependency; or track desired-state via a lock-guarded set of "known running" local endpoints rather than a single "current" value.
- **Expected Improvement:** Removes a concurrency race that gets worse as concurrent usage grows.
- **Status:** Recommended, not applied.

### ISSUE-08 — In-process caches (`response_cache`, `rag_cache`) don't survive restarts or multiple instances
- **Severity:** Low-Medium
- **Category:** Performance / Scalability
- **Location:** `backend/app/core/cache.py:15-90` (in-memory `OrderedDict`-based LRU)
- **Description:** Both caches are per-process Python dicts. This is fine for a single instance, but if the backend is ever scaled horizontally (multiple Render/uvicorn workers), cache hit rate silently drops to ~1/N with no cross-instance sharing, and every restart cold-starts the cache.
- **Root Cause:** Simplicity — appropriate for current single-instance deployment (`Procfile` implies one dyno-style process).
- **Impact:** None today at current scale; becomes a hidden performance cliff the moment horizontal scaling is introduced without anyone touching this file.
- **Old/New Implementation:** N/A — flagged as a scaling constraint to know about, not a bug to fix now.
- **Expected Improvement:** N/A.
- **Status:** Documented as a future scaling constraint (see Future Recommendations), not a current defect.

### ISSUE-09 — `/upload-knowledge` has no size limit, no auth differentiation, and no rate limit
- **Severity:** Medium
- **Category:** Security / Backend
- **Location:** `backend/app/api/routes.py:116-121`
- **Description:** Accepts any uploaded file, decodes it as UTF-8, and ingests it into the shared ChromaDB knowledge collection used by **all** users' RAG context — there's no per-user knowledge namespace. No file size cap, no rate limit (see ISSUE-04), and any caller with the shared key can pollute or bloat the shared knowledge base for everyone.
- **Root Cause:** Endpoint built for a trusted single-operator use case, not multi-tenant.
- **Impact:** Denial-of-service via large uploads (unbounded `await file.read()`), or knowledge-base pollution affecting every user's chat/design context.
- **Old Implementation:** No size cap, global shared collection.
- **New Implementation (recommended):** Add `max_length` check on upload size (FastAPI `File(..., max_length=...)` or manual check), and apply the rate limiter from ISSUE-04.
- **Expected Improvement:** Bounds worst-case abuse of this endpoint.
- **Status:** Recommended, not applied.

### ISSUE-10 — Duplicate, drifting `Dockerfile`s
- **Severity:** Low
- **Category:** DevOps / Maintainability
- **Location:** `Dockerfile:11,15` (root) vs `backend/Dockerfile:11,15` — identical except `COPY backend/requirements.txt .` / `COPY backend/` (root) vs `COPY requirements.txt .` / `COPY .` (backend/)
- **Description:** Two Dockerfiles build the same backend image with different build-context assumptions. Nothing enforces they stay in sync; a change to one (e.g., adding a system dependency) is easy to forget in the other.
- **Root Cause:** Likely one added for a platform (Render, root-context build) and one for local/other tooling (`backend/`-context build) without consolidating.
- **Impact:** Silent drift risk — one image could get a fix the other doesn't.
- **Old Implementation:** Two files.
- **New Implementation (recommended):** Keep one Dockerfile (root, since it's referenced by the root-level build) and delete `backend/Dockerfile`, or make `backend/Dockerfile` a thin wrapper. Confirm which one Render/the `Procfile` path actually uses before deleting.
- **Expected Improvement:** One source of truth for the image.
- **Status:** Recommended, not applied.

### ISSUE-11 — Stray `backend/package-lock.json` (empty, Node artifact in a Python project)
- **Severity:** Low
- **Category:** Code Quality
- **Location:** `backend/package-lock.json` (`{"name":"backend","lockfileVersion":3,"requires":true,"packages":{}}`)
- **Description:** An empty npm lockfile sitting in the Python backend directory — almost certainly created by accidentally running `npm install` there once. It has no packages and does nothing.
- **Impact:** Confuses tooling/contributors about whether the backend has a Node component.
- **New Implementation (recommended):** Delete it.
- **Status:** Recommended, not applied.

### ISSUE-12 — No automated tests and no CI anywhere in the project
- **Severity:** Medium-High
- **Category:** DevOps / Maintainability / QA
- **Location:** Whole repo — no `pytest`/`vitest`/`jest` config, no `tests/` directory, no `.github/workflows/`. `frontend/test.js` (repo root of `frontend/`) is a 2-line ad hoc script for manually exercising `partial-json`, not a test suite.
- **Description:** Every change (including the 12 files currently modified-but-uncommitted on this branch) ships with zero automated verification. The LLM-parsing logic in `design_service.py` (`_safe_parse`, `_repair_json` — three-stage JSON repair) and the streaming SSE parsers on the frontend are exactly the kind of fragile, regex-heavy logic that benefits most from unit tests, and currently has none.
- **Impact:** Regressions in JSON-repair logic, history windowing, or cache key logic would only be caught by a human manually testing the UI.
- **New Implementation (recommended):** Start with `pytest` unit tests for `_safe_parse`/`_repair_json` (`design_service.py`), `trim_history`/`build_summary_prefix` (`history.py`), and `run_simulation` (`simulation.py`) — all pure functions, cheap to test. Add a minimal GitHub Actions workflow running `pytest` + `npm run build` + `npm run lint` on push.
- **Status:** Recommended, not applied.

### ISSUE-13 — Dead/misleading exception handling around `asyncio.create_task`
- **Severity:** Low
- **Category:** Code Quality
- **Location:** `backend/app/main.py:41-45`
- **Description:** 
  ```python
  try:
      asyncio.create_task(_init_rag_background())
  except Exception as e:
      print(f"⚠️  RAG initialization failed: {str(e)}")
  ```
  `asyncio.create_task()` schedules a coroutine and returns immediately — it cannot raise the *task's* exceptions synchronously. This `try/except` will never catch a RAG init failure (that's already handled correctly, redundantly, inside `_init_rag_background` itself at `main.py:22-28`). It only reads as if it's handling the failure.
- **Impact:** None functionally (the real handling exists one level down), but it's misleading to future readers and adds dead code.
- **New Implementation (recommended):** Remove the outer `try/except`; keep only the one inside `_init_rag_background`.
- **Status:** Recommended, not applied.

### ISSUE-14 — `frontend/dist` (build output) is committed... actually verified NOT tracked; `frontend/dist` present only as local build artifact
- **Note:** Initial survey flagged `frontend/dist` as possibly checked in; verified via `git ls-files frontend/dist` → empty result. **Not an issue** — correctly gitignored (`.gitignore:37`). Included here only to record it was checked and cleared, not left unverified.

---

# Optimizations Applied

**None. This is an analysis-only pass per explicit agreement with the user.** All items above are recommendations for a future implementation pass, not changes made now.

---

# Files Modified

**None.** The only new file created in this pass is this `solution.md` at the repo root (untracked, not committed).

---

# Performance Improvements

Not measured (no code changed). Estimated impact **if** the recommendations above were implemented:

| Recommendation | Estimated effect |
|---|---|
| Apply rate limiting (ISSUE-04) | Bounds worst-case LLM spend per client; no baseline-case latency change |
| Fix `/simulate`/`/improve` validation (ISSUE-06) | Negligible latency change; removes silent-failure debugging time |
| Fix concurrent provider race (ISSUE-07) | Prevents intermittent request failures under concurrent multi-provider load (currently unmeasured but non-zero above ~2 concurrent users on different providers) |
| Cap `/upload-knowledge` size (ISSUE-09) | Prevents worst-case multi-second/OOM ingestion stalls from oversized uploads |

The existing LLM path (`llm.py`) is already well-optimized: persistent httpx connection pool, litellm pre-warm, response caching (10-min TTL, 500 entries), RAG result caching (15-min TTL), and chat-history windowing/summarization to cap token usage — no further backend LLM-latency work is recommended at this time.

---

# Security Improvements

If implemented, the recommendations above would:
- Close the cross-user chat data exposure (ISSUE-01)
- Make missing-API-key misconfiguration visible instead of silently fail-open (ISSUE-02)
- Stop committing user data and DB files to git going forward (ISSUE-03)
- Bound abuse/cost via rate limiting on all LLM and upload endpoints (ISSUE-04, ISSUE-09)
- Restore input validation on `/simulate` and `/improve` (ISSUE-06)

No SQL injection risk found — `chats.py` (aiosqlite) uses parameterized queries throughout (`chats.py:33,41,52-59,66`). No obvious XSS: `ReactMarkdown` is used for chat rendering (`ChatPanel.jsx:33`) rather than `dangerouslySetInnerHTML`, which is the correct safe default. CORS origins are an explicit allowlist, not a wildcard (`main.py:67-80`) — correctly configured. The one known client-side API-key-in-localStorage tradeoff is already self-disclosed to users in the UI (`ChatPanel.jsx:547,571-574`) — acceptable given it's a user-supplied *personal* provider key, not a repo secret, and is explicitly warned about.

---

# Future Recommendations (not changed, worth considering later)

- **Cache backend**: if horizontal scaling is ever needed, move `response_cache`/`rag_cache` (ISSUE-08) to Redis or similar shared store.
- **Multi-user chat model**: introduce a real per-user identity concept (even a lightweight signed cookie) rather than one shared API key, as the foundation for fixing ISSUE-01 properly.
- **Frontend code splitting**: `ChatPanel.jsx` (657 lines) bundles markdown rendering, syntax highlighting, settings UI, and history UI into one file/one bundle chunk; consider `React.lazy` for the settings/history overlays and syntax highlighter, since they're not needed on initial paint.
- **Structured logging**: backend currently uses bare `print()` for all diagnostics (`main.py`, `rag.py`, `llm.py`) — fine for a small deploy, but would benefit from Python's `logging` module with levels if this grows, to allow filtering signal from the printed warmup/RAG noise in production logs.
- **Consolidate Dockerfiles** (ISSUE-10) once it's confirmed which one is actually used by the deploy pipeline.

---

# Final Checklist

- [x] Read every backend source file in `backend/app/`
- [x] Read every frontend source file in `frontend/src/`
- [x] Verified rate limiter is configured but unused (repo-wide search, zero `@limiter.limit` matches)
- [x] Verified chat/session endpoints have no ownership scoping
- [x] Verified committed data files via `git ls-files`
- [x] Verified CORS config is an explicit allowlist, not wildcard
- [x] Verified SQL queries are parameterized (no injection found)
- [x] Verified `/simulate` and `/improve` bypass existing Pydantic schemas
- [x] Found and root-caused the broken "Analyze" frontend feature (axios/fetch mismatch)
- [x] Verified no test suite or CI config exists
- [x] Verified duplicate Dockerfiles and stray `package-lock.json`
- [ ] No code changes applied — pending user approval of which fixes to implement next

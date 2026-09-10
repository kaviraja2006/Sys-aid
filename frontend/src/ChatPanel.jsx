import { useState, useEffect, useRef, lazy, Suspense } from 'react';
import { Send, Bot, User, Sparkles, RefreshCcw, ChevronLeft, ChevronRight, History, X, PenTool, Settings, Trash2, Search, CheckCircle, AlertTriangle, Mic, MicOff } from 'lucide-react';
import { api, API_URL } from './config/api';
import { secureGet, secureSet } from './utils/secureStorage';
import { useSpeechRecognition } from './hooks/useSpeechRecognition';

// react-markdown + remark-gfm + react-syntax-highlighter (ChatMessage.jsx)
// are by far the heaviest slice of this bundle — split into their own chunk,
// fetched only once the first message actually needs rendering, instead of
// blocking initial paint on a brand-new chat session.
const ChatMessage = lazy(() => import('./ChatMessage'));

const initialMessage = {
  id: 1,
  role: 'ai',
  text: 'Hello! I am your AI architect. Describe the software system you would like to design today. We can brainstorm, and when you are ready, click "Draw Board" below!'
};

const generateSessionId = () => Math.random().toString(36).substr(2, 9) + Date.now().toString(36);

let _msgCounter = 100;
const nextId = () => ++_msgCounter;
// Curated, periodically-verified model ids per provider. Free-text model
// entry used to be the only option, which silently broke whenever a typo'd
// id (or, for NVIDIA, a since-retired catalog id) 404'd against the
// provider with no indication of *why* — the id just looked plausible.
// A dropdown of ids we've actually confirmed still work removes that whole
// failure class for the common case; "Custom…" keeps free text available
// for anything not listed here.
const CURATED_MODELS = {
  openai: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'],
  gemini: ['gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-2.0-flash'],
  anthropic: ['claude-3-haiku-20240307', 'claude-3-5-sonnet-20240620'],
  // Verified live by calling integrate.api.nvidia.com directly as of this
  // writing — NVIDIA retires catalog ids with no notice (a bulk EOL on
  // 2026-08-26 took out most "obvious" ids, this app's old default
  // included), and its own model pages can lag the API's real state, so
  // don't restock this from build.nvidia.com without testing the id against
  // the API first. Re-check if "Custom…" starts getting used a lot.
  nvidia: ['mistralai/mistral-nemotron', 'nvidia/llama-3.1-nemotron-70b-instruct', 'mistralai/mistral-large-2-instruct'],
};
const CUSTOM_MODEL_VALUE = '__custom__';

const defaultLlmConfig = { provider: '', api_key: '', model_name: '', api_url: '' };
const normalizeSavedLlmConfig = (config) => {
  if (!config) return defaultLlmConfig;
  if (config.provider === 'ollama' && !config.api_key && !config.api_url && (!config.model_name || config.model_name === 'llama3')) {
    return defaultLlmConfig;
  }
  return { ...defaultLlmConfig, ...config };
};

export default function ChatPanel({ onGraphUpdate, onReset, currentNodes, currentEdges, onGenerationStart, onGenerationFinish, onGenerationProgress, setLlmConfig: syncLlmConfig, isAuthenticated }) {
  const [sessionId, setSessionId] = useState(generateSessionId());
  const [sessionTitle, setSessionTitle] = useState('New Architecture');
  const [messages, setMessages] = useState([initialMessage]);
  const [inputValue, setInputValue] = useState('');
  const [loading, setLoading] = useState(false);
  const [drawing, setDrawing] = useState(false);

  const inputTextareaRef = useRef(null);

  // Always-current mirrors of the canvas props, for code (drawBoard's wait
  // loop below) that reads them after an `await` — by then the props this
  // render closed over may be stale, since a background per-turn sync can
  // have updated the canvas in the meantime.
  const currentNodesRef = useRef(currentNodes);
  currentNodesRef.current = currentNodes;
  const currentEdgesRef = useRef(currentEdges);
  currentEdgesRef.current = currentEdges;
  // Counts chat turns whose background per-turn design sync (see handleSend)
  // hasn't landed yet. drawBoard waits for this to hit 0 so it never
  // finalizes a graph that's missing the very last thing just discussed.
  const pendingSyncCountRef = useRef(0);
  // The design JSON kept current turn-by-turn in the background — NOT drawn
  // to the canvas until the user clicks Draw. { nodes, edges } or null if
  // nothing has synced yet this session. Kept separate from currentNodes/
  // currentEdges (what's actually rendered) on purpose: the user asked for
  // the graph to only ever appear on an explicit Draw click, even though the
  // JSON backing it is being built/updated continuously underneath.
  const latestSyncedDesignRef = useRef(null);

  // Voice input — free, browser-native Web Speech API (Chrome/Edge/Opera/Brave only).
  // baseTextRef holds whatever was already in the textarea before this listening
  // session started, so live speech is layered on top of it (and each update
  // replaces the in-progress words in place instead of appending duplicates).
  const baseTextRef = useRef('');
  const speech = useSpeechRecognition({
    onTranscript: (liveText) =>
      setInputValue(baseTextRef.current ? `${baseTextRef.current} ${liveText}` : liveText),
  });

  // Auto-grow the input textarea with its content (typed or spoken) instead of
  // staying pinned to one row and scrolling long text out of view.
  const MAX_INPUT_HEIGHT = 260;
  useEffect(() => {
    const el = inputTextareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_INPUT_HEIGHT)}px`;
  }, [inputValue]);

  // UX logic
  const [width, setWidth] = useState(380);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isResizing, setIsResizing] = useState(false);

  // History
  const [showHistory, setShowHistory] = useState(false);
  const [historyList, setHistoryList] = useState([]);
  const [historySearch, setHistorySearch] = useState('');
  const [historyLoading, setHistoryLoading] = useState(false);

  // LLM Settings
  const [showSettings, setShowSettings] = useState(false);
  const [testStatus, setTestStatus] = useState(null);
  const [testMessage, setTestMessage] = useState('');
  const [llmConfig, setLlmConfig] = useState(defaultLlmConfig);
  const llmConfigLoaded = useRef(false);
  // True while the Model Name field shows a free-text box instead of the
  // curated dropdown — either the user picked "Custom…", or a previously
  // saved config already holds a model id outside the curated list.
  const [useCustomModel, setUseCustomModel] = useState(false);

  // Load the encrypted config once on mount. Loading is async (Web Crypto /
  // IndexedDB), so the settings form briefly shows defaults until this resolves.
  useEffect(() => {
    let cancelled = false;
    secureGet('sysaid_llm_config').then((saved) => {
      if (cancelled) return;
      llmConfigLoaded.current = true;
      if (saved) {
        const normalized = normalizeSavedLlmConfig(saved);
        setLlmConfig(normalized);
        const curated = CURATED_MODELS[normalized.provider];
        setUseCustomModel(!!curated && !!normalized.model_name && !curated.includes(normalized.model_name));
      }
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!llmConfigLoaded.current) return; // don't clobber saved config with defaults pre-load
    secureSet('sysaid_llm_config', llmConfig);
    syncLlmConfig?.(llmConfig);
  }, [llmConfig, syncLlmConfig]);

  const saveTimeout = useRef(null);
  const messagesEndRef = useRef(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading, drawing]);

  const stripGraphData = (nodes, edges) => ({
    nodes: nodes.map(n => ({ id: n.id, data: n.data, type: n.type, position: n.position || { x: 0, y: 0 } })),
    edges: edges.map(e => ({ id: e.id, source: e.source, target: e.target }))
  });

  // Turns the backend's {"nodes":[...],"edges":[...]} shape into safe
  // ReactFlow nodes/edges. Returns null (and logs) on anything unusable
  // instead of throwing, so a bad background sync never crashes the chat
  // turn that carried it.
  const sanitizeGraph = (parsed) => {
    if (!parsed || !Array.isArray(parsed.nodes)) return null;
    const safeNodes = parsed.nodes.map((n, i) => ({
      ...n,
      id: n.id || `node-${i}`,
      type: 'archNode',
      data: {
        label: n.data?.label || 'Node',
        description: n.data?.description || '',
        systemType: n.data?.systemType || 'default'
      }
    }));
    const safeEdges = (parsed.edges || []).map((e, i) => ({
      ...e,
      id: e.id || `edge-${i}`,
      source: e.source || '',
      target: e.target || ''
    })).filter(e => e.source && e.target);
    return { nodes: safeNodes, edges: safeEdges };
  };

  // Renders a graph JSON string onto the canvas (Draw button, or the
  // fallback full-generation path when nothing has synced in the background
  // yet). Keeps latestSyncedDesignRef in lockstep with whatever gets drawn,
  // so the next chat turn's background sync builds on exactly what's on
  // screen. Returns false on anything unusable.
  const applyGraphJson = (jsonString, { persistNow = false } = {}) => {
    let parsed;
    try {
      parsed = JSON.parse(jsonString);
    } catch (err) {
      console.error('Design graph JSON parse failed:', err, jsonString.slice(0, 200));
      return false;
    }
    const safe = sanitizeGraph(parsed);
    if (!safe) {
      console.error('Design graph JSON missing nodes array:', jsonString.slice(0, 200));
      return false;
    }
    onGraphUpdate(safe.nodes, safe.edges);
    latestSyncedDesignRef.current = safe;
    if (persistNow) {
      if (saveTimeout.current) clearTimeout(saveTimeout.current);
      persistSession({ nodes: safe.nodes, edges: safe.edges });
    }
    return true;
  };

  // Background-only counterpart: parses/sanitizes a per-turn design sync and
  // stashes it in latestSyncedDesignRef WITHOUT touching the canvas — the
  // graph should only ever appear when the user clicks Draw, even though the
  // JSON behind it is kept current after every reply.
  const storeSyncedDesign = (jsonString) => {
    let parsed;
    try {
      parsed = JSON.parse(jsonString);
    } catch (err) {
      console.error('Background design sync JSON parse failed:', err, jsonString.slice(0, 200));
      return;
    }
    const safe = sanitizeGraph(parsed);
    if (!safe) {
      console.error('Background design sync JSON missing nodes array:', jsonString.slice(0, 200));
      return;
    }
    latestSyncedDesignRef.current = safe;
  };


  // Persists a session immediately, bypassing the debounce below. Accepts
  // overrides for nodes/edges/messages/session id/title so callers that just
  // produced fresh data (e.g. drawBoard right after generating a graph, or a
  // session switch flushing the outgoing session) don't have to wait for
  // props/state to catch up on the next render.
  const persistSession = async (overrides = {}) => {
    if (!isAuthenticated) return;
    const payloadMessages = overrides.messages ?? messages;
    if (payloadMessages.length <= 1) return;
    try {
      await api.post('/chats/', {
        id: overrides.sessionId ?? sessionId,
        title: overrides.sessionTitle ?? sessionTitle,
        updated_at: new Date().toISOString(),
        messages: payloadMessages,
        nodes: overrides.nodes ?? currentNodes,
        edges: overrides.edges ?? currentEdges
      });
    } catch (err) {
      console.error("Failed to save", err);
    }
  };

  useEffect(() => {
    if (messages.length <= 1) return;
    if (!isAuthenticated) return;
    if (saveTimeout.current) clearTimeout(saveTimeout.current);
    saveTimeout.current = setTimeout(() => {
      if (loading || drawing) return;
      persistSession();
    }, 5000);
    return () => clearTimeout(saveTimeout.current);
  }, [messages, currentNodes, currentEdges, sessionId, sessionTitle, loading, drawing, isAuthenticated]);

  const loadHistoryList = async () => {
    if (!isAuthenticated) return;
    setHistoryLoading(true);
    try {
      const res = await api.get('/chats/');
      setHistoryList(res.data);
    } catch (e) {
      console.error(e);
    } finally {
      setHistoryLoading(false);
    }
  };

  const handleLoadSession = async (id) => {
    // Flush any pending autosave for the session we're leaving — otherwise a
    // board drawn in the last 5s gets cancelled by the effect cleanup below
    // and is never written to the DB before we switch away from it.
    if (saveTimeout.current) {
      clearTimeout(saveTimeout.current);
      await persistSession();
    }
    setLoading(true);
    try {
      const res = await api.get(`/chats/${id}`);
      setSessionId(res.data.id);
      setSessionTitle(res.data.title);
      setMessages(res.data.messages);
      onGraphUpdate(res.data.nodes || [], res.data.edges || []);
      // The loaded board is the known-good baseline going forward — future
      // background syncs in this session build on top of it.
      latestSyncedDesignRef.current = { nodes: res.data.nodes || [], edges: res.data.edges || [] };
      setShowHistory(false);
    } catch (e) {
      alert("Failed to load session");
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteSession = async (e, id) => {
    e.stopPropagation();
    if (!window.confirm("Are you sure you want to delete this session?")) return;
    try {
      await api.delete(`/chats/${id}`);
      setHistoryList(historyList.filter(h => h.id !== id));
      if (sessionId === id) handleResetChat();
    } catch (err) {
      alert("Failed to delete session");
    }
  };

  const handleResetChat = () => {
    // Same flush as handleLoadSession — don't lose an unsaved board when
    // starting a fresh session.
    if (saveTimeout.current) {
      clearTimeout(saveTimeout.current);
      persistSession();
    }
    setSessionId(generateSessionId());
    setSessionTitle('New Architecture');
    setMessages([initialMessage]);
    latestSyncedDesignRef.current = null;
    onReset();
  };

  const getChatHistory = () => messages.filter(m => m.id !== 1).slice(-8).map(m => ({ role: m.role, text: m.text }));

  // Draw uses the FULL discussion (not the 8-message window used for normal chat turns)
  // so the final board reflects every add/remove/change discussed, not just the recent tail.
  const getFullChatHistory = () => messages.filter(m => m.id !== 1).map(m => ({ role: m.role, text: m.text }));

  // The most recent AI response is treated as the finalized architecture
  // idea/documentation — the diagram must be generated from exactly this text
  // so the two never drift apart.
  const getLatestDocumentation = () => {
    const aiMessages = messages.filter(m => m.id !== 1 && m.role === 'ai' && m.text?.trim());
    return aiMessages.length ? aiMessages[aiMessages.length - 1].text : '';
  };

  const generateTitle = (text) => {
    // Truncate at word boundary near 30 chars
    if (text.length <= 30) return text;
    const substr = text.substring(0, 30);
    const lastSpace = substr.lastIndexOf(' ');
    if (lastSpace > 0) return substr.substring(0, lastSpace) + '...';
    return substr + '...';
  };

  const handleSend = async (e, textOverride) => {
    if (e) e.preventDefault();
    const textToSend = textOverride || inputValue;
    if (!textToSend.trim() || loading || drawing) return;
    if (speech.isListening) speech.stop();

    if (messages.length === 1) setSessionTitle(generateTitle(textToSend));

    const userMsgId = nextId();
    const aiMessageId = nextId();
    setMessages((prev) => [...prev, { id: userMsgId, role: 'user', text: textToSend }, { id: aiMessageId, role: 'ai', text: '' }]);
    setInputValue('');
    setLoading(true);
    pendingSyncCountRef.current += 1;

    try {
      // Base the backend's sync on the latest background JSON if we have one
      // — it can already be ahead of what's on screen, since the canvas only
      // updates on an explicit Draw. Falls back to the canvas itself before
      // anything has synced yet (e.g. the very first message).
      const syncBase = latestSyncedDesignRef.current
        ? stripGraphData(latestSyncedDesignRef.current.nodes, latestSyncedDesignRef.current.edges)
        : stripGraphData(currentNodesRef.current, currentEdgesRef.current);
      const payload = {
        prompt: textToSend,
        chat_history: getChatHistory(),
        // Lets the backend sync the design graph against what already
        // exists instead of guessing from scratch each turn — see the
        // `design` event handling below.
        current_design: syncBase,
        ...llmConfig
      };

      const response = await fetch(`${API_URL}/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': import.meta.env.VITE_BACKEND_API_KEY || ''
        },
        // Backend routes now identify the calling user (see get_current_user),
        // which reads the session cookie set by /auth/google. A cross-origin
        // fetch() doesn't send cookies unless told to.
        credentials: 'include',
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let aiText = '';
      let lineBuffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        // Buffer raw bytes and split on real newlines — avoids SSE lines split across TCP chunks
        lineBuffer += decoder.decode(value, { stream: true });
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop(); // keep incomplete last line in buffer

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            if (!data || data === '[DONE]') continue;
            let textChunk = '';
            try { textChunk = JSON.parse(data); } catch (e) { textChunk = data; }
            if (textChunk && typeof textChunk === 'object' && textChunk.error) {
              aiText += `\n\n_Error: ${textChunk.error}_`;
              setMessages((prev) => prev.map(msg => msg.id === aiMessageId ? { ...msg, text: aiText } : msg));
              continue;
            }
            // The reply text is fully streamed at this point — the backend
            // now moves on to a much slower background design sync (see
            // below) before it closes the stream. Re-enable input now
            // instead of leaving it disabled for that extra 5-50s, which
            // read as a hang. The read loop below keeps running in the
            // background to catch the design update when it arrives.
            if (textChunk && typeof textChunk === 'object' && textChunk.text_done) {
              setLoading(false);
              continue;
            }
            // The backend syncs the design JSON after every turn (add/replace/
            // remove components as the discussion evolves) so it's already
            // current by the time the user clicks Draw — but it's kept out of
            // the canvas until then; the user only wants the graph to appear
            // on an explicit Draw click. Silent on failure — this is a
            // background enhancement, never something to interrupt chat over.
            if (textChunk && typeof textChunk === 'object' && typeof textChunk.design === 'string') {
              storeSyncedDesign(textChunk.design);
              continue;
            }
            if (textChunk) {
              aiText += textChunk;
              setMessages((prev) => prev.map(msg => msg.id === aiMessageId ? { ...msg, text: aiText } : msg));
            }
          }
        }
      }
    } catch (error) {
      setMessages((prev) => [...prev, { id: nextId(), role: 'ai', text: `Error: ${error.message}` }]);
    } finally {
      setLoading(false);
      pendingSyncCountRef.current = Math.max(0, pendingSyncCountRef.current - 1);
    }
  };

  const drawBoard = async () => {
    if (loading || drawing) return;
    if (speech.isListening) speech.stop();
    setDrawing(true);

    try {
      // Wait for any chat turn's background design sync (see handleSend) to
      // land first — otherwise Draw could finalize a graph that's missing
      // the very last thing just discussed. Capped so a stuck sync can't
      // hang Draw forever; past the cap it just falls through to the full
      // regeneration below, which is a safe (if slower) superset either way.
      const SYNC_WAIT_MS = 60000;
      const waitStart = Date.now();
      while (pendingSyncCountRef.current > 0 && Date.now() - waitStart < SYNC_WAIT_MS) {
        await new Promise((r) => setTimeout(r, 300));
      }

      // The design JSON is already kept in sync with the conversation turn
      // by turn (see the `design` events handled in handleSend) — it's just
      // been sitting in the background, not on the canvas, since the graph
      // is only meant to appear on this explicit click. Drawing it now is
      // rendering that already-built JSON, not asking the model to build the
      // whole thing over again from scratch — which is what made this slow
      // and timeout-prone before. Only fall back to a full LLM generation
      // below if nothing has synced in the background yet.
      const backgroundDesign = latestSyncedDesignRef.current;
      if (backgroundDesign && backgroundDesign.nodes && backgroundDesign.nodes.length > 0) {
        onGraphUpdate(backgroundDesign.nodes, backgroundDesign.edges || []);
        if (saveTimeout.current) clearTimeout(saveTimeout.current);
        await persistSession({ nodes: backgroundDesign.nodes, edges: backgroundDesign.edges || [] });
        setInputValue('');
        return;
      }
      // Nothing synced in the background (e.g. every prior sync attempt
      // failed) but the canvas already has something drawn from earlier —
      // just re-confirm/re-layout what's already there instead of a fresh
      // generation.
      if (currentNodesRef.current && currentNodesRef.current.length > 0) {
        onGraphUpdate(currentNodesRef.current, currentEdgesRef.current);
        if (saveTimeout.current) clearTimeout(saveTimeout.current);
        await persistSession({ nodes: currentNodesRef.current, edges: currentEdgesRef.current });
        setInputValue('');
        return;
      }

      const payload = {
        prompt: "Draw the final confirmed board logic based on our chat history.",
        current_design: stripGraphData(currentNodesRef.current, currentEdgesRef.current),
        chat_history: getFullChatHistory(),
        documentation: getLatestDocumentation(),
        ...llmConfig
      };

      const response = await fetch(`${API_URL}/generate-board`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': import.meta.env.VITE_BACKEND_API_KEY || ''
        },
        // Backend routes now identify the calling user (see get_current_user),
        // which reads the session cookie set by /auth/google. A cross-origin
        // fetch() doesn't send cookies unless told to.
        credentials: 'include',
        body: JSON.stringify(payload)
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      onGenerationStart?.();
      onGenerationProgress?.(0);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      // The backend now sends exactly one of three events, never raw partial
      // text: {progress: seconds} while it's still working, {final: json}
      // once the model's COMPLETE output has been validated as a real
      // diagram, or {error: message} if it wasn't. Nothing to reassemble or
      // salvage client-side any more.
      let finalJson = null;
      let errorMessage = null;
      let lineBuffer = '';

      const handleEvent = (data) => {
        if (!data || data === '[DONE]') return;
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          return; // not one of our JSON events — ignore rather than guess
        }
        if (parsed?.error) errorMessage = parsed.error;
        else if (typeof parsed?.final === 'string') finalJson = parsed.final;
        else if (typeof parsed?.progress === 'number') onGenerationProgress?.(parsed.progress);
      };

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        lineBuffer += decoder.decode(value, { stream: true });
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop(); // keep incomplete line buffered

        for (const line of lines) {
          if (line.startsWith('data: ')) handleEvent(line.slice(6).trim());
        }
      }
      if (lineBuffer.startsWith('data: ')) handleEvent(lineBuffer.slice(6).trim());

      if (errorMessage) {
        console.error('Graph generation error:', errorMessage);
        alert(`Draw failed: ${errorMessage}`);
        return;
      }
      if (!finalJson) {
        console.error('Graph generation ended with no result and no error.');
        alert('Draw failed: no response from the server. Please try again.');
        return;
      }

      // Save immediately -- don't rely on the 5s debounce, which can be
      // cancelled if the user switches chats right after drawing.
      if (!applyGraphJson(finalJson, { persistNow: true })) {
        alert('Draw failed: server returned an unusable diagram. See console for details.');
        return;
      }

      setInputValue('');
    } catch (error) {
      alert(`Draw failed: ${error.message}`);
    } finally {
      onGenerationFinish?.();
      setDrawing(false);
      setInputValue('');
    }
  };

  const testConnection = async () => {
    setTestStatus('testing');
    setTestMessage('');
    // Under 8s is the normal case. Past that, the model is still alive but
    // slow to respond (cold start / a heavier model) — let the user know
    // we're still waiting instead of going straight to an error.
    const slowNoticeTimer = setTimeout(() => {
      setTestMessage('This model needs extra time to connect, please wait…');
    }, 8000);
    try {
      // A 502 here always means "the upstream provider rejected the
      // request" (bad key/model), never a transient gateway blip — retrying
      // it 3x just re-sends the same bad request and triples how long the
      // user waits to see the (correct) error, so opt this call out.
      // 65s > backend's HEALTH_TIMEOUT_SECONDS (60s) so the backend's own
      // timeout always fires first and returns the real reason — otherwise
      // this axios timeout could cut the request off first and report a
      // generic client-side timeout instead of NVIDIA's actual response
      // (e.g. a cold-started free-tier NIM endpoint that's simply slow).
      const res = await api.post('/health/llm', llmConfig, { timeout: 65000, 'axios-retry': { retries: 0 } });
      if (res.data?.status !== 'ok') {
        throw new Error(res.data?.message || 'Connection failed');
      }
      clearTimeout(slowNoticeTimer);
      setTestStatus('success');
      setTestMessage('Connection OK');
    } catch (e) {
      clearTimeout(slowNoticeTimer);
      const detail = e.response?.data?.detail;
      const message = detail?.message || e.response?.data?.message || e.message || 'Connection failed';
      setTestStatus('error');
      setTestMessage(message.replace(/^litellm\.[^:]+:\s*/i, '').slice(0, 160));
    }
    setTimeout(() => {
      setTestStatus(null);
      setTestMessage('');
    }, 6000);
  };

  useEffect(() => {
    const handleMouseMove = (e) => isResizing && !isCollapsed && setWidth(Math.max(300, Math.min(e.clientX, 800)));
    const handleMouseUp = () => isResizing && setIsResizing(false);
    if (isResizing) { document.addEventListener('mousemove', handleMouseMove); document.addEventListener('mouseup', handleMouseUp); }
    return () => { document.removeEventListener('mousemove', handleMouseMove); document.removeEventListener('mouseup', handleMouseUp); };
  }, [isResizing, isCollapsed]);

  if (isCollapsed) return (
    <div className="h-full bg-[#050505] border-r border-[#1f2023] z-10 flex flex-col items-center py-4 w-12 transition-all shadow-xl absolute md:relative">
      <button onClick={() => setIsCollapsed(false)} className="p-2 mb-4 rounded-xl bg-blue-600/20 text-blue-400 hover:bg-blue-600/40"><ChevronRight size={18} /></button>
    </div>
  );

  const filteredHistory = historyList.filter(h => h.title.toLowerCase().includes(historySearch.toLowerCase()));

  return (
    <div style={{ width: `${width}px` }} className={`h-full flex flex-col bg-[#050505] border-r border-[#1f2023] z-50 font-sans shadow-2xl relative select-none md:static absolute inset-y-0 left-0 transition-transform ${isCollapsed ? '-translate-x-full md:translate-x-0' : 'translate-x-0'}`}>
      <div className="absolute top-0 right-0 w-1.5 h-full cursor-col-resize hover:bg-blue-500/50 active:bg-blue-500 z-20 hidden md:block" onMouseDown={() => setIsResizing(true)} />

      {/* History Menu */}
      {showHistory && (
        <div className="absolute inset-0 bg-[#050505]/95 backdrop-blur-sm z-30 flex flex-col pt-5 px-4 pb-4 overflow-hidden border-r border-[#1f2023]">
          <div className="flex justify-between items-center mb-4">
            <h3 className="text-white font-semibold flex items-center gap-2"><History size={16} className="text-blue-400" /> Past Sessions</h3>
            <button onClick={() => setShowHistory(false)} className="p-1 hover:bg-[#1f2023] rounded-lg text-gray-400"><X size={18} /></button>
          </div>
          <div className="mb-4 relative">
            <Search size={14} className="absolute left-3 top-2.5 text-gray-500" />
            <input type="text" placeholder="Search..." value={historySearch} onChange={e => setHistorySearch(e.target.value)} className="w-full bg-[#111215] border border-[#2c2d31] rounded-lg py-2 pl-9 pr-3 text-[13px] text-gray-200 outline-none focus:border-blue-500" />
          </div>
          <div className="flex-1 overflow-y-auto space-y-2 custom-scrollbar">
            {historyLoading && <div className="text-center py-4"><RefreshCcw size={16} className="animate-spin text-gray-500 mx-auto" /></div>}
            {!historyLoading && filteredHistory.length === 0 && <p className="text-sm text-gray-500 text-center mt-4">No sessions found.</p>}
            {filteredHistory.map(session => (
              <div key={session.id} onClick={() => handleLoadSession(session.id)} className="p-3 rounded-xl border cursor-pointer border-[#1f2023] hover:border-blue-500/30 bg-[#111215] hover:bg-[#15161A] flex justify-between items-center group">
                <div className="overflow-hidden">
                  <h4 className="text-sm font-medium text-gray-200 truncate">{session.title}</h4>
                  <p className="text-[11px] text-gray-500 mt-1">{new Date(session.updated_at).toLocaleString()}</p>
                </div>
                <button onClick={(e) => handleDeleteSession(e, session.id)} className="p-1.5 text-red-400/50 hover:text-red-400 hover:bg-red-400/10 rounded hidden group-hover:block"><Trash2 size={14} /></button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Settings Menu */}
      {showSettings && (
        <div className="absolute inset-0 bg-[#050505]/95 backdrop-blur-sm z-30 flex flex-col pt-5 px-5 pb-4 overflow-hidden border-r border-[#1f2023]">
          <div className="flex justify-between items-center mb-6">
            <h3 className="text-white font-semibold flex items-center gap-2"><Settings size={16} className="text-blue-400" /> API Settings</h3>
            <button onClick={() => setShowSettings(false)} className="p-1 hover:bg-[#1f2023] rounded-lg text-gray-400"><X size={18} /></button>
          </div>
          <div className="flex-1 overflow-y-auto space-y-4 custom-scrollbar text-sm text-gray-300">
            <div className="flex flex-col gap-1.5">
              <label className="text-gray-400 text-[12px] uppercase tracking-wider font-semibold">Provider</label>
              <select value={llmConfig.provider} onChange={(e) => { setLlmConfig({ ...llmConfig, provider: e.target.value, model_name: '' }); setUseCustomModel(false); }} className="bg-[#111215] border border-[#2c2d31] rounded-lg p-2 outline-none focus:border-blue-500">
                <option value="">Fast backend default</option>
                <option value="ollama">Ollama (Local / Free)</option>
                <option value="openai">OpenAI (ChatGPT)</option>
                <option value="gemini">Google Gemini</option>
                <option value="anthropic">Anthropic (Claude)</option>
                <option value="nvidia">NVIDIA (GeForce NIM)</option>
                <option value="openai-compatible">Custom (OpenAI Compatible)</option>
              </select>
            </div>
            {llmConfig.provider && llmConfig.provider !== 'ollama' && (
              <div className="flex flex-col gap-1.5">
                <label className="text-gray-400 text-[12px] uppercase tracking-wider font-semibold flex justify-between">
                  API Key
                  <span className="text-amber-500/80 normal-case font-normal flex items-center gap-1"><AlertTriangle size={10} /> Stored insecurely in browser</span>
                </label>
                <input type="password" value={llmConfig.api_key} onChange={(e) => setLlmConfig({ ...llmConfig, api_key: e.target.value })} placeholder={llmConfig.provider === 'openai' ? 'sk-...' : (llmConfig.provider === 'anthropic' ? 'sk-ant-...' : 'Your API Key')} className="bg-[#111215] border border-[#2c2d31] rounded-lg p-2 outline-none focus:border-blue-500" />
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              <label className="text-gray-400 text-[12px] uppercase tracking-wider font-semibold">Model Name {llmConfig.provider === 'ollama' && '(e.g. llama3.2:1b)'}</label>
              {CURATED_MODELS[llmConfig.provider] && !useCustomModel ? (
                <select
                  value={llmConfig.model_name || ''}
                  onChange={(e) => {
                    if (e.target.value === CUSTOM_MODEL_VALUE) { setUseCustomModel(true); return; }
                    setLlmConfig({ ...llmConfig, model_name: e.target.value });
                  }}
                  className="bg-[#111215] border border-[#2c2d31] rounded-lg p-2 outline-none focus:border-blue-500"
                >
                  <option value="">Fast backend default</option>
                  {CURATED_MODELS[llmConfig.provider].map((m) => <option key={m} value={m}>{m}</option>)}
                  <option value={CUSTOM_MODEL_VALUE}>Custom…</option>
                </select>
              ) : (
                <>
                  <input type="text" value={llmConfig.model_name} onChange={(e) => setLlmConfig({ ...llmConfig, model_name: e.target.value })} placeholder={llmConfig.provider === 'openai' ? 'gpt-4o-mini' : llmConfig.provider === 'gemini' ? 'gemini-1.5-flash' : llmConfig.provider === 'anthropic' ? 'claude-3-haiku-20240307' : llmConfig.provider === 'nvidia' ? 'mistralai/mistral-nemotron' : llmConfig.provider === 'ollama' ? 'llama3.2:1b' : 'Backend default'} className="bg-[#111215] border border-[#2c2d31] rounded-lg p-2 outline-none focus:border-blue-500" />
                  {CURATED_MODELS[llmConfig.provider] && (
                    <button type="button" onClick={() => { setUseCustomModel(false); setLlmConfig({ ...llmConfig, model_name: '' }); }} className="text-[11px] text-blue-400 hover:text-blue-300 text-left">
                      ← back to the verified model list
                    </button>
                  )}
                  {llmConfig.provider === 'nvidia' && (
                    <p className="text-[11px] text-gray-500">
                      Must match a live id at build.nvidia.com/models exactly — NVIDIA retires catalog ids without notice.
                    </p>
                  )}
                  <p className="text-[11px] text-amber-500/80 flex items-start gap-1">
                    <AlertTriangle size={11} className="shrink-0 mt-0.5" />
                    Custom models aren't speed-tested. Draw Board needs a model
                    that returns a large JSON diagram quickly — a big or
                    "reasoning" model can time out generating one even if it
                    chats fine. If Draw keeps failing, switch back to a
                    verified model above.
                  </p>
                </>
              )}
            </div>
            {(llmConfig.provider === 'openai-compatible' || llmConfig.provider === 'ollama') && (
              <div className="flex flex-col gap-1.5">
                <label className="text-gray-400 text-[12px] uppercase tracking-wider font-semibold">Custom AI URL</label>
                <input type="text" value={llmConfig.api_url} onChange={(e) => setLlmConfig({ ...llmConfig, api_url: e.target.value })} placeholder={llmConfig.provider === 'ollama' ? 'http://localhost:11434/api/generate' : 'https://api.groq.com/openai/v1/chat/completions'} className="bg-[#111215] border border-[#2c2d31] rounded-lg p-2 outline-none focus:border-blue-500" />
              </div>
            )}
            <button onClick={testConnection} className="mt-2 w-full py-2 flex items-center justify-center gap-2 border border-[#2c2d31] rounded-lg hover:bg-[#1a1b1e] transition-colors">
              {testStatus === 'testing' ? <RefreshCcw size={14} className="animate-spin text-gray-400" /> : testStatus === 'success' ? <CheckCircle size={14} className="text-emerald-400" /> : testStatus === 'error' ? <AlertTriangle size={14} className="text-red-400" /> : <Sparkles size={14} className="text-blue-400" />}
              {testStatus === 'testing' ? 'Testing...' : testStatus === 'success' ? 'Success' : testStatus === 'error' ? 'Connection Failed' : 'Test Connection'}
            </button>
            {testMessage && (
              <p className={`text-xs leading-relaxed ${testStatus === 'error' ? 'text-red-300' : testStatus === 'testing' ? 'text-amber-300' : 'text-emerald-300'}`}>
                {testMessage}
              </p>
            )}
            <div className="mt-4 border border-amber-500/20 bg-amber-500/5 text-amber-400/80 p-3 rounded-lg text-xs leading-relaxed flex gap-2">
              <AlertTriangle size={16} className="shrink-0 mt-0.5" />
              <span>Your API key is encrypted at rest in this browser (AES-GCM, key never leaves the browser's secure storage). It is still decrypted in memory to make requests, so never use a production key with limits disabled.</span>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="p-4 xl:p-5 border-b border-[#1f2023] flex flex-col bg-gradient-to-b from-[#111112] to-transparent shrink-0 space-y-4 shadow-sm">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-sm xl:text-[15px] flex items-center gap-2 text-white truncate">
            <div className="bg-blue-500/10 p-1.5 rounded-lg border border-blue-500/20"><Sparkles size={16} className="text-blue-400" /></div>
            <span>SysAid Architect</span>
          </h2>
          <div className="flex items-center gap-2 shrink-0">
            <button onClick={() => setShowSettings(true)} className="p-1.5 rounded-md text-gray-400 hover:text-blue-400 hover:bg-blue-500/10"><Settings size={16} /></button>
            <button onClick={() => { setShowHistory(true); loadHistoryList(); }} className="p-1.5 rounded-md text-gray-400 hover:text-blue-400 hover:bg-blue-500/10"><History size={16} /></button>
            <button onClick={handleResetChat} disabled={loading || drawing} className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-blue-600/10 text-blue-400 text-[12px] font-medium border border-blue-500/20 hover:bg-blue-600/30"><RefreshCcw size={12} /> New Chat</button>
            <button onClick={() => setIsCollapsed(true)} className="p-1.5 rounded-md text-gray-400 hover:bg-gray-500/30"><ChevronLeft size={16} /></button>
          </div>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 xl:p-5 space-y-6 custom-scrollbar bg-gradient-to-b from-[#050505] to-[#0A0B0E] select-text">
        <Suspense fallback={messages.map((msg) => (
          <div key={msg.id} className="flex gap-3 animate-pulse">
            <div className="flex-shrink-0 w-8 h-8 rounded-full bg-[#1a1b1e] border border-[#2c2d31]" />
            <div className="h-10 flex-1 max-w-[85%] rounded-2xl bg-[#151618] border border-[#232427]" />
          </div>
        ))}>
          {messages.map((msg) => (
            <ChatMessage key={msg.id} msg={msg} isStreaming={loading} />
          ))}
        </Suspense>

        {messages.length === 1 && (
          <div className="mt-8 flex flex-col gap-2 px-2">
            <p className="text-xs text-gray-500 uppercase tracking-wider font-semibold mb-2 ml-1">Try asking:</p>
            <button onClick={(e) => handleSend(e, "Design a microservices e-commerce app")} className="text-left p-3 rounded-xl border border-[#2c2d31] bg-[#111215] hover:bg-[#1a1b1e] text-sm text-gray-300 transition-colors">
              🛒 Design a microservices e-commerce app
            </button>
            <button onClick={(e) => handleSend(e, "Build a real-time chat system")} className="text-left p-3 rounded-xl border border-[#2c2d31] bg-[#111215] hover:bg-[#1a1b1e] text-sm text-gray-300 transition-colors">
              💬 Build a real-time chat system
            </button>
            <button onClick={(e) => handleSend(e, "Design a large-scale data pipeline")} className="text-left p-3 rounded-xl border border-[#2c2d31] bg-[#111215] hover:bg-[#1a1b1e] text-sm text-gray-300 transition-colors">
              📊 Design a large-scale data pipeline
            </button>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Action Footer */}
      <div className="p-4 border-t border-[#1f2023] bg-[#0c0d0f] shrink-0 flex flex-col gap-3">
        {messages.length > 1 && (
          <button
            onClick={drawBoard}
            disabled={loading || drawing}
            className="w-full py-2.5 rounded-xl bg-emerald-600/20 text-emerald-400 border border-emerald-500/30 font-medium text-[13px] tracking-wide flex justify-center items-center gap-2 shadow-sm hover:bg-emerald-600/30 transition-all disabled:opacity-50"
          >
            {drawing ? <RefreshCcw size={14} className="animate-spin" /> : <PenTool size={14} />}
            {drawing ? 'Drawing Board...' : 'Draw Architecture Board'}
          </button>
        )}

        {speech.error && (
          <p className="flex items-center gap-1.5 text-[11px] text-amber-400 -mb-1">
            <AlertTriangle size={12} />
            {speech.error}
          </p>
        )}

        <form onSubmit={handleSend} className="relative flex items-end">
          <textarea
            ref={inputTextareaRef}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && e.ctrlKey) {
                e.preventDefault();
                drawBoard();
              } else if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend(e);
              }
            }}
            placeholder={speech.isListening ? 'Listening...' : 'Discuss architecture... (Ctrl+Enter to Draw Board)'}
            disabled={loading || drawing}
            rows="1"
            style={{ resize: 'none', maxHeight: `${MAX_INPUT_HEIGHT}px`, overflowY: 'auto' }}
            className={`w-full bg-[#151618] border rounded-xl py-3 pl-4 text-[13px] leading-relaxed text-gray-200 placeholder-gray-500 shadow-inner disabled:opacity-50 outline-none custom-scrollbar transition-[height,border-color] duration-150 ${speech.isSupported ? 'pr-20' : 'pr-12'} ${speech.isListening ? 'border-red-500/50' : 'border-[#2c2d31] focus:border-blue-500/50'}`}
          />
          {speech.isSupported && (
            <button
              type="button"
              title={speech.isListening ? 'Stop recording' : 'Speak your idea'}
              onClick={() => {
                if (speech.isListening) {
                  speech.stop();
                } else {
                  baseTextRef.current = inputValue.trim();
                  speech.start();
                }
              }}
              disabled={loading || drawing}
              className={`absolute right-9 bottom-2 p-1.5 rounded-lg transition-all disabled:opacity-40 ${speech.isListening ? 'bg-red-600/20 text-red-400 border border-red-500/40 animate-pulse' : 'bg-[#1f2023] text-gray-400 hover:text-gray-200 border border-[#2c2d31]'}`}
            >
              {speech.isListening ? <MicOff size={14} /> : <Mic size={14} />}
            </button>
          )}
          <button type="submit" disabled={!inputValue.trim() || loading || drawing} className="absolute right-1.5 bottom-2 p-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-40 transition-all"><Send size={14} className="ml-0.5" /></button>
        </form>
        <p className="text-[10.5px] text-gray-600 px-1 -mt-1.5 select-none">
          <kbd className="px-1 py-0.5 rounded bg-[#1a1b1e] border border-[#2c2d31] text-gray-500">Enter</kbd> to send &nbsp;·&nbsp; <kbd className="px-1 py-0.5 rounded bg-[#1a1b1e] border border-[#2c2d31] text-gray-500">Shift+Enter</kbd> new line &nbsp;·&nbsp; <kbd className="px-1 py-0.5 rounded bg-[#1a1b1e] border border-[#2c2d31] text-gray-500">Ctrl+Enter</kbd> draw board
        </p>
      </div>

    </div>
  );
}

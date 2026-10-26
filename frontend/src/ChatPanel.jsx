import { useState, useEffect, useRef, lazy, Suspense } from 'react';
import {
  Send, Bot, User, Sparkles, RefreshCcw, ChevronLeft, ChevronRight, History, X,
  PenTool, Settings, Trash2, Search, CheckCircle, AlertTriangle, Mic, MicOff,
  ChevronDown, Check, Zap, Cpu, Filter, Brain, Layers, ArrowRight, SlidersHorizontal,
  CheckCircle2
} from 'lucide-react';
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

const isReasoningModel = (id) => {
  const lower = (id || '').toLowerCase();
  return (
    lower.includes('r1') ||
    lower.includes('reasoning') ||
    lower.includes('qwq') ||
    lower.includes('nemotron') ||
    lower.includes('thinking') ||
    lower.includes('o1') ||
    lower.includes('o3')
  );
};

const MODEL_FAMILIES = [
  { id: 'deepseek', label: 'DeepSeek', color: 'from-cyan-500/20 to-blue-500/10 text-cyan-300 border-cyan-500/30', tag: 'DS', test: (id) => id.includes('deepseek') },
  { id: 'llama', label: 'Llama', color: 'from-indigo-500/20 to-blue-500/10 text-indigo-300 border-indigo-500/30', tag: 'LL', test: (id) => id.includes('llama') },
  { id: 'qwen', label: 'Qwen', color: 'from-violet-500/20 to-purple-500/10 text-violet-300 border-violet-500/30', tag: 'QW', test: (id) => id.includes('qwen') },
  { id: 'mistral', label: 'Mistral', color: 'from-amber-500/20 to-orange-500/10 text-amber-300 border-amber-500/30', tag: 'MS', test: (id) => id.includes('mistral') || id.includes('mixtral') || id.includes('codestral') },
  { id: 'gemma', label: 'Gemma', color: 'from-blue-500/20 to-sky-500/10 text-blue-300 border-blue-500/30', tag: 'GM', test: (id) => id.includes('gemma') || id.includes('gemini') },
  { id: 'claude', label: 'Claude', color: 'from-rose-500/20 to-orange-500/10 text-rose-300 border-rose-500/30', tag: 'CL', test: (id) => id.includes('claude') },
  { id: 'nemotron', label: 'Nemotron', color: 'from-emerald-500/20 to-teal-500/10 text-emerald-300 border-emerald-500/30', tag: 'NV', test: (id) => id.includes('nemotron') || id.includes('nvidia') },
  { id: 'openai', label: 'OpenAI', color: 'from-teal-500/20 to-emerald-500/10 text-teal-300 border-teal-500/30', tag: 'OA', test: (id) => id.includes('gpt') || id.includes('o1') || id.includes('o3') },
];

const getModelFamilyBadge = (modelId) => {
  const lower = (modelId || '').toLowerCase();
  for (const fam of MODEL_FAMILIES) {
    if (fam.test(lower)) return fam;
  }
  return null;
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
  nvidia: ['nvidia/nemotron-3.5-lightning-30b-a3b', 'nvidia/nemotron-3-ultra-550b-a55b', 'nvidia/nemotron-3-super-120b-a12b'],
  // Verified live against https://openrouter.ai/api/v1/models (public, no
  // auth needed) as of this writing — OpenRouter's free catalog turns over
  // like NVIDIA's does, so re-check that endpoint before restocking this.
  // gemma-4 listed first (and used as the backend default) — the smaller
  // liquid/lfm-2.5-2.6b struggled with this app's strict JSON-schema
  // output (design sync/Draw Board), either failing to parse or running
  // slow enough under free-tier rate limits that Draw fell back to the
  // much slower full-regeneration path. Avoid picking a "reasoning"-tagged
  // free model here — the extra thinking tokens fight the same fast,
  // schema-only JSON output this app needs.
  openrouter: ['liquid/lfm-2.5-2.6b:free','apodex/apodex-1.1-mini:free'],
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
  const [useCustomModel, setUseCustomModel] = useState(false);
  const [availableModels, setAvailableModels] = useState([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelSearch, setModelSearch] = useState('');
  const [isModelDropdownOpen, setIsModelDropdownOpen] = useState(false);
  const [modelCategoryFilter, setModelCategoryFilter] = useState('all');
  const modelDropdownRef = useRef(null);
  const searchInputRef = useRef(null);

  useEffect(() => {
    if (isModelDropdownOpen) {
      if (searchInputRef.current) {
        searchInputRef.current.focus();
      }
      setTimeout(() => {
        modelDropdownRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }, 50);
    }
  }, [isModelDropdownOpen]);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(e.target)) {
        setIsModelDropdownOpen(false);
      }
    };
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        setIsModelDropdownOpen(false);
      }
    };
    if (isModelDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('keydown', handleKeyDown);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isModelDropdownOpen]);

  const fetchModels = async (provider, apiKey, apiUrl) => {
    if (!provider) {
      setAvailableModels([]);
      return;
    }
    setLoadingModels(true);
    try {
      const res = await api.post('/models', {
        provider,
        api_key: apiKey || '',
        api_url: apiUrl || '',
      });
      if (res.data?.status === 'ok' && Array.isArray(res.data.models) && res.data.models.length > 0) {
        setAvailableModels(res.data.models);
      } else if (CURATED_MODELS[provider]) {
        setAvailableModels(CURATED_MODELS[provider].map((m) => ({ id: m, name: m })));
      } else {
        setAvailableModels([]);
      }
    } catch (e) {
      console.warn('Failed to fetch provider models:', e);
      if (CURATED_MODELS[provider]) {
        setAvailableModels(CURATED_MODELS[provider].map((m) => ({ id: m, name: m })));
      } else {
        setAvailableModels([]);
      }
    } finally {
      setLoadingModels(false);
    }
  };

  useEffect(() => {
    if (showSettings && llmConfig.provider) {
      fetchModels(llmConfig.provider, llmConfig.api_key, llmConfig.api_url);
    }
  }, [showSettings, llmConfig.provider]);

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

    // Free-tier providers (e.g. NVIDIA NIM) can take up to ~60s to respond
    // on a cold-started container — the request is genuinely still working,
    // not frozen, but the typing dots alone don't say that. Swap in a
    // one-time note past the point where a warm model would already have
    // started streaming; cleared the moment real text starts arriving below.
    const warmupNoticeTimer = setTimeout(() => {
      setMessages((prev) => prev.map(msg => (msg.id === aiMessageId && !msg.text)
        ? { ...msg, text: '_Still waiting on the model — a cold-started free-tier endpoint can take up to a minute on its first response…_' }
        : msg));
    }, 8000);

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
            // on an explicit Draw click. A failed sync surfaces as
            // design_sync_warning below rather than blocking chat.
            if (textChunk && typeof textChunk === 'object' && typeof textChunk.design === 'string') {
              storeSyncedDesign(textChunk.design);
              continue;
            }
            // Background design sync genuinely failed this turn (slow/heavy
            // model timed out, or returned something unusable) — distinct
            // from the normal "nothing to draw yet" case, which sends no
            // event at all. Surface it quietly (console, not a blocking
            // alert) since the chat reply itself is unaffected.
            if (textChunk && typeof textChunk === 'object' && typeof textChunk.design_sync_warning === 'string') {
              console.warn(textChunk.design_sync_warning);
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
      clearTimeout(warmupNoticeTimer);
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
            {/* Provider Selection */}
            <div className="flex flex-col gap-1.5">
              <label className="text-gray-400 text-[12px] uppercase tracking-wider font-semibold flex items-center gap-1.5">
                <SlidersHorizontal size={13} className="text-blue-400" />
                <span>AI Provider</span>
              </label>
              <select
                value={llmConfig.provider}
                onChange={(e) => {
                  setLlmConfig({ ...llmConfig, provider: e.target.value, model_name: '' });
                  setUseCustomModel(false);
                  setModelCategoryFilter('all');
                  setModelSearch('');
                }}
                className="w-full bg-[#12141a] border border-[#242836] hover:border-[#353a4c] rounded-xl p-2.5 text-xs text-white outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 transition-all cursor-pointer font-medium shadow-sm"
              >
                <option value="">Fast backend default (Recommended)</option>
                <option value="ollama">Ollama (Local / Free)</option>
                <option value="openai">OpenAI (ChatGPT)</option>
                <option value="gemini">Google Gemini</option>
                <option value="anthropic">Anthropic (Claude)</option>
                <option value="nvidia">NVIDIA (GeForce NIM - 85+ Models)</option>
                <option value="openrouter">OpenRouter (460+ Models)</option>
                <option value="openai-compatible">Custom (OpenAI Compatible Endpoint)</option>
              </select>
            </div>

            {/* API Key */}
            {llmConfig.provider && llmConfig.provider !== 'ollama' && (
              <div className="flex flex-col gap-1.5">
                <label className="text-gray-400 text-[12px] uppercase tracking-wider font-semibold flex justify-between items-center">
                  <span>API Key</span>
                  <span className="text-amber-500/90 normal-case font-normal text-[11px] flex items-center gap-1">
                    <AlertTriangle size={11} /> Stored in encrypted browser storage
                  </span>
                </label>
                <input
                  type="password"
                  value={llmConfig.api_key}
                  onChange={(e) => setLlmConfig({ ...llmConfig, api_key: e.target.value })}
                  placeholder={
                    llmConfig.provider === 'openai'
                      ? 'sk-...'
                      : llmConfig.provider === 'anthropic'
                      ? 'sk-ant-...'
                      : llmConfig.provider === 'openrouter'
                      ? 'sk-or-...'
                      : llmConfig.provider === 'nvidia'
                      ? 'nvapi-...'
                      : 'Paste your API key here'
                  }
                  className="w-full bg-[#12141a] border border-[#242836] hover:border-[#353a4c] rounded-xl p-2.5 text-xs text-white placeholder-gray-500 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 font-mono transition-all shadow-sm"
                />
              </div>
            )}

            {/* Model Selection & Filter Dropdown */}
            <div className="flex flex-col gap-1.5" ref={modelDropdownRef}>
              <div className="flex items-center justify-between">
                <label className="text-gray-400 text-[12px] uppercase tracking-wider font-semibold flex items-center gap-1.5">
                  <Cpu size={13} className="text-blue-400" />
                  <span>Model Selection</span>
                  {availableModels.length > 0 && (
                    <span className="text-[11px] font-normal text-blue-400 font-mono bg-blue-500/10 px-2 py-0.5 rounded-full border border-blue-500/20">
                      {availableModels.length} ready
                    </span>
                  )}
                </label>
                {llmConfig.provider && (
                  <button
                    type="button"
                    onClick={() => fetchModels(llmConfig.provider, llmConfig.api_key, llmConfig.api_url)}
                    disabled={loadingModels}
                    className="text-[11px] text-blue-400 hover:text-blue-300 flex items-center gap-1.5 transition-all px-2 py-0.5 rounded-md hover:bg-blue-500/10 border border-transparent hover:border-blue-500/20"
                    title="Fetch all live models from provider"
                  >
                    <RefreshCcw size={11} className={loadingModels ? 'animate-spin text-blue-400' : ''} />
                    <span>{loadingModels ? 'Syncing...' : 'Sync Catalog'}</span>
                  </button>
                )}
              </div>

              {!useCustomModel ? (
                <div className="relative">
                  {/* Trigger Card */}
                  {(() => {
                    const list = availableModels.length > 0 
                      ? availableModels 
                      : (CURATED_MODELS[llmConfig.provider] || []).map(m => ({ id: m, name: m }));
                    const selectedObj = list.find(m => m.id === llmConfig.model_name);
                    const isReasoning = selectedObj ? isReasoningModel(selectedObj.id) : (llmConfig.model_name ? isReasoningModel(llmConfig.model_name) : false);
                    const famBadge = selectedObj ? getModelFamilyBadge(selectedObj.id) : (llmConfig.model_name ? getModelFamilyBadge(llmConfig.model_name) : null);

                    return (
                      <button
                        type="button"
                        onClick={() => setIsModelDropdownOpen(!isModelDropdownOpen)}
                        className={`w-full bg-gradient-to-r from-[#11131a] to-[#0c0d12] hover:from-[#151722] hover:to-[#0f1118] border ${
                          isModelDropdownOpen
                            ? 'border-blue-500 ring-2 ring-blue-500/20 shadow-[0_4px_24px_rgba(37,99,235,0.18)]'
                            : 'border-[#242836] hover:border-blue-500/40 shadow-sm'
                        } rounded-xl p-3 flex items-center justify-between text-left transition-all duration-200 group`}
                      >
                        <div className="flex items-center gap-3 min-w-0 flex-1">
                          {/* Left Icon Avatar */}
                          <div
                            className={`w-8 h-8 rounded-xl flex items-center justify-center font-bold text-xs tracking-wider shrink-0 border ${
                              !llmConfig.model_name
                                ? 'bg-gradient-to-br from-amber-500/20 to-orange-500/10 border-amber-500/30 text-amber-400 shadow-[0_0_12px_rgba(245,158,11,0.15)]'
                                : famBadge
                                ? `bg-gradient-to-br ${famBadge.color}`
                                : isReasoning
                                ? 'bg-gradient-to-br from-purple-500/20 to-indigo-500/10 border-purple-500/30 text-purple-300 shadow-[0_0_12px_rgba(168,85,247,0.15)]'
                                : selectedObj?.is_free
                                ? 'bg-gradient-to-br from-emerald-500/20 to-teal-500/10 border-emerald-500/30 text-emerald-400 shadow-[0_0_12px_rgba(16,185,129,0.15)]'
                                : 'bg-gradient-to-br from-blue-500/20 to-indigo-500/10 border-blue-500/30 text-blue-400 shadow-[0_0_12px_rgba(59,130,246,0.15)]'
                            }`}
                          >
                            {!llmConfig.model_name ? (
                              <Zap size={15} />
                            ) : famBadge ? (
                              famBadge.tag
                            ) : isReasoning ? (
                              <Brain size={15} />
                            ) : selectedObj?.is_free ? (
                              <Sparkles size={15} />
                            ) : (
                              <Cpu size={15} />
                            )}
                          </div>

                          {/* Text Details */}
                          <div className="truncate min-w-0 flex-1">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="text-[13px] font-semibold text-white tracking-tight truncate">
                                {selectedObj ? (selectedObj.name || selectedObj.id) : (llmConfig.model_name || 'Fast backend default')}
                              </span>
                              {selectedObj?.is_free && (
                                <span className="inline-flex items-center gap-1 text-[9px] uppercase font-bold tracking-wider px-2 py-0.2 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 shadow-sm">
                                  <span className="w-1 h-1 rounded-full bg-emerald-400 animate-pulse" />
                                  Free
                                </span>
                              )}
                              {isReasoning && (
                                <span className="inline-flex items-center gap-1 text-[9px] uppercase font-bold tracking-wider px-2 py-0.2 rounded-full bg-purple-500/15 text-purple-200 border border-purple-500/30 shadow-sm">
                                  Reasoning
                                </span>
                              )}
                              {!llmConfig.model_name && (
                                <span className="text-[9.5px] font-semibold text-blue-400 bg-blue-500/10 px-1.5 py-0.2 rounded border border-blue-500/20">
                                  Recommended
                                </span>
                              )}
                            </div>
                            <p className="text-[11px] font-mono text-gray-400 truncate mt-0.5">
                              {selectedObj?.id && selectedObj.id !== selectedObj.name
                                ? selectedObj.id
                                : llmConfig.model_name
                                ? llmConfig.model_name
                                : 'Auto-selects optimal low-latency model'}
                            </p>
                          </div>
                        </div>

                        {/* Right Controls */}
                        <div className="flex items-center gap-2 shrink-0 ml-2">
                          {selectedObj?.context_length && (
                            <span className="hidden sm:inline-flex items-center text-[10px] text-gray-400 font-mono bg-[#161822] px-2 py-0.5 rounded-md border border-[#272b38]">
                              {Math.round(selectedObj.context_length / 1000)}k ctx
                            </span>
                          )}
                          <div className={`w-6 h-6 rounded-lg bg-[#161822] border border-[#262a38] flex items-center justify-center text-gray-400 group-hover:text-white transition-all ${isModelDropdownOpen ? 'bg-blue-600/20 border-blue-500/40 text-blue-400' : ''}`}>
                            <ChevronDown
                              size={14}
                              className={`transition-transform duration-200 ${
                                isModelDropdownOpen ? 'rotate-180 text-blue-400' : ''
                              }`}
                            />
                          </div>
                        </div>
                      </button>
                    );
                  })()}

                  {/* Dropdown Menu Popover */}
                  {isModelDropdownOpen && (
                    <div className="absolute left-0 right-0 top-full mt-2 bg-[#0c0d12]/98 backdrop-blur-2xl border border-[#242836] rounded-2xl shadow-[0_20px_50px_rgba(0,0,0,0.85),0_0_0_1px_rgba(255,255,255,0.06)] z-50 overflow-hidden flex flex-col">
                      {/* Search Header */}
                      <div className="p-2.5 bg-[#101217] border-b border-[#1c1f2b] flex items-center gap-2">
                        <div className="relative flex-1">
                          <Search size={13} className="absolute left-2.5 top-2.5 text-gray-400" />
                          <input
                            ref={searchInputRef}
                            type="text"
                            value={modelSearch}
                            onChange={(e) => setModelSearch(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Escape') {
                                setIsModelDropdownOpen(false);
                              }
                            }}
                            placeholder="Search models by name, ID, or architecture..."
                            className="w-full bg-[#161822] border border-[#262a38] focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 rounded-xl pl-8 pr-7 py-2 text-xs text-white placeholder-gray-500 outline-none transition-all shadow-inner"
                          />
                          {modelSearch && (
                            <button
                              type="button"
                              onClick={() => setModelSearch('')}
                              className="absolute right-2 top-2 text-gray-400 hover:text-white transition-colors"
                              title="Clear search"
                            >
                              <X size={13} />
                            </button>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            setIsModelDropdownOpen(false);
                            setUseCustomModel(true);
                          }}
                          className="px-2.5 py-2 text-[11px] font-medium text-blue-400 hover:text-blue-300 bg-blue-500/10 hover:bg-blue-500/15 border border-blue-500/25 rounded-xl shrink-0 transition-colors flex items-center gap-1.5"
                          title="Type any custom model ID manually"
                        >
                          <PenTool size={11} />
                          <span>Custom ID</span>
                        </button>
                      </div>

                      {/* Filter Chips Toolbar */}
                      {(() => {
                        const list = availableModels.length > 0
                          ? availableModels
                          : (CURATED_MODELS[llmConfig.provider] || []).map((m) => ({ id: m, name: m }));
                        const freeCount = list.filter((m) => m.is_free).length;
                        const reasoningCount = list.filter((m) => isReasoningModel(m.id)).length;
                        const matchedFamilies = MODEL_FAMILIES.map((fam) => ({
                          ...fam,
                          count: list.filter((m) => fam.test((m.id || '').toLowerCase())).length,
                        })).filter((fam) => fam.count > 0);

                        return (
                          <div className="px-2.5 py-2 bg-[#0d0e14] border-b border-[#1c1f2b] flex items-center gap-1.5 overflow-x-auto no-scrollbar">
                            {/* All */}
                            <button
                              type="button"
                              onClick={() => setModelCategoryFilter('all')}
                              className={`px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all shrink-0 flex items-center gap-1.5 ${
                                modelCategoryFilter === 'all'
                                  ? 'bg-blue-600 text-white shadow-[0_2px_10px_rgba(37,99,235,0.35)] border border-blue-400/30 font-semibold'
                                  : 'bg-[#141620] hover:bg-[#1a1d28] text-gray-400 hover:text-gray-200 border border-[#232734]'
                              }`}
                            >
                              <span>All</span>
                              <span className="text-[10px] px-1.5 py-0.2 rounded-md bg-black/40 text-gray-300 font-mono">
                                {list.length}
                              </span>
                            </button>

                            {/* Free */}
                            {freeCount > 0 && (
                              <button
                                type="button"
                                onClick={() => setModelCategoryFilter('free')}
                                className={`px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all shrink-0 flex items-center gap-1.5 ${
                                  modelCategoryFilter === 'free'
                                    ? 'bg-emerald-500/25 text-emerald-300 border border-emerald-500/50 shadow-[0_2px_10px_rgba(16,185,129,0.25)] font-semibold'
                                    : 'bg-[#141620] hover:bg-[#1a1d28] text-gray-400 hover:text-emerald-300 border border-[#232734]'
                                }`}
                              >
                                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                                <span>Free</span>
                                <span className="text-[10px] px-1.5 py-0.2 rounded-md bg-black/40 text-emerald-300 font-mono">
                                  {freeCount}
                                </span>
                              </button>
                            )}

                            {/* Reasoning */}
                            {reasoningCount > 0 && (
                              <button
                                type="button"
                                onClick={() => setModelCategoryFilter('reasoning')}
                                className={`px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all shrink-0 flex items-center gap-1.5 ${
                                  modelCategoryFilter === 'reasoning'
                                    ? 'bg-purple-500/25 text-purple-200 border border-purple-500/50 shadow-[0_2px_10px_rgba(168,85,247,0.25)] font-semibold'
                                    : 'bg-[#141620] hover:bg-[#1a1d28] text-gray-400 hover:text-purple-300 border border-[#232734]'
                                }`}
                              >
                                <Brain size={12} className={modelCategoryFilter === 'reasoning' ? 'text-purple-300' : 'text-purple-400/80'} />
                                <span>Reasoning</span>
                                <span className="text-[10px] px-1.5 py-0.2 rounded-md bg-black/40 text-purple-300 font-mono">
                                  {reasoningCount}
                                </span>
                              </button>
                            )}

                            {/* Dynamic Family Filters: DeepSeek, Llama, Qwen, etc. */}
                            {matchedFamilies.map((fam) => {
                              const isActive = modelCategoryFilter === fam.id;
                              return (
                                <button
                                  key={fam.id}
                                  type="button"
                                  onClick={() => setModelCategoryFilter(fam.id)}
                                  className={`px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all shrink-0 flex items-center gap-1.5 ${
                                    isActive
                                      ? 'bg-blue-600/30 text-blue-200 border border-blue-500/50 shadow-sm font-semibold'
                                      : 'bg-[#141620] hover:bg-[#1a1d28] text-gray-400 hover:text-gray-200 border border-[#232734]'
                                  }`}
                                >
                                  <span>{fam.label}</span>
                                  <span className="text-[10px] px-1.5 py-0.2 rounded-md bg-black/40 text-gray-400 font-mono">
                                    {fam.count}
                                  </span>
                                </button>
                              );
                            })}
                          </div>
                        );
                      })()}

                      {/* Scrollable Model Items */}
                      {(() => {
                        const list = availableModels.length > 0
                          ? availableModels
                          : (CURATED_MODELS[llmConfig.provider] || []).map((m) => ({ id: m, name: m }));

                        const filtered = list.filter((m) => {
                          if (modelCategoryFilter === 'free' && !m.is_free) return false;
                          if (modelCategoryFilter === 'reasoning' && !isReasoningModel(m.id)) return false;
                          const fam = MODEL_FAMILIES.find((f) => f.id === modelCategoryFilter);
                          if (fam && !fam.test((m.id || '').toLowerCase())) return false;
                          if (!modelSearch) return true;
                          const q = modelSearch.toLowerCase().trim();
                          return (m.id && m.id.toLowerCase().includes(q)) || (m.name && m.name.toLowerCase().includes(q));
                        });

                        return (
                          <div className="max-h-72 overflow-y-auto p-2 space-y-1 custom-scrollbar">
                            {/* Fast backend default option (pinned at top when no search or in 'all') */}
                            {!modelSearch && modelCategoryFilter === 'all' && (
                              <div
                                onClick={() => {
                                  setLlmConfig({ ...llmConfig, model_name: '' });
                                  setIsModelDropdownOpen(false);
                                }}
                                className={`p-2.5 rounded-xl cursor-pointer flex items-center justify-between text-xs transition-all border ${
                                  !llmConfig.model_name
                                    ? 'bg-gradient-to-r from-blue-600/20 via-blue-500/10 to-transparent border-blue-500/40 text-white shadow-sm'
                                    : 'bg-[#12141a]/60 hover:bg-[#161924] border-[#222532] text-gray-300'
                                }`}
                              >
                                <div className="flex items-center gap-2.5 min-w-0 flex-1">
                                  <div className="w-7 h-7 rounded-lg bg-amber-500/10 border border-amber-500/30 flex items-center justify-center shrink-0">
                                    <Zap size={14} className="text-amber-400" />
                                  </div>
                                  <div className="truncate min-w-0 flex-1">
                                    <div className="font-semibold text-gray-100 flex items-center gap-1.5">
                                      <span>Fast Backend Default</span>
                                      <span className="text-[9.5px] font-semibold text-blue-400 bg-blue-500/15 px-1.5 py-0.2 rounded border border-blue-500/30">
                                        Recommended
                                      </span>
                                    </div>
                                    <p className="text-[11px] text-gray-400 truncate mt-0.5">Auto-routes to the lowest latency verified endpoint</p>
                                  </div>
                                </div>
                                {!llmConfig.model_name && (
                                  <div className="w-5 h-5 rounded-full bg-blue-500/20 border border-blue-500/40 flex items-center justify-center text-blue-400 shrink-0">
                                    <Check size={12} strokeWidth={2.5} />
                                  </div>
                                )}
                              </div>
                            )}

                            {/* Section divider & count */}
                            <div className="px-2 pt-1.5 pb-1 text-[10.5px] font-semibold uppercase tracking-wider text-gray-400 flex items-center justify-between">
                              <span className="flex items-center gap-1.5">
                                <Layers size={11} className="text-blue-400" />
                                <span>{modelCategoryFilter === 'all' ? 'Provider Catalog' : `${modelCategoryFilter.toUpperCase()} Models`}</span>
                              </span>
                              <span className="font-mono text-[10px] text-gray-400">
                                {filtered.length} {filtered.length === 1 ? 'model' : 'models'}
                              </span>
                            </div>

                            {/* Model list */}
                            {filtered.length > 0 ? (
                              filtered.slice(0, 100).map((m) => {
                                const isSelected = llmConfig.model_name === m.id;
                                const isReasoning = isReasoningModel(m.id);
                                const famBadge = getModelFamilyBadge(m.id);

                                return (
                                  <div
                                    key={m.id}
                                    onClick={() => {
                                      setLlmConfig({ ...llmConfig, model_name: m.id });
                                      setIsModelDropdownOpen(false);
                                    }}
                                    className={`p-2.5 rounded-xl cursor-pointer flex items-center justify-between text-xs transition-all duration-150 group border ${
                                      isSelected
                                        ? 'bg-gradient-to-r from-blue-600/20 via-blue-500/10 to-transparent border-blue-500/40 text-white shadow-sm'
                                        : 'hover:bg-[#141620] border-transparent hover:border-[#232735] text-gray-300'
                                    }`}
                                  >
                                    <div className="flex items-center gap-2.5 min-w-0 flex-1 pr-2">
                                      {/* Family tag / icon avatar */}
                                      <div
                                        className={`w-7 h-7 rounded-lg shrink-0 flex items-center justify-center font-bold text-[10px] tracking-wider border ${
                                          famBadge
                                            ? `bg-gradient-to-br ${famBadge.color}`
                                            : isReasoning
                                            ? 'bg-purple-500/15 text-purple-300 border-purple-500/30'
                                            : m.is_free
                                            ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
                                            : 'bg-[#171922] text-gray-400 border-[#262936]'
                                        }`}
                                      >
                                        {famBadge ? famBadge.tag : isReasoning ? <Brain size={13} /> : m.is_free ? <Sparkles size={13} /> : <Cpu size={13} />}
                                      </div>

                                      {/* Model details */}
                                      <div className="min-w-0 flex-1">
                                        <div className="flex items-center gap-1.5 flex-wrap">
                                          <span className={`font-semibold truncate text-[12.5px] ${isSelected ? 'text-blue-300' : 'text-gray-100 group-hover:text-white'}`}>
                                            {m.name || m.id}
                                          </span>
                                          {m.is_free && (
                                            <span className="inline-flex items-center gap-0.5 text-[9px] uppercase font-bold tracking-wider px-1.5 py-0.2 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                                              <span className="w-1 h-1 rounded-full bg-emerald-400" />
                                              Free
                                            </span>
                                          )}
                                          {isReasoning && (
                                            <span className="inline-flex items-center gap-0.5 text-[9px] uppercase font-bold tracking-wider px-1.5 py-0.2 rounded-full bg-purple-500/15 text-purple-300 border border-purple-500/30">
                                              Reasoning
                                            </span>
                                          )}
                                        </div>
                                        <p className="text-[10.5px] font-mono text-gray-400 truncate group-hover:text-gray-300 mt-0.5">
                                          {m.id}
                                        </p>
                                      </div>
                                    </div>

                                    {/* Right side: Context length & Selection check */}
                                    <div className="flex items-center gap-2 shrink-0">
                                      {m.context_length && (
                                        <span className="text-[10px] text-gray-400 font-mono bg-[#141620] px-1.5 py-0.5 rounded border border-[#232734]">
                                          {Math.round(m.context_length / 1000)}k ctx
                                        </span>
                                      )}
                                      {isSelected ? (
                                        <div className="w-5 h-5 rounded-full bg-blue-500/20 border border-blue-500/40 flex items-center justify-center text-blue-400">
                                          <Check size={12} strokeWidth={2.5} />
                                        </div>
                                      ) : (
                                        <div className="w-5" />
                                      )}
                                    </div>
                                  </div>
                                );
                              })
                            ) : (
                              <div className="py-8 px-4 text-center border border-dashed border-[#232734] rounded-xl my-2 bg-[#0e1015]/60">
                                <div className="w-10 h-10 rounded-full bg-[#181a24] border border-[#272b38] flex items-center justify-center mx-auto mb-2.5 text-gray-400">
                                  <Search size={18} />
                                </div>
                                <p className="text-xs text-gray-200 font-medium">No models found</p>
                                <p className="text-[11px] text-gray-400 mt-0.5 max-w-[240px] mx-auto">
                                  No models match &ldquo;{modelSearch}&rdquo; in {modelCategoryFilter === 'all' ? 'the catalog' : `${modelCategoryFilter} category`}.
                                </p>
                                <div className="mt-3 flex flex-col gap-1.5 items-center">
                                  {modelSearch && (
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setLlmConfig({ ...llmConfig, model_name: modelSearch.trim() });
                                        setIsModelDropdownOpen(false);
                                      }}
                                      className="px-3 py-1.5 text-[11px] font-medium text-blue-300 bg-blue-500/15 hover:bg-blue-500/25 border border-blue-500/30 rounded-lg flex items-center gap-1.5 transition-all shadow-sm"
                                    >
                                      <span>Use &ldquo;{modelSearch}&rdquo; as custom model ID</span>
                                      <ArrowRight size={12} />
                                    </button>
                                  )}
                                  {(modelCategoryFilter !== 'all' || modelSearch) && (
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setModelCategoryFilter('all');
                                        setModelSearch('');
                                      }}
                                      className="text-[11px] text-gray-400 hover:text-gray-200 underline mt-1"
                                    >
                                      Clear search & filters
                                    </button>
                                  )}
                                </div>
                              </div>
                            )}

                            {filtered.length > 100 && (
                              <div className="py-2.5 text-center text-[10.5px] text-gray-400 font-mono border-t border-[#1c1f2b] mt-1">
                                Showing top 100 of {filtered.length} models — type above to search all models instantly
                              </div>
                            )}
                          </div>
                        );
                      })()}

                      {/* Dropdown Footer */}
                      <div className="p-2.5 border-t border-[#1c1f2b] bg-[#0c0d12] flex items-center justify-between text-[11px]">
                        <div className="flex items-center gap-1.5 text-gray-400">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                          <span>
                            {availableModels.length > 0
                              ? `${availableModels.length} models synced`
                              : 'Curated provider models'}
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            setIsModelDropdownOpen(false);
                            setUseCustomModel(true);
                          }}
                          className="text-blue-400 hover:text-blue-300 font-medium flex items-center gap-1 hover:underline transition-all"
                        >
                          <span>Enter ID manually</span>
                          <ArrowRight size={11} />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                /* Custom Model ID Entry Mode */
                <div className="flex flex-col gap-2 p-3 rounded-xl bg-gradient-to-r from-[#11131a] to-[#0c0d12] border border-[#242836]">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-semibold text-gray-300 flex items-center gap-1.5">
                      <PenTool size={12} className="text-blue-400" />
                      <span>Custom Model Identifier</span>
                    </span>
                    {llmConfig.model_name && (
                      <span className="text-emerald-400 font-mono text-[10px] bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20 flex items-center gap-1">
                        <span className="w-1 h-1 rounded-full bg-emerald-400" />
                        Active
                      </span>
                    )}
                  </div>
                  <div className="relative">
                    <input
                      type="text"
                      value={llmConfig.model_name}
                      onChange={(e) => setLlmConfig({ ...llmConfig, model_name: e.target.value })}
                      placeholder={
                        llmConfig.provider === 'openai'
                          ? 'e.g. gpt-4o-mini'
                          : llmConfig.provider === 'gemini'
                          ? 'e.g. gemini-1.5-flash'
                          : llmConfig.provider === 'anthropic'
                          ? 'e.g. claude-3-haiku-20240307'
                          : llmConfig.provider === 'nvidia'
                          ? 'e.g. nvidia/nemotron-3.5-lightning-30b-a3b'
                          : llmConfig.provider === 'openrouter'
                          ? 'e.g. deepseek/deepseek-r1:free'
                          : llmConfig.provider === 'ollama'
                          ? 'e.g. llama3.2:1b'
                          : 'e.g. provider/model-id'
                      }
                      className="w-full bg-[#161822] border border-[#2a2e3d] rounded-lg p-2.5 text-xs text-white placeholder-gray-500 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 font-mono transition-all shadow-inner"
                    />
                  </div>
                  <div className="flex justify-between items-center text-[11px] pt-1">
                    <button
                      type="button"
                      onClick={() => setUseCustomModel(false)}
                      className="text-blue-400 hover:text-blue-300 font-medium flex items-center gap-1 transition-colors"
                    >
                      <span>← Back to {availableModels.length > 0 ? `${availableModels.length} models` : 'catalog'}</span>
                    </button>
                    <span className="text-[10px] text-gray-500">
                      Supports any provider model ID
                    </span>
                  </div>
                </div>
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

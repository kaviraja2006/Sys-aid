import { useState, useEffect, useRef, memo, useMemo } from 'react';
import { Send, Bot, User, Sparkles, RefreshCcw, ChevronLeft, ChevronRight, History, X, PenTool, Settings, Trash2, Search, CheckCircle, AlertTriangle } from 'lucide-react';
import { api, API_URL } from './config/api';
import { secureGet, secureSet } from './utils/secureStorage';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';

// Memoized message bubble — only re-renders when the message text changes
// This prevents all previous messages from re-rendering during streaming
const ChatMessage = memo(({ msg, isStreaming }) => {
  const mdComponents = useMemo(() => ({
    code({ node, inline, className, children, ...props }) {
      const match = /language-(\w+)/.exec(className || '');
      return !inline && match ? (
        <SyntaxHighlighter style={vscDarkPlus} language={match[1]} PreTag="div" {...props}>
          {String(children).replace(/\n$/, '')}
        </SyntaxHighlighter>
      ) : (
        <code className="bg-[#2c2d31] px-1 py-0.5 rounded text-blue-300" {...props}>{children}</code>
      );
    }
  }), []);

  return (
    <div className={`flex gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : 'flex-row'}`}>
      <div className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center border shadow-sm ${msg.role === 'user' ? 'bg-blue-600/20 border-blue-500/30 text-blue-400' : 'bg-[#1a1b1e] border-[#2c2d31] text-gray-300'}`}>
        {msg.role === 'user' ? <User size={14} /> : <Bot size={14} />}
      </div>
      <div className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'} max-w-[85%]`}>
        <div className={`px-4 py-3 rounded-2xl text-[13px] xl:text-[14px] leading-relaxed shadow-sm w-full markdown-body ${msg.role === 'user' ? 'bg-blue-600 text-white rounded-tr-[4px]' : 'bg-[#151618] border border-[#232427] text-gray-200 rounded-tl-[4px]'}`}>
          {msg.text ? (
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
              {msg.text}
            </ReactMarkdown>
          ) : (
            isStreaming && msg.role === 'ai' && (
              <span className="flex gap-1 items-center text-gray-500">
                <span className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-bounce" style={{animationDelay:'0ms'}}/>
                <span className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-bounce" style={{animationDelay:'150ms'}}/>
                <span className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-bounce" style={{animationDelay:'300ms'}}/>
              </span>
            )
          )}
        </div>
      </div>
    </div>
  );
});
ChatMessage.displayName = 'ChatMessage';

const initialMessage = {
  id: 1,
  role: 'ai',
  text: 'Hello! I am your AI architect. Describe the software system you would like to design today. We can brainstorm, and when you are ready, click "Draw Board" below!'
};

const generateSessionId = () => Math.random().toString(36).substr(2, 9) + Date.now().toString(36);

let _msgCounter = 100;
const nextId = () => ++_msgCounter;
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

  // Load the encrypted config once on mount. Loading is async (Web Crypto /
  // IndexedDB), so the settings form briefly shows defaults until this resolves.
  useEffect(() => {
    let cancelled = false;
    secureGet('sysaid_llm_config').then((saved) => {
      if (cancelled) return;
      llmConfigLoaded.current = true;
      if (saved) setLlmConfig(normalizeSavedLlmConfig(saved));
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

    if (messages.length === 1) setSessionTitle(generateTitle(textToSend));

    const userMsgId = nextId();
    const aiMessageId = nextId();
    setMessages((prev) => [...prev, { id: userMsgId, role: 'user', text: textToSend }, { id: aiMessageId, role: 'ai', text: '' }]);
    setInputValue('');
    setLoading(true);

    try {
      const payload = {
        prompt: textToSend,
        chat_history: getChatHistory(),
        ...llmConfig
      };

      const response = await fetch(`${API_URL}/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': import.meta.env.VITE_BACKEND_API_KEY || ''
        },
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
    }
  };

  const drawBoard = async () => {
    if (loading || drawing) return;
    setDrawing(true);

    try {
      const payload = {
        prompt: "Draw the final confirmed board logic based on our chat history.",
        current_design: stripGraphData(currentNodes, currentEdges),
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
        body: JSON.stringify(payload)
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      onGenerationStart?.();
      onGenerationProgress?.(0);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullJson = '';
      let finalJson = null;
      let lineBuffer = '';
      let tokenCount = 0;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        lineBuffer += decoder.decode(value, { stream: true });
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop(); // keep incomplete line buffered

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (!data) continue;

          if (data === '[DONE]') {
            break;
          }

          if (data.startsWith('{') || data.startsWith('"')) {
            let parsedData;
            try {
              parsedData = JSON.parse(data);
            } catch (e) {
              parsedData = data;
            }

            if (parsedData && typeof parsedData === 'object' && parsedData.error) {
              console.error('Graph generation error:', parsedData.error);
              alert(`Draw failed: ${parsedData.error}`);
              return;
            }

            if (parsedData && typeof parsedData === 'object' && typeof parsedData.final === 'string') {
              // Server-repaired canonical JSON — replaces the accumulated buffer,
              // it does not get appended (it already contains everything so far).
              finalJson = parsedData.final;
            } else {
              fullJson += typeof parsedData === 'string' ? parsedData : String(parsedData);
            }
          } else {
            fullJson += data;
          }
          tokenCount += 1;
          onGenerationProgress?.(tokenCount);
        }
      }

      if (lineBuffer) {
        const remaining = lineBuffer.trim();
        if (remaining.startsWith('data: ')) {
          const data = remaining.slice(6).trim();
          if (data && data !== '[DONE]') {
            if (data.startsWith('{') || data.startsWith('"')) {
              let parsedData;
              try { parsedData = JSON.parse(data); } catch (e) { parsedData = data; }
              if (parsedData && typeof parsedData === 'object' && parsedData.error) {
                console.error('Graph generation error:', parsedData.error);
                alert(`Draw failed: ${parsedData.error}`);
                return;
              }
              if (parsedData && typeof parsedData === 'object' && typeof parsedData.final === 'string') {
                finalJson = parsedData.final;
              } else {
                fullJson += typeof parsedData === 'string' ? parsedData : String(parsedData);
              }
            } else {
              fullJson += data;
            }
          }
        }
      }

      if (finalJson !== null) fullJson = finalJson;

      const extractJson = (text) => {
        let s = text.replace(/```json/gi, '').replace(/```/g, '').trim();
        s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

        let inString = false;
        let escape = false;
        let depth = 0;
        let start = -1;
        let lastObject = '';

        for (let i = 0; i < s.length; i += 1) {
          const ch = s[i];
          if (escape) {
            escape = false;
            continue;
          }
          if (ch === '\\') {
            if (inString) escape = true;
            continue;
          }
          if (ch === '"') {
            inString = !inString;
            continue;
          }
          if (inString) continue;

          if (ch === '{') {
            if (depth === 0) start = i;
            depth += 1;
          } else if (ch === '}') {
            if (depth > 0) {
              depth -= 1;
              if (depth === 0 && start !== -1) {
                lastObject = s.slice(start, i + 1);
                start = -1;
              }
            }
          }
        }

        if (lastObject) {
          return lastObject;
        }

        const firstStart = s.indexOf('{');
        const lastEnd = s.lastIndexOf('}');
        if (firstStart !== -1 && lastEnd !== -1 && lastEnd > firstStart) {
          return s.slice(firstStart, lastEnd + 1);
        }

        return s;
      };

      const cleanedJson = extractJson(fullJson);
      if (cleanedJson.startsWith('{')) {
        try {
          const parsed = JSON.parse(cleanedJson);
          if (parsed && Array.isArray(parsed.nodes)) {
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
            onGraphUpdate(safeNodes, safeEdges);
            // Save immediately — don't rely on the 5s debounce, which can be
            // cancelled if the user switches chats right after drawing.
            if (saveTimeout.current) clearTimeout(saveTimeout.current);
            persistSession({ nodes: safeNodes, edges: safeEdges });
          } else {
            throw new Error('Payload did not contain nodes array');
          }
        } catch (err) {
          console.error('JSON parse failed:', err, cleanedJson.slice(0, 200));
          alert('Draw failed: generated output was not valid graph JSON. See console for details.');
        }
      } else if (fullJson.includes('[Error:')) {
        console.error('Graph generation error:', fullJson);
        alert(`Draw failed: ${fullJson.trim()}`);
      } else {
        console.error('Graph generation returned non-JSON output:', fullJson);
        alert('Draw failed: generated output was not valid JSON.');
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
    try {
      const res = await api.post('/health/llm', llmConfig, { timeout: 9000 });
      if (res.data?.status !== 'ok') {
        throw new Error(res.data?.message || 'Connection failed');
      }
      setTestStatus('success');
      setTestMessage('Connection OK');
    } catch (e) {
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
              <select value={llmConfig.provider} onChange={(e) => setLlmConfig({ ...llmConfig, provider: e.target.value, model_name: '' })} className="bg-[#111215] border border-[#2c2d31] rounded-lg p-2 outline-none focus:border-blue-500">
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
              <input type="text" value={llmConfig.model_name} onChange={(e) => setLlmConfig({ ...llmConfig, model_name: e.target.value })} placeholder={llmConfig.provider === 'openai' ? 'gpt-4o-mini' : llmConfig.provider === 'gemini' ? 'gemini-1.5-flash' : llmConfig.provider === 'anthropic' ? 'claude-3-haiku-20240307' : llmConfig.provider === 'nvidia' ? 'meta/llama-3.1-8b-instruct' : llmConfig.provider === 'ollama' ? 'llama3.2:1b' : 'Backend default'} className="bg-[#111215] border border-[#2c2d31] rounded-lg p-2 outline-none focus:border-blue-500" />
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
              <p className={`text-xs leading-relaxed ${testStatus === 'error' ? 'text-red-300' : 'text-emerald-300'}`}>
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
      <div className="p-4 xl:p-5 border-b border-[#1f2023] flex flex-col bg-gradient-to-b from-[#111112] to-transparent shrink-0 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-sm xl:text-[15px] flex items-center gap-2 text-white truncate">
            <div className="bg-blue-500/10 p-1.5 rounded-lg border border-blue-500/20"><Sparkles size={16} className="text-blue-400" /></div>
            SysAid Architect
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
        {messages.map((msg) => (
          <ChatMessage key={msg.id} msg={msg} isStreaming={loading} />
        ))}

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

        <form onSubmit={handleSend} className="relative flex items-center">
          <textarea
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
            placeholder="Discuss architecture... (Ctrl+Enter to Draw Board)"
            disabled={loading || drawing}
            rows="1"
            style={{ resize: 'none' }}
            className="w-full bg-[#151618] border border-[#2c2d31] focus:border-blue-500/50 rounded-xl py-3 pl-4 pr-12 text-[13px] text-gray-200 placeholder-gray-500 shadow-inner disabled:opacity-50 outline-none custom-scrollbar"
          />
          <button type="submit" disabled={!inputValue.trim() || loading || drawing} className="absolute right-1.5 p-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-40 transition-all"><Send size={14} className="ml-0.5" /></button>
        </form>
      </div>

    </div>
  );
}

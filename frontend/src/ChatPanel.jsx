import { useState, useEffect, useRef } from 'react';
import { Send, Bot, User, Sparkles, RefreshCcw, ChevronLeft, ChevronRight, History, X, PenTool, Settings } from 'lucide-react';
import axios from 'axios';

const initialMessage = {
  id: 1,
  role: 'ai',
  text: 'Hello! I am your AI architect. Describe the software system you would like to design today. We can brainstorm, and when you are ready, click "Draw Board" below!'
};

const generateSessionId = () => Math.random().toString(36).substr(2, 9) + Date.now().toString(36);

// Monotonic counter — guaranteed unique, avoids duplicate-key React warnings
let _msgCounter = 100;
const nextId = () => ++_msgCounter;

export default function ChatPanel({ onGraphUpdate, onReset, currentNodes, currentEdges }) {
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

  // LLM Settings
  const [showSettings, setShowSettings] = useState(false);
  const [llmConfig, setLlmConfig] = useState(() => {
    const saved = localStorage.getItem('sysaid_llm_config');
    return saved ? JSON.parse(saved) : { provider: 'ollama', api_key: '', model_name: '', api_url: '' };
  });

  // Save settings automatically
  useEffect(() => {
    localStorage.setItem('sysaid_llm_config', JSON.stringify(llmConfig));
  }, [llmConfig]);

  // Auto-Save ref
  const saveTimeout = useRef(null);
  const messagesEndRef = useRef(null);

  // Auto scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading, drawing]);

  const stripGraphData = (nodes, edges) => ({
    nodes: nodes.map(n => ({ id: n.id, data: n.data, type: n.type, position: n.position || { x: 0, y: 0 } })),
    edges: edges.map(e => ({ id: e.id, source: e.source, target: e.target }))
  });

  // Auto-save session debounced
  useEffect(() => {
    if (messages.length <= 1) return;
    if (saveTimeout.current) clearTimeout(saveTimeout.current);
    saveTimeout.current = setTimeout(async () => {
      try {
        await axios.post('http://127.0.0.1:8000/chats/', {
          id: sessionId,
          title: sessionTitle,
          updated_at: new Date().toISOString(),
          messages,
          nodes: currentNodes,
          edges: currentEdges
        });
      } catch (err) {
        console.error("Failed to save", err);
      }
    }, 2000);
    return () => clearTimeout(saveTimeout.current);
  }, [messages, currentNodes, currentEdges, sessionId, sessionTitle]);

  const loadHistoryList = async () => {
    const res = await axios.get('http://127.0.0.1:8000/chats/');
    setHistoryList(res.data);
  };

  const handleLoadSession = async (id) => {
    const res = await axios.get(`http://127.0.0.1:8000/chats/${id}`);
    setSessionId(res.data.id);
    setSessionTitle(res.data.title);
    setMessages(res.data.messages);
    onGraphUpdate(res.data.nodes || [], res.data.edges || []);
    setShowHistory(false);
  };

  const handleResetChat = () => {
    setSessionId(generateSessionId());
    setSessionTitle('New Architecture');
    setMessages([initialMessage]);
    onReset();
  };

  // Keep at most 6 turns — matches backend WINDOW_SIZE to avoid sending extra tokens
  const getChatHistory = () => messages.filter(m => m.id !== 1).slice(-6).map(m => ({ role: m.role, text: m.text }));

  const handleSend = async (e) => {
    e.preventDefault();
    if (!inputValue.trim() || loading || drawing) return;

    const userText = inputValue;
    if (messages.length === 1) setSessionTitle(userText.slice(0, 30) + '...');

    const userMsgId = nextId();
    const aiMessageId = nextId();
    setMessages((prev) => [...prev, { id: userMsgId, role: 'user', text: userText }, { id: aiMessageId, role: 'ai', text: '' }]);
    setInputValue('');
    setLoading(true);

    try {
      const payload = {
        prompt: userText,
        chat_history: getChatHistory(),
        ...llmConfig
      };

      const response = await fetch('http://127.0.0.1:8000/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(errText || response.statusText);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let aiText = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        aiText += decoder.decode(value, { stream: true });

        setMessages((prev) => prev.map(msg =>
          msg.id === aiMessageId ? { ...msg, text: aiText } : msg
        ));
      }

    } catch (error) {
      setMessages((prev) => [...prev, { id: nextId(), role: 'ai', text: `Error processing stream: ${error.message}` }]);
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
        chat_history: getChatHistory(),
        ...llmConfig
      };

      const response = await axios.post('http://127.0.0.1:8000/generate-board', payload);
      if (response.data.error) throw new Error(response.data.error);
      if (response.data.nodes && response.data.edges) {
        onGraphUpdate(response.data.nodes, response.data.edges);
      }
    } catch (error) {
      alert(`Draw failed: ${error.response?.data?.error || error.message}`);
    } finally {
      setDrawing(false);
    }
  };

  // Resize Handlers
  useEffect(() => {
    const handleMouseMove = (e) => isResizing && !isCollapsed && setWidth(Math.max(300, Math.min(e.clientX, 800)));
    const handleMouseUp = () => isResizing && setIsResizing(false);
    if (isResizing) { document.addEventListener('mousemove', handleMouseMove); document.addEventListener('mouseup', handleMouseUp); }
    return () => { document.removeEventListener('mousemove', handleMouseMove); document.removeEventListener('mouseup', handleMouseUp); };
  }, [isResizing, isCollapsed]);

  if (isCollapsed) return (
    <div className="h-full bg-[#050505] border-r border-[#1f2023] z-10 flex flex-col items-center py-4 w-12 transition-all shadow-xl">
      <button onClick={() => setIsCollapsed(false)} className="p-2 mb-4 rounded-xl bg-blue-600/20 text-blue-400 hover:bg-blue-600/40"><ChevronRight size={18} /></button>
    </div>
  );

  return (
    <div style={{ width: `${width}px` }} className="h-full flex flex-col bg-[#050505] border-r border-[#1f2023] z-10 font-sans shadow-2xl relative select-none">
      <div className="absolute top-0 right-0 w-1.5 h-full cursor-col-resize hover:bg-blue-500/50 active:bg-blue-500 z-20" onMouseDown={() => setIsResizing(true)} />

      {/* History Menu */}
      {showHistory && (
        <div className="absolute inset-0 bg-[#050505]/95 backdrop-blur-sm z-30 flex flex-col pt-5 px-4 pb-4 overflow-hidden border-r border-[#1f2023]">
          <div className="flex justify-between items-center mb-6">
            <h3 className="text-white font-semibold flex items-center gap-2"><History size={16} className="text-blue-400" /> Past Sessions</h3>
            <button onClick={() => setShowHistory(false)} className="p-1 hover:bg-[#1f2023] rounded-lg text-gray-400"><X size={18} /></button>
          </div>
          <div className="flex-1 overflow-y-auto space-y-2 custom-scrollbar">
            {historyList.length === 0 && <p className="text-sm text-gray-500">No saved sessions yet.</p>}
            {historyList.map(session => (
              <div key={session.id} onClick={() => handleLoadSession(session.id)} className="p-3 rounded-xl border cursor-pointer border-[#1f2023] hover:border-blue-500/30 bg-[#111215] hover:bg-[#15161A]">
                <h4 className="text-sm font-medium text-gray-200 truncate">{session.title}</h4>
                <p className="text-[11px] text-gray-500 mt-1">{new Date(session.updated_at).toLocaleString()}</p>
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
              <select value={llmConfig.provider} onChange={(e) => setLlmConfig({ ...llmConfig, provider: e.target.value })} className="bg-[#111215] border border-[#2c2d31] rounded-lg p-2 outline-none focus:border-blue-500">
                <option value="ollama">Ollama (Local / Free)</option>
                <option value="openai">OpenAI (ChatGPT)</option>
                <option value="gemini">Google Gemini</option>
                <option value="anthropic">Anthropic (Claude)</option>
                <option value="nvidia">NVIDIA (GeForce NIM)</option>
                <option value="openai-compatible">Custom (OpenAI Compatible)</option>
              </select>
            </div>
            {llmConfig.provider !== 'ollama' && (
              <div className="flex flex-col gap-1.5">
                <label className="text-gray-400 text-[12px] uppercase tracking-wider font-semibold">API Key</label>
                <input type="password" value={llmConfig.api_key} onChange={(e) => setLlmConfig({ ...llmConfig, api_key: e.target.value })} placeholder={llmConfig.provider === 'openai' ? 'sk-...' : (llmConfig.provider === 'anthropic' ? 'sk-ant-...' : 'Your API Key')} className="bg-[#111215] border border-[#2c2d31] rounded-lg p-2 outline-none focus:border-blue-500" />
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              <label className="text-gray-400 text-[12px] uppercase tracking-wider font-semibold">Model Name {llmConfig.provider === 'ollama' && '(e.g. llama3)'}</label>
              <input type="text" value={llmConfig.model_name} onChange={(e) => setLlmConfig({ ...llmConfig, model_name: e.target.value })} placeholder={llmConfig.provider === 'openai' ? 'gpt-4o' : llmConfig.provider === 'gemini' ? 'gemini-1.5-pro' : llmConfig.provider === 'anthropic' ? 'claude-3-5-sonnet-20240620' : llmConfig.provider === 'nvidia' ? 'meta/llama-3.1-405b-instruct' : 'llama3'} className="bg-[#111215] border border-[#2c2d31] rounded-lg p-2 outline-none focus:border-blue-500" />
            </div>
            {(llmConfig.provider === 'openai-compatible' || llmConfig.provider === 'ollama') && (
              <div className="flex flex-col gap-1.5">
                <label className="text-gray-400 text-[12px] uppercase tracking-wider font-semibold">Custom AI URL</label>
                <input type="text" value={llmConfig.api_url} onChange={(e) => setLlmConfig({ ...llmConfig, api_url: e.target.value })} placeholder={llmConfig.provider === 'ollama' ? 'http://localhost:11434/api/generate' : 'https://api.groq.com/openai/v1/chat/completions'} className="bg-[#111215] border border-[#2c2d31] rounded-lg p-2 outline-none focus:border-blue-500" />
              </div>
            )}
            <div className="mt-6 border border-emerald-500/20 bg-emerald-500/5 text-emerald-400 p-3 rounded-lg text-xs leading-relaxed">
              These API keys are saved securely and locally to your current browser window via `localStorage`. They are never stored in the project codebase.
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
      <div className="flex-1 overflow-y-auto p-4 xl:p-5 space-y-6 custom-scrollbar bg-[url('https://www.transparenttextures.com/patterns/cubes.png')] bg-opacity-20 bg-fixed select-text">
        {messages.map((msg) => (
          <div key={msg.id} className={`flex gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : 'flex-row'}`}>
            <div className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center border shadow-sm ${msg.role === 'user' ? 'bg-blue-600/20 border-blue-500/30 text-blue-400' : 'bg-[#1a1b1e] border-[#2c2d31] text-gray-300'}`}>
              {msg.role === 'user' ? <User size={14} /> : <Bot size={14} />}
            </div>
            <div className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
              <div className={`px-4 py-3 rounded-2xl max-w-[90%] text-[13px] xl:text-[14px] leading-relaxed shadow-sm whitespace-pre-wrap ${msg.role === 'user' ? 'bg-blue-600 text-white rounded-tr-[4px]' : 'bg-[#151618] border border-[#232427] text-gray-200 rounded-tl-[4px]'}`}>
                {msg.text || (loading && msg.role === 'ai' && <span className="animate-pulse text-gray-500">Thinking...</span>)}
              </div>
            </div>
          </div>
        ))}
        {/* Loading skeleton removed since we inject empty AI models into the queue immediately for streaming */}
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
          <input type="text" value={inputValue} onChange={(e) => setInputValue(e.target.value)} placeholder="Discuss architecture..." disabled={loading || drawing} className="w-full bg-[#151618] border border-[#2c2d31] focus:border-blue-500/50 rounded-xl py-3 pl-4 pr-12 text-[13px] text-gray-200 placeholder-gray-500 shadow-inner disabled:opacity-50 outline-none" />
          <button type="submit" disabled={!inputValue.trim() || loading || drawing} className="absolute right-1.5 p-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-40 transition-all"><Send size={14} className="ml-0.5" /></button>
        </form>
      </div>

    </div>
  );
}

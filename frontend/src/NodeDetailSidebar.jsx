import { useState, useCallback } from 'react';
import { X, Loader } from 'lucide-react';
import { API_URL } from './config/api';

const annotationTypeMap = {
  risk: { icon: '🔴', label: 'Risk', color: 'bg-red-500/20 text-red-400 border-red-500/30' },
  decision: { icon: '🟡', label: 'Decision', color: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30' },
  note: { icon: '🔵', label: 'Note', color: 'bg-blue-500/20 text-blue-400 border-blue-500/30' },
  todo: { icon: '🟢', label: 'Todo', color: 'bg-green-500/20 text-green-400 border-green-500/30' }
};

const systemTypeColors = {
  database: 'bg-emerald-500/20 text-emerald-400',
  server: 'bg-blue-500/20 text-blue-400',
  client: 'bg-indigo-500/20 text-indigo-400',
  cloud: 'bg-sky-500/20 text-sky-400',
  cache: 'bg-amber-500/20 text-amber-400',
  default: 'bg-gray-500/20 text-gray-400'
};

export default function NodeDetailSidebar({ node, isOpen, onClose, llmConfig }) {
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisResult, setAnalysisResult] = useState(null);

  const handleAnalyze = useCallback(async () => {
    if (!node) return;
    setAnalysisLoading(true);
    try {
      const payload = {
        prompt: `Analyze this architecture component and provide a brief technical analysis.\n\nComponent:\nName: ${node.data?.label || 'Unknown'}\nType: ${node.data?.systemType || 'default'}\nDescription: ${node.data?.description || 'No description'}`,
        chat_history: [],
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

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullText = '';
      let lineBuffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        lineBuffer += decoder.decode(value, { stream: true });
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop();

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (!data || data === '[DONE]') continue;
          
          try {
            const chunk = JSON.parse(data);
            fullText += chunk;
          } catch (e) {
            fullText += data;
          }
        }
      }

      setAnalysisResult(fullText);
    } catch (err) {
      console.error('Analysis failed:', err);
      setAnalysisResult('Failed to analyze component. Please try again.');
    } finally {
      setAnalysisLoading(false);
    }
  }, [node, llmConfig]);

  if (!isOpen || !node) return null;

  const annotations = node.data?.annotations || [];
  const systemType = node.data?.systemType || 'default';
  const typeColor = systemTypeColors[systemType] || systemTypeColors.default;

  return (
    <div className="fixed right-0 top-0 h-full w-80 bg-[#050505] border-l border-[#1f2023] shadow-2xl z-40 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex justify-between items-center p-4 border-b border-[#1f2023]">
        <h2 className="text-sm font-semibold text-gray-100">Node Details</h2>
        <button
          onClick={onClose}
          className="p-1 hover:bg-[#1f2023] rounded text-gray-400 hover:text-gray-200 transition-colors"
        >
          <X size={18} />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto custom-scrollbar">
        <div className="p-4 space-y-4">
          {/* Node Info */}
          <div>
            <h3 className="text-xs font-semibold text-gray-400 uppercase mb-2">Label</h3>
            <div className="text-sm font-medium text-gray-200">{node.data?.label || 'Unknown'}</div>
          </div>

          <div>
            <h3 className="text-xs font-semibold text-gray-400 uppercase mb-2">Type</h3>
            <div className={`inline-block px-2 py-1 rounded text-xs font-medium ${typeColor}`}>
              {systemType.charAt(0).toUpperCase() + systemType.slice(1)}
            </div>
          </div>

          {node.data?.description && (
            <div>
              <h3 className="text-xs font-semibold text-gray-400 uppercase mb-2">Description</h3>
              <div className="text-xs text-gray-300 leading-relaxed">{node.data.description}</div>
            </div>
          )}

          {/* Annotations */}
          {annotations.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold text-gray-400 uppercase mb-2">Annotations</h3>
              <div className="space-y-2">
                {annotations.map((ann) => {
                  const annType = annotationTypeMap[ann.type];
                  return (
                    <div
                      key={ann.id}
                      className={`p-2 rounded border text-xs text-gray-300 ${annType.color}`}
                    >
                      <div className="font-medium mb-1 flex items-center gap-1">
                        <span>{annType.icon}</span>
                        <span>{annType.label}</span>
                      </div>
                      <div>{ann.text}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Analysis */}
          <div>
            <h3 className="text-xs font-semibold text-gray-400 uppercase mb-2">LLM Analysis</h3>
            {analysisResult ? (
              <div className="bg-[#1a1b1e] border border-[#2c2d31] rounded p-2 text-xs text-gray-300 leading-relaxed max-h-48 overflow-auto custom-scrollbar">
                {analysisResult}
              </div>
            ) : (
              <button
                onClick={handleAnalyze}
                disabled={analysisLoading}
                className="w-full py-2 px-3 bg-blue-600/20 hover:bg-blue-600/30 text-blue-400 border border-blue-500/30 rounded text-xs font-medium transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {analysisLoading ? (
                  <>
                    <Loader size={12} className="animate-spin" />
                    Analyzing...
                  </>
                ) : (
                  'Get LLM Analysis'
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

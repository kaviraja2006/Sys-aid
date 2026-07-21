import { useCallback, useMemo, useRef, memo, useState } from 'react';
import {
  ReactFlow,
  MiniMap,
  Controls,
  Background,
  addEdge,
  Panel,
  reconnectEdge,
  useReactFlow,
  getNodesBounds,
  getViewportForBounds
} from '@xyflow/react';
import { LayoutGrid, Download, Plus, RefreshCcw, Copy, CheckCircle, Sparkles, Loader } from 'lucide-react';
import { toPng } from 'html-to-image';
import '@xyflow/react/dist/style.css';
import ArchitectureNode from './ArchitectureNode';
import { templates } from './templates';
import { copyMermaidToClipboard } from './utils/mermaidExport';
import ReviewPanel from './ReviewPanel';
import { api } from './config/api';

function GraphBoard({ nodes, edges, onNodesChange, onEdgesChange, setEdges, onAutoLayout, onGraphUpdate, isGenerating, genTokens, onNodeSelect, llmConfig }) {

  const [mermaidCopyStatus, setMermaidCopyStatus] = useState(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewData, setReviewData] = useState(null);
  const nodeTypes = useMemo(() => ({ archNode: ArchitectureNode }), []);

  // Connect handler for manual lines drawn natively by React Flow
  const onConnect = useCallback(
    (params) => setEdges((eds) => addEdge({ ...params, type: 'smoothstep', style: { stroke: '#4B5563', strokeWidth: 2 }, animated: true }, eds)),
    [setEdges],
  );

  // Reconnect handler for rewiring edges manually
  const onReconnect = useCallback(
    (oldEdge, newConnection) => setEdges((els) => reconnectEdge(oldEdge, newConnection, els)),
    [setEdges],
  );

  const reactFlowWrapper = useRef(null);
  const { screenToFlowPosition } = useReactFlow();

  const handleExport = useCallback(() => {
    if (nodes.length === 0) return;
    const viewportElement = document.querySelector('.react-flow__viewport');
    if (!viewportElement) return;

    // Calculate the bounding box of all nodes
    const bounds = getNodesBounds(nodes);
    const width = bounds.width + 100; // Add padding
    const height = bounds.height + 100;

    // Get the viewport coordinates required to show the bounds
    const viewport = getViewportForBounds(bounds, width, height, 0.5, 2, 0.1);

    toPng(viewportElement, {
      backgroundColor: '#0B0C0E',
      width: width,
      height: height,
      style: {
        width: `${width}px`,
        height: `${height}px`,
        transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
      },
    }).then((dataUrl) => {
      const a = document.createElement('a');
      a.setAttribute('download', 'architecture.png');
      a.setAttribute('href', dataUrl);
      a.click();
    });
  }, [nodes]);

  const handleMermaidExport = useCallback(async () => {
    if (nodes.length === 0) return;
    const result = await copyMermaidToClipboard(nodes, edges);
    setMermaidCopyStatus(result.success ? 'success' : 'error');
    setTimeout(() => setMermaidCopyStatus(null), 2000);
  }, [nodes, edges]);

  const handleNodeClick = useCallback((event, node) => {
    onNodeSelect?.(node);
  }, [onNodeSelect]);

  const handleReviewArchitecture = useCallback(async () => {
    if (nodes.length === 0) return;
    setReviewLoading(true);
    try {
      const response = await api.post('/review', {
        current_design: { nodes, edges },
        prompt: '',
        ...(llmConfig || {})
      });
      setReviewData(response.data);
      setReviewOpen(true);
    } catch (error) {
      console.error('Review failed:', error);
      alert('Failed to review architecture. Please try again.');
    } finally {
      setReviewLoading(false);
    }
  }, [nodes, edges, llmConfig]);

  const addManualNode = (type) => {
    const newNode = {
      id: `manual_${Date.now()}`,
      type: 'archNode',
      position: { x: 100, y: 100 }, // Defaults, user can drag
      data: { label: `New ${type}`, systemType: type, description: 'Double click to edit' },
      style: { background: '#151618', color: '#EDEEF0', border: '1px solid #2C2D31', borderRadius: '8px', padding: '12px 16px', fontSize: '13px', fontWeight: '500', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.5), 0 2px 4px -1px rgba(0, 0, 0, 0.4)', width: '180px', textAlign: 'center', letterSpacing: '0.01em', borderTop: '3px solid #3B82F6' }
    };
    onNodesChange([{ type: 'add', item: newNode }]);
  };

  return (
    <div className="flex-1 h-full relative font-sans" style={{ backgroundColor: '#0B0C0E', width: '100%', height: '100%' }} ref={reactFlowWrapper}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onReconnect={onReconnect}
        onNodeClick={handleNodeClick}
        deleteKeyCode={["Backspace", "Delete"]}
        snapToGrid={true}
        snapGrid={[20, 20]}
        panOnScroll={true}
        selectionOnDrag={true}
        panOnDrag={[1]}
        fitView
        proOptions={{ hideAttribution: true }}
        style={{ width: '100%', height: '100%' }}
      >
        <Controls
          style={{
            display: 'flex',
            flexDirection: 'column',
            backgroundColor: '#151618',
            borderRadius: '8px',
            border: '1px solid #2C2D31',
            boxShadow: '0 4px 6px rgba(0,0,0,0.3)',
            overflow: 'hidden'
          }}
        />
        <MiniMap
          nodeStrokeWidth={3}
          zoomable
          pannable
          style={{ backgroundColor: '#050505', border: '1px solid #1F2023', borderRadius: '8px' }}
          nodeColor="#2C2D31"
          maskColor="rgba(0, 0, 0, 0.6)"
        />
        <Background variant="dots" gap={20} size={1.5} color="#1F2023" />

        {isGenerating && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/40 pointer-events-none">
            <div className="bg-[#151618] border border-[#2c2d31] rounded-xl p-6 text-center backdrop-blur-md shadow-xl">
              <RefreshCcw className="animate-spin text-blue-400 mx-auto mb-3" />
              <p className="text-gray-300 text-sm">Drawing architecture...</p>
              <p className="text-gray-500 text-xs mt-1">{genTokens} tokens generated</p>
            </div>
          </div>
        )}

        <Panel position="top-right" className="bg-[#050505]/95 backdrop-blur-md border border-[#1f2023] p-4 rounded-xl mr-4 mt-4 shadow-xl flex flex-col items-end w-64 gap-4">
          <div className="flex justify-between items-center w-full">
            <h3 className="text-[13px] font-semibold text-gray-100 uppercase tracking-wider mb-1">Architecture Graph</h3>
            <div className="flex gap-2">
              <button onClick={handleReviewArchitecture} disabled={nodes.length === 0 || reviewLoading} className="p-1.5 hover:bg-[#1f2023] rounded text-gray-400 hover:text-purple-400 disabled:opacity-50" title="Review Architecture">
                {reviewLoading ? <RefreshCcw size={14} className="animate-spin" /> : <Sparkles size={14} />}
              </button>
              <button onClick={handleMermaidExport} disabled={nodes.length === 0} className="p-1.5 hover:bg-[#1f2023] rounded text-gray-400 hover:text-amber-400 disabled:opacity-50" title="Export as Mermaid">
                {mermaidCopyStatus === 'success' ? <CheckCircle size={14} className="text-green-400" /> : <Copy size={14} />}
              </button>
              <button onClick={handleExport} disabled={nodes.length === 0} className="p-1.5 hover:bg-[#1f2023] rounded text-gray-400 hover:text-blue-400 disabled:opacity-50" title="Export as PNG"><Download size={14} /></button>
            </div>
          </div>

          <div className="w-full grid grid-cols-2 gap-2 pb-2 border-b border-[#1f2023]">
            <button onClick={() => addManualNode('server')} className="text-[11px] py-1 bg-[#1a1b1e] border border-[#2c2d31] rounded hover:border-blue-500 text-gray-300">Add Server</button>
            <button onClick={() => addManualNode('database')} className="text-[11px] py-1 bg-[#1a1b1e] border border-[#2c2d31] rounded hover:border-emerald-500 text-gray-300">Add DB</button>
            <button onClick={() => addManualNode('client')} className="text-[11px] py-1 bg-[#1a1b1e] border border-[#2c2d31] rounded hover:border-indigo-500 text-gray-300">Add Client</button>
            <button onClick={() => addManualNode('cache')} className="text-[11px] py-1 bg-[#1a1b1e] border border-[#2c2d31] rounded hover:border-amber-500 text-gray-300">Add Cache</button>
          </div>

          <div className="w-full pb-2 border-b border-[#1f2023]">
            <select
              onChange={(e) => {
                if (!e.target.value) return;
                const tpl = templates[e.target.value];
                if (tpl && window.confirm(`Load ${tpl.name}? This will overwrite your board.`)) {
                  onGraphUpdate(tpl.nodes, tpl.edges);
                }
                e.target.value = "";
              }}
              className="w-full text-[11px] py-1.5 px-2 bg-[#1a1b1e] border border-[#2c2d31] rounded text-gray-300 outline-none"
            >
              <option value="">Load Template...</option>
              {Object.entries(templates).map(([key, tpl]) => (
                <option key={key} value={key}>{tpl.name}</option>
              ))}
            </select>
          </div>

          <div className="w-full flex flex-col gap-3">
            {/* Review Architecture Button */}
            <button
              onClick={handleReviewArchitecture}
              disabled={nodes.length === 0 || reviewLoading}
              className="w-full flex items-center justify-center gap-2 py-2 px-3 bg-amber-600/10 hover:bg-amber-600/20 text-amber-400 border border-amber-500/20 rounded-lg text-[12px] font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {reviewLoading ? <Loader size={14} className="animate-spin" /> : <Sparkles size={14} />}
              {reviewLoading ? 'Reviewing...' : 'Review Architecture'}
            </button>

            {/* Auto Layout Button */}
            <button
              onClick={onAutoLayout}
              disabled={nodes.length === 0}
              className="w-full flex items-center justify-center gap-2 py-2 px-3 bg-blue-600/10 hover:bg-blue-600/20 text-blue-400 border border-blue-500/20 rounded-lg text-[12px] font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <LayoutGrid size={14} />
              ✨ Auto-Layout
            </button>

            {/* Status Indicator */}
            {nodes.length > 0 ? (
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse border border-green-400 shadow-[0_0_8px_rgba(34,197,94,0.5)]"></span>
                <p className="text-[12px] text-gray-400">Interactive Canvas active</p>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-yellow-500 animate-pulse border border-yellow-400 shadow-[0_0_8px_rgba(234,179,8,0.5)]"></span>
                <p className="text-[12px] text-gray-400">Waiting for prompt...</p>
              </div>
            )}
          </div>
        </Panel>
      </ReactFlow>
    </div>
  );
}

export default memo(GraphBoard);

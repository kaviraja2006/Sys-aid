import { useCallback, useMemo } from 'react';
import {
  ReactFlow,
  MiniMap,
  Controls,
  Background,
  addEdge,
  Panel,
  reconnectEdge
} from '@xyflow/react';
import { LayoutGrid } from 'lucide-react';
import '@xyflow/react/dist/style.css';
import ArchitectureNode from './ArchitectureNode';

export default function GraphBoard({ nodes, edges, onNodesChange, onEdgesChange, setEdges, onAutoLayout }) {

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

  return (
    <div className="flex-1 h-full relative font-sans" style={{ backgroundColor: '#0B0C0E' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onReconnect={onReconnect}
        deleteKeyCode={["Backspace", "Delete"]}
        snapToGrid={true}
        snapGrid={[20, 20]}
        panOnScroll={true}
        selectionOnDrag={true}
        panOnDrag={[1]}
        fitView
        proOptions={{ hideAttribution: true }}
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
        
        <Panel position="top-right" className="bg-[#050505]/95 backdrop-blur-md border border-[#1f2023] p-4 rounded-xl mr-4 mt-4 shadow-xl flex flex-col items-end w-64">
            <div className="flex justify-between items-center w-full mb-3">
              <h3 className="text-[13px] font-semibold text-gray-100 uppercase tracking-wider mb-1">Architecture Graph</h3>
            </div>
            
            <div className="w-full flex flex-col gap-3">
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

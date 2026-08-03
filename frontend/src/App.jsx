import { useState, useCallback } from 'react';
import ChatPanel from './ChatPanel';
import GraphBoard from './GraphBoard';
import NodeDetailSidebar from './NodeDetailSidebar';
import TopBar from './TopBar';
import LoginPage from './LoginPage';
import useAuth from './useAuth';
import { useNodesState, useEdgesState, ReactFlowProvider } from '@xyflow/react';
import dagre from '@dagrejs/dagre';
import './App.css';

const defaultLlmConfig = { provider: '', api_key: '', model_name: '', api_url: '' };

// Node Style Definition
const nodeStyle = {
  background: '#151618',
  color: '#EDEEF0',
  border: '1px solid #2C2D31',
  borderRadius: '8px',
  padding: '12px 16px',
  fontSize: '13px',
  fontWeight: '500',
  boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.5), 0 2px 4px -1px rgba(0, 0, 0, 0.4)',
  width: '180px',
  textAlign: 'center',
  letterSpacing: '0.01em',
  borderTop: '3px solid #3B82F6' // default accent
};

// Layout function
const getLayoutedElements = (nodes, edges, direction = 'TB') => {
  const dagreGraph = new dagre.graphlib.Graph();
  dagreGraph.setDefaultEdgeLabel(() => ({}));

  const nodeWidth = 180;
  const nodeHeight = 60;

  dagreGraph.setGraph({ rankdir: direction, ranksep: 80, nodesep: 60 });

  nodes.forEach((node) => {
    dagreGraph.setNode(node.id, { width: nodeWidth, height: nodeHeight });
  });

  edges.forEach((edge) => {
    if (edge.source && edge.target) {
      dagreGraph.setEdge(edge.source, edge.target);
    }
  });

  dagre.layout(dagreGraph);

  const layoutedNodes = nodes.map((node) => {
    const nodeWithPosition = dagreGraph.node(node.id);
    const pos = nodeWithPosition
      ? { x: nodeWithPosition.x - nodeWidth / 2, y: nodeWithPosition.y - nodeHeight / 2 }
      : { x: 0, y: 0 };
    return {
      ...node,
      targetPosition: direction === 'TB' ? 'top' : 'left',
      sourcePosition: direction === 'TB' ? 'bottom' : 'right',
      position: pos,
      style: { ...nodeStyle, ...(node.style || {}) }
    };
  });

  const layoutedEdges = edges.map((edge) => {
    return {
      ...edge,
      style: { stroke: '#4B5563', strokeWidth: 2, ...(edge.style || {}) },
      labelBgStyle: { fill: '#1a1b1e', color: '#fff', fillOpacity: 0.9 },
      labelStyle: { fill: '#EDEEF0', fontWeight: 500, fontSize: 12 },
      animated: true
    };
  });

  return { nodes: layoutedNodes, edges: layoutedEdges };
};


function App() {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [genTokens, setGenTokens] = useState(0);
  const [selectedNode, setSelectedNode] = useState(null);
  const { user, setUser, loading: authLoading, logout } = useAuth();
  // ChatPanel owns the encrypted, persisted copy of this config and pushes
  // it up via setLlmConfig once it's loaded (see secureGet in ChatPanel.jsx).
  const [llmConfig, setLlmConfig] = useState(defaultLlmConfig);

  const handleGraphUpdate = useCallback((newNodes, newEdges) => {
    if (!newNodes || newNodes.length === 0) {
      setNodes([]);
      setEdges([]);
      return;
    }
    // Always run dagre layout so nodes are never overlapping
    const { nodes: layoutedNodes, edges: layoutedEdges } = getLayoutedElements(
      newNodes,
      newEdges || []
    );
    setNodes(layoutedNodes);
    setEdges(layoutedEdges);
  }, [setNodes, setEdges]);

  const handleReset = useCallback(() => {
    setNodes([]);
    setEdges([]);
  }, [setNodes, setEdges]);

  // Expose manual re-layouting to the UI button
  const handleAutoLayout = useCallback(() => {
    const { nodes: layoutedNodes, edges: layoutedEdges } = getLayoutedElements(nodes, edges);
    setNodes(layoutedNodes);
    setEdges(layoutedEdges);
  }, [nodes, edges, setNodes, setEdges]);

  const handleNodeSelect = useCallback((node) => {
    setSelectedNode(node);
  }, []);

  const handleLogout = useCallback(async () => {
    await logout();
    handleReset();
  }, [logout, handleReset]);

  if (authLoading) {
    return (
      <div className="flex items-center justify-center w-full h-screen bg-[#050b1a]">
        <div className="w-8 h-8 border-2 border-blue-500/30 border-t-blue-500 rounded-full animate-spin" />
      </div>
    );
  }

  if (!user) {
    return <LoginPage setUser={setUser} />;
  }

  return (
    <ReactFlowProvider>
      <div className="flex flex-col w-full h-screen overflow-hidden bg-background font-sans text-gray-100">
      <TopBar user={user} onLogout={handleLogout} />
      <div className="flex flex-1 overflow-hidden">
        <ChatPanel
          key={user.id}
          onGraphUpdate={handleGraphUpdate}
          onReset={handleReset}
          currentNodes={nodes}
          currentEdges={edges}
          onGenerationStart={() => { setGenTokens(0); setIsGenerating(true); }}
          onGenerationFinish={() => { setIsGenerating(false); setGenTokens(0); }}
          onGenerationProgress={(count) => setGenTokens(count)}
          setLlmConfig={setLlmConfig}
          isAuthenticated={!!user}
        />

        <GraphBoard
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          setEdges={setEdges}
          onAutoLayout={handleAutoLayout}
          onGraphUpdate={handleGraphUpdate}
          isGenerating={isGenerating}
          genTokens={genTokens}
          onNodeSelect={handleNodeSelect}
          llmConfig={llmConfig}
        />

        <NodeDetailSidebar
          node={selectedNode}
          isOpen={!!selectedNode}
          onClose={() => setSelectedNode(null)}
          llmConfig={llmConfig}
        />
      </div>
      </div>
    </ReactFlowProvider>
  );
}

export default App;

import { memo, useState, useRef, useEffect } from 'react';
import { Handle, Position, useReactFlow } from '@xyflow/react';
import { Database, Server, MonitorSmartphone, Cloud, Layers, Blocks, X } from 'lucide-react';

const iconMap = {
  database: Database,
  server: Server,
  client: MonitorSmartphone,
  cloud: Cloud,
  cache: Layers,
  default: Blocks
};

const colorMap = {
  database: 'border-emerald-500 bg-emerald-500/10 text-emerald-400',
  server: 'border-blue-500 bg-blue-500/10 text-blue-400',
  client: 'border-indigo-500 bg-indigo-500/10 text-indigo-400',
  cloud: 'border-sky-500 bg-sky-500/10 text-sky-400',
  cache: 'border-amber-500 bg-amber-500/10 text-amber-400',
  default: 'border-gray-500 bg-gray-500/10 text-gray-400'
};

const annotationTypeMap = {
  risk: { icon: '🔴', label: 'Risk', color: 'bg-red-500/20 text-red-400 border-red-500/30' },
  decision: { icon: '🟡', label: 'Decision', color: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30' },
  note: { icon: '🔵', label: 'Note', color: 'bg-blue-500/20 text-blue-400 border-blue-500/30' },
  todo: { icon: '🟢', label: 'Todo', color: 'bg-green-500/20 text-green-400 border-green-500/30' }
};

const ArchitectureNode = ({ id, data }) => {
  const { updateNodeData } = useReactFlow();
  const [isEditing, setIsEditing] = useState(false);
  const [editLabel, setEditLabel] = useState(data.label || '');
  const [editType, setEditType] = useState(data.systemType || 'default');
  const [showAnnotationMenu, setShowAnnotationMenu] = useState(false);
  const [showAnnotationInput, setShowAnnotationInput] = useState(false);
  const [annotationText, setAnnotationText] = useState('');
  const [selectedAnnotationType, setSelectedAnnotationType] = useState('note');
  const contextMenuRef = useRef(null);
  const nodeRef = useRef(null);

  const systemType = data.systemType || 'default';
  const Icon = iconMap[systemType] || iconMap.default;
  const theme = colorMap[systemType] || colorMap.default;
  const annotations = data.annotations || [];

  const handleSave = () => {
    updateNodeData(id, { label: editLabel, systemType: editType });
    setIsEditing(false);
  };

  const handleContextMenu = (e) => {
    e.preventDefault();
    setShowAnnotationMenu(true);
  };

  const addAnnotation = (type) => {
    setSelectedAnnotationType(type);
    setShowAnnotationInput(true);
    setShowAnnotationMenu(false);
  };

  const saveAnnotation = () => {
    if (annotationText.trim()) {
      const newAnnotation = {
        id: `ann-${Date.now()}`,
        type: selectedAnnotationType,
        text: annotationText,
        createdAt: new Date().toISOString()
      };
      updateNodeData(id, { 
        annotations: [...annotations, newAnnotation]
      });
      setAnnotationText('');
      setShowAnnotationInput(false);
    }
  };

  const removeAnnotation = (annId) => {
    updateNodeData(id, { 
      annotations: annotations.filter(a => a.id !== annId)
    });
  };

  // Close menus when clicking outside
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target) && 
          nodeRef.current && !nodeRef.current.contains(e.target)) {
        setShowAnnotationMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  if (isEditing) {
    return (
      <div className={`px-4 py-3 shadow-md rounded-xl border ${theme} backdrop-blur-md min-w-[180px] font-sans flex flex-col gap-2 z-50 relative`}>
        <input 
          autoFocus
          value={editLabel}
          onChange={e => setEditLabel(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleSave()}
          className="bg-[#1a1b1e] text-white text-xs px-2 py-1 rounded border border-gray-600 outline-none w-full"
        />
        <select 
          value={editType} 
          onChange={e => setEditType(e.target.value)}
          className="bg-[#1a1b1e] text-white text-xs px-2 py-1 rounded border border-gray-600 outline-none w-full"
        >
          <option value="default">Default</option>
          <option value="server">Server</option>
          <option value="database">Database</option>
          <option value="client">Client</option>
          <option value="cloud">Cloud</option>
          <option value="cache">Cache</option>
        </select>
        <div className="flex gap-2 w-full">
            <button onClick={handleSave} className="flex-1 bg-blue-600 text-white text-[10px] rounded py-1 hover:bg-blue-500">Save</button>
            <button onClick={() => setIsEditing(false)} className="flex-1 bg-gray-700 text-white text-[10px] rounded py-1 hover:bg-gray-600">Cancel</button>
        </div>
      </div>
    );
  }

  if (showAnnotationInput) {
    const annType = annotationTypeMap[selectedAnnotationType];
    return (
      <div className={`px-4 py-3 shadow-md rounded-xl border ${theme} backdrop-blur-md min-w-[200px] font-sans flex flex-col gap-2 z-50 relative`}>
        <div className="text-xs font-semibold text-gray-300 flex items-center gap-2">
          <span className="text-lg">{annType.icon}</span>
          {annType.label}
        </div>
        <textarea
          autoFocus
          value={annotationText}
          onChange={e => setAnnotationText(e.target.value)}
          placeholder="Add annotation text..."
          className="bg-[#1a1b1e] text-white text-xs px-2 py-1 rounded border border-gray-600 outline-none w-full min-h-[50px] resize-none"
        />
        <div className="flex gap-2 w-full">
          <button onClick={saveAnnotation} className="flex-1 bg-green-600 text-white text-[10px] rounded py-1 hover:bg-green-500">Save</button>
          <button onClick={() => setShowAnnotationInput(false)} className="flex-1 bg-gray-700 text-white text-[10px] rounded py-1 hover:bg-gray-600">Cancel</button>
        </div>
      </div>
    );
  }

  return (
    <div 
      ref={nodeRef}
      onContextMenu={handleContextMenu}
      onDoubleClick={() => setIsEditing(true)} 
      className={`px-4 py-3 shadow-md rounded-xl border ${theme} backdrop-blur-md min-w-[180px] font-sans flex items-center justify-between gap-3 cursor-pointer hover:border-blue-500/50 transition-colors relative`}
    >
      {/* Context Menu */}
      {showAnnotationMenu && (
        <div
          ref={contextMenuRef}
          className="absolute -top-2 -right-2 bg-[#1a1b1e] border border-[#2c2d31] rounded-lg shadow-xl z-50 overflow-hidden"
        >
          {Object.entries(annotationTypeMap).map(([type, info]) => (
            <button
              key={type}
              onClick={() => addAnnotation(type)}
              className="w-full px-3 py-2 text-left text-xs text-gray-300 hover:bg-[#2c2d31] flex items-center gap-2 whitespace-nowrap"
            >
              <span className="text-base">{info.icon}</span>
              <span>Add {info.label}</span>
            </button>
          ))}
        </div>
      )}
      
      {/* Top Handle - Input */}
      <Handle type="target" position={Position.Top} className="w-16 h-1 !bg-gray-600 border-none rounded-full" />
      
      <div className="flex bg-[#1a1b1e]/80 p-2 rounded-lg shrink-0">
        <Icon size={20} strokeWidth={1.5} />
      </div>

      <div className="flex flex-col w-full text-left">
        <div className="text-[12px] font-semibold text-gray-200 tracking-wide">{data.label}</div>
        {data.description && (
          <div className="text-[10px] text-gray-400 mt-0.5 leading-tight">{data.description}</div>
        )}
        {annotations.length > 0 && (
          <div className="text-[10px] text-amber-400 mt-1 font-medium">
            📌 {annotations.length} annotation{annotations.length !== 1 ? 's' : ''}
          </div>
        )}
      </div>

      {/* Bottom Handle - Output */}
      <Handle type="source" position={Position.Bottom} className="w-16 h-1 !bg-gray-600 border-none rounded-full" />
    </div>
  );
};

export default memo(ArchitectureNode);

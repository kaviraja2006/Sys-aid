import { memo, useState } from 'react';
import { Handle, Position, useReactFlow } from '@xyflow/react';
import { Database, Server, MonitorSmartphone, Cloud, Layers, Blocks } from 'lucide-react';

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

const ArchitectureNode = ({ id, data }) => {
  const { updateNodeData } = useReactFlow();
  const [isEditing, setIsEditing] = useState(false);
  const [editLabel, setEditLabel] = useState(data.label || '');
  const [editType, setEditType] = useState(data.systemType || 'default');

  const systemType = data.systemType || 'default';
  const Icon = iconMap[systemType] || iconMap.default;
  const theme = colorMap[systemType] || colorMap.default;

  const handleSave = () => {
    updateNodeData(id, { label: editLabel, systemType: editType });
    setIsEditing(false);
  };

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

  return (
    <div onDoubleClick={() => setIsEditing(true)} className={`px-4 py-3 shadow-md rounded-xl border ${theme} backdrop-blur-md min-w-[180px] font-sans flex items-center justify-between gap-3 cursor-pointer hover:border-blue-500/50 transition-colors`}>
      
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
      </div>

      {/* Bottom Handle - Output */}
      <Handle type="source" position={Position.Bottom} className="w-16 h-1 !bg-gray-600 border-none rounded-full" />
    </div>
  );
};

export default memo(ArchitectureNode);

import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
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

const ArchitectureNode = ({ data }) => {
  const systemType = data.systemType || 'default';
  const Icon = iconMap[systemType] || iconMap.default;
  const theme = colorMap[systemType] || colorMap.default;

  return (
    <div className={`px-4 py-3 shadow-md rounded-xl border ${theme} backdrop-blur-md min-w-[180px] font-sans flex items-center justify-between gap-3`}>
      
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

import { memo, useMemo } from 'react';
import { Bot, User } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';

// Split into its own chunk (lazy-loaded from ChatPanel.jsx) — react-markdown,
// remark-gfm, and react-syntax-highlighter together are the single biggest
// slice of the frontend bundle, and a brand-new chat session doesn't need
// any of them until the first message actually renders.
//
// Memoized message bubble — only re-renders when the message text changes.
// This prevents all previous messages from re-rendering during streaming.
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

export default ChatMessage;

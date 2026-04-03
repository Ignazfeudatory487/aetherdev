import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Send, Plus, Trash2, Loader2, Code2, FileText, Zap } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { useStore, useActiveSession } from '../store/index.ts';
import { useSendMessage, useRunPipeline } from '../hooks/useApi.ts';
import { clsx } from 'clsx';
import toast from 'react-hot-toast';

const QUICK_ACTIONS = [
  { label: 'Generate code', icon: Code2, prompt: 'Generate ' },
  { label: 'Review file', icon: FileText, prompt: 'Review the code in ' },
  { label: 'Run pipeline', icon: Zap, prompt: 'Build a complete implementation for ' },
];

export default function ChatPage() {
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const { sessions, activeSessionId, addSession, setActiveSession, addMessage, clearSession, deleteSession, currentProject } = useStore();
  const activeSession = useActiveSession();
  const sendMessage = useSendMessage();
  const runPipeline = useRunPipeline();

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [activeSession?.messages]);

  // Auto-resize textarea
  useEffect(() => {
    const ta = textareaRef.current;
    if (ta) {
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
    }
  }, [input]);

  const handleNewSession = useCallback(() => {
    const id = addSession({ name: 'New Chat', projectPath: currentProject?.path, messages: [] });
    setActiveSession(id);
  }, [addSession, setActiveSession, currentProject]);

  // Create initial session
  useEffect(() => {
    if (sessions.length === 0) handleNewSession();
    else if (!activeSessionId) setActiveSession(sessions[0]!.id);
  }, []);

  const handleSend = async () => {
    if (!input.trim() || !activeSessionId) return;

    const userMessage = input.trim();
    setInput('');

    addMessage(activeSessionId, { role: 'user', content: userMessage });
    setIsStreaming(true);

    try {
      const isPipelineRequest = /generate|build|create|implement|refactor|fix|debug/i.test(userMessage);

      if (isPipelineRequest) {
        addMessage(activeSessionId, {
          role: 'assistant',
          content: '🔄 Running AI pipeline... (Planner → Coder → Reviewer → Tester)',
        });

        const result = await runPipeline.mutateAsync({
          type: 'generate',
          prompt: userMessage,
          projectPath: currentProject?.path,
          sessionId: activeSessionId,
          autoReview: true,
          autoTest: false,
        });

        const { results } = result.data;
        let content = '';

        if (results?.code?.explanation) {
          content += `**✅ Done!** ${results.code.explanation}\n\n`;
        }
        if (results?.code?.files?.length) {
          content += `**📁 Files:**\n${results.code.files.map((f: any) => `- \`${f.path}\` — ${f.changesSummary}`).join('\n')}\n\n`;
        }
        if (results?.review) {
          const r = results.review;
          content += `**🔍 Review:** ${r.score}/100 — ${r.approved ? '✅ Approved' : '❌ Changes needed'}\n`;
          if (r.comments?.length > 0) {
            content += r.comments.slice(0, 3).map((c: any) => `- [${c.severity}] ${c.title}`).join('\n');
          }
        }

        // Update last assistant message
        const lastMsgIdx = (activeSession?.messages.length ?? 0) - 1;
        addMessage(activeSessionId, { role: 'assistant', content: content || 'Pipeline completed.' });
      } else {
        const result = await sendMessage.mutateAsync({
          prompt: userMessage,
          sessionId: activeSessionId,
          projectPath: currentProject?.path,
        });
        addMessage(activeSessionId, { role: 'assistant', content: result.content });
      }
    } catch (err) {
      addMessage(activeSessionId, {
        role: 'assistant',
        content: `❌ Error: ${err instanceof Error ? err.message : 'Request failed'}`,
      });
      toast.error('Request failed');
    } finally {
      setIsStreaming(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex h-full">
      {/* Sessions Sidebar */}
      <div className="w-60 flex-shrink-0 border-r border-gray-800 flex flex-col bg-gray-900">
        <div className="p-3 border-b border-gray-800">
          <button onClick={handleNewSession} className="btn-secondary w-full text-sm">
            <Plus className="w-4 h-4" /> New Chat
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {sessions.map(session => (
            <div
              key={session.id}
              onClick={() => setActiveSession(session.id)}
              className={clsx(
                'group flex items-center justify-between px-3 py-2 rounded-lg cursor-pointer text-sm transition-colors',
                activeSessionId === session.id ? 'bg-aether-900/50 text-aether-300' : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
              )}
            >
              <span className="truncate flex-1">{session.name}</span>
              <button
                onClick={(e) => { e.stopPropagation(); deleteSession(session.id); }}
                className="opacity-0 group-hover:opacity-100 p-0.5 hover:text-red-400 transition-opacity"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Chat Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-3 border-b border-gray-800">
          <div>
            <h1 className="text-sm font-semibold text-gray-200">{activeSession?.name ?? 'Chat'}</h1>
            {currentProject && <p className="text-xs text-gray-500">{currentProject.name}</p>}
          </div>
          {activeSession && (
            <button
              onClick={() => clearSession(activeSession.id)}
              className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
            >
              Clear
            </button>
          )}
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-6 py-6 space-y-6">
          {!activeSession?.messages.length && (
            <div className="flex flex-col items-center justify-center h-full text-center space-y-6">
              <div className="w-16 h-16 bg-aether-900/50 rounded-2xl flex items-center justify-center">
                <Zap className="w-8 h-8 text-aether-400" />
              </div>
              <div>
                <h2 className="text-xl font-semibold text-gray-200">AetherDev AI Agent</h2>
                <p className="text-gray-500 mt-1 text-sm">Ask me anything about your code, or use the pipeline to build features.</p>
              </div>
              <div className="flex flex-wrap justify-center gap-3">
                {QUICK_ACTIONS.map(action => (
                  <button
                    key={action.label}
                    onClick={() => setInput(action.prompt)}
                    className="flex items-center gap-2 px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded-lg text-sm text-gray-300 transition-colors"
                  >
                    <action.icon className="w-4 h-4 text-aether-400" />
                    {action.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {activeSession?.messages.map(msg => (
            <div key={msg.id} className={clsx('flex gap-3', msg.role === 'user' ? 'justify-end' : 'justify-start')}>
              {msg.role !== 'user' && (
                <div className="w-8 h-8 flex-shrink-0 bg-aether-600 rounded-lg flex items-center justify-center mt-0.5">
                  <Zap className="w-4 h-4 text-white" />
                </div>
              )}
              <div className={clsx(
                'max-w-[80%] rounded-2xl px-4 py-3 text-sm',
                msg.role === 'user'
                  ? 'bg-aether-700 text-white rounded-br-sm'
                  : 'bg-gray-800 text-gray-200 rounded-bl-sm'
              )}>
                {msg.role === 'assistant' ? (
                  <div className="markdown-body prose prose-invert max-w-none text-sm">
                    <ReactMarkdown>{msg.content}</ReactMarkdown>
                  </div>
                ) : (
                  <p className="whitespace-pre-wrap">{msg.content}</p>
                )}
                <div className="mt-1 text-xs opacity-40 text-right">
                  {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </div>
              </div>
              {msg.role === 'user' && (
                <div className="w-8 h-8 flex-shrink-0 bg-gray-700 rounded-lg flex items-center justify-center mt-0.5 text-xs font-bold text-gray-300">
                  U
                </div>
              )}
            </div>
          ))}

          {isStreaming && (
            <div className="flex gap-3 justify-start">
              <div className="w-8 h-8 flex-shrink-0 bg-aether-600 rounded-lg flex items-center justify-center">
                <Zap className="w-4 h-4 text-white" />
              </div>
              <div className="bg-gray-800 rounded-2xl rounded-bl-sm px-4 py-3">
                <div className="typing-indicator flex items-center gap-1 h-5">
                  <span /><span /><span />
                </div>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <div className="px-6 py-4 border-t border-gray-800">
          <div className="flex items-end gap-3 bg-gray-800 rounded-2xl px-4 py-3 border border-gray-700 focus-within:border-aether-600 transition-colors">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask AetherDev anything, or describe code to generate..."
              className="flex-1 bg-transparent text-gray-200 placeholder-gray-500 resize-none focus:outline-none text-sm max-h-48 min-h-[24px]"
              rows={1}
            />
            <button
              onClick={handleSend}
              disabled={!input.trim() || isStreaming}
              className="flex-shrink-0 w-8 h-8 bg-aether-600 hover:bg-aether-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg flex items-center justify-center transition-colors"
            >
              {isStreaming
                ? <Loader2 className="w-4 h-4 text-white animate-spin" />
                : <Send className="w-4 h-4 text-white" />
              }
            </button>
          </div>
          <p className="text-xs text-gray-600 mt-2 text-center">
            Press Enter to send · Shift+Enter for new line · Type "generate" to trigger the full pipeline
          </p>
        </div>
      </div>
    </div>
  );
}

import React, { useState } from 'react';
import { Play, Loader2, CheckCircle, XCircle, ChevronDown, ChevronUp, FileCode, Shield, TestTube } from 'lucide-react';
import { useRunPipeline } from '../hooks/useApi.ts';
import { useStore, useActivePipelineRun } from '../store/index.ts';
import toast from 'react-hot-toast';
import { clsx } from 'clsx';
import ReactMarkdown from 'react-markdown';

const TASK_TYPES = [
  { value: 'generate', label: '⚡ Generate', desc: 'Create new code from description' },
  { value: 'refactor', label: '♻️ Refactor', desc: 'Improve existing code quality' },
  { value: 'debug', label: '🔧 Debug', desc: 'Find and fix bugs' },
  { value: 'test', label: '🧪 Test', desc: 'Generate comprehensive tests' },
  { value: 'review', label: '🔍 Review', desc: 'Code review with feedback' },
  { value: 'document', label: '📝 Document', desc: 'Generate documentation' },
];

export default function PipelinePage() {
  const [prompt, setPrompt] = useState('');
  const [taskType, setTaskType] = useState('generate');
  const [files, setFiles] = useState('');
  const [autoReview, setAutoReview] = useState(true);
  const [autoTest, setAutoTest] = useState(true);
  const [expandedSection, setExpandedSection] = useState<string | null>('code');

  const { currentProject } = useStore();
  const activeRun = useActivePipelineRun();
  const runPipeline = useRunPipeline();

  const handleRun = async () => {
    if (!prompt.trim()) { toast.error('Enter a task description'); return; }
    try {
      await runPipeline.mutateAsync({
        type: taskType,
        prompt,
        targetFiles: files.split('\n').map(f => f.trim()).filter(Boolean),
        projectPath: currentProject?.path,
        autoReview,
        autoTest,
      });
      toast.success('Pipeline completed!');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Pipeline failed');
    }
  };

  const isRunning = runPipeline.isPending;

  return (
    <div className="flex h-full">
      {/* Config Panel */}
      <div className="w-80 flex-shrink-0 border-r border-gray-800 flex flex-col p-4 space-y-4 overflow-y-auto">
        <div>
          <h2 className="text-sm font-semibold text-gray-300 mb-3">Task Type</h2>
          <div className="space-y-1.5">
            {TASK_TYPES.map(t => (
              <button
                key={t.value}
                onClick={() => setTaskType(t.value)}
                className={clsx(
                  'w-full text-left px-3 py-2 rounded-lg text-sm transition-colors',
                  taskType === t.value ? 'bg-aether-900/50 text-aether-300 border border-aether-800' : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
                )}
              >
                <div className="font-medium">{t.label}</div>
                <div className="text-xs opacity-60 mt-0.5">{t.desc}</div>
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="text-sm font-semibold text-gray-300 block mb-2">Task Description</label>
          <textarea
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            placeholder="Describe what you want to build or fix..."
            className="input min-h-[120px] resize-none text-sm"
          />
        </div>

        <div>
          <label className="text-sm font-semibold text-gray-300 block mb-2">Target Files (optional)</label>
          <textarea
            value={files}
            onChange={e => setFiles(e.target.value)}
            placeholder="src/components/Button.tsx&#10;src/utils/auth.ts"
            className="input min-h-[80px] resize-none text-xs font-mono"
          />
          <p className="text-xs text-gray-600 mt-1">One file per line</p>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-semibold text-gray-300">Options</label>
          {[
            { key: 'autoReview', label: 'Auto Review', state: autoReview, set: setAutoReview },
            { key: 'autoTest', label: 'Auto Test', state: autoTest, set: setAutoTest },
          ].map(opt => (
            <label key={opt.key} className="flex items-center gap-3 cursor-pointer">
              <div
                onClick={() => opt.set(!opt.state)}
                className={clsx(
                  'w-9 h-5 rounded-full transition-colors relative cursor-pointer',
                  opt.state ? 'bg-aether-600' : 'bg-gray-700'
                )}
              >
                <div className={clsx(
                  'absolute top-0.5 w-4 h-4 bg-white rounded-full transition-transform shadow',
                  opt.state ? 'translate-x-4' : 'translate-x-0.5'
                )} />
              </div>
              <span className="text-sm text-gray-300">{opt.label}</span>
            </label>
          ))}
        </div>

        <button onClick={handleRun} disabled={isRunning || !prompt.trim()} className="btn-primary w-full">
          {isRunning ? <><Loader2 className="w-4 h-4 animate-spin" /> Running...</> : <><Play className="w-4 h-4" /> Run Pipeline</>}
        </button>
      </div>

      {/* Results Panel */}
      <div className="flex-1 overflow-y-auto p-6 space-y-4">
        {!activeRun && (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <div className="w-16 h-16 bg-gray-800 rounded-2xl flex items-center justify-center mb-4">
              <Play className="w-8 h-8 text-gray-600" />
            </div>
            <h3 className="text-gray-400 font-medium">No pipeline run yet</h3>
            <p className="text-gray-600 text-sm mt-1">Configure your task and click Run Pipeline</p>
          </div>
        )}

        {activeRun && (
          <>
            {/* Status */}
            <div className={clsx('card border', activeRun.status === 'done' ? 'border-green-800' : activeRun.status === 'error' ? 'border-red-800' : 'border-aether-800')}>
              <div className="flex items-center gap-3">
                {activeRun.status === 'done'
                  ? <CheckCircle className="w-5 h-5 text-green-400" />
                  : activeRun.status === 'error'
                  ? <XCircle className="w-5 h-5 text-red-400" />
                  : <Loader2 className="w-5 h-5 text-aether-400 animate-spin" />
                }
                <div>
                  <p className="text-sm font-medium text-gray-200 capitalize">{activeRun.status}</p>
                  <p className="text-xs text-gray-500">{activeRun.taskType} · {activeRun.totalTokens} tokens</p>
                </div>
                {activeRun.qualityScore && (
                  <div className="ml-auto">
                    <span className={clsx('text-sm font-bold', activeRun.qualityScore >= 80 ? 'text-green-400' : activeRun.qualityScore >= 60 ? 'text-yellow-400' : 'text-red-400')}>
                      {activeRun.qualityScore}/100
                    </span>
                  </div>
                )}
              </div>
            </div>

            {/* Code Results */}
            {activeRun.result?.files && activeRun.result.files.length > 0 && (
              <ResultSection
                icon={<FileCode className="w-4 h-4 text-aether-400" />}
                title={`Generated Files (${activeRun.result.files.length})`}
                id="code"
                expanded={expandedSection === 'code'}
                onToggle={() => setExpandedSection(expandedSection === 'code' ? null : 'code')}
              >
                {activeRun.result.explanation && (
                  <div className="mb-4 p-3 bg-gray-800 rounded-lg text-sm text-gray-300">
                    <ReactMarkdown>{activeRun.result.explanation}</ReactMarkdown>
                  </div>
                )}
                {activeRun.result.files.map((f, i) => (
                  <div key={i} className="mb-4">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-xs font-mono text-aether-400">{f.path}</span>
                      <span className={clsx('badge text-xs', f.isNew ? 'badge-success' : 'badge-info')}>
                        {f.isNew ? 'new' : 'modified'}
                      </span>
                    </div>
                    <pre className="code-block overflow-x-auto max-h-80 text-xs">
                      <code>{f.content}</code>
                    </pre>
                  </div>
                ))}
              </ResultSection>
            )}

            {/* Review Results */}
            {activeRun.result?.review && (
              <ResultSection
                icon={<Shield className="w-4 h-4 text-purple-400" />}
                title={`Code Review — ${activeRun.result.review.score}/100`}
                id="review"
                expanded={expandedSection === 'review'}
                onToggle={() => setExpandedSection(expandedSection === 'review' ? null : 'review')}
              >
                <div className="space-y-2">
                  {activeRun.result.review.comments.slice(0, 10).map((c, i) => (
                    <div key={i} className={clsx('p-3 rounded-lg border text-sm', {
                      'border-red-800 bg-red-900/20': c.severity === 'critical',
                      'border-orange-800 bg-orange-900/20': c.severity === 'high',
                      'border-yellow-800 bg-yellow-900/20': c.severity === 'medium',
                      'border-blue-800 bg-blue-900/20': c.severity === 'low',
                    })}>
                      <div className="flex items-center gap-2 mb-1">
                        <span className={`badge badge-${c.severity}`}>{c.severity}</span>
                        <span className="text-gray-300 font-medium">{c.title}</span>
                      </div>
                      <p className="text-gray-400 text-xs">{c.description}</p>
                      {c.suggestion && <p className="text-aether-400 text-xs mt-1">💡 {c.suggestion}</p>}
                    </div>
                  ))}
                </div>
              </ResultSection>
            )}

            {/* Test Results */}
            {activeRun.result?.tests && (
              <ResultSection
                icon={<TestTube className="w-4 h-4 text-green-400" />}
                title={`Tests — ${activeRun.result.tests.passed}/${activeRun.result.tests.total} passed`}
                id="tests"
                expanded={expandedSection === 'tests'}
                onToggle={() => setExpandedSection(expandedSection === 'tests' ? null : 'tests')}
              >
                <div className="flex gap-4 text-sm">
                  <span className="text-green-400">✓ {activeRun.result.tests.passed} passed</span>
                  {activeRun.result.tests.failed > 0 && <span className="text-red-400">✗ {activeRun.result.tests.failed} failed</span>}
                  <span className="text-gray-500">{activeRun.result.tests.total} total</span>
                </div>
              </ResultSection>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function ResultSection({ icon, title, id, expanded, onToggle, children }: {
  icon: React.ReactNode; title: string; id: string;
  expanded: boolean; onToggle: () => void; children: React.ReactNode;
}) {
  return (
    <div className="card">
      <button onClick={onToggle} className="flex items-center justify-between w-full">
        <div className="flex items-center gap-2">
          {icon}
          <span className="text-sm font-semibold text-gray-200">{title}</span>
        </div>
        {expanded ? <ChevronUp className="w-4 h-4 text-gray-500" /> : <ChevronDown className="w-4 h-4 text-gray-500" />}
      </button>
      {expanded && <div className="mt-4">{children}</div>}
    </div>
  );
}

import React, { useState } from 'react';
import { Shield, AlertCircle, CheckCircle, XCircle, Loader2 } from 'lucide-react';
import { useRunPipeline } from '../hooks/useApi.ts';
import { useStore, useActivePipelineRun } from '../store/index.ts';
import { clsx } from 'clsx';
import toast from 'react-hot-toast';

export default function ReviewPage() {
  const [files, setFiles] = useState('');
  const { currentProject } = useStore();
  const runPipeline = useRunPipeline();
  const activeRun = useActivePipelineRun();

  const handleReview = async () => {
    const targetFiles = files.split('\n').map(f => f.trim()).filter(Boolean);
    if (targetFiles.length === 0) { toast.error('Enter at least one file path'); return; }
    try {
      await runPipeline.mutateAsync({
        type: 'review',
        prompt: 'Perform a comprehensive code review including security, performance, and maintainability analysis',
        targetFiles,
        projectPath: currentProject?.path,
      });
    } catch { toast.error('Review failed'); }
  };

  const review = activeRun?.result?.review;

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Code Review</h1>
        <p className="text-gray-500 mt-1">AI-powered security, performance, and quality analysis</p>
      </div>

      <div className="card space-y-4">
        <div>
          <label className="text-sm font-medium text-gray-300 block mb-2">Files to Review</label>
          <textarea
            value={files}
            onChange={e => setFiles(e.target.value)}
            placeholder="src/auth/login.ts&#10;src/api/users.ts"
            className="input min-h-[100px] resize-none font-mono text-sm"
          />
        </div>
        <button onClick={handleReview} disabled={runPipeline.isPending} className="btn-primary">
          {runPipeline.isPending ? <><Loader2 className="w-4 h-4 animate-spin" /> Reviewing...</> : <><Shield className="w-4 h-4" /> Review Code</>}
        </button>
      </div>

      {review && (
        <>
          {/* Score Card */}
          <div className={clsx('card border-2', review.score >= 80 ? 'border-green-700' : review.score >= 60 ? 'border-yellow-700' : 'border-red-700')}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                {review.approved ? <CheckCircle className="w-8 h-8 text-green-400" /> : <XCircle className="w-8 h-8 text-red-400" />}
                <div>
                  <p className="text-lg font-bold text-white">{review.approved ? 'Approved' : 'Changes Required'}</p>
                  <p className="text-sm text-gray-400">{review.comments.length} issues found</p>
                </div>
              </div>
              <div className="text-4xl font-bold" style={{ color: review.score >= 80 ? '#22c55e' : review.score >= 60 ? '#eab308' : '#ef4444' }}>
                {review.score}<span className="text-xl text-gray-500">/100</span>
              </div>
            </div>
          </div>

          {/* Issues */}
          {review.comments.length > 0 && (
            <div className="space-y-3">
              <h3 className="font-semibold text-gray-300">Issues Found</h3>
              {['critical', 'high', 'medium', 'low', 'info'].map(sev => {
                const items = review.comments.filter((c: any) => c.severity === sev);
                if (!items.length) return null;
                return (
                  <div key={sev}>
                    <h4 className="text-xs font-semibold text-gray-500 uppercase mb-2">{sev} ({items.length})</h4>
                    <div className="space-y-2">
                      {items.map((c: any, i: number) => (
                        <div key={i} className={clsx('card border', {
                          'border-red-800': sev === 'critical',
                          'border-orange-800': sev === 'high',
                          'border-yellow-800': sev === 'medium',
                          'border-blue-800': sev === 'low',
                          'border-gray-700': sev === 'info',
                        })}>
                          <div className="flex items-start gap-3">
                            <AlertCircle className={clsx('w-4 h-4 mt-0.5 flex-shrink-0', {
                              'text-red-400': sev === 'critical',
                              'text-orange-400': sev === 'high',
                              'text-yellow-400': sev === 'medium',
                              'text-blue-400': sev === 'low',
                              'text-gray-400': sev === 'info',
                            })} />
                            <div className="flex-1">
                              <p className="text-sm font-medium text-gray-200">{c.title}</p>
                              <p className="text-xs text-gray-400 mt-1">{c.description}</p>
                              {c.suggestion && (
                                <p className="text-xs text-aether-400 mt-1.5">💡 {c.suggestion}</p>
                              )}
                              {c.filePath && (
                                <p className="text-xs text-gray-600 mt-1 font-mono">{c.filePath}{c.line ? `:${c.line}` : ''}</p>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}

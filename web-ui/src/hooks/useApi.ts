/**
 * AetherDev Web UI — API Hooks
 * React Query hooks for all backend API calls
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import { useStore } from '../store/index.ts';

const getApiUrl = () =>
  import.meta.env['VITE_API_URL'] ?? 'http://localhost:3001';

const api = axios.create({ baseURL: getApiUrl() });

api.interceptors.response.use(
  r => r,
  err => {
    console.error('[API Error]', err.response?.data ?? err.message);
    return Promise.reject(err);
  }
);

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RunPipelineRequest {
  type: string;
  prompt: string;
  targetFiles?: string[];
  projectPath?: string;
  sessionId?: string;
  mode?: string;
  autoReview?: boolean;
  autoTest?: boolean;
}

// ─── Engine ───────────────────────────────────────────────────────────────────

export function useEngineStatus() {
  return useQuery({
    queryKey: ['engine', 'status'],
    queryFn: async () => {
      const res = await api.get('/api/engine/status');
      return res.data as {
        provider: string; model: string; ollamaOnline: boolean;
        totalRequests: number; totalTokens: number; errors: number;
      };
    },
    refetchInterval: 30_000,
    retry: false,
  });
}

export function useOllamaModels() {
  return useQuery({
    queryKey: ['engine', 'models'],
    queryFn: async () => {
      const res = await api.get('/api/engine/models');
      return res.data as string[];
    },
    retry: false,
  });
}

// ─── Pipeline ─────────────────────────────────────────────────────────────────

export function useRunPipeline() {
  const { startPipelineRun, updatePipelineRun } = useStore();

  return useMutation({
    mutationFn: async (request: RunPipelineRequest) => {
      const runId = startPipelineRun({
        taskType: request.type as any,
        prompt: request.prompt,
        status: 'planning',
        progress: 0,
        totalTokens: 0,
        result: undefined,
      });

      try {
        const res = await api.post('/api/pipeline/run', request);
        updatePipelineRun(runId, {
          status: 'done',
          progress: 100,
          result: res.data.results,
          totalTokens: res.data.totalTokens,
          completedAt: Date.now(),
        });
        return { runId, data: res.data };
      } catch (err) {
        updatePipelineRun(runId, { status: 'error', completedAt: Date.now() });
        throw err;
      }
    },
  });
}

export function usePipelineRun(runId: string | null) {
  return useQuery({
    queryKey: ['pipeline', 'run', runId],
    queryFn: async () => {
      const res = await api.get(`/api/pipeline/runs/${runId}`);
      return res.data;
    },
    enabled: !!runId,
    refetchInterval: (query) => {
      const data = query.state.data as { status?: string } | undefined;
      return data?.status === 'running' ? 2000 : false;
    },
  });
}

// ─── Chat ─────────────────────────────────────────────────────────────────────

export function useSendMessage() {
  return useMutation({
    mutationFn: async (data: { prompt: string; sessionId: string; projectPath?: string }) => {
      const res = await api.post('/api/chat/message', data);
      return res.data as { content: string; tokens: number };
    },
  });
}

// ─── Memory / Index ───────────────────────────────────────────────────────────

export function useIndexProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: { projectPath: string; force?: boolean }) => {
      const res = await api.post('/api/memory/index', data);
      return res.data as { files: number; chunks: number };
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project'] }),
  });
}

export function useSearchCode(query: string, projectPath?: string) {
  return useQuery({
    queryKey: ['code', 'search', query, projectPath],
    queryFn: async () => {
      const res = await api.get('/api/memory/search', { params: { query, projectPath, type: 'code' } });
      return res.data as Array<{ content: string; filePath: string; score: number }>;
    },
    enabled: query.length > 2,
  });
}

// ─── Quality ──────────────────────────────────────────────────────────────────

export function useScanProject(projectPath?: string) {
  return useQuery({
    queryKey: ['scan', projectPath],
    queryFn: async () => {
      const res = await api.post('/api/quality/scan', { projectPath });
      return res.data as {
        overall: { score: number; passed: boolean; totalIssues: number; criticalCount: number };
        reports: unknown[];
      };
    },
    enabled: !!projectPath,
    staleTime: 60_000,
  });
}

// ─── Git ──────────────────────────────────────────────────────────────────────

export function useGitStatus(projectPath?: string) {
  return useQuery({
    queryKey: ['git', 'status', projectPath],
    queryFn: async () => {
      const res = await api.get('/api/git/status', { params: { projectPath } });
      return res.data as { branch: string; staged: string[]; unstaged: string[]; isClean: boolean };
    },
    enabled: !!projectPath,
    refetchInterval: 10_000,
  });
}

export function useGitCommit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: { message: string; projectPath: string; stageAll?: boolean }) => {
      const res = await api.post('/api/git/commit', data);
      return res.data as { hash: string };
    },
    onSuccess: (_, vars) => qc.invalidateQueries({ queryKey: ['git', 'status', vars.projectPath] }),
  });
}

// ─── Plugins ──────────────────────────────────────────────────────────────────

export function usePlugins() {
  return useQuery({
    queryKey: ['plugins'],
    queryFn: async () => {
      const res = await api.get('/api/plugins');
      return res.data as Array<{
        name: string; version: string; status: string; description: string;
      }>;
    },
  });
}

export function useReloadPlugin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) => {
      await api.post(`/api/plugins/${name}/reload`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['plugins'] }),
  });
}

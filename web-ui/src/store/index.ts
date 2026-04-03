/**
 * AetherDev Web UI — Zustand Global State Store
 */

import { create } from 'zustand';
import { persist, subscribeWithSelector } from 'zustand/middleware';

// ─── Types ────────────────────────────────────────────────────────────────────

export type TaskType = 'generate' | 'refactor' | 'debug' | 'test' | 'review' | 'document' | 'explain';
export type PipelineStatus = 'idle' | 'planning' | 'coding' | 'reviewing' | 'testing' | 'done' | 'error';
export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  files?: string[];
  metadata?: Record<string, unknown>;
}

export interface Session {
  id: string;
  name: string;
  projectPath?: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
}

export interface PipelineRun {
  id: string;
  taskType: TaskType;
  prompt: string;
  status: PipelineStatus;
  progress: number;
  currentAgent?: string;
  startedAt: number;
  completedAt?: number;
  result?: {
    files?: Array<{ path: string; content: string; language: string; isNew: boolean }>;
    review?: { score: number; approved: boolean; comments: ReviewComment[] };
    tests?: { passed: number; failed: number; total: number };
    explanation?: string;
    error?: string;
  };
  totalTokens: number;
  qualityScore?: number;
}

export interface ReviewComment {
  id: string;
  severity: Severity;
  category: string;
  title: string;
  description: string;
  suggestion: string;
  filePath?: string;
  line?: number;
}

export interface ProjectInfo {
  path: string;
  name: string;
  indexed: boolean;
  filesCount: number;
  lastIndexed?: number;
}

export interface EngineStatus {
  provider: string;
  model: string;
  ollamaOnline: boolean;
  totalRequests: number;
  totalTokens: number;
  errors: number;
}

export interface AppSettings {
  theme: 'dark' | 'light' | 'system';
  fontSize: number;
  llmProvider: string;
  ollamaModel: string;
  autoReview: boolean;
  autoTest: boolean;
  streamResponse: boolean;
  showLineNumbers: boolean;
  apiUrl: string;
}

// ─── State Interface ──────────────────────────────────────────────────────────

interface AetherState {
  // Sessions
  sessions: Session[];
  activeSessionId: string | null;
  addSession: (session: Omit<Session, 'id' | 'createdAt' | 'updatedAt'>) => string;
  setActiveSession: (id: string) => void;
  addMessage: (sessionId: string, message: Omit<Message, 'id' | 'timestamp'>) => void;
  clearSession: (sessionId: string) => void;
  deleteSession: (sessionId: string) => void;
  updateSessionName: (sessionId: string, name: string) => void;

  // Pipeline
  pipelineRuns: PipelineRun[];
  activePipelineId: string | null;
  startPipelineRun: (run: Omit<PipelineRun, 'id' | 'startedAt'>) => string;
  updatePipelineRun: (id: string, updates: Partial<PipelineRun>) => void;
  setActivePipeline: (id: string | null) => void;

  // Project
  currentProject: ProjectInfo | null;
  recentProjects: ProjectInfo[];
  setCurrentProject: (project: ProjectInfo | null) => void;
  addRecentProject: (project: ProjectInfo) => void;

  // Engine Status
  engineStatus: EngineStatus;
  setEngineStatus: (status: Partial<EngineStatus>) => void;

  // Settings
  settings: AppSettings;
  updateSettings: (updates: Partial<AppSettings>) => void;

  // UI State
  sidebarOpen: boolean;
  activeFile: string | null;
  openFiles: Array<{ path: string; content: string; language: string; modified: boolean }>;
  setSidebarOpen: (open: boolean) => void;
  setActiveFile: (path: string | null) => void;
  openFile: (file: { path: string; content: string; language: string }) => void;
  closeFile: (path: string) => void;
  updateFileContent: (path: string, content: string) => void;
}

// ─── Default Settings ─────────────────────────────────────────────────────────

const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  fontSize: 14,
  llmProvider: 'ollama',
  ollamaModel: 'codellama:13b',
  autoReview: true,
  autoTest: true,
  streamResponse: true,
  showLineNumbers: true,
  apiUrl: import.meta.env['VITE_API_URL'] ?? 'http://localhost:3001',
};

// ─── Store ────────────────────────────────────────────────────────────────────

export const useStore = create<AetherState>()(
  persist(
    subscribeWithSelector((set, get) => ({
      // ─── Sessions ────────────────────────────────────────────────────────────
      sessions: [],
      activeSessionId: null,

      addSession: (session) => {
        const id = crypto.randomUUID();
        const now = Date.now();
        set(state => ({
          sessions: [...state.sessions, { ...session, id, messages: session.messages ?? [], createdAt: now, updatedAt: now }],
          activeSessionId: id,
        }));
        return id;
      },

      setActiveSession: (id) => set({ activeSessionId: id }),

      addMessage: (sessionId, message) => {
        set(state => ({
          sessions: state.sessions.map(s =>
            s.id === sessionId
              ? { ...s, messages: [...s.messages, { ...message, id: crypto.randomUUID(), timestamp: Date.now() }], updatedAt: Date.now() }
              : s
          ),
        }));
      },

      clearSession: (sessionId) => {
        set(state => ({
          sessions: state.sessions.map(s => s.id === sessionId ? { ...s, messages: [], updatedAt: Date.now() } : s),
        }));
      },

      deleteSession: (sessionId) => {
        set(state => ({
          sessions: state.sessions.filter(s => s.id !== sessionId),
          activeSessionId: state.activeSessionId === sessionId ? null : state.activeSessionId,
        }));
      },

      updateSessionName: (sessionId, name) => {
        set(state => ({
          sessions: state.sessions.map(s => s.id === sessionId ? { ...s, name, updatedAt: Date.now() } : s),
        }));
      },

      // ─── Pipeline ────────────────────────────────────────────────────────────
      pipelineRuns: [],
      activePipelineId: null,

      startPipelineRun: (run) => {
        const id = crypto.randomUUID();
        set(state => ({
          pipelineRuns: [{ ...run, id, startedAt: Date.now() }, ...state.pipelineRuns.slice(0, 49)],
          activePipelineId: id,
        }));
        return id;
      },

      updatePipelineRun: (id, updates) => {
        set(state => ({
          pipelineRuns: state.pipelineRuns.map(r => r.id === id ? { ...r, ...updates } : r),
        }));
      },

      setActivePipeline: (id) => set({ activePipelineId: id }),

      // ─── Project ──────────────────────────────────────────────────────────────
      currentProject: null,
      recentProjects: [],

      setCurrentProject: (project) => set({ currentProject: project }),

      addRecentProject: (project) => {
        set(state => ({
          recentProjects: [project, ...state.recentProjects.filter(p => p.path !== project.path).slice(0, 9)],
        }));
      },

      // ─── Engine Status ────────────────────────────────────────────────────────
      engineStatus: { provider: 'ollama', model: 'codellama:13b', ollamaOnline: false, totalRequests: 0, totalTokens: 0, errors: 0 },

      setEngineStatus: (status) => set(state => ({ engineStatus: { ...state.engineStatus, ...status } })),

      // ─── Settings ─────────────────────────────────────────────────────────────
      settings: DEFAULT_SETTINGS,

      updateSettings: (updates) => set(state => ({ settings: { ...state.settings, ...updates } })),

      // ─── UI ───────────────────────────────────────────────────────────────────
      sidebarOpen: true,
      activeFile: null,
      openFiles: [],

      setSidebarOpen: (open) => set({ sidebarOpen: open }),
      setActiveFile: (path) => set({ activeFile: path }),

      openFile: (file) => {
        set(state => {
          const exists = state.openFiles.find(f => f.path === file.path);
          if (exists) return { activeFile: file.path };
          return {
            openFiles: [...state.openFiles, { ...file, modified: false }],
            activeFile: file.path,
          };
        });
      },

      closeFile: (filePath) => {
        set(state => {
          const newFiles = state.openFiles.filter(f => f.path !== filePath);
          const newActive = state.activeFile === filePath
            ? newFiles[newFiles.length - 1]?.path ?? null
            : state.activeFile;
          return { openFiles: newFiles, activeFile: newActive };
        });
      },

      updateFileContent: (filePath, content) => {
        set(state => ({
          openFiles: state.openFiles.map(f => f.path === filePath ? { ...f, content, modified: true } : f),
        }));
      },
    })),
    {
      name: 'aetherdev-store',
      partialize: (state) => ({
        sessions: state.sessions.slice(0, 20),
        recentProjects: state.recentProjects,
        settings: state.settings,
      }),
    }
  )
);

// ─── Selectors ────────────────────────────────────────────────────────────────

export const useActiveSession = () => {
  const { sessions, activeSessionId } = useStore();
  return sessions.find(s => s.id === activeSessionId) ?? null;
};

export const useActivePipelineRun = () => {
  const { pipelineRuns, activePipelineId } = useStore();
  return pipelineRuns.find(r => r.id === activePipelineId) ?? null;
};

export const useSettings = () => useStore(s => s.settings);

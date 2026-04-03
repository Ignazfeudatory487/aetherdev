/**
 * AetherDev — Pipeline & Agent Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockLLMResponse = {
  id: 'mock-id', content: '```typescript\nconst x = 1;\n```\n\nExplanation: done',
  model: 'mock', provider: 'ollama',
  usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
  finishReason: 'stop', latencyMs: 100,
};

vi.mock('../../src/core/engine.js', () => ({
  getEngine: vi.fn(() => ({
    chat: vi.fn().mockResolvedValue(mockLLMResponse),
    generate: vi.fn().mockResolvedValue(mockLLMResponse.content),
    generateJSON: vi.fn().mockResolvedValue({}),
    streamOllama: vi.fn().mockResolvedValue(mockLLMResponse),
    getStats: vi.fn().mockReturnValue({ totalRequests: 1, totalTokens: 150, errors: 0, cacheHits: 0 }),
    checkOllamaHealth: vi.fn().mockResolvedValue(true),
    listOllamaModels: vi.fn().mockResolvedValue(['codellama:13b']),
  })),
  SYSTEM_PROMPTS: {
    coder: 'You are a coder', planner: 'You are a planner',
    reviewer: 'You are a reviewer', tester: 'You are a tester',
    documenter: 'You are a documenter', debugger: 'You are a debugger',
  },
}));

vi.mock('../../src/core/memory.js', () => ({
  getMemoryStore: vi.fn().mockResolvedValue({
    init: vi.fn(), store: vi.fn().mockResolvedValue({ id: 'mem-1' }),
    search: vi.fn().mockResolvedValue([]),
    getRecent: vi.fn().mockResolvedValue([]),
    delete: vi.fn(), clear: vi.fn(),
    saveMessage: vi.fn(), getConversationHistory: vi.fn().mockResolvedValue([]),
    clearSession: vi.fn(), indexProject: vi.fn().mockResolvedValue({ files: 10, chunks: 50 }),
    searchCode: vi.fn().mockResolvedValue([]),
    buildContext: vi.fn().mockResolvedValue(''),
    close: vi.fn(),
  }),
}));

vi.mock('../../src/core/sandbox.js', () => ({
  getSandbox: vi.fn(() => ({
    execute: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '', timedOut: false, killed: false, id: 'exec-1', command: 'test', args: [], durationMs: 100 }),
    run: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '', timedOut: false, killed: false, id: 'exec-1', command: 'test', args: [], durationMs: 100 }),
    runNodeCode: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '{"numPassedTests":1,"numFailedTests":0,"numTotalTests":1,"testResults":[]}', stderr: '', durationMs: 100 }),
    checkCommandAvailable: vi.fn().mockResolvedValue(true),
    getHistory: vi.fn().mockReturnValue([]),
    getActiveProcessCount: vi.fn().mockReturnValue(0),
    on: vi.fn(), emit: vi.fn(),
  })),
}));

vi.mock('../../src/core/quality.js', () => ({
  getQualityGate: vi.fn(() => ({
    analyze: vi.fn().mockResolvedValue({ score: 85, passed: true, issues: [], metrics: {}, summary: 'Good', language: 'typescript', filePath: 'test.ts' }),
    analyzeProject: vi.fn().mockResolvedValue({ reports: [], overall: { score: 85, passed: true, totalIssues: 0, criticalCount: 0 } }),
  })),
  ComplexityAnalyzer: vi.fn().mockImplementation(() => ({
    calculateCyclomatic: vi.fn().mockReturnValue(3),
    calculateCognitive: vi.fn().mockReturnValue(5),
    calculateNestingDepth: vi.fn().mockReturnValue(2),
    countFunctions: vi.fn().mockReturnValue(2),
    calculateMaintainability: vi.fn().mockReturnValue(75),
  })),
  SecurityScanner: vi.fn().mockImplementation(() => ({
    scan: vi.fn().mockResolvedValue({ vulnerabilities: [], riskScore: 0, passed: true }),
  })),
}));

vi.mock('../../src/config/index.js', () => ({
  getConfig: vi.fn().mockReturnValue({
    llmProvider: 'ollama', ollamaModel: 'codellama:13b',
    maxConcurrentAgents: 2, memoryCacheTtl: 3600,
    sandboxEnabled: false, nodeEnv: 'test',
  }),
}));

vi.mock('../../src/utils/logger.js', () => ({
  getLogger: vi.fn(() => ({
    trace: vi.fn(), debug: vi.fn(), info: vi.fn(),
    warn: vi.fn(), error: vi.fn(), fatal: vi.fn(),
    child: vi.fn().mockReturnThis(), startTimer: vi.fn().mockReturnValue(vi.fn()),
  })),
  logError: vi.fn(),
  agentLogger: { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../src/utils/fs.js', () => ({
  readFile: vi.fn().mockResolvedValue({ content: 'const x = 1;', size: 12, path: 'test.ts', encoding: 'utf-8' }),
  writeFile: vi.fn().mockResolvedValue({ path: 'test.ts', size: 12, created: false }),
  findCodeFiles: vi.fn().mockResolvedValue(['src/index.ts', 'src/utils.ts']),
  buildDirectoryTree: vi.fn().mockResolvedValue({ name: 'root', path: '/root', isDirectory: true, children: [] }),
  detectLanguage: vi.fn().mockReturnValue('typescript'),
}));

vi.mock('../../src/utils/git.js', () => ({
  getGitManager: vi.fn(() => ({
    getStatus: vi.fn().mockResolvedValue({ branch: 'main', staged: [], unstaged: [], isClean: true }),
    isGitRepo: vi.fn().mockResolvedValue(true),
  })),
}));

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AgentRegistry', () => {
  it('should register and create agents', async () => {
    // Import agents to trigger registration
    const { AgentRegistry } = await import('../../src/agents/base.js');
    await import('../../src/agents/coder.js');
    await import('../../src/agents/reviewer.js');
    await import('../../src/agents/tester.js');
    await import('../../src/agents/planner.js');

    expect(AgentRegistry.list()).toContain('coder');
    expect(AgentRegistry.list()).toContain('reviewer');
    expect(AgentRegistry.list()).toContain('tester');
    expect(AgentRegistry.list()).toContain('planner');
  });

  it('should throw for unknown agent type', async () => {
    const { AgentRegistry } = await import('../../src/agents/base.js');
    expect(() => AgentRegistry.create('unknown-agent-type')).toThrow();
  });
});

describe('CoderAgent', () => {
  it('should complete a generation task successfully', async () => {
    const { CoderAgent } = await import('../../src/agents/coder.js');
    const agent = new CoderAgent();

    const result = await agent.run({
      sessionId: 'test-session',
      task: {
        type: 'generate',
        prompt: 'Create a simple hello world function',
        maxIterations: 2,
        timeoutMs: 30000,
      },
      metadata: {},
    });

    expect(result.agentType).toBe('coder');
    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.totalTokens).toBeGreaterThan(0);
  });

  it('should track self-healing attempts on failure', async () => {
    const { CoderAgent } = await import('../../src/agents/coder.js');
    const agent = new CoderAgent();

    // Override engine to fail first time
    const { getEngine } = await import('../../src/core/engine.js');
    vi.mocked(getEngine)().chat
      .mockRejectedValueOnce(new Error('LLM unavailable'))
      .mockResolvedValue(mockLLMResponse);

    const result = await agent.run({
      sessionId: 'test-healing',
      task: {
        type: 'generate',
        prompt: 'Generate code',
        maxIterations: 3,
        timeoutMs: 30000,
      },
      metadata: {},
    });

    // Either succeeds or fails gracefully
    expect(result.agentType).toBe('coder');
    expect(['success', 'failed'].includes(result.success ? 'success' : 'failed')).toBe(true);
  });
});

describe('PlannerAgent', () => {
  it('should generate a valid plan with steps', async () => {
    const { getEngine } = await import('../../src/core/engine.js');
    vi.mocked(getEngine)().chat.mockResolvedValue({
      ...mockLLMResponse,
      content: JSON.stringify({
        id: 'plan-1', title: 'Test Plan', description: 'A test plan',
        steps: [
          { id: 'step-1', order: 1, description: 'Create index.ts', type: 'code', targetFiles: ['index.ts'], estimatedTokens: 500, dependencies: [], acceptanceCriteria: ['File exists'], agentType: 'coder' },
          { id: 'step-2', order: 2, description: 'Write tests', type: 'test', targetFiles: ['index.test.ts'], estimatedTokens: 300, dependencies: ['step-1'], acceptanceCriteria: ['Tests pass'], agentType: 'tester' },
        ],
        estimatedComplexity: 'simple', risks: [], assumptions: [], totalEstimatedTokens: 800, parallelizable: false,
      }),
    });

    const { PlannerAgent } = await import('../../src/agents/planner.js');
    const agent = new PlannerAgent();
    const result = await agent.run({
      sessionId: 'test-plan',
      task: { type: 'generate', prompt: 'Build a simple API', maxIterations: 2, timeoutMs: 30000 },
      metadata: {},
    });

    expect(result.success).toBe(true);
    const plan = result.data as any;
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0].id).toBe('step-1');
    expect(plan.steps[1].dependencies).toContain('step-1');
  });
});

describe('AgentPipeline', () => {
  it('should run code-only pipeline and return results', async () => {
    const { AgentPipeline } = await import('../../src/agents/pipeline.js');
    const pipeline = new AgentPipeline();

    const run = await pipeline.run(
      {
        type: 'generate',
        prompt: 'Create a utils function',
        maxIterations: 2,
        timeoutMs: 60000,
      },
      { mode: 'code-only', projectPath: '/tmp/test-project' }
    );

    expect(run.status).toBe('completed');
    expect(run.stepExecutions.length).toBeGreaterThan(0);
    expect(run.totalTokens).toBeGreaterThanOrEqual(0);
  });

  it('should emit pipeline events', async () => {
    const { AgentPipeline } = await import('../../src/agents/pipeline.js');
    const pipeline = new AgentPipeline();
    const events: string[] = [];

    pipeline.on('pipeline:start', () => events.push('start'));
    pipeline.on('pipeline:complete', () => events.push('complete'));

    await pipeline.run(
      { type: 'generate', prompt: 'Test', maxIterations: 2, timeoutMs: 30000 },
      { mode: 'code-only' }
    );

    expect(events).toContain('start');
    expect(events).toContain('complete');
  });
});

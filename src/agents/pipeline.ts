/**
 * AetherDev — Multi-Agent Pipeline
 * Orchestrates: Planner → Coder → Reviewer → Tester
 * Supports sequential and parallel execution with dependency resolution
 */

import { EventEmitter } from 'eventemitter3';
import pLimit from 'p-limit';
import { v4 as uuidv4 } from 'uuid';
import { AgentRegistry, AgentContext, AgentResult, BaseAgent } from './base.js';
import { PlannerAgent, ExecutionPlan, PlanStep } from './planner.js';
import { CoderAgent, CoderResult } from './coder.js';
import { ReviewerAgent, ReviewResult } from './reviewer.js';
import { TesterAgent, TesterResult } from './tester.js';
import { ValidatedTask } from '../utils/validator.js';
import { getLogger } from '../utils/logger.js';
import { getConfig } from '../config/index.js';
import { getMemoryStore } from '../core/memory.js';

const logger = getLogger('pipeline');

// ─── Types ────────────────────────────────────────────────────────────────────

export type PipelineMode = 'full' | 'plan-only' | 'code-only' | 'review-only' | 'test-only' | 'auto';

export interface PipelineOptions {
  mode?: PipelineMode;
  projectPath?: string;
  sessionId?: string;
  autoReview?: boolean;
  autoTest?: boolean;
  skipOnLowQuality?: boolean;
  qualityThreshold?: number;
  maxParallel?: number;
}

export interface StepExecution {
  stepId: string;
  agentType: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'skipped';
  result?: AgentResult;
  error?: string;
  startedAt?: number;
  completedAt?: number;
}

export interface PipelineRun {
  id: string;
  sessionId: string;
  task: ValidatedTask;
  plan?: ExecutionPlan;
  stepExecutions: StepExecution[];
  results: {
    code?: CoderResult;
    review?: ReviewResult;
    tests?: TesterResult;
  };
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: number;
  completedAt?: number;
  totalTokens: number;
  error?: string;
  qualityGatePassed: boolean;
}

// ─── Pipeline ─────────────────────────────────────────────────────────────────

export class AgentPipeline extends EventEmitter {
  private readonly cfg = getConfig();
  private activeRuns = new Map<string, PipelineRun>();

  constructor() {
    super();
  }

  async run(task: ValidatedTask, options: PipelineOptions = {}): Promise<PipelineRun> {
    const runId = uuidv4();
    const sessionId = options.sessionId ?? uuidv4();
    const start = Date.now();

    const pipelineRun: PipelineRun = {
      id: runId, sessionId, task,
      stepExecutions: [], results: {},
      status: 'running', startedAt: start, totalTokens: 0,
      qualityGatePassed: true,
    };

    this.activeRuns.set(runId, pipelineRun);
    this.emit('pipeline:start', { runId, task });
    logger.info('Pipeline started', { runId, taskType: task.type, mode: options.mode ?? 'auto' });

    try {
      const mode = options.mode ?? this.detectMode(task);
      const baseCtx: AgentContext = {
        sessionId, task, projectPath: options.projectPath,
        metadata: { pipelineId: runId },
      };

      switch (mode) {
        case 'full':
          await this.runFullPipeline(pipelineRun, baseCtx, options);
          break;
        case 'plan-only':
          await this.runPlanOnly(pipelineRun, baseCtx);
          break;
        case 'code-only':
          await this.runCodeOnly(pipelineRun, baseCtx);
          break;
        case 'review-only':
          await this.runReviewOnly(pipelineRun, baseCtx);
          break;
        case 'test-only':
          await this.runTestOnly(pipelineRun, baseCtx);
          break;
        case 'auto':
          await this.runAuto(pipelineRun, baseCtx, options);
          break;
      }

      pipelineRun.status = 'completed';
    } catch (err) {
      pipelineRun.status = 'failed';
      pipelineRun.error = err instanceof Error ? err.message : String(err);
      logger.error('Pipeline failed', { runId, error: pipelineRun.error });
    } finally {
      pipelineRun.completedAt = Date.now();
      pipelineRun.totalTokens = pipelineRun.stepExecutions
        .reduce((s, e) => s + (e.result?.totalTokens ?? 0), 0);
      this.emit('pipeline:complete', pipelineRun);
      logger.info('Pipeline completed', {
        runId,
        status: pipelineRun.status,
        steps: pipelineRun.stepExecutions.length,
        tokens: pipelineRun.totalTokens,
        duration: (pipelineRun.completedAt - start) / 1000,
      });
    }

    return pipelineRun;
  }

  // ─── Pipeline Modes ────────────────────────────────────────────────────────

  private async runFullPipeline(
    run: PipelineRun,
    ctx: AgentContext,
    options: PipelineOptions
  ): Promise<void> {
    // 1. Plan
    const plan = await this.execAgent('planner', ctx, run);
    if (plan?.success) {
      run.plan = plan.data as ExecutionPlan;
    }

    // 2. Execute plan steps
    if (run.plan) {
      await this.executePlanSteps(run.plan, ctx, run, options);
    } else {
      // Fallback: just code
      const codeResult = await this.execAgent('coder', ctx, run);
      if (codeResult?.success) run.results.code = codeResult.data as CoderResult;
    }

    // 3. Review
    if (options.autoReview !== false && run.results.code) {
      const reviewCtx = { ...ctx, task: { ...ctx.task, type: 'review' as const } };
      const reviewResult = await this.execAgent('reviewer', reviewCtx, run);
      if (reviewResult?.success) {
        run.results.review = reviewResult.data as ReviewResult;
        run.qualityGatePassed = run.results.review.score >= (options.qualityThreshold ?? 60);
      }
    }

    // 4. Test
    if (options.autoTest !== false) {
      const testCtx = { ...ctx, task: { ...ctx.task, type: 'test' as const } };
      const testResult = await this.execAgent('tester', testCtx, run);
      if (testResult?.success) run.results.tests = testResult.data as TesterResult;
    }
  }

  private async runAuto(
    run: PipelineRun,
    ctx: AgentContext,
    options: PipelineOptions
  ): Promise<void> {
    const taskType = ctx.task.type;

    if (taskType === 'generate' || taskType === 'refactor') {
      await this.runFullPipeline(run, ctx, { ...options, autoReview: true, autoTest: true });
    } else if (taskType === 'debug') {
      // Debug: code + test
      const codeResult = await this.execAgent('coder', ctx, run);
      if (codeResult?.success) run.results.code = codeResult.data as CoderResult;
      const testCtx = { ...ctx, task: { ...ctx.task, type: 'test' as const } };
      const testResult = await this.execAgent('tester', testCtx, run);
      if (testResult?.success) run.results.tests = testResult.data as TesterResult;
    } else if (taskType === 'review') {
      await this.runReviewOnly(run, ctx);
    } else if (taskType === 'test') {
      await this.runTestOnly(run, ctx);
    } else {
      // Default: just code
      const codeResult = await this.execAgent('coder', ctx, run);
      if (codeResult?.success) run.results.code = codeResult.data as CoderResult;
    }
  }

  private async runPlanOnly(run: PipelineRun, ctx: AgentContext): Promise<void> {
    const result = await this.execAgent('planner', ctx, run);
    if (result?.success) run.plan = result.data as ExecutionPlan;
  }

  private async runCodeOnly(run: PipelineRun, ctx: AgentContext): Promise<void> {
    const result = await this.execAgent('coder', ctx, run);
    if (result?.success) run.results.code = result.data as CoderResult;
  }

  private async runReviewOnly(run: PipelineRun, ctx: AgentContext): Promise<void> {
    const result = await this.execAgent('reviewer', ctx, run);
    if (result?.success) run.results.review = result.data as ReviewResult;
  }

  private async runTestOnly(run: PipelineRun, ctx: AgentContext): Promise<void> {
    const result = await this.execAgent('tester', ctx, run);
    if (result?.success) run.results.tests = result.data as TesterResult;
  }

  // ─── Plan Execution ────────────────────────────────────────────────────────

  private async executePlanSteps(
    plan: ExecutionPlan,
    baseCtx: AgentContext,
    run: PipelineRun,
    options: PipelineOptions
  ): Promise<void> {
    const maxParallel = options.maxParallel ?? this.cfg.maxConcurrentAgents;
    const limit = pLimit(maxParallel);

    // Topological sort for dependency resolution
    const ordered = this.topologicalSort(plan.steps);
    const completed = new Set<string>();

    for (const batch of this.groupIntoWaves(ordered)) {
      await Promise.all(
        batch.map(step => limit(async () => {
          // Check dependencies
          const depsOk = step.dependencies.every(d => completed.has(d));
          if (!depsOk) {
            this.markStepSkipped(step.id, run);
            return;
          }

          const stepCtx: AgentContext = {
            ...baseCtx,
            task: {
              ...baseCtx.task,
              type: this.mapStepTypeToTask(step.type),
              prompt: step.description,
              targetFiles: step.targetFiles,
            },
            metadata: { ...baseCtx.metadata, planStepId: step.id },
          };

          const result = await this.execAgent(step.agentType, stepCtx, run);

          if (result?.success) {
            completed.add(step.id);
            // Accumulate code results
            if (step.agentType === 'coder' && result.data) {
              const coderData = result.data as CoderResult;
              run.results.code = run.results.code
                ? { ...run.results.code, files: [...run.results.code.files, ...coderData.files] }
                : coderData;
            }
          }
        }))
      );
    }
  }

  private groupIntoWaves(steps: PlanStep[]): PlanStep[][] {
    const waves: PlanStep[][] = [];
    const remaining = [...steps];
    const done = new Set<string>();

    while (remaining.length > 0) {
      const wave = remaining.filter(s =>
        s.dependencies.every(d => done.has(d))
      );
      if (wave.length === 0) {
        // Circular dependency — add all remaining
        waves.push(remaining.splice(0));
        break;
      }
      waves.push(wave);
      wave.forEach(s => {
        done.add(s.id);
        remaining.splice(remaining.indexOf(s), 1);
      });
    }
    return waves;
  }

  private topologicalSort(steps: PlanStep[]): PlanStep[] {
    const visited = new Set<string>();
    const result: PlanStep[] = [];
    const stepMap = new Map(steps.map(s => [s.id, s]));

    function visit(step: PlanStep): void {
      if (visited.has(step.id)) return;
      visited.add(step.id);
      for (const dep of step.dependencies) {
        const depStep = stepMap.get(dep);
        if (depStep) visit(depStep);
      }
      result.push(step);
    }

    steps.forEach(s => visit(s));
    return result;
  }

  // ─── Agent Execution ───────────────────────────────────────────────────────

  private async execAgent(
    agentType: string,
    ctx: AgentContext,
    run: PipelineRun
  ): Promise<AgentResult | null> {
    const execEntry: StepExecution = {
      stepId: uuidv4(),
      agentType,
      status: 'running',
      startedAt: Date.now(),
    };
    run.stepExecutions.push(execEntry);
    this.emit('step:start', { runId: run.id, agentType, stepId: execEntry.stepId });

    try {
      const agent = AgentRegistry.create(agentType);
      const result = await agent.run(ctx);

      execEntry.status = result.success ? 'done' : 'failed';
      execEntry.result = result;
      execEntry.completedAt = Date.now();
      execEntry.error = result.error;

      this.emit('step:complete', { runId: run.id, agentType, result });
      return result;
    } catch (err) {
      execEntry.status = 'failed';
      execEntry.error = err instanceof Error ? err.message : String(err);
      execEntry.completedAt = Date.now();
      logger.error(`Agent ${agentType} threw exception`, { error: execEntry.error });
      this.emit('step:error', { runId: run.id, agentType, error: execEntry.error });
      return null;
    }
  }

  private markStepSkipped(stepId: string, run: PipelineRun): void {
    run.stepExecutions.push({
      stepId, agentType: 'unknown',
      status: 'skipped', startedAt: Date.now(), completedAt: Date.now(),
    });
  }

  private mapStepTypeToTask(stepType: string): ValidatedTask['type'] {
    const map: Record<string, ValidatedTask['type']> = {
      code: 'generate', test: 'test', docs: 'document',
      refactor: 'refactor', review: 'review', execute: 'custom', analyze: 'explain',
    };
    return map[stepType] ?? 'generate';
  }

  private detectMode(task: ValidatedTask): PipelineMode {
    const typeMap: Record<string, PipelineMode> = {
      generate: 'full', refactor: 'full', debug: 'auto',
      test: 'test-only', review: 'review-only',
      explain: 'code-only', document: 'code-only', custom: 'auto',
    };
    return typeMap[task.type] ?? 'auto';
  }

  // ─── Management ───────────────────────────────────────────────────────────

  getRun(runId: string): PipelineRun | undefined {
    return this.activeRuns.get(runId);
  }

  getActiveRuns(): PipelineRun[] {
    return Array.from(this.activeRuns.values()).filter(r => r.status === 'running');
  }

  cancel(runId: string): boolean {
    const run = this.activeRuns.get(runId);
    if (run && run.status === 'running') {
      run.status = 'cancelled';
      run.completedAt = Date.now();
      this.emit('pipeline:cancelled', { runId });
      return true;
    }
    return false;
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let _pipeline: AgentPipeline | null = null;

export function getPipeline(): AgentPipeline {
  if (!_pipeline) _pipeline = new AgentPipeline();
  return _pipeline;
}

export default getPipeline;

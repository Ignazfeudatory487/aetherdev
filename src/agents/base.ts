/**
 * AetherDev — Base Agent
 * Foundation class for all agents: Planner, Coder, Reviewer, Tester, Documenter
 * Includes self-healing, retry, fallback, and event emission
 */

import { EventEmitter } from 'eventemitter3';
import { v4 as uuidv4 } from 'uuid';
import pRetry from 'p-retry';
import { getEngine, AetherEngine, LLMRequest, SYSTEM_PROMPTS } from '../core/engine.js';
import { getMemoryStore, MemoryStore } from '../core/memory.js';
import { getSandbox, Sandbox } from '../core/sandbox.js';
import { getLogger, AetherLogger, formatError } from '../utils/logger.js';
import { ValidatedTask } from '../utils/validator.js';
import { getConfig, AetherConfig } from '../config/index.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type AgentStatus = 'idle' | 'running' | 'paused' | 'completed' | 'failed' | 'healing';

export interface AgentContext {
  sessionId: string;
  projectPath?: string;
  task: ValidatedTask;
  metadata: Record<string, unknown>;
}

export interface AgentResult<T = unknown> {
  agentId: string;
  agentType: string;
  sessionId: string;
  success: boolean;
  data: T;
  error?: string;
  iterations: number;
  totalTokens: number;
  durationMs: number;
  selfHealingAttempts: number;
  qualityScore?: number;
}

export interface AgentStep {
  id: string;
  name: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  startedAt?: number;
  completedAt?: number;
  result?: unknown;
  error?: string;
}

export interface HealingStrategy {
  name: string;
  condition: (error: Error, attempt: number) => boolean;
  action: (ctx: AgentContext, error: Error) => Promise<void>;
}

// ─── Base Agent ───────────────────────────────────────────────────────────────

export abstract class BaseAgent<TResult = unknown> extends EventEmitter {
  readonly id: string;
  abstract readonly type: string;
  abstract readonly description: string;

  protected status: AgentStatus = 'idle';
  protected steps: AgentStep[] = [];
  protected totalTokens = 0;
  protected selfHealingAttempts = 0;

  protected readonly engine: AetherEngine;
  protected readonly sandbox: Sandbox;
  protected readonly cfg: AetherConfig;
  protected readonly logger: AetherLogger;

  private memoryStore: MemoryStore | null = null;

  constructor() {
    super();
    this.id = uuidv4();
    this.engine = getEngine();
    this.sandbox = getSandbox();
    this.cfg = getConfig();
    this.logger = getLogger(`agent:${this.constructor.name.toLowerCase()}`);
  }

  protected async getMemory(): Promise<MemoryStore> {
    if (!this.memoryStore) {
      this.memoryStore = await getMemoryStore();
    }
    return this.memoryStore;
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  async run(context: AgentContext): Promise<AgentResult<TResult>> {
    const start = Date.now();
    this.status = 'running';
    this.totalTokens = 0;
    this.selfHealingAttempts = 0;

    this.emit('agent:start', { agentId: this.id, type: this.type, context });
    this.logger.info(`Agent started`, { agentId: this.id, type: this.type, task: context.task.type });

    try {
      const result = await pRetry(
        async (attemptNum) => {
          if (attemptNum > 1) {
            this.status = 'healing';
            this.selfHealingAttempts++;
            this.emit('agent:healing', { agentId: this.id, attempt: attemptNum });
            this.logger.warn(`Self-healing attempt ${attemptNum}`, { agentId: this.id });
          }
          return this.execute(context);
        },
        {
          retries: context.task.maxIterations - 1,
          minTimeout: 2000,
          maxTimeout: 15000,
          factor: 1.5,
          onFailedAttempt: async (err) => {
            this.logger.warn(`Attempt ${err.attemptNumber} failed: ${err.message}`);
            await this.onHealingAttempt(context, err, err.attemptNumber);
          },
        }
      );

      this.status = 'completed';
      const agentResult: AgentResult<TResult> = {
        agentId: this.id,
        agentType: this.type,
        sessionId: context.sessionId,
        success: true,
        data: result,
        iterations: this.steps.length,
        totalTokens: this.totalTokens,
        durationMs: Date.now() - start,
        selfHealingAttempts: this.selfHealingAttempts,
      };

      this.emit('agent:complete', agentResult);
      this.logger.info(`Agent completed`, {
        agentId: this.id,
        tokens: this.totalTokens,
        duration: agentResult.durationMs,
        healed: this.selfHealingAttempts,
      });

      // Save to memory
      await this.saveToMemory(context, agentResult);

      return agentResult;
    } catch (err) {
      this.status = 'failed';
      const error = err instanceof Error ? err.message : String(err);
      this.logger.error(`Agent failed`, { agentId: this.id, error: formatError(err) });
      this.emit('agent:error', { agentId: this.id, error });

      return {
        agentId: this.id,
        agentType: this.type,
        sessionId: context.sessionId,
        success: false,
        data: null as unknown as TResult,
        error,
        iterations: this.steps.length,
        totalTokens: this.totalTokens,
        durationMs: Date.now() - start,
        selfHealingAttempts: this.selfHealingAttempts,
      };
    }
  }

  protected abstract execute(context: AgentContext): Promise<TResult>;

  protected async onHealingAttempt(
    context: AgentContext,
    error: pRetry.FailedAttemptError,
    attempt: number
  ): Promise<void> {
    // Default: log and wait — subclasses can override with specific healing
    this.logger.debug(`Default healing: waiting before retry`, { attempt });
  }

  // ─── Step Management ───────────────────────────────────────────────────────

  protected addStep(name: string): AgentStep {
    const step: AgentStep = { id: uuidv4(), name, status: 'pending' };
    this.steps.push(step);
    return step;
  }

  protected startStep(step: AgentStep): void {
    step.status = 'running';
    step.startedAt = Date.now();
    this.emit('step:start', { agentId: this.id, step });
    this.logger.debug(`Step started: ${step.name}`);
  }

  protected completeStep(step: AgentStep, result?: unknown): void {
    step.status = 'done';
    step.completedAt = Date.now();
    step.result = result;
    this.emit('step:complete', { agentId: this.id, step });
    this.logger.debug(`Step completed: ${step.name}`);
  }

  protected failStep(step: AgentStep, error: string): void {
    step.status = 'failed';
    step.completedAt = Date.now();
    step.error = error;
    this.emit('step:failed', { agentId: this.id, step, error });
    this.logger.warn(`Step failed: ${step.name}`, { error });
  }

  protected skipStep(step: AgentStep): void {
    step.status = 'skipped';
    this.emit('step:skipped', { agentId: this.id, step });
  }

  protected async runStep<T>(
    name: string,
    fn: () => Promise<T>
  ): Promise<T> {
    const step = this.addStep(name);
    this.startStep(step);
    try {
      const result = await fn();
      this.completeStep(step, result);
      return result;
    } catch (err) {
      this.failStep(step, err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  // ─── LLM Helpers ──────────────────────────────────────────────────────────

  protected async llm(request: LLMRequest): Promise<string> {
    const response = await this.engine.chat(request);
    this.totalTokens += response.usage.totalTokens;
    return response.content;
  }

  protected async llmWithContext(
    prompt: string,
    systemPrompt: string,
    context: AgentContext,
    historyLimit: number = 6
  ): Promise<string> {
    const memory = await this.getMemory();
    const history = await memory.getConversationHistory(context.sessionId, historyLimit);

    const messages = [
      ...history.map(h => ({ role: h.role as 'user' | 'assistant', content: h.content })),
      { role: 'user' as const, content: prompt },
    ];

    const response = await this.engine.chat({ messages, systemPrompt });
    this.totalTokens += response.usage.totalTokens;

    // Save to conversation history
    await memory.saveMessage(context.sessionId, 'user', prompt);
    await memory.saveMessage(context.sessionId, 'assistant', response.content);

    return response.content;
  }

  protected async buildContextFromProject(
    query: string,
    context: AgentContext
  ): Promise<string> {
    if (!context.projectPath) return '';
    const memory = await this.getMemory();
    return memory.buildContext(query, context.projectPath);
  }

  // ─── Memory ───────────────────────────────────────────────────────────────

  private async saveToMemory(context: AgentContext, result: AgentResult<TResult>): Promise<void> {
    try {
      const memory = await this.getMemory();
      await memory.store({
        type: 'task',
        content: `Task: ${context.task.prompt}\nResult: ${JSON.stringify(result.data).slice(0, 500)}`,
        metadata: {
          projectPath: context.projectPath,
          timestamp: Date.now(),
          tags: [this.type, context.task.type],
        },
      });
    } catch {
      // Non-critical — don't fail the agent
    }
  }

  // ─── Status ───────────────────────────────────────────────────────────────

  getStatus(): AgentStatus {
    return this.status;
  }

  getSteps(): ReadonlyArray<AgentStep> {
    return this.steps;
  }

  pause(): void {
    if (this.status === 'running') {
      this.status = 'paused';
      this.emit('agent:paused', { agentId: this.id });
    }
  }

  resume(): void {
    if (this.status === 'paused') {
      this.status = 'running';
      this.emit('agent:resumed', { agentId: this.id });
    }
  }
}

// ─── Agent Factory ────────────────────────────────────────────────────────────

export interface AgentConstructor<T = unknown> {
  new(): BaseAgent<T>;
}

export class AgentRegistry {
  private static readonly registry = new Map<string, AgentConstructor>();

  static register(type: string, ctor: AgentConstructor): void {
    this.registry.set(type, ctor);
  }

  static create<T = unknown>(type: string): BaseAgent<T> {
    const Ctor = this.registry.get(type);
    if (!Ctor) throw new Error(`Unknown agent type: ${type}`);
    return new Ctor() as BaseAgent<T>;
  }

  static list(): string[] {
    return Array.from(this.registry.keys());
  }
}

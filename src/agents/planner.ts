/**
 * AetherDev — Planner Agent
 * Breaks complex tasks into structured, dependency-aware execution plans
 */

import { BaseAgent, AgentContext, AgentRegistry } from './base.js';
import { SYSTEM_PROMPTS } from '../core/engine.js';
import { extractJsonFromResponse } from '../utils/validator.js';
import { buildDirectoryTree } from '../utils/fs.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PlanStep {
  id: string;
  order: number;
  description: string;
  type: 'code' | 'test' | 'docs' | 'refactor' | 'review' | 'execute' | 'analyze';
  targetFiles: string[];
  estimatedTokens: number;
  dependencies: string[];
  acceptanceCriteria: string[];
  agentType: 'coder' | 'tester' | 'reviewer' | 'documenter' | 'executor';
}

export interface ExecutionPlan {
  id: string;
  title: string;
  description: string;
  steps: PlanStep[];
  estimatedComplexity: 'trivial' | 'simple' | 'moderate' | 'complex' | 'very-complex';
  risks: string[];
  assumptions: string[];
  totalEstimatedTokens: number;
  parallelizable: boolean;
}

// ─── Planner Agent ────────────────────────────────────────────────────────────

export class PlannerAgent extends BaseAgent<ExecutionPlan> {
  readonly type = 'planner';
  readonly description = 'Breaks tasks into structured, actionable execution plans';

  protected async execute(context: AgentContext): Promise<ExecutionPlan> {
    const { task, projectPath } = context;

    // Step 1: Gather project context
    const projectContext = await this.runStep('gather-project-context', async () => {
      if (!projectPath) return '';
      try {
        const tree = await buildDirectoryTree(projectPath, 3);
        return `Project structure:\n${JSON.stringify(tree, null, 2).slice(0, 2000)}`;
      } catch {
        return '';
      }
    });

    // Step 2: Retrieve relevant memories
    const memContext = await this.runStep('retrieve-memory', async () => {
      if (!projectPath) return '';
      return this.buildContextFromProject(task.prompt, context);
    });

    // Step 3: Generate plan
    const plan = await this.runStep('generate-plan', async () => {
      const prompt = this.buildPlanPrompt(task.prompt, projectContext, memContext, task.targetFiles ?? []);
      const response = await this.llm({
        messages: [{ role: 'user', content: prompt }],
        systemPrompt: SYSTEM_PROMPTS.planner,
        responseFormat: 'json',
        temperature: 0.1,
      });

      return this.parsePlan(response, task.prompt);
    });

    // Step 4: Validate and enrich plan
    return await this.runStep('validate-plan', async () => {
      return this.validateAndEnrichPlan(plan, projectPath);
    });
  }

  private buildPlanPrompt(
    userPrompt: string,
    projectContext: string,
    memContext: string,
    targetFiles: string[]
  ): string {
    const parts = [
      `You must create a detailed execution plan for the following task:`,
      ``,
      `TASK: ${userPrompt}`,
    ];

    if (targetFiles.length > 0) {
      parts.push(``, `TARGET FILES: ${targetFiles.join(', ')}`);
    }

    if (projectContext) {
      parts.push(``, `PROJECT CONTEXT:`, projectContext);
    }

    if (memContext) {
      parts.push(``, `RELEVANT CODEBASE CONTEXT:`, memContext.slice(0, 2000));
    }

    parts.push(
      ``,
      `Return a JSON object with this EXACT structure:`,
      `{`,
      `  "id": "plan-uuid",`,
      `  "title": "Short plan title",`,
      `  "description": "What this plan accomplishes",`,
      `  "steps": [`,
      `    {`,
      `      "id": "step-1",`,
      `      "order": 1,`,
      `      "description": "What to do",`,
      `      "type": "code|test|docs|refactor|review|execute|analyze",`,
      `      "targetFiles": ["src/file.ts"],`,
      `      "estimatedTokens": 500,`,
      `      "dependencies": [],`,
      `      "acceptanceCriteria": ["Criterion 1"],`,
      `      "agentType": "coder|tester|reviewer|documenter|executor"`,
      `    }`,
      `  ],`,
      `  "estimatedComplexity": "trivial|simple|moderate|complex|very-complex",`,
      `  "risks": ["Risk 1"],`,
      `  "assumptions": ["Assumption 1"],`,
      `  "totalEstimatedTokens": 2000,`,
      `  "parallelizable": false`,
      `}`
    );

    return parts.join('\n');
  }

  private parsePlan(response: string, originalPrompt: string): ExecutionPlan {
    try {
      const parsed = extractJsonFromResponse(response) as Partial<ExecutionPlan>;

      return {
        id: parsed.id ?? `plan-${Date.now()}`,
        title: parsed.title ?? originalPrompt.slice(0, 60),
        description: parsed.description ?? originalPrompt,
        steps: (parsed.steps ?? []).map((s, i) => ({
          id: s.id ?? `step-${i + 1}`,
          order: s.order ?? i + 1,
          description: s.description ?? `Step ${i + 1}`,
          type: s.type ?? 'code',
          targetFiles: s.targetFiles ?? [],
          estimatedTokens: s.estimatedTokens ?? 500,
          dependencies: s.dependencies ?? [],
          acceptanceCriteria: s.acceptanceCriteria ?? ['Implementation complete'],
          agentType: s.agentType ?? 'coder',
        })),
        estimatedComplexity: parsed.estimatedComplexity ?? 'moderate',
        risks: parsed.risks ?? [],
        assumptions: parsed.assumptions ?? [],
        totalEstimatedTokens: parsed.totalEstimatedTokens ?? 2000,
        parallelizable: parsed.parallelizable ?? false,
      };
    } catch {
      // Fallback: create minimal plan
      return {
        id: `plan-${Date.now()}`,
        title: originalPrompt.slice(0, 60),
        description: originalPrompt,
        steps: [{
          id: 'step-1', order: 1,
          description: originalPrompt,
          type: 'code', targetFiles: [],
          estimatedTokens: 2000,
          dependencies: [],
          acceptanceCriteria: ['Implementation complete'],
          agentType: 'coder',
        }],
        estimatedComplexity: 'moderate',
        risks: ['Could not parse detailed plan — using fallback'],
        assumptions: [],
        totalEstimatedTokens: 2000,
        parallelizable: false,
      };
    }
  }

  private validateAndEnrichPlan(plan: ExecutionPlan, projectPath?: string): ExecutionPlan {
    // Ensure unique IDs
    const seenIds = new Set<string>();
    plan.steps = plan.steps.map((step, i) => {
      if (seenIds.has(step.id)) {
        step.id = `${step.id}-${i}`;
      }
      seenIds.add(step.id);
      return step;
    });

    // Sort by order
    plan.steps.sort((a, b) => a.order - b.order);

    // Validate dependencies exist
    const stepIds = new Set(plan.steps.map(s => s.id));
    plan.steps = plan.steps.map(step => ({
      ...step,
      dependencies: step.dependencies.filter(dep => stepIds.has(dep)),
    }));

    // Recalculate total tokens
    plan.totalEstimatedTokens = plan.steps.reduce((s, step) => s + step.estimatedTokens, 0);

    // Check parallelizability
    const hasDependencies = plan.steps.some(s => s.dependencies.length > 0);
    plan.parallelizable = !hasDependencies && plan.steps.length > 1;

    this.logger.info('Plan validated', {
      steps: plan.steps.length,
      complexity: plan.estimatedComplexity,
      tokens: plan.totalEstimatedTokens,
    });

    return plan;
  }
}

AgentRegistry.register('planner', PlannerAgent);
export default PlannerAgent;

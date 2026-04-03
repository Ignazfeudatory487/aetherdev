/**
 * AetherDev — Reviewer Agent
 * Code review: security, performance, bugs, style, test coverage
 * Returns structured, actionable feedback with severity levels
 */

import * as path from 'path';
import { BaseAgent, AgentContext, AgentRegistry } from './base.js';
import { SYSTEM_PROMPTS } from '../core/engine.js';
import { extractJsonFromResponse } from '../utils/validator.js';
import { readFile, detectLanguage } from '../utils/fs.js';
import { getQualityGate, QualityIssue, Severity } from '../core/quality.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ReviewComment {
  id: string;
  severity: Severity;
  category: 'security' | 'performance' | 'correctness' | 'style' | 'maintainability' | 'testing' | 'documentation';
  filePath: string;
  line?: number;
  title: string;
  description: string;
  suggestion: string;
  codeSnippet?: string;
  fixedSnippet?: string;
  references?: string[];
}

export interface ReviewResult {
  approved: boolean;
  score: number;
  summary: string;
  comments: ReviewComment[];
  qualityMetrics: {
    securityScore: number;
    performanceScore: number;
    maintainabilityScore: number;
    testabilityScore: number;
    overallScore: number;
  };
  recommendations: string[];
  mustFix: ReviewComment[];
  niceToFix: ReviewComment[];
  praise: string[];
}

// ─── Reviewer Agent ───────────────────────────────────────────────────────────

export class ReviewerAgent extends BaseAgent<ReviewResult> {
  readonly type = 'reviewer';
  readonly description = 'Reviews code for security, performance, bugs, and maintainability';

  protected async execute(context: AgentContext): Promise<ReviewResult> {
    const { task } = context;
    const targetFiles = task.targetFiles ?? [];

    // Step 1: Read all target files
    const filesContent = await this.runStep('read-files', async () => {
      return this.readFiles(targetFiles, context.projectPath);
    });

    if (filesContent.length === 0) {
      return this.emptyReview('No files to review');
    }

    // Step 2: Run automated quality gate
    const gateResults = await this.runStep('quality-gate', async () => {
      const gate = getQualityGate();
      const results = [];
      for (const { filePath } of filesContent) {
        try {
          const report = await gate.analyze(filePath);
          results.push(report);
        } catch {
          // Continue with other files
        }
      }
      return results;
    });

    // Step 3: LLM code review
    const llmReview = await this.runStep('llm-review', async () => {
      const combinedCode = filesContent
        .map(f => `// === ${f.filePath} ===\n${f.content.slice(0, 2500)}`)
        .join('\n\n');

      const prompt = this.buildReviewPrompt(combinedCode, task.prompt);

      const response = await this.llm({
        messages: [{ role: 'user', content: prompt }],
        systemPrompt: SYSTEM_PROMPTS.reviewer,
        responseFormat: 'json',
        temperature: 0.1,
      });

      return this.parseReviewResponse(response);
    });

    // Step 4: Merge automated + LLM results
    return await this.runStep('merge-results', async () => {
      return this.mergeResults(llmReview, gateResults, filesContent);
    });
  }

  private async readFiles(
    targetFiles: string[],
    projectPath?: string
  ): Promise<Array<{ filePath: string; content: string; language: string }>> {
    const results = [];
    for (const filePath of targetFiles.slice(0, 15)) {
      try {
        const fullPath = path.isAbsolute(filePath)
          ? filePath
          : path.join(projectPath ?? process.cwd(), filePath);
        const result = await readFile(fullPath);
        results.push({
          filePath: fullPath,
          content: result.content,
          language: detectLanguage(fullPath),
        });
      } catch {
        // File not readable — skip
      }
    }
    return results;
  }

  private buildReviewPrompt(code: string, reviewFocus: string): string {
    return `Review the following code thoroughly. ${reviewFocus ? `Focus especially on: ${reviewFocus}` : ''}

${code}

Return a JSON review object with this structure:
{
  "approved": false,
  "score": 75,
  "summary": "Overall review summary",
  "comments": [
    {
      "id": "c1",
      "severity": "critical|high|medium|low|info",
      "category": "security|performance|correctness|style|maintainability|testing|documentation",
      "filePath": "path/to/file.ts",
      "line": 42,
      "title": "Issue title",
      "description": "Detailed explanation",
      "suggestion": "How to fix it",
      "codeSnippet": "problematic code",
      "fixedSnippet": "corrected code"
    }
  ],
  "recommendations": ["High-level recommendation 1"],
  "praise": ["What is done well"],
  "qualityMetrics": {
    "securityScore": 80,
    "performanceScore": 75,
    "maintainabilityScore": 70,
    "testabilityScore": 65,
    "overallScore": 72
  }
}`;
  }

  private parseReviewResponse(response: string): Partial<ReviewResult> {
    try {
      const parsed = extractJsonFromResponse(response) as Partial<ReviewResult>;
      return {
        approved: parsed.approved ?? false,
        score: typeof parsed.score === 'number' ? parsed.score : 50,
        summary: parsed.summary ?? 'Review complete',
        comments: (parsed.comments ?? []).map((c, i) => ({
          id: c.id ?? `c${i + 1}`,
          severity: c.severity ?? 'medium',
          category: c.category ?? 'correctness',
          filePath: c.filePath ?? '',
          line: c.line,
          title: c.title ?? 'Issue found',
          description: c.description ?? '',
          suggestion: c.suggestion ?? '',
          codeSnippet: c.codeSnippet,
          fixedSnippet: c.fixedSnippet,
          references: c.references,
        })),
        qualityMetrics: parsed.qualityMetrics ?? {
          securityScore: 70, performanceScore: 70,
          maintainabilityScore: 70, testabilityScore: 70, overallScore: 70,
        },
        recommendations: parsed.recommendations ?? [],
        praise: parsed.praise ?? [],
      };
    } catch {
      return {
        approved: false, score: 50, summary: 'Review parsing failed',
        comments: [], recommendations: [], praise: [],
        qualityMetrics: { securityScore: 0, performanceScore: 0, maintainabilityScore: 0, testabilityScore: 0, overallScore: 0 },
      };
    }
  }

  private mergeResults(
    llmReview: Partial<ReviewResult>,
    gateResults: Awaited<ReturnType<typeof getQualityGate extends () => infer R ? R : never>>[],
    files: Array<{ filePath: string }>
  ): ReviewResult {
    const comments: ReviewComment[] = [...(llmReview.comments ?? [])];

    // Convert quality gate issues to review comments
    for (const report of gateResults as any[]) {
      if (!report?.issues) continue;
      for (const issue of report.issues as QualityIssue[]) {
        const existing = comments.find(c => c.line === issue.line && c.filePath === issue.filePath);
        if (!existing) {
          comments.push({
            id: issue.id ?? `gate-${comments.length}`,
            severity: issue.severity,
            category: issue.category === 'security' ? 'security' :
              issue.category === 'complexity' ? 'maintainability' : 'style',
            filePath: issue.filePath ?? '',
            line: issue.line,
            title: issue.message.slice(0, 80),
            description: issue.message,
            suggestion: issue.suggestion ?? 'Refactor this code',
          });
        }
      }
    }

    // Recalculate scores with gate data
    const gateScore = gateResults.length > 0
      ? (gateResults as any[]).reduce((s: number, r: any) => s + (r?.score ?? 50), 0) / gateResults.length
      : 70;

    const llmScore = llmReview.score ?? 70;
    const finalScore = Math.round((llmScore * 0.6) + (gateScore * 0.4));

    const criticalIssues = comments.filter(c => c.severity === 'critical');
    const highIssues = comments.filter(c => c.severity === 'high');
    const approved = finalScore >= 70 && criticalIssues.length === 0 && highIssues.length < 3;

    return {
      approved,
      score: finalScore,
      summary: llmReview.summary ?? `Review complete. Score: ${finalScore}/100. ${criticalIssues.length} critical issues.`,
      comments,
      qualityMetrics: llmReview.qualityMetrics ?? {
        securityScore: 70, performanceScore: 70,
        maintainabilityScore: Math.round(gateScore),
        testabilityScore: 70, overallScore: finalScore,
      },
      recommendations: llmReview.recommendations ?? [],
      mustFix: comments.filter(c => c.severity === 'critical' || c.severity === 'high'),
      niceToFix: comments.filter(c => c.severity === 'medium' || c.severity === 'low'),
      praise: llmReview.praise ?? [],
    };
  }

  private emptyReview(reason: string): ReviewResult {
    return {
      approved: false, score: 0, summary: reason, comments: [],
      qualityMetrics: { securityScore: 0, performanceScore: 0, maintainabilityScore: 0, testabilityScore: 0, overallScore: 0 },
      recommendations: [reason], mustFix: [], niceToFix: [], praise: [],
    };
  }
}

AgentRegistry.register('reviewer', ReviewerAgent);
export default ReviewerAgent;

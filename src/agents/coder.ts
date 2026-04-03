/**
 * AetherDev — Coder Agent
 * AI-driven code generation, refactoring, and debugging
 * Self-healing: auto-fixes syntax errors, import issues, type errors
 */

import * as path from 'path';
import { BaseAgent, AgentContext, AgentRegistry } from './base.js';
import { SYSTEM_PROMPTS } from '../core/engine.js';
import { extractCodeBlocks, extractJsonFromResponse } from '../utils/validator.js';
import { readFile, writeFile, detectLanguage } from '../utils/fs.js';
import { getQualityGate } from '../core/quality.js';
import { v4 as uuidv4 } from 'uuid';
import pRetry from 'p-retry';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GeneratedFile {
  path: string;
  content: string;
  language: string;
  isNew: boolean;
  changesSummary: string;
}

export interface CoderResult {
  files: GeneratedFile[];
  explanation: string;
  testSuggestions: string[];
  followUpTasks: string[];
  qualityScore?: number;
  compilable: boolean;
}

export interface RefactorPlan {
  targetFile: string;
  changes: Array<{
    type: 'rename' | 'extract' | 'inline' | 'move' | 'restructure';
    description: string;
    beforeCode: string;
    afterCode: string;
    line?: number;
  }>;
  reasoning: string;
}

// ─── Coder Agent ──────────────────────────────────────────────────────────────

export class CoderAgent extends BaseAgent<CoderResult> {
  readonly type = 'coder';
  readonly description = 'Generates, refactors, and debugs code with self-healing';

  protected async execute(context: AgentContext): Promise<CoderResult> {
    const { task } = context;

    // Step 1: Gather context from existing files
    const fileContext = await this.runStep('read-target-files', async () => {
      return this.readTargetFiles(task.targetFiles ?? [], context.projectPath);
    });

    // Step 2: Build memory context
    const memCtx = await this.runStep('build-memory-context', async () => {
      return this.buildContextFromProject(task.prompt, context);
    });

    // Step 3: Generate code
    const generated = await this.runStep('generate-code', async () => {
      return this.generateCode(task, fileContext, memCtx);
    });

    // Step 4: Self-healing — validate and fix
    const healed = await this.runStep('self-heal', async () => {
      return this.selfHeal(generated, context);
    });

    // Step 5: Quality gate check
    const qualityScore = await this.runStep('quality-check', async () => {
      if (!healed.files.length) return undefined;
      const gate = getQualityGate();
      let totalScore = 0;
      for (const file of healed.files) {
        if (file.content.length > 100 && context.projectPath) {
          const tmpPath = path.join(context.projectPath, file.path);
          // Write temporarily for analysis
          const report = await gate.analyze(tmpPath).catch(() => null);
          if (report) totalScore += report.score;
        }
      }
      return healed.files.length > 0 ? Math.round(totalScore / healed.files.length) : undefined;
    });

    // Step 6: Write files if projectPath available
    if (context.projectPath && healed.files.length > 0) {
      await this.runStep('write-files', async () => {
        for (const file of healed.files) {
          await writeFile(
            path.join(context.projectPath!, file.path),
            file.content,
            undefined,
            { createDirs: true, backup: !file.isNew }
          );
          this.logger.info(`File written: ${file.path}`);
        }
      });
    }

    return { ...healed, qualityScore };
  }

  private async readTargetFiles(
    targetFiles: string[],
    projectPath?: string
  ): Promise<string> {
    if (!targetFiles.length || !projectPath) return '';
    const parts: string[] = [];

    for (const filePath of targetFiles.slice(0, 10)) {
      try {
        const fullPath = path.isAbsolute(filePath) ? filePath : path.join(projectPath, filePath);
        const result = await readFile(fullPath);
        parts.push(`// File: ${filePath}\n${result.content.slice(0, 3000)}`);
      } catch {
        parts.push(`// File: ${filePath} (new file)`);
      }
    }
    return parts.join('\n\n---\n\n');
  }

  private async generateCode(
    task: AgentContext['task'],
    fileContext: string,
    memCtx: string
  ): Promise<CoderResult> {
    const prompt = this.buildCoderPrompt(task, fileContext, memCtx);

    const response = await this.llm({
      messages: [{ role: 'user', content: prompt }],
      systemPrompt: this.getSystemPromptForTask(task.type),
      temperature: 0.2,
    });

    return this.parseCoderResponse(response, task.targetFiles ?? []);
  }

  private buildCoderPrompt(
    task: AgentContext['task'],
    fileContext: string,
    memCtx: string
  ): string {
    const parts: string[] = [];

    parts.push(`Task Type: ${task.type.toUpperCase()}`);
    parts.push(`Task: ${task.prompt}`);

    if (task.targetFiles?.length) {
      parts.push(`\nTarget Files: ${task.targetFiles.join(', ')}`);
    }

    if (fileContext) {
      parts.push(`\nExisting Code:\n${fileContext}`);
    }

    if (memCtx) {
      parts.push(`\nRelevant Project Context:\n${memCtx.slice(0, 2000)}`);
    }

    if (task.context && Object.keys(task.context).length > 0) {
      parts.push(`\nAdditional Context: ${JSON.stringify(task.context)}`);
    }

    parts.push(`
Respond with a JSON object:
{
  "files": [
    {
      "path": "relative/path/to/file.ts",
      "content": "// complete file content here",
      "language": "typescript",
      "isNew": true,
      "changesSummary": "What changed and why"
    }
  ],
  "explanation": "What was done and why",
  "testSuggestions": ["Test case 1", "Test case 2"],
  "followUpTasks": ["Follow-up task 1"],
  "compilable": true
}`);

    return parts.join('\n');
  }

  private getSystemPromptForTask(taskType: string): string {
    const prompts: Record<string, string> = {
      generate: SYSTEM_PROMPTS.coder,
      refactor: `${SYSTEM_PROMPTS.coder}\n\nFocus on improving code quality while preserving functionality. Apply SOLID principles.`,
      debug: SYSTEM_PROMPTS.debugger,
      test: SYSTEM_PROMPTS.tester,
      explain: SYSTEM_PROMPTS.documenter,
      review: SYSTEM_PROMPTS.reviewer,
      document: SYSTEM_PROMPTS.documenter,
    };
    return prompts[taskType] ?? SYSTEM_PROMPTS.coder;
  }

  private parseCoderResponse(response: string, targetFiles: string[]): CoderResult {
    try {
      const parsed = extractJsonFromResponse(response) as Partial<CoderResult>;

      return {
        files: (parsed.files ?? []).map(f => ({
          path: f.path ?? (targetFiles[0] ?? 'output.ts'),
          content: f.content ?? '',
          language: f.language ?? detectLanguage(f.path ?? ''),
          isNew: f.isNew ?? false,
          changesSummary: f.changesSummary ?? 'Modified',
        })),
        explanation: parsed.explanation ?? response.slice(0, 500),
        testSuggestions: parsed.testSuggestions ?? [],
        followUpTasks: parsed.followUpTasks ?? [],
        compilable: parsed.compilable ?? true,
      };
    } catch {
      // Fallback: extract code blocks directly
      const blocks = extractCodeBlocks(response);
      const files: GeneratedFile[] = blocks.map((block, i) => ({
        path: targetFiles[i] ?? `output-${i + 1}.${this.langToExt(block.lang)}`,
        content: block.code,
        language: block.lang,
        isNew: !targetFiles[i],
        changesSummary: 'Generated code',
      }));

      return {
        files,
        explanation: response.replace(/```[\s\S]*?```/g, '').trim().slice(0, 1000),
        testSuggestions: [],
        followUpTasks: [],
        compilable: true,
      };
    }
  }

  private langToExt(lang: string): string {
    const map: Record<string, string> = {
      typescript: 'ts', javascript: 'js', python: 'py', java: 'java',
      go: 'go', rust: 'rs', cpp: 'cpp', c: 'c', ruby: 'rb',
    };
    return map[lang] ?? lang ?? 'txt';
  }

  // ─── Self-Healing ──────────────────────────────────────────────────────────

  private async selfHeal(result: CoderResult, context: AgentContext): Promise<CoderResult> {
    if (result.files.length === 0) return result;

    const healed = { ...result, files: [...result.files] };

    for (let i = 0; i < healed.files.length; i++) {
      const file = healed.files[i]!;

      // Fix common TypeScript/JavaScript issues
      if (file.language === 'typescript' || file.language === 'javascript') {
        file.content = this.fixCommonTsIssues(file.content);
      }

      // Fix Python issues
      if (file.language === 'python') {
        file.content = this.fixCommonPyIssues(file.content);
      }

      // If TypeScript compilation fails, attempt LLM-based fix
      if (context.projectPath && (file.language === 'typescript')) {
        const compileResult = await this.sandbox.execute('npx', ['tsc', '--noEmit', '--allowJs'], {
          cwd: context.projectPath,
          timeout: 20000,
          role: 'read-only',
        });

        if (compileResult.exitCode !== 0 && this.selfHealingAttempts < 2) {
          const fixedContent = await this.fixWithLLM(file.content, compileResult.stderr, context.task.prompt);
          if (fixedContent) file.content = fixedContent;
        }
      }

      healed.files[i] = file;
    }

    return healed;
  }

  private fixCommonTsIssues(code: string): string {
    let fixed = code;

    // Remove duplicate imports of same module
    const importLines = new Map<string, string>();
    fixed = fixed.replace(/^import .+ from ['"].+['"];?\n/gm, (line) => {
      const moduleMatch = line.match(/from ['"](.+)['"]/);
      if (!moduleMatch) return line;
      const mod = moduleMatch[1]!;
      if (importLines.has(mod)) return '';
      importLines.set(mod, line);
      return line;
    });

    // Fix missing semicolons in obvious places
    fixed = fixed.replace(/^(\s*(?:const|let|var|return|throw|export).+[^{;,])\s*$/gm, '$1;');

    // Remove trailing whitespace
    fixed = fixed.replace(/[ \t]+$/gm, '');

    // Ensure file ends with newline
    if (!fixed.endsWith('\n')) fixed += '\n';

    return fixed;
  }

  private fixCommonPyIssues(code: string): string {
    let fixed = code;

    // Fix inconsistent indentation (4 spaces)
    const lines = fixed.split('\n');
    const fixedLines = lines.map(line => {
      // Convert tabs to 4 spaces
      return line.replace(/^\t+/, tabs => '    '.repeat(tabs.length));
    });
    fixed = fixedLines.join('\n');

    // Ensure file ends with newline
    if (!fixed.endsWith('\n')) fixed += '\n';

    return fixed;
  }

  private async fixWithLLM(
    code: string,
    errorOutput: string,
    originalPrompt: string
  ): Promise<string | null> {
    try {
      const fixPrompt = `The following code has compilation errors. Fix them without changing the functionality.

ORIGINAL TASK: ${originalPrompt.slice(0, 200)}

CODE WITH ERRORS:
\`\`\`
${code.slice(0, 3000)}
\`\`\`

ERRORS:
\`\`\`
${errorOutput.slice(0, 1000)}
\`\`\`

Return ONLY the fixed code in a code block, no explanations.`;

      const response = await this.llm({
        messages: [{ role: 'user', content: fixPrompt }],
        systemPrompt: SYSTEM_PROMPTS.debugger,
        temperature: 0.1,
      });

      const blocks = extractCodeBlocks(response);
      return blocks[0]?.code ?? null;
    } catch {
      return null;
    }
  }

  protected async onHealingAttempt(
    context: AgentContext,
    error: pRetry.FailedAttemptError,
    attempt: number
  ): Promise<void> {
    this.logger.warn(`CoderAgent healing attempt ${attempt}`, { error: error.message });
    // On retry, reduce scope of the task slightly
    if (attempt === 2) {
      context.task.maxIterations = Math.max(1, context.task.maxIterations - 1);
    }
  }
}

AgentRegistry.register('coder', CoderAgent);
export default CoderAgent;

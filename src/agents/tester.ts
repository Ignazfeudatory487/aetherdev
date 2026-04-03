/**
 * AetherDev — Tester Agent
 * Generates comprehensive tests: unit, integration, e2e
 * Runs tests via sandbox and reports results with coverage insights
 */

import * as path from 'path';
import { BaseAgent, AgentContext, AgentRegistry } from './base.js';
import { SYSTEM_PROMPTS } from '../core/engine.js';
import { extractCodeBlocks, extractJsonFromResponse } from '../utils/validator.js';
import { readFile, writeFile, detectLanguage, findFiles } from '../utils/fs.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type TestFramework = 'vitest' | 'jest' | 'mocha' | 'pytest' | 'unittest' | 'rspec' | 'go-test' | 'playwright';

export interface TestCase {
  name: string;
  description: string;
  type: 'unit' | 'integration' | 'e2e' | 'snapshot' | 'property';
  code: string;
}

export interface TestFile {
  path: string;
  framework: TestFramework;
  language: string;
  testCases: TestCase[];
  content: string;
  setupCode?: string;
  teardownCode?: string;
}

export interface TestRunResult {
  framework: TestFramework;
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  coverage?: {
    lines: number;
    functions: number;
    branches: number;
    statements: number;
  };
  failures: Array<{ name: string; message: string; stack?: string }>;
  duration: number;
  exitCode: number;
}

export interface TesterResult {
  testFiles: TestFile[];
  runResult?: TestRunResult;
  coverageReport?: string;
  suggestions: string[];
  frameworkDetected: TestFramework;
}

// ─── Framework Detection ──────────────────────────────────────────────────────

async function detectFramework(projectPath?: string): Promise<TestFramework> {
  if (!projectPath) return 'vitest';

  try {
    const pkgPath = path.join(projectPath, 'package.json');
    const pkg = JSON.parse((await readFile(pkgPath)).content) as Record<string, unknown>;
    const deps = { ...(pkg['dependencies'] as object ?? {}), ...(pkg['devDependencies'] as object ?? {}) };

    if ('vitest' in deps) return 'vitest';
    if ('jest' in deps) return 'jest';
    if ('mocha' in deps) return 'mocha';
    if ('@playwright/test' in deps) return 'playwright';
  } catch { /* not a node project */ }

  try {
    const pyFiles = await findFiles(projectPath, ['**/pytest.ini', '**/setup.cfg', '**/pyproject.toml']);
    if (pyFiles.length > 0) return 'pytest';
  } catch { /* ignore */ }

  return 'vitest'; // Default
}

// ─── Tester Agent ─────────────────────────────────────────────────────────────

export class TesterAgent extends BaseAgent<TesterResult> {
  readonly type = 'tester';
  readonly description = 'Generates and runs comprehensive tests with coverage analysis';

  protected async execute(context: AgentContext): Promise<TesterResult> {
    const { task } = context;
    const targetFiles = task.targetFiles ?? [];

    // Step 1: Detect framework
    const framework = await this.runStep('detect-framework', async () => {
      return detectFramework(context.projectPath);
    });

    // Step 2: Read source files
    const sourceFiles = await this.runStep('read-source-files', async () => {
      return this.readSourceFiles(targetFiles, context.projectPath);
    });

    // Step 3: Generate tests
    const testFiles = await this.runStep('generate-tests', async () => {
      return this.generateTests(sourceFiles, framework, task.prompt, context);
    });

    // Step 4: Write test files
    if (context.projectPath && testFiles.length > 0) {
      await this.runStep('write-test-files', async () => {
        for (const testFile of testFiles) {
          const fullPath = path.isAbsolute(testFile.path)
            ? testFile.path
            : path.join(context.projectPath!, testFile.path);
          await writeFile(fullPath, testFile.content, undefined, { createDirs: true });
          this.logger.info(`Test file written: ${testFile.path}`);
        }
      });
    }

    // Step 5: Run tests
    const runResult = context.projectPath
      ? await this.runStep('run-tests', async () => {
          return this.runTests(framework, context.projectPath!);
        })
      : undefined;

    return {
      testFiles,
      runResult,
      suggestions: this.buildSuggestions(testFiles, runResult),
      frameworkDetected: framework,
    };
  }

  private async readSourceFiles(
    targetFiles: string[],
    projectPath?: string
  ): Promise<Array<{ path: string; content: string; language: string }>> {
    const results = [];
    for (const f of targetFiles.slice(0, 8)) {
      try {
        const fullPath = path.isAbsolute(f) ? f : path.join(projectPath ?? '', f);
        const result = await readFile(fullPath);
        results.push({ path: f, content: result.content.slice(0, 4000), language: detectLanguage(f) });
      } catch { /* skip */ }
    }
    return results;
  }

  private async generateTests(
    sourceFiles: Array<{ path: string; content: string; language: string }>,
    framework: TestFramework,
    userPrompt: string,
    context: AgentContext
  ): Promise<TestFile[]> {
    const testFiles: TestFile[] = [];

    for (const source of sourceFiles) {
      const prompt = this.buildTestPrompt(source, framework, userPrompt);

      const response = await this.llm({
        messages: [{ role: 'user', content: prompt }],
        systemPrompt: SYSTEM_PROMPTS.tester,
        temperature: 0.15,
      });

      const testFile = this.parseTestResponse(response, source, framework);
      if (testFile) testFiles.push(testFile);
    }

    // If no specific files, generate based on prompt alone
    if (sourceFiles.length === 0) {
      const prompt = this.buildGeneralTestPrompt(userPrompt, framework);
      const response = await this.llm({
        messages: [{ role: 'user', content: prompt }],
        systemPrompt: SYSTEM_PROMPTS.tester,
        temperature: 0.15,
      });
      const blocks = extractCodeBlocks(response);
      if (blocks.length > 0) {
        testFiles.push({
          path: `tests/generated.${this.frameworkExt(framework)}`,
          framework,
          language: this.frameworkLang(framework),
          testCases: [],
          content: blocks[0]!.code,
        });
      }
    }

    return testFiles;
  }

  private buildTestPrompt(
    source: { path: string; content: string; language: string },
    framework: TestFramework,
    userPrompt: string
  ): string {
    return `Generate comprehensive tests for this ${source.language} file using ${framework}.

SOURCE FILE: ${source.path}
\`\`\`${source.language}
${source.content}
\`\`\`

REQUIREMENTS:
- ${userPrompt || 'Write complete test coverage'}
- Test happy paths, edge cases, and error conditions
- Use AAA pattern (Arrange, Act, Assert)
- Mock external dependencies
- Test both sync and async functions
- Include at least one test per exported function/class

Return a JSON object:
{
  "testCases": [
    {
      "name": "should do X when Y",
      "description": "Tests that...",
      "type": "unit|integration|e2e",
      "code": "// test code here"
    }
  ],
  "setupCode": "// beforeAll/beforeEach setup",
  "teardownCode": "// afterAll/afterEach teardown",
  "fullTestFile": "// complete test file content"
}`;
  }

  private buildGeneralTestPrompt(userPrompt: string, framework: TestFramework): string {
    return `Generate test code using ${framework} for: ${userPrompt}

Write complete, runnable test code. Include:
- Setup and teardown
- Multiple test cases with edge cases
- Mocks where needed
- Assertions with good error messages

Return a complete test file in a code block.`;
  }

  private parseTestResponse(
    response: string,
    source: { path: string; language: string },
    framework: TestFramework
  ): TestFile | null {
    try {
      const parsed = extractJsonFromResponse(response) as {
        testCases?: TestCase[];
        setupCode?: string;
        teardownCode?: string;
        fullTestFile?: string;
      };

      const testPath = this.getTestPath(source.path, framework);
      const content = parsed.fullTestFile ?? this.assembleTestFile(
        parsed.testCases ?? [],
        parsed.setupCode,
        parsed.teardownCode,
        framework,
        source.language
      );

      return {
        path: testPath,
        framework,
        language: source.language,
        testCases: parsed.testCases ?? [],
        content,
        setupCode: parsed.setupCode,
        teardownCode: parsed.teardownCode,
      };
    } catch {
      // Try extracting code blocks
      const blocks = extractCodeBlocks(response);
      if (blocks.length > 0) {
        const testPath = this.getTestPath(source.path, framework);
        return {
          path: testPath,
          framework,
          language: source.language,
          testCases: [],
          content: blocks[0]!.code,
        };
      }
      return null;
    }
  }

  private getTestPath(sourcePath: string, framework: TestFramework): string {
    const dir = path.dirname(sourcePath);
    const base = path.basename(sourcePath, path.extname(sourcePath));
    const ext = this.frameworkExt(framework);

    if (framework === 'pytest') {
      return path.join('tests', `test_${base}.py`);
    }
    return path.join(dir, `${base}.test.${ext}`);
  }

  private assembleTestFile(
    testCases: TestCase[],
    setup?: string,
    teardown?: string,
    framework: TestFramework = 'vitest',
    language: string = 'typescript'
  ): string {
    if (framework === 'vitest' || framework === 'jest') {
      const imports = framework === 'vitest'
        ? `import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';`
        : `import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';`;

      const cases = testCases.map(tc => `
  it('${tc.name}', async () => {
${tc.code.split('\n').map(l => `    ${l}`).join('\n')}
  });`).join('\n');

      return [
        imports,
        '',
        `describe('Generated Tests', () => {`,
        setup ? `  beforeEach(() => {\n${setup.split('\n').map(l => `    ${l}`).join('\n')}\n  });` : '',
        teardown ? `  afterEach(() => {\n${teardown.split('\n').map(l => `    ${l}`).join('\n')}\n  });` : '',
        cases,
        `});`,
      ].filter(Boolean).join('\n');
    }

    if (framework === 'pytest') {
      const cases = testCases.map(tc => `
def ${tc.name.replace(/\s+/g, '_').replace(/[^a-z0-9_]/gi, '')}():
    """${tc.description}"""
${tc.code.split('\n').map(l => `    ${l}`).join('\n')}`).join('\n');

      return [
        `import pytest`,
        ``,
        setup ?? '',
        cases,
      ].filter(Boolean).join('\n');
    }

    return testCases.map(tc => tc.code).join('\n\n');
  }

  private async runTests(framework: TestFramework, projectPath: string): Promise<TestRunResult> {
    const start = Date.now();

    const commands: Record<TestFramework, { cmd: string; args: string[] }> = {
      vitest: { cmd: 'npx', args: ['vitest', 'run', '--reporter=json'] },
      jest: { cmd: 'npx', args: ['jest', '--json'] },
      mocha: { cmd: 'npx', args: ['mocha', '--reporter', 'json'] },
      pytest: { cmd: 'python', args: ['-m', 'pytest', '--tb=short', '-q'] },
      unittest: { cmd: 'python', args: ['-m', 'unittest', 'discover', '-v'] },
      rspec: { cmd: 'bundle', args: ['exec', 'rspec', '--format', 'json'] },
      'go-test': { cmd: 'go', args: ['test', './...', '-v', '-json'] },
      playwright: { cmd: 'npx', args: ['playwright', 'test', '--reporter=json'] },
    };

    const { cmd, args } = commands[framework];

    try {
      const result = await this.sandbox.execute(cmd, args, {
        cwd: projectPath,
        timeout: 120000,
        role: 'standard',
      });

      return this.parseTestOutput(result.stdout, result.stderr, result.exitCode, framework, Date.now() - start);
    } catch (err) {
      return {
        framework, passed: 0, failed: 0, skipped: 0, total: 0,
        failures: [{ name: 'Test Runner Error', message: String(err) }],
        duration: Date.now() - start,
        exitCode: 1,
      };
    }
  }

  private parseTestOutput(
    stdout: string,
    stderr: string,
    exitCode: number,
    framework: TestFramework,
    duration: number
  ): TestRunResult {
    try {
      if (framework === 'vitest' || framework === 'jest') {
        const json = JSON.parse(stdout) as {
          numPassedTests?: number;
          numFailedTests?: number;
          numPendingTests?: number;
          numTotalTests?: number;
          testResults?: Array<{
            testResults: Array<{ title: string; status: string; failureMessages?: string[] }>;
          }>;
          coverageMap?: unknown;
        };

        const failures: Array<{ name: string; message: string }> = [];
        for (const suite of json.testResults ?? []) {
          for (const test of suite.testResults) {
            if (test.status === 'failed') {
              failures.push({ name: test.title, message: test.failureMessages?.[0] ?? 'Unknown failure' });
            }
          }
        }

        return {
          framework, exitCode, duration,
          passed: json.numPassedTests ?? 0,
          failed: json.numFailedTests ?? 0,
          skipped: json.numPendingTests ?? 0,
          total: json.numTotalTests ?? 0,
          failures,
        };
      }

      // Fallback: parse human-readable output
      const passMatch = stdout.match(/(\d+)\s+passed/);
      const failMatch = stdout.match(/(\d+)\s+failed/);
      const skipMatch = stdout.match(/(\d+)\s+(?:skipped|pending)/);

      return {
        framework, exitCode, duration,
        passed: passMatch ? parseInt(passMatch[1]!) : exitCode === 0 ? 1 : 0,
        failed: failMatch ? parseInt(failMatch[1]!) : exitCode !== 0 ? 1 : 0,
        skipped: skipMatch ? parseInt(skipMatch[1]!) : 0,
        total: 0,
        failures: exitCode !== 0 ? [{ name: 'Tests failed', message: stderr.slice(0, 500) }] : [],
      };
    } catch {
      return {
        framework, exitCode, duration,
        passed: exitCode === 0 ? 1 : 0,
        failed: exitCode !== 0 ? 1 : 0,
        skipped: 0, total: 0,
        failures: exitCode !== 0 ? [{ name: 'Unknown', message: stderr.slice(0, 500) }] : [],
      };
    }
  }

  private buildSuggestions(testFiles: TestFile[], runResult?: TestRunResult): string[] {
    const suggestions: string[] = [];

    if (testFiles.length === 0) {
      suggestions.push('No test files generated — check if source files are accessible');
    }

    if (runResult) {
      const { passed, failed, total } = runResult;
      if (failed > 0) {
        suggestions.push(`${failed} tests failed — review failures and fix implementation or test expectations`);
      }
      if (total > 0 && passed / total < 0.8) {
        suggestions.push('Test pass rate below 80% — investigate failing tests');
      }
      if (!runResult.coverage) {
        suggestions.push('Enable coverage reporting: add --coverage flag to test command');
      } else {
        if ((runResult.coverage.lines ?? 0) < 80) {
          suggestions.push(`Line coverage is ${runResult.coverage.lines}% — aim for 80%+`);
        }
      }
    }

    suggestions.push('Add edge case tests for null/undefined inputs');
    suggestions.push('Consider property-based testing for complex logic');

    return suggestions;
  }

  private frameworkExt(f: TestFramework): string {
    return { vitest: 'ts', jest: 'ts', mocha: 'ts', pytest: 'py', unittest: 'py', rspec: 'rb', 'go-test': 'go', playwright: 'ts' }[f] ?? 'ts';
  }

  private frameworkLang(f: TestFramework): string {
    return { vitest: 'typescript', jest: 'typescript', mocha: 'javascript', pytest: 'python', unittest: 'python', rspec: 'ruby', 'go-test': 'go', playwright: 'typescript' }[f] ?? 'typescript';
  }
}

AgentRegistry.register('tester', TesterAgent);
export default TesterAgent;

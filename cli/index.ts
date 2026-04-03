#!/usr/bin/env node
/**
 * AetherDev CLI — Natural Language Developer Assistant
 * Commands: ask, generate, refactor, review, test, debug, doc, git, plugins, status
 */

import { Command, Option } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { input, select, confirm, checkbox } from '@inquirer/prompts';
import { table } from 'table';
import boxen from 'boxen';
import * as path from 'path';
import * as fs from 'fs';
import 'dotenv/config';

import { getPipeline, PipelineMode } from '../src/agents/pipeline.js';
import { getEngine } from '../src/core/engine.js';
import { getMemoryStore } from '../src/core/memory.js';
import { getGitManager } from '../src/utils/git.js';
import { getQualityGate } from '../src/core/quality.js';
import { getPluginLoader } from '../src/plugins/loader.js';
import { validate, TaskSchema } from '../src/utils/validator.js';
import { getConfig } from '../src/config/index.js';
import { findCodeFiles } from '../src/utils/fs.js';
import { v4 as uuidv4 } from 'uuid';

// ─── CLI Setup ────────────────────────────────────────────────────────────────

const program = new Command();
const VERSION = '1.0.0';

program
  .name('aether')
  .description(chalk.cyan('AetherDev — AI-powered developer assistant. 100% free & local-first.'))
  .version(VERSION, '-v, --version')
  .option('--project <path>', 'Project root directory', process.cwd())
  .option('--session <id>', 'Session ID for conversation continuity')
  .option('--json', 'Output results as JSON')
  .option('--no-color', 'Disable colored output');

// ─── Banner ───────────────────────────────────────────────────────────────────

function printBanner(): void {
  const banner = boxen(
    `${chalk.cyan.bold('⚡ AetherDev')} ${chalk.gray(`v${VERSION}`)}\n` +
    `${chalk.gray('Free · Local-First · Open-Source')}\n` +
    `${chalk.gray('AI Developer Agent — 1000% better than OpenClaw')}`,
    { padding: 1, borderStyle: 'round', borderColor: 'cyan', textAlignment: 'center' }
  );
  console.log(banner);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function printResult(data: unknown, asJson: boolean): void {
  if (asJson) {
    console.log(JSON.stringify(data, null, 2));
  } else if (typeof data === 'string') {
    console.log(data);
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}

function printSuccess(msg: string): void {
  console.log(`${chalk.green('✓')} ${msg}`);
}

function printError(msg: string): void {
  console.error(`${chalk.red('✗')} ${msg}`);
}

function printWarning(msg: string): void {
  console.warn(`${chalk.yellow('⚠')} ${msg}`);
}

function printInfo(msg: string): void {
  console.log(`${chalk.blue('ℹ')} ${msg}`);
}

function getProjectPath(opts: { project?: string }): string {
  return path.resolve(opts.project ?? process.cwd());
}

// ─── ask command ──────────────────────────────────────────────────────────────

program
  .command('ask [prompt...]')
  .description('Ask AetherDev anything — natural language AI assistant')
  .option('-m, --model <model>', 'Override LLM model')
  .option('-s, --stream', 'Stream the response')
  .option('--no-context', 'Disable project context')
  .action(async (promptParts: string[], opts) => {
    const globalOpts = program.opts();
    const projectPath = getProjectPath(globalOpts);

    let userPrompt = promptParts.join(' ');
    if (!userPrompt) {
      userPrompt = await input({ message: 'What do you want to ask?' });
    }

    const spinner = ora('Thinking...').start();
    try {
      const engine = getEngine();
      let context = '';

      if (opts.context !== false) {
        const memory = await getMemoryStore();
        context = await memory.buildContext(userPrompt, projectPath).catch(() => '');
      }

      const fullPrompt = context
        ? `Context:\n${context}\n\nQuestion: ${userPrompt}`
        : userPrompt;

      spinner.stop();

      if (opts.stream) {
        process.stdout.write(chalk.cyan('\nAetherDev: '));
        await engine.streamOllama(
          { messages: [{ role: 'user', content: fullPrompt }] },
          chunk => { if (!chunk.done) process.stdout.write(chunk.delta); }
        );
        process.stdout.write('\n\n');
      } else {
        const response = await engine.generate(fullPrompt);
        console.log(`\n${chalk.cyan('AetherDev:')} ${response}\n`);
      }
    } catch (err) {
      spinner.fail('Request failed');
      printError(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ─── generate command ─────────────────────────────────────────────────────────

program
  .command('generate [prompt...]')
  .alias('gen')
  .description('Generate code from a natural language description')
  .option('-f, --files <files...>', 'Target files to modify or create')
  .option('-l, --lang <language>', 'Target programming language')
  .option('--no-review', 'Skip automatic code review')
  .option('--no-test', 'Skip automatic test generation')
  .option('--plan-only', 'Only show the execution plan, do not generate code')
  .action(async (promptParts: string[], opts) => {
    const globalOpts = program.opts();
    const projectPath = getProjectPath(globalOpts);

    let userPrompt = promptParts.join(' ');
    if (!userPrompt) {
      userPrompt = await input({ message: 'What code do you want to generate?' });
    }

    const task = validate(TaskSchema, {
      type: 'generate',
      prompt: userPrompt,
      targetFiles: opts.files ?? [],
      projectPath,
    });

    const mode: PipelineMode = opts.planOnly ? 'plan-only' : 'full';
    const spinner = ora('Running pipeline...').start();

    try {
      const pipeline = getPipeline();
      const sessionId = globalOpts.session ?? uuidv4();

      pipeline.on('step:start', ({ agentType }) => {
        spinner.text = `Running ${chalk.cyan(agentType)} agent...`;
      });

      pipeline.on('pipeline:complete', (run) => {
        spinner.succeed(`Pipeline completed in ${((run.completedAt - run.startedAt) / 1000).toFixed(1)}s`);
      });

      const run = await pipeline.run(task, {
        mode,
        projectPath,
        sessionId,
        autoReview: opts.review !== false,
        autoTest: opts.test !== false,
      });

      if (globalOpts.json) {
        printResult(run, true);
        return;
      }

      // Display results
      if (run.plan) {
        console.log(`\n${chalk.bold.blue('📋 Execution Plan:')}`);
        run.plan.steps.forEach((step, i) => {
          console.log(`  ${chalk.gray(`${i + 1}.`)} ${step.description} ${chalk.gray(`(${step.agentType})`)}`);
        });
      }

      if (run.results.code?.files.length) {
        console.log(`\n${chalk.bold.green('📁 Generated Files:')}`);
        run.results.code.files.forEach(f => {
          const status = f.isNew ? chalk.green('new') : chalk.yellow('modified');
          console.log(`  ${chalk.cyan(f.path)} ${chalk.gray(`[${status}]`)} — ${f.changesSummary}`);
        });
        if (run.results.code.explanation) {
          console.log(`\n${chalk.bold('💡 Explanation:')} ${run.results.code.explanation}`);
        }
      }

      if (run.results.review) {
        const r = run.results.review;
        const scoreColor = r.score >= 80 ? chalk.green : r.score >= 60 ? chalk.yellow : chalk.red;
        console.log(`\n${chalk.bold.magenta('🔍 Code Review:')} Score: ${scoreColor(r.score + '/100')} | ${r.approved ? chalk.green('✓ Approved') : chalk.red('✗ Changes Required')}`);
        if (r.mustFix.length > 0) {
          console.log(`  ${chalk.red('Must Fix:')}`);
          r.mustFix.slice(0, 3).forEach(c => console.log(`    • [${c.severity}] ${c.title}`));
        }
      }

      if (run.results.tests?.runResult) {
        const t = run.results.tests.runResult;
        const passColor = t.failed === 0 ? chalk.green : chalk.red;
        console.log(`\n${chalk.bold.yellow('🧪 Tests:')} ${passColor(`${t.passed} passed`)} / ${t.failed > 0 ? chalk.red(`${t.failed} failed`) : chalk.gray('0 failed')} / ${t.total} total`);
      }

      if (run.error) {
        printError(`Pipeline error: ${run.error}`);
      }
    } catch (err) {
      spinner.fail('Pipeline failed');
      printError(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ─── refactor command ─────────────────────────────────────────────────────────

program
  .command('refactor <files...>')
  .description('Refactor code with AI suggestions')
  .option('-p, --prompt <text>', 'Specific refactoring instructions')
  .option('--dry-run', 'Show changes without writing files')
  .action(async (files: string[], opts) => {
    const globalOpts = program.opts();
    const projectPath = getProjectPath(globalOpts);

    const prompt = opts.prompt ?? await input({ message: 'Describe the refactoring goal:' });
    const spinner = ora('Analyzing and refactoring...').start();

    try {
      const task = validate(TaskSchema, {
        type: 'refactor', prompt,
        targetFiles: files.map(f => path.resolve(projectPath, f)),
      });

      const pipeline = getPipeline();
      const run = await pipeline.run(task, {
        mode: 'code-only', projectPath,
        sessionId: globalOpts.session ?? uuidv4(),
      });

      spinner.succeed('Refactoring complete');

      if (run.results.code?.files.length) {
        if (opts.dryRun) {
          console.log(chalk.yellow('\n⚠ Dry run — changes NOT written to disk\n'));
        }
        run.results.code.files.forEach(f => {
          console.log(`\n${chalk.bold(`📄 ${f.path}`)}`);
          console.log(chalk.gray('─'.repeat(50)));
          console.log(f.content.slice(0, 1000));
          if (f.content.length > 1000) console.log(chalk.gray(`... (${f.content.length} chars total)`));
        });
      }
    } catch (err) {
      spinner.fail('Refactoring failed');
      printError(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ─── review command ───────────────────────────────────────────────────────────

program
  .command('review <files...>')
  .description('AI code review with security and quality analysis')
  .option('--ci', 'CI mode — exit with error code if review fails')
  .action(async (files: string[], opts) => {
    const globalOpts = program.opts();
    const projectPath = getProjectPath(globalOpts);

    const spinner = ora('Reviewing code...').start();

    try {
      const task = validate(TaskSchema, {
        type: 'review',
        prompt: 'Perform a comprehensive code review',
        targetFiles: files.map(f => path.resolve(projectPath, f)),
      });

      const pipeline = getPipeline();
      const run = await pipeline.run(task, { mode: 'review-only', projectPath });

      spinner.succeed('Review complete');

      const review = run.results.review;
      if (!review) { printWarning('No review results'); return; }

      if (globalOpts.json) { printResult(review, true); return; }

      const scoreColor = review.score >= 80 ? chalk.green : review.score >= 60 ? chalk.yellow : chalk.red;
      console.log(`\n${chalk.bold('📊 Review Score:')} ${scoreColor(`${review.score}/100`)} — ${review.approved ? chalk.green('✅ Approved') : chalk.red('❌ Changes Required')}`);
      console.log(`${chalk.gray(review.summary)}\n`);

      if (review.mustFix.length > 0) {
        console.log(chalk.red.bold('🚨 Must Fix:'));
        review.mustFix.forEach(c => {
          console.log(`  ${chalk.red('●')} [${c.severity.toUpperCase()}] ${c.title}`);
          if (c.line) console.log(`    ${chalk.gray(`Line ${c.line}:`)} ${c.description}`);
          if (c.suggestion) console.log(`    ${chalk.cyan('Fix:')} ${c.suggestion}`);
        });
      }

      if (review.niceToFix.length > 0) {
        console.log(`\n${chalk.yellow.bold('💡 Nice to Fix:')}`);
        review.niceToFix.slice(0, 5).forEach(c => {
          console.log(`  ${chalk.yellow('●')} [${c.severity}] ${c.title}`);
        });
      }

      if (review.praise.length > 0) {
        console.log(`\n${chalk.green.bold('👍 Good Job:')}`);
        review.praise.forEach(p => console.log(`  ${chalk.green('●')} ${p}`));
      }

      if (opts.ci && !review.approved) process.exit(1);
    } catch (err) {
      spinner.fail('Review failed');
      printError(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ─── test command ─────────────────────────────────────────────────────────────

program
  .command('test <files...>')
  .description('Generate and run tests for source files')
  .option('--run', 'Run tests after generating them')
  .option('-f, --framework <framework>', 'Test framework (vitest|jest|pytest)')
  .action(async (files: string[], opts) => {
    const globalOpts = program.opts();
    const projectPath = getProjectPath(globalOpts);

    const spinner = ora('Generating tests...').start();

    try {
      const task = validate(TaskSchema, {
        type: 'test',
        prompt: `Generate comprehensive tests${opts.framework ? ` using ${opts.framework}` : ''}`,
        targetFiles: files.map(f => path.resolve(projectPath, f)),
      });

      const pipeline = getPipeline();
      const run = await pipeline.run(task, { mode: 'test-only', projectPath });

      spinner.succeed('Tests generated');

      const tests = run.results.tests;
      if (!tests) { printWarning('No test results'); return; }

      tests.testFiles.forEach(tf => {
        printSuccess(`Test file: ${chalk.cyan(tf.path)} (${tf.testCases.length} test cases)`);
      });

      if (tests.runResult) {
        const r = tests.runResult;
        console.log(`\n${chalk.bold('🧪 Test Results:')}`);
        console.log(`  Passed: ${chalk.green(r.passed)}`);
        console.log(`  Failed: ${r.failed > 0 ? chalk.red(r.failed) : chalk.gray(r.failed)}`);
        console.log(`  Total: ${r.total}`);
        if (r.failures.length > 0) {
          console.log(`\n${chalk.red('Failures:')}`);
          r.failures.slice(0, 5).forEach(f => {
            console.log(`  ${chalk.red('✗')} ${f.name}: ${f.message.slice(0, 100)}`);
          });
        }
      }
    } catch (err) {
      spinner.fail('Test generation failed');
      printError(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ─── debug command ────────────────────────────────────────────────────────────

program
  .command('debug <prompt...>')
  .description('Debug errors and get AI-powered fixes')
  .option('-f, --files <files...>', 'Relevant source files')
  .option('-e, --error <text>', 'Error message or stack trace')
  .action(async (promptParts: string[], opts) => {
    const globalOpts = program.opts();
    const projectPath = getProjectPath(globalOpts);

    const basePrompt = promptParts.join(' ');
    const errorText = opts.error ?? '';
    const fullPrompt = errorText ? `${basePrompt}\n\nError:\n${errorText}` : basePrompt;

    const spinner = ora('Analyzing error...').start();

    try {
      const task = validate(TaskSchema, {
        type: 'debug', prompt: fullPrompt,
        targetFiles: opts.files?.map((f: string) => path.resolve(projectPath, f)) ?? [],
      });

      const pipeline = getPipeline();
      const run = await pipeline.run(task, { mode: 'auto', projectPath });

      spinner.succeed('Debug analysis complete');

      if (run.results.code) {
        console.log(`\n${chalk.bold.cyan('🔧 Fix:')}`);
        console.log(run.results.code.explanation);
        if (run.results.code.files.length > 0) {
          console.log(`\n${chalk.bold('📁 Files to update:')}`);
          run.results.code.files.forEach(f => {
            console.log(`  ${chalk.cyan(f.path)}: ${f.changesSummary}`);
          });
        }
      }
    } catch (err) {
      spinner.fail('Debug failed');
      printError(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ─── scan command ─────────────────────────────────────────────────────────────

program
  .command('scan [path]')
  .description('Security and quality scan of your codebase')
  .option('--ci', 'Exit with error code if critical issues found')
  .option('--format <format>', 'Output format: table|json|summary', 'summary')
  .action(async (scanPath: string | undefined, opts) => {
    const globalOpts = program.opts();
    const targetPath = path.resolve(scanPath ?? globalOpts.project ?? process.cwd());

    const spinner = ora('Scanning codebase...').start();

    try {
      const files = await findCodeFiles(targetPath);
      spinner.text = `Scanning ${files.length} files...`;

      const gate = getQualityGate();
      const sampleFiles = files.slice(0, 30); // Scan first 30 for speed
      const { reports, overall } = await gate.analyzeProject(targetPath, sampleFiles);

      spinner.succeed(`Scan complete — ${sampleFiles.length} files analyzed`);

      if (opts.format === 'json') {
        printResult({ overall, reports }, true);
        return;
      }

      const scoreColor = overall.score >= 80 ? chalk.green : overall.score >= 60 ? chalk.yellow : chalk.red;
      console.log(boxen(
        `${chalk.bold('Security & Quality Report')}\n` +
        `Score: ${scoreColor(`${overall.score}/100`)}\n` +
        `Files: ${sampleFiles.length} | Issues: ${overall.totalIssues} | Critical: ${chalk.red(overall.criticalCount)}\n` +
        `Status: ${overall.passed ? chalk.green('✅ PASSED') : chalk.red('❌ FAILED')}`,
        { padding: 1, borderStyle: 'round', borderColor: overall.passed ? 'green' : 'red' }
      ));

      // Show top issues
      const allIssues = reports.flatMap(r => r.issues);
      const critical = allIssues.filter(i => i.severity === 'critical');
      const high = allIssues.filter(i => i.severity === 'high');

      if (critical.length > 0) {
        console.log(`\n${chalk.red.bold('🚨 Critical Issues:')}`);
        critical.slice(0, 5).forEach(i => {
          console.log(`  ${chalk.red('●')} ${i.message}`);
          if (i.filePath) console.log(`    ${chalk.gray(i.filePath)}${i.line ? `:${i.line}` : ''}`);
          if (i.suggestion) console.log(`    ${chalk.cyan('→')} ${i.suggestion}`);
        });
      }

      if (high.length > 0) {
        console.log(`\n${chalk.yellow.bold('⚠ High Severity:')}`);
        high.slice(0, 5).forEach(i => {
          console.log(`  ${chalk.yellow('●')} ${i.message}`);
        });
      }

      if (opts.ci && !overall.passed) process.exit(1);
    } catch (err) {
      spinner.fail('Scan failed');
      printError(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ─── git command ──────────────────────────────────────────────────────────────

program
  .command('git')
  .description('AI-powered Git operations')
  .addCommand(
    new Command('commit')
      .description('Auto-generate conventional commit message and commit')
      .option('--all', 'Stage all files before committing')
      .action(async (opts) => {
        const globalOpts = program.opts();
        const projectPath = getProjectPath(globalOpts);
        const git = getGitManager(projectPath);
        const spinner = ora('Analyzing changes...').start();

        try {
          const status = await git.getStatus();
          if (status.isClean) { spinner.fail('No changes to commit'); return; }

          if (opts.all) await git.stageAll();

          spinner.text = 'Generating commit message...';
          const stagedFiles = status.staged.length > 0 ? status.staged : [...status.unstaged];
          if (stagedFiles.length === 0) { spinner.fail('No staged files'); return; }

          const commitMsg = await git.generateAutoCommitMessage(stagedFiles);
          const formatted = git.formatConventionalCommit(commitMsg);

          spinner.stop();
          console.log(`\n${chalk.bold('Generated commit message:')}`);
          console.log(chalk.cyan(formatted));

          const confirmed = await confirm({ message: 'Use this message?' });
          if (confirmed) {
            if (status.staged.length === 0) await git.stageAll();
            const hash = await git.commit(formatted);
            printSuccess(`Committed: ${chalk.cyan(hash.slice(0, 7))}`);
          }
        } catch (err) {
          spinner.fail('Git commit failed');
          printError(err instanceof Error ? err.message : String(err));
        }
      })
  )
  .addCommand(
    new Command('pr')
      .description('Generate pull request template')
      .option('-b, --base <branch>', 'Base branch', 'main')
      .action(async (opts) => {
        const globalOpts = program.opts();
        const git = getGitManager(getProjectPath(globalOpts));
        const spinner = ora('Generating PR template...').start();
        try {
          const prTemplate = await git.generatePRTemplate(opts.base);
          spinner.succeed('PR template generated');
          console.log(`\n${chalk.bold('Title:')} ${prTemplate.title}`);
          console.log(`\n${chalk.bold('Body:')}\n${prTemplate.body}`);
          if (prTemplate.labels.length > 0) {
            console.log(`\n${chalk.bold('Labels:')} ${prTemplate.labels.join(', ')}`);
          }
        } catch (err) {
          spinner.fail('PR generation failed');
          printError(err instanceof Error ? err.message : String(err));
        }
      })
  )
  .addCommand(
    new Command('status')
      .description('Show repository status')
      .action(async () => {
        const globalOpts = program.opts();
        const git = getGitManager(getProjectPath(globalOpts));
        try {
          const status = await git.getStatus();
          console.log(`\n${chalk.bold('Branch:')} ${chalk.cyan(status.branch)}`);
          console.log(`Staged: ${chalk.green(status.staged.length)} | Unstaged: ${chalk.yellow(status.unstaged.length)} | Untracked: ${chalk.gray(status.untracked.length)}`);
          if (status.staged.length > 0) {
            console.log(`\n${chalk.green('Staged:')}`);
            status.staged.forEach(f => console.log(`  ${chalk.green('+')} ${f}`));
          }
          if (status.unstaged.length > 0) {
            console.log(`\n${chalk.yellow('Modified:')}`);
            status.unstaged.forEach(f => console.log(`  ${chalk.yellow('~')} ${f}`));
          }
        } catch (err) {
          printError(err instanceof Error ? err.message : String(err));
        }
      })
  );

// ─── index command ────────────────────────────────────────────────────────────

program
  .command('index [path]')
  .description('Index a project for context-aware AI responses')
  .option('--force', 'Force re-index even if cache is fresh')
  .action(async (indexPath: string | undefined, opts) => {
    const globalOpts = program.opts();
    const targetPath = path.resolve(indexPath ?? globalOpts.project ?? process.cwd());
    const spinner = ora('Indexing project...').start();

    try {
      const memory = await getMemoryStore();
      const result = await memory.indexProject(targetPath, opts.force);
      spinner.succeed(`Project indexed: ${result.files} files, ${result.chunks} code chunks`);
    } catch (err) {
      spinner.fail('Indexing failed');
      printError(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ─── plugins command ──────────────────────────────────────────────────────────

program
  .command('plugins')
  .description('Manage AetherDev plugins')
  .addCommand(
    new Command('list').description('List installed plugins').action(async () => {
      const loader = await getPluginLoader();
      const plugins = loader.listPlugins();
      if (plugins.length === 0) { printInfo('No plugins installed'); return; }
      const rows = plugins.map(p => [
        p.manifest.name, p.manifest.version,
        p.status === 'active' ? chalk.green(p.status) : chalk.red(p.status),
        p.manifest.description.slice(0, 40),
      ]);
      console.log(table([['Name', 'Version', 'Status', 'Description'], ...rows]));
    })
  )
  .addCommand(
    new Command('reload <name>').description('Reload a plugin').action(async (name: string) => {
      const loader = await getPluginLoader();
      await loader.reloadPlugin(name);
      printSuccess(`Plugin reloaded: ${name}`);
    })
  );

// ─── status command ───────────────────────────────────────────────────────────

program
  .command('status')
  .description('Show AetherDev system status')
  .action(async () => {
    const cfg = getConfig();
    const engine = getEngine();
    const spinner = ora('Checking status...').start();

    try {
      const ollamaOk = cfg.llmProvider === 'ollama' ? await engine.checkOllamaHealth() : null;
      const models = cfg.llmProvider === 'ollama' ? await engine.listOllamaModels() : [];
      const stats = engine.getStats();

      spinner.stop();

      console.log(boxen(
        `${chalk.bold.cyan('AetherDev Status')}\n\n` +
        `Provider: ${chalk.cyan(cfg.llmProvider)}\n` +
        `Model: ${chalk.cyan(cfg.ollamaModel)}\n` +
        `Ollama: ${ollamaOk === null ? chalk.gray('N/A') : ollamaOk ? chalk.green('✓ Online') : chalk.red('✗ Offline')}\n` +
        `Available Models: ${chalk.cyan(models.slice(0, 3).join(', ') || 'none')}\n\n` +
        `Requests: ${stats.totalRequests} | Tokens: ${stats.totalTokens}\n` +
        `Cache Hits: ${stats.cacheHits} | Errors: ${stats.errors}`,
        { padding: 1, borderStyle: 'round', borderColor: 'cyan' }
      ));
    } catch (err) {
      spinner.fail('Status check failed');
      printError(err instanceof Error ? err.message : String(err));
    }
  });

// ─── interactive command ──────────────────────────────────────────────────────

program
  .command('interactive')
  .alias('i')
  .description('Start interactive AI chat session')
  .action(async () => {
    printBanner();
    const globalOpts = program.opts();
    const projectPath = getProjectPath(globalOpts);
    const sessionId = globalOpts.session ?? uuidv4();
    const engine = getEngine();
    const memory = await getMemoryStore();

    console.log(chalk.gray(`\nSession: ${sessionId}`));
    console.log(chalk.gray(`Project: ${projectPath}`));
    console.log(chalk.gray('Type "exit" to quit, "clear" to clear history\n'));

    while (true) {
      const userInput = await input({ message: chalk.cyan('You:') });

      if (userInput.toLowerCase() === 'exit') break;
      if (userInput.toLowerCase() === 'clear') {
        await memory.clearSession(sessionId);
        console.log(chalk.gray('Session cleared'));
        continue;
      }

      const spinner = ora('').start();
      try {
        const context = await memory.buildContext(userInput, projectPath).catch(() => '');
        const history = await memory.getConversationHistory(sessionId, 10);

        const messages = [
          ...history.map(h => ({ role: h.role as 'user' | 'assistant', content: h.content })),
          { role: 'user' as const, content: context ? `Context:\n${context}\n\nUser: ${userInput}` : userInput },
        ];

        spinner.stop();
        process.stdout.write(chalk.green('AetherDev: '));

        const response = await engine.streamOllama(
          { messages },
          chunk => { if (!chunk.done) process.stdout.write(chunk.delta); }
        );
        process.stdout.write('\n\n');

        await memory.saveMessage(sessionId, 'user', userInput);
        await memory.saveMessage(sessionId, 'assistant', response.content);
      } catch (err) {
        spinner.fail(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
      }
    }

    console.log(chalk.cyan('\nGoodbye! 👋\n'));
  });

// ─── Error Handling ───────────────────────────────────────────────────────────

program.on('command:*', (cmds) => {
  printError(`Unknown command: ${cmds[0]}`);
  console.log('Run ' + chalk.cyan('aether --help') + ' to see available commands');
  process.exit(1);
});

// ─── Entry Point ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (err instanceof Error && err.message.includes('User force closed')) {
      process.exit(0);
    }
    printError(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

main();

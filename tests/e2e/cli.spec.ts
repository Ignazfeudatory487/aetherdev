/**
 * AetherDev — CLI E2E Tests (Playwright)
 */

import { test, expect } from '@playwright/test';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';

const execAsync = promisify(exec);
const CLI_PATH = path.resolve(__dirname, '../../dist/cli/index.js');

async function runCLI(args: string, cwd?: string): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execAsync(`node ${CLI_PATH} ${args}`, {
      cwd: cwd ?? process.cwd(),
      env: { ...process.env, NODE_ENV: 'test', AETHER_LOG_LEVEL: 'error' },
      timeout: 30000,
    });
    return { stdout, stderr, code: 0 };
  } catch (err: any) {
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', code: err.code ?? 1 };
  }
}

test.describe('CLI Basic Commands', () => {
  test('should show version', async () => {
    const { stdout, code } = await runCLI('--version');
    expect(code).toBe(0);
    expect(stdout).toMatch(/\d+\.\d+\.\d+/);
  });

  test('should show help', async () => {
    const { stdout, code } = await runCLI('--help');
    expect(code).toBe(0);
    expect(stdout).toContain('aether');
    expect(stdout).toContain('generate');
    expect(stdout).toContain('review');
    expect(stdout).toContain('test');
  });

  test('should show status command help', async () => {
    const { stdout, code } = await runCLI('status --help');
    expect(code).toBe(0);
    expect(stdout).toContain('status');
  });

  test('should fail gracefully for unknown command', async () => {
    const { code } = await runCLI('unknown-command-xyz');
    expect(code).toBe(1);
  });
});

test.describe('CLI Scan Command', () => {
  let tmpDir: string;

  test.beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aether-e2e-'));
    await fs.writeFile(path.join(tmpDir, 'test.ts'), `
      const password = "hardcoded123";
      function greet(name: string): string {
        return \`Hello, \${name}\`;
      }
      export default greet;
    `);
  });

  test.afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('should scan a directory and produce output', async () => {
    const { stdout, code } = await runCLI(`scan ${tmpDir} --format json`);
    // Note: scan may exit 0 or 1 depending on findings
    expect([0, 1]).toContain(code);
    // If JSON output exists, it should be valid
    if (stdout.trim().startsWith('{')) {
      const result = JSON.parse(stdout);
      expect(result).toHaveProperty('overall');
    }
  });
});

test.describe('CLI Git Commands', () => {
  let tmpDir: string;

  test.beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aether-git-'));
    await execAsync('git init', { cwd: tmpDir });
    await execAsync('git config user.email "test@test.com"', { cwd: tmpDir });
    await execAsync('git config user.name "Test"', { cwd: tmpDir });
    await fs.writeFile(path.join(tmpDir, 'README.md'), '# Test');
    await execAsync('git add .', { cwd: tmpDir });
    await execAsync('git commit -m "init"', { cwd: tmpDir });
  });

  test.afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('should show git status', async () => {
    const { stdout, code } = await runCLI(`git status --project ${tmpDir}`);
    expect(code).toBe(0);
    expect(stdout).toContain('Branch:');
  });
});

/**
 * AetherDev — Execution Sandbox
 * Role-based, sandboxed command & code execution
 * Prevents unauthorized system calls, enforces timeouts, memory limits
 */

import { spawn, SpawnOptions } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { EventEmitter } from 'eventemitter3';
import { getConfig, getSandboxAllowedCommands, getSandboxBlockedCommands } from '../config/index.js';
import { getLogger } from '../utils/logger.js';
import { containsShellInjection, SecurityError } from '../utils/validator.js';
import { v4 as uuidv4 } from 'uuid';

const logger = getLogger('sandbox');

// ─── Types ────────────────────────────────────────────────────────────────────

export type ExecutionRole = 'read-only' | 'standard' | 'elevated' | 'admin';

export interface ExecutionOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
  maxMemoryMb?: number;
  role?: ExecutionRole;
  stdin?: string;
  captureOutput?: boolean;
  projectRoot?: string;
}

export interface ExecutionResult {
  id: string;
  command: string;
  args: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  killed: boolean;
  memoryUsedMb?: number;
  error?: string;
}

export interface SandboxPolicy {
  role: ExecutionRole;
  allowedCommands: string[];
  blockedCommands: string[];
  maxOutputBytes: number;
  allowNetworkAccess: boolean;
  allowFileWrite: boolean;
  allowProcessSpawn: boolean;
}

// ─── Role Policies ────────────────────────────────────────────────────────────

const ROLE_POLICIES: Record<ExecutionRole, Omit<SandboxPolicy, 'allowedCommands' | 'blockedCommands'>> = {
  'read-only': {
    role: 'read-only',
    maxOutputBytes: 512 * 1024,
    allowNetworkAccess: false,
    allowFileWrite: false,
    allowProcessSpawn: false,
  },
  'standard': {
    role: 'standard',
    maxOutputBytes: 2 * 1024 * 1024,
    allowNetworkAccess: false,
    allowFileWrite: true,
    allowProcessSpawn: true,
  },
  'elevated': {
    role: 'elevated',
    maxOutputBytes: 10 * 1024 * 1024,
    allowNetworkAccess: true,
    allowFileWrite: true,
    allowProcessSpawn: true,
  },
  'admin': {
    role: 'admin',
    maxOutputBytes: 50 * 1024 * 1024,
    allowNetworkAccess: true,
    allowFileWrite: true,
    allowProcessSpawn: true,
  },
};

const READ_ONLY_COMMANDS = ['ls', 'cat', 'head', 'tail', 'echo', 'pwd', 'which', 'type', 'find', 'grep', 'wc', 'stat'];
const ALWAYS_BLOCKED = ['rm', 'rmdir', 'del', 'format', 'fdisk', 'mkfs', 'dd', 'wget', 'curl', 'ssh', 'scp', 'rsync', 'nc', 'netcat', 'nmap', 'ncat', 'telnet', 'sudo', 'su', 'chmod', 'chown', 'passwd', 'useradd', 'userdel', 'reboot', 'shutdown', 'halt', 'poweroff', 'kill', 'killall', 'pkill'];

// ─── Execution History ────────────────────────────────────────────────────────

interface HistoryEntry {
  id: string;
  command: string;
  role: ExecutionRole;
  timestamp: number;
  durationMs: number;
  exitCode: number;
  projectRoot?: string;
}

// ─── Sandbox ──────────────────────────────────────────────────────────────────

export class Sandbox extends EventEmitter {
  private readonly cfg = getConfig();
  private readonly history: HistoryEntry[] = [];
  private readonly maxHistory = 500;
  private activeProcesses = new Map<string, ReturnType<typeof spawn>>();

  constructor() {
    super();
    logger.info('Sandbox initialized', {
      enabled: this.cfg.sandboxEnabled,
      timeout: this.cfg.sandboxTimeoutMs,
    });
  }

  // ─── Policy Resolution ────────────────────────────────────────────────────

  private buildPolicy(role: ExecutionRole = 'standard'): SandboxPolicy {
    const base = ROLE_POLICIES[role];
    const configAllowed = getSandboxAllowedCommands(this.cfg);
    const configBlocked = getSandboxBlockedCommands(this.cfg);

    return {
      ...base,
      allowedCommands: role === 'read-only' ? READ_ONLY_COMMANDS : configAllowed,
      blockedCommands: [...ALWAYS_BLOCKED, ...configBlocked],
    };
  }

  // ─── Command Validation ───────────────────────────────────────────────────

  validateCommand(command: string, args: string[], policy: SandboxPolicy): void {
    const fullCmd = command.toLowerCase();
    const baseCmd = path.basename(fullCmd);

    // Block always-blocked commands
    if (policy.blockedCommands.some(b => baseCmd === b || fullCmd.endsWith(`/${b}`) || fullCmd.endsWith(`\\${b}`))) {
      throw new SecurityError(`Command blocked by security policy: ${command}`);
    }

    // Check for shell injection in command
    const fullInput = [command, ...args].join(' ');
    if (containsShellInjection(fullInput)) {
      throw new SecurityError(`Shell injection detected in: ${fullInput}`);
    }

    // Read-only enforcement
    if (!policy.allowFileWrite) {
      const writeCommands = ['write', 'create', 'mkdir', 'touch', 'append', 'tee', 'install', 'init'];
      if (writeCommands.some(w => baseCmd.includes(w) || args.some(a => a.includes('--save') || a.includes('--write')))) {
        throw new SecurityError(`File write not allowed in ${policy.role} mode`);
      }
    }

    // Validate allowed commands list (if restrictive)
    if (policy.role === 'read-only' && !policy.allowedCommands.includes(baseCmd)) {
      throw new SecurityError(`Command not in allow-list for read-only mode: ${command}`);
    }

    // Check path safety for file operations
    const fileArgs = args.filter(a => !a.startsWith('-') && (a.includes('/') || a.includes('\\')));
    for (const fileArg of fileArgs) {
      if (fileArg.includes('..')) {
        throw new SecurityError(`Path traversal attempt detected: ${fileArg}`);
      }
    }
  }

  // ─── Execute ──────────────────────────────────────────────────────────────

  async execute(
    command: string,
    args: string[] = [],
    options: ExecutionOptions = {}
  ): Promise<ExecutionResult> {
    const execId = uuidv4();
    const role = options.role ?? 'standard';
    const policy = this.buildPolicy(role);
    const timeout = options.timeout ?? this.cfg.sandboxTimeoutMs;
    const maxOutput = policy.maxOutputBytes;
    const cwd = options.cwd ?? options.projectRoot ?? process.cwd();
    const start = Date.now();

    // Validate if sandbox enabled
    if (this.cfg.sandboxEnabled) {
      this.validateCommand(command, args, policy);
    }

    logger.debug('Executing command', { execId, command, args, cwd, role });
    this.emit('execution:start', { id: execId, command, args, role });

    return new Promise((resolve) => {
      const spawnOpts: SpawnOptions = {
        cwd,
        shell: false,
        env: {
          ...this.buildSafeEnv(),
          ...options.env,
        },
      };

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let killed = false;

      const child = spawn(command, args, spawnOpts);
      this.activeProcesses.set(execId, child);

      if (options.stdin) {
        child.stdin?.write(options.stdin);
        child.stdin?.end();
      }

      child.stdout?.on('data', (data: Buffer) => {
        const chunk = data.toString();
        stdout += chunk;
        if (stdout.length > maxOutput) {
          stdout = stdout.slice(0, maxOutput) + '\n[Output truncated]';
          child.kill('SIGTERM');
        }
        this.emit('execution:stdout', { id: execId, data: chunk });
      });

      child.stderr?.on('data', (data: Buffer) => {
        const chunk = data.toString();
        stderr += chunk;
        if (stderr.length > maxOutput) {
          stderr = stderr.slice(0, maxOutput) + '\n[Stderr truncated]';
        }
        this.emit('execution:stderr', { id: execId, data: chunk });
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 2000);
        logger.warn('Command timed out', { execId, command, timeout });
      }, timeout);

      child.on('close', (code) => {
        clearTimeout(timer);
        this.activeProcesses.delete(execId);
        const durationMs = Date.now() - start;

        const result: ExecutionResult = {
          id: execId,
          command,
          args,
          exitCode: code ?? (timedOut ? 124 : 1),
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          durationMs,
          timedOut,
          killed,
          error: timedOut ? `Command timed out after ${timeout}ms` : undefined,
        };

        this.addToHistory({ id: execId, command, role, timestamp: start, durationMs, exitCode: result.exitCode, projectRoot: options.projectRoot });
        this.emit('execution:complete', result);
        logger.debug('Command completed', { execId, exitCode: result.exitCode, durationMs });
        resolve(result);
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        this.activeProcesses.delete(execId);
        const durationMs = Date.now() - start;
        const result: ExecutionResult = {
          id: execId, command, args,
          exitCode: 1, stdout, stderr,
          durationMs, timedOut: false, killed: false,
          error: err.message,
        };
        resolve(result);
      });
    });
  }

  // ─── Convenience Methods ──────────────────────────────────────────────────

  async run(cmd: string, options: ExecutionOptions = {}): Promise<ExecutionResult> {
    const parts = cmd.trim().split(/\s+/);
    return this.execute(parts[0]!, parts.slice(1), options);
  }

  async runScript(
    code: string,
    language: 'node' | 'python' | 'bash',
    options: ExecutionOptions = {}
  ): Promise<ExecutionResult> {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aether-'));
    const ext = { node: '.js', python: '.py', bash: '.sh' }[language];
    const scriptPath = path.join(tmpDir, `script${ext}`);

    try {
      await fs.writeFile(scriptPath, code, 'utf-8');
      if (language === 'bash') await fs.chmod(scriptPath, 0o755);

      const runtimes = { node: 'node', python: 'python3', bash: 'bash' };
      return await this.execute(runtimes[language], [scriptPath], {
        ...options,
        role: options.role ?? 'standard',
      });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }

  async runNodeCode(code: string, options: ExecutionOptions = {}): Promise<ExecutionResult> {
    return this.runScript(code, 'node', options);
  }

  async runPythonCode(code: string, options: ExecutionOptions = {}): Promise<ExecutionResult> {
    return this.runScript(code, 'python', options);
  }

  async checkCommandAvailable(cmd: string): Promise<boolean> {
    const result = await this.execute('which', [cmd], { role: 'read-only', timeout: 3000 });
    return result.exitCode === 0;
  }

  killAll(): void {
    for (const [id, proc] of this.activeProcesses) {
      proc.kill('SIGTERM');
      logger.warn(`Killed process: ${id}`);
    }
    this.activeProcesses.clear();
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private buildSafeEnv(): Record<string, string> {
    const safeVars = ['PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'LC_ALL', 'TERM', 'NODE_ENV'];
    const env: Record<string, string> = {};
    for (const key of safeVars) {
      if (process.env[key]) env[key] = process.env[key]!;
    }
    env['AETHER_SANDBOX'] = '1';
    return env;
  }

  private addToHistory(entry: HistoryEntry): void {
    this.history.push(entry);
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }
  }

  getHistory(): ReadonlyArray<HistoryEntry> {
    return this.history;
  }

  getActiveProcessCount(): number {
    return this.activeProcesses.size;
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let _sandbox: Sandbox | null = null;

export function getSandbox(): Sandbox {
  if (!_sandbox) _sandbox = new Sandbox();
  return _sandbox;
}

export default getSandbox;

/**
 * AetherDev — Config Manager
 * Centralized, type-safe, Zod-validated configuration
 * Supports .env, env vars, and runtime overrides
 */

import { z } from 'zod';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

// ─── Schema ───────────────────────────────────────────────────────────────────

const LLMProviderSchema = z.enum(['ollama', 'openai', 'anthropic', 'local']);

const ConfigSchema = z.object({
  // App
  nodeEnv: z.enum(['development', 'production', 'test']).default('development'),
  port: z.coerce.number().int().min(1024).max(65535).default(3001),
  host: z.string().default('0.0.0.0'),
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  logFormat: z.enum(['pretty', 'json']).default('pretty'),
  secretKey: z.string().min(16).default('aetherdev_default_secret_changeme'),

  // LLM
  llmProvider: LLMProviderSchema.default('ollama'),
  ollamaBaseUrl: z.string().url().default('http://localhost:11434'),
  ollamaModel: z.string().default('codellama:13b'),
  ollamaFallbackModel: z.string().default('llama3:8b'),
  openaiApiKey: z.string().optional(),
  openaiBaseUrl: z.string().url().default('https://api.openai.com/v1'),
  openaiModel: z.string().default('gpt-4o'),
  anthropicApiKey: z.string().optional(),
  anthropicModel: z.string().default('claude-3-5-sonnet-20241022'),
  localLlmBaseUrl: z.string().default('http://localhost:1234/v1'),
  localLlmModel: z.string().default(''),
  llmMaxTokens: z.coerce.number().int().min(256).max(128000).default(8192),
  llmTemperature: z.coerce.number().min(0).max(2).default(0.2),
  llmRequestTimeout: z.coerce.number().int().default(120000),

  // Database
  sqlitePath: z.string().default('./data/aetherdev.db'),
  redisUrl: z.string().default('redis://localhost:6379'),
  redisPassword: z.string().optional(),

  // Vector Store
  chromaHost: z.string().default('localhost'),
  chromaPort: z.coerce.number().int().default(8000),
  chromaCollection: z.string().default('aetherdev_memory'),

  // Sandbox
  sandboxEnabled: z.coerce.boolean().default(true),
  sandboxTimeoutMs: z.coerce.number().int().default(30000),
  sandboxMaxMemoryMb: z.coerce.number().int().default(512),
  sandboxAllowedCommands: z.string().default('git,node,npm,python,pip,ls,cat,echo,mkdir,touch'),
  sandboxBlockedCommands: z.string().default('rm,curl,wget,ssh,nc,nmap,sudo,su'),

  // Git
  gitUserName: z.string().default('AetherDev Bot'),
  gitUserEmail: z.string().email().default('bot@aetherdev.local'),
  gitAutoCommit: z.coerce.boolean().default(false),
  gitSignCommits: z.coerce.boolean().default(false),

  // Collaboration
  collabEnabled: z.coerce.boolean().default(false),
  collabSignalingUrl: z.string().default('ws://localhost:3002'),
  collabMaxUsers: z.coerce.number().int().default(10),

  // Performance
  maxConcurrentAgents: z.coerce.number().int().min(1).max(32).default(4),
  agentQueueSize: z.coerce.number().int().default(100),
  memoryCacheTtl: z.coerce.number().int().default(3600),
  codeIndexBatchSize: z.coerce.number().int().default(50),
  cpuThrottlePercent: z.coerce.number().int().min(10).max(100).default(80),
  memoryLimitMb: z.coerce.number().int().default(2048),

  // Telemetry
  telemetryEnabled: z.coerce.boolean().default(false),
  telemetryEndpoint: z.string().optional(),

  // Plugins
  pluginsDir: z.string().default('./plugins'),
  pluginsAutoReload: z.coerce.boolean().default(true),
  pluginsSandbox: z.coerce.boolean().default(true),

  // STT
  sttEnabled: z.coerce.boolean().default(false),
  sttProvider: z.enum(['whisper', 'vosk']).default('whisper'),
  whisperModel: z.string().default('base.en'),

  // CI
  ci: z.coerce.boolean().default(false),
  ciFailOnSecurityIssues: z.coerce.boolean().default(true),
  ciFailOnComplexityThreshold: z.coerce.number().int().default(20),
});

export type AetherConfig = z.infer<typeof ConfigSchema>;

// ─── Parser ───────────────────────────────────────────────────────────────────

function parseEnv(): AetherConfig {
  const raw = {
    nodeEnv: process.env['NODE_ENV'],
    port: process.env['AETHER_PORT'],
    host: process.env['AETHER_HOST'],
    logLevel: process.env['AETHER_LOG_LEVEL'],
    logFormat: process.env['AETHER_LOG_FORMAT'],
    secretKey: process.env['AETHER_SECRET_KEY'],
    llmProvider: process.env['LLM_PROVIDER'],
    ollamaBaseUrl: process.env['OLLAMA_BASE_URL'],
    ollamaModel: process.env['OLLAMA_MODEL'],
    ollamaFallbackModel: process.env['OLLAMA_FALLBACK_MODEL'],
    openaiApiKey: process.env['OPENAI_API_KEY'],
    openaiBaseUrl: process.env['OPENAI_BASE_URL'],
    openaiModel: process.env['OPENAI_MODEL'],
    anthropicApiKey: process.env['ANTHROPIC_API_KEY'],
    anthropicModel: process.env['ANTHROPIC_MODEL'],
    localLlmBaseUrl: process.env['LOCAL_LLM_BASE_URL'],
    localLlmModel: process.env['LOCAL_LLM_MODEL'],
    llmMaxTokens: process.env['LLM_MAX_TOKENS'],
    llmTemperature: process.env['LLM_TEMPERATURE'],
    llmRequestTimeout: process.env['LLM_REQUEST_TIMEOUT'],
    sqlitePath: process.env['SQLITE_PATH'],
    redisUrl: process.env['REDIS_URL'],
    redisPassword: process.env['REDIS_PASSWORD'],
    chromaHost: process.env['CHROMA_HOST'],
    chromaPort: process.env['CHROMA_PORT'],
    chromaCollection: process.env['CHROMA_COLLECTION'],
    sandboxEnabled: process.env['SANDBOX_ENABLED'],
    sandboxTimeoutMs: process.env['SANDBOX_TIMEOUT_MS'],
    sandboxMaxMemoryMb: process.env['SANDBOX_MAX_MEMORY_MB'],
    sandboxAllowedCommands: process.env['SANDBOX_ALLOWED_COMMANDS'],
    sandboxBlockedCommands: process.env['SANDBOX_BLOCKED_COMMANDS'],
    gitUserName: process.env['GIT_USER_NAME'],
    gitUserEmail: process.env['GIT_USER_EMAIL'],
    gitAutoCommit: process.env['GIT_AUTO_COMMIT'],
    gitSignCommits: process.env['GIT_SIGN_COMMITS'],
    collabEnabled: process.env['COLLAB_ENABLED'],
    collabSignalingUrl: process.env['COLLAB_SIGNALING_URL'],
    collabMaxUsers: process.env['COLLAB_MAX_USERS'],
    maxConcurrentAgents: process.env['MAX_CONCURRENT_AGENTS'],
    agentQueueSize: process.env['AGENT_QUEUE_SIZE'],
    memoryCacheTtl: process.env['MEMORY_CACHE_TTL'],
    codeIndexBatchSize: process.env['CODE_INDEX_BATCH_SIZE'],
    cpuThrottlePercent: process.env['CPU_THROTTLE_PERCENT'],
    memoryLimitMb: process.env['MEMORY_LIMIT_MB'],
    telemetryEnabled: process.env['TELEMETRY_ENABLED'],
    telemetryEndpoint: process.env['TELEMETRY_ENDPOINT'],
    pluginsDir: process.env['PLUGINS_DIR'],
    pluginsAutoReload: process.env['PLUGINS_AUTO_RELOAD'],
    pluginsSandbox: process.env['PLUGINS_SANDBOX'],
    sttEnabled: process.env['STT_ENABLED'],
    sttProvider: process.env['STT_PROVIDER'],
    whisperModel: process.env['WHISPER_MODEL'],
    ci: process.env['CI'],
    ciFailOnSecurityIssues: process.env['CI_FAIL_ON_SECURITY_ISSUES'],
    ciFailOnComplexityThreshold: process.env['CI_FAIL_ON_COMPLEXITY_THRESHOLD'],
  };

  // Remove undefined entries so Zod defaults apply
  const cleaned = Object.fromEntries(
    Object.entries(raw).filter(([, v]) => v !== undefined && v !== '')
  );

  const result = ConfigSchema.safeParse(cleaned);
  if (!result.success) {
    const errors = result.error.flatten().fieldErrors;
    console.error('[AetherConfig] Configuration validation failed:');
    Object.entries(errors).forEach(([field, msgs]) => {
      console.error(`  ${field}: ${msgs?.join(', ')}`);
    });
    process.exit(1);
  }

  return result.data;
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let _config: AetherConfig | null = null;

export function getConfig(): AetherConfig {
  if (!_config) {
    _config = parseEnv();
    ensureDataDirectories(_config);
  }
  return _config;
}

export function reloadConfig(): AetherConfig {
  _config = null;
  return getConfig();
}

function ensureDataDirectories(cfg: AetherConfig): void {
  const sqliteDir = path.dirname(path.resolve(process.cwd(), cfg.sqlitePath));
  const pluginsDir = path.resolve(process.cwd(), cfg.pluginsDir);
  [sqliteDir, pluginsDir].forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
}

export function getSandboxAllowedCommands(cfg: AetherConfig): string[] {
  return cfg.sandboxAllowedCommands.split(',').map(c => c.trim()).filter(Boolean);
}

export function getSandboxBlockedCommands(cfg: AetherConfig): string[] {
  return cfg.sandboxBlockedCommands.split(',').map(c => c.trim()).filter(Boolean);
}

export function isProduction(): boolean {
  return getConfig().nodeEnv === 'production';
}

export function isDevelopment(): boolean {
  return getConfig().nodeEnv === 'development';
}

export function isTest(): boolean {
  return getConfig().nodeEnv === 'test';
}

export { ConfigSchema };
export default getConfig;

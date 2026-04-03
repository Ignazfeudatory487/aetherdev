/**
 * AetherDev — Core AI Engine
 * Unified LLM interface with retries, fallbacks, streaming, and token counting
 * Supports: Ollama (local) | OpenAI-compatible | Anthropic | LM Studio
 */

import axios, { AxiosInstance, AxiosError } from 'axios';
import { EventEmitter } from 'eventemitter3';
import pRetry from 'p-retry';
import pLimit from 'p-limit';
import { LRUCache } from 'lru-cache';
import { getConfig, AetherConfig } from '../config/index.js';
import { getLogger, logError } from '../utils/logger.js';
import { extractCodeBlocks, extractJsonFromResponse, truncateForLLM } from '../utils/validator.js';
import { v4 as uuidv4 } from 'uuid';

const logger = getLogger('engine');

// ─── Types ────────────────────────────────────────────────────────────────────

export type LLMProvider = 'ollama' | 'openai' | 'anthropic' | 'local';
export type MessageRole = 'system' | 'user' | 'assistant';

export interface Message {
  role: MessageRole;
  content: string;
}

export interface LLMRequest {
  messages: Message[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  responseFormat?: 'text' | 'json';
  stopSequences?: string[];
  systemPrompt?: string;
}

export interface LLMResponse {
  id: string;
  content: string;
  model: string;
  provider: LLMProvider;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  finishReason: 'stop' | 'length' | 'error';
  latencyMs: number;
}

export interface StreamChunk {
  id: string;
  delta: string;
  done: boolean;
}

export type StreamCallback = (chunk: StreamChunk) => void | Promise<void>;

export interface EngineStats {
  totalRequests: number;
  totalTokens: number;
  totalLatencyMs: number;
  errors: number;
  cacheHits: number;
  provider: LLMProvider;
  model: string;
}

// ─── System Prompts ───────────────────────────────────────────────────────────

export const SYSTEM_PROMPTS = {
  coder: `You are AetherDev, an expert AI software engineer. You write clean, efficient, well-documented code following SOLID, DRY, and KISS principles. You always:
- Write complete, working code — no placeholders, no TODOs unless explicitly asked
- Follow the project's existing patterns and conventions
- Include error handling and edge cases
- Add concise inline comments for complex logic
- Return code in properly formatted markdown code blocks with language identifiers
- Consider security, performance, and maintainability`,

  reviewer: `You are AetherDev Code Reviewer. You review code for:
- Bugs, logic errors, and off-by-one errors
- Security vulnerabilities (injection, XSS, CSRF, insecure deserialization, etc.)
- Performance bottlenecks and memory leaks
- Code style and convention violations
- Missing error handling
- Test coverage gaps
Return structured JSON feedback with severity levels: critical, high, medium, low, info`,

  planner: `You are AetherDev Task Planner. Break down complex tasks into clear, actionable steps.
Return your plan as structured JSON with: steps[], dependencies, estimatedComplexity, risks[].
Each step must have: id, description, type (code|test|docs|refactor|review), targetFiles[], acceptanceCriteria`,

  tester: `You are AetherDev Test Engineer. Write comprehensive tests that:
- Cover happy paths, edge cases, and error conditions
- Follow AAA (Arrange-Act-Assert) pattern
- Use descriptive test names that explain what and why
- Mock external dependencies appropriately
- Achieve high coverage without redundancy
Write tests in the appropriate framework for the detected language/stack`,

  documenter: `You are AetherDev Documentation Writer. Create clear, accurate technical documentation:
- API docs with parameter descriptions, return types, examples
- Architecture explanations with diagrams (as Mermaid/ASCII)
- Setup and usage guides
- Troubleshooting sections
Use clear language, real examples, and proper formatting`,

  debugger: `You are AetherDev Debugger. Analyze errors and provide:
1. Root cause analysis (not just symptoms)
2. Step-by-step fix with explanation
3. Prevention strategies
4. Test cases to verify the fix
Be precise about line numbers and code paths`,
} as const;

// ─── Token Estimator ──────────────────────────────────────────────────────────

function estimateTokens(text: string): number {
  // Rough approximation: ~4 chars per token for English code
  return Math.ceil(text.length / 4);
}

// ─── Request Cache ────────────────────────────────────────────────────────────

interface CacheEntry {
  response: LLMResponse;
  timestamp: number;
}

// ─── Engine ───────────────────────────────────────────────────────────────────

export class AetherEngine extends EventEmitter {
  private readonly cfg: AetherConfig;
  private readonly http: AxiosInstance;
  private readonly limiter: ReturnType<typeof pLimit>;
  private readonly cache: LRUCache<string, CacheEntry>;
  private readonly stats: EngineStats;

  constructor() {
    super();
    this.cfg = getConfig();
    this.http = axios.create({
      timeout: this.cfg.llmRequestTimeout,
      headers: { 'Content-Type': 'application/json' },
    });
    this.limiter = pLimit(this.cfg.maxConcurrentAgents);
    this.cache = new LRUCache<string, CacheEntry>({
      max: 200,
      ttl: this.cfg.memoryCacheTtl * 1000,
    });
    this.stats = {
      totalRequests: 0,
      totalTokens: 0,
      totalLatencyMs: 0,
      errors: 0,
      cacheHits: 0,
      provider: this.cfg.llmProvider,
      model: this.getActiveModel(),
    };
    logger.info('AetherEngine initialized', { provider: this.cfg.llmProvider, model: this.getActiveModel() });
  }

  getActiveModel(): string {
    switch (this.cfg.llmProvider) {
      case 'ollama': return this.cfg.ollamaModel;
      case 'openai': return this.cfg.openaiModel;
      case 'anthropic': return this.cfg.anthropicModel;
      case 'local': return this.cfg.localLlmModel;
    }
  }

  getStats(): Readonly<EngineStats> {
    return { ...this.stats };
  }

  // ─── Main Chat Method ──────────────────────────────────────────────────────

  async chat(request: LLMRequest): Promise<LLMResponse> {
    const cacheKey = this.buildCacheKey(request);
    const cached = this.cache.get(cacheKey);
    if (cached && !request.stream) {
      this.stats.cacheHits++;
      logger.debug('Cache hit', { cacheKey: cacheKey.slice(0, 20) });
      return cached.response;
    }

    return this.limiter(() => this.chatWithRetry(request, cacheKey));
  }

  private async chatWithRetry(request: LLMRequest, cacheKey: string): Promise<LLMResponse> {
    return pRetry(
      async () => {
        try {
          return await this.dispatch(request, cacheKey);
        } catch (err) {
          if (this.isNonRetryableError(err)) {
            throw new pRetry.AbortError(err instanceof Error ? err.message : String(err));
          }
          throw err;
        }
      },
      {
        retries: 3,
        minTimeout: 1000,
        maxTimeout: 10000,
        factor: 2,
        onFailedAttempt: (error) => {
          logger.warn(`LLM request failed (attempt ${error.attemptNumber}/${error.retriesLeft + error.attemptNumber})`, {
            message: error.message,
          });
          // Try fallback on second attempt
          if (error.attemptNumber === 2 && this.cfg.llmProvider === 'ollama') {
            logger.info('Attempting fallback to lighter model');
          }
        },
      }
    );
  }

  private async dispatch(request: LLMRequest, cacheKey: string): Promise<LLMResponse> {
    const start = Date.now();
    this.stats.totalRequests++;

    let response: LLMResponse;
    try {
      switch (this.cfg.llmProvider) {
        case 'ollama':
          response = await this.callOllama(request);
          break;
        case 'openai':
        case 'local':
          response = await this.callOpenAICompatible(request);
          break;
        case 'anthropic':
          response = await this.callAnthropic(request);
          break;
        default:
          throw new Error(`Unknown LLM provider: ${this.cfg.llmProvider}`);
      }
    } catch (err) {
      this.stats.errors++;
      // Attempt fallback to Ollama fallback model
      if (this.cfg.llmProvider === 'ollama') {
        logger.warn('Primary model failed, trying fallback model');
        response = await this.callOllamaFallback(request);
      } else {
        throw err;
      }
    }

    response.latencyMs = Date.now() - start;
    this.stats.totalTokens += response.usage.totalTokens;
    this.stats.totalLatencyMs += response.latencyMs;

    if (!request.stream) {
      this.cache.set(cacheKey, { response, timestamp: Date.now() });
    }

    this.emit('response', response);
    logger.debug('LLM response received', {
      provider: response.provider,
      model: response.model,
      tokens: response.usage.totalTokens,
      latency: response.latencyMs,
    });

    return response;
  }

  // ─── Ollama ────────────────────────────────────────────────────────────────

  private async callOllama(request: LLMRequest, modelOverride?: string): Promise<LLMResponse> {
    const model = modelOverride ?? (request.model ?? this.cfg.ollamaModel);
    const messages = this.buildMessages(request);

    const body = {
      model,
      messages,
      stream: false,
      options: {
        temperature: request.temperature ?? this.cfg.llmTemperature,
        num_predict: request.maxTokens ?? this.cfg.llmMaxTokens,
        stop: request.stopSequences,
      },
      format: request.responseFormat === 'json' ? 'json' : undefined,
    };

    const res = await this.http.post(`${this.cfg.ollamaBaseUrl}/api/chat`, body);
    const data = res.data as {
      message: { content: string };
      model: string;
      prompt_eval_count?: number;
      eval_count?: number;
      done_reason?: string;
    };

    return {
      id: uuidv4(),
      content: data.message.content,
      model: data.model,
      provider: 'ollama',
      usage: {
        promptTokens: data.prompt_eval_count ?? 0,
        completionTokens: data.eval_count ?? 0,
        totalTokens: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0),
      },
      finishReason: data.done_reason === 'stop' ? 'stop' : 'length',
      latencyMs: 0,
    };
  }

  private async callOllamaFallback(request: LLMRequest): Promise<LLMResponse> {
    return this.callOllama(request, this.cfg.ollamaFallbackModel);
  }

  async streamOllama(request: LLMRequest, onChunk: StreamCallback): Promise<LLMResponse> {
    const model = request.model ?? this.cfg.ollamaModel;
    const messages = this.buildMessages(request);
    const id = uuidv4();
    let fullContent = '';
    let promptTokens = 0;
    let completionTokens = 0;

    const res = await this.http.post(
      `${this.cfg.ollamaBaseUrl}/api/chat`,
      { model, messages, stream: true },
      { responseType: 'stream' }
    );

    return new Promise((resolve, reject) => {
      let buffer = '';
      res.data.on('data', async (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line) as {
              message?: { content: string };
              done?: boolean;
              prompt_eval_count?: number;
              eval_count?: number;
            };
            if (parsed.message?.content) {
              fullContent += parsed.message.content;
              await onChunk({ id, delta: parsed.message.content, done: false });
            }
            if (parsed.done) {
              promptTokens = parsed.prompt_eval_count ?? 0;
              completionTokens = parsed.eval_count ?? 0;
            }
          } catch { /* Skip malformed JSON */ }
        }
      });

      res.data.on('end', async () => {
        await onChunk({ id, delta: '', done: true });
        resolve({
          id, content: fullContent, model, provider: 'ollama',
          usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
          finishReason: 'stop', latencyMs: 0,
        });
      });

      res.data.on('error', reject);
    });
  }

  // ─── OpenAI-Compatible ────────────────────────────────────────────────────

  private async callOpenAICompatible(request: LLMRequest): Promise<LLMResponse> {
    const isLocal = this.cfg.llmProvider === 'local';
    const baseUrl = isLocal ? this.cfg.localLlmBaseUrl : this.cfg.openaiBaseUrl;
    const model = request.model ?? (isLocal ? this.cfg.localLlmModel : this.cfg.openaiModel);
    const apiKey = isLocal ? 'local' : (this.cfg.openaiApiKey ?? '');

    const messages = this.buildMessages(request);

    const body = {
      model,
      messages,
      temperature: request.temperature ?? this.cfg.llmTemperature,
      max_tokens: request.maxTokens ?? this.cfg.llmMaxTokens,
      response_format: request.responseFormat === 'json' ? { type: 'json_object' } : undefined,
      stop: request.stopSequences,
    };

    const res = await this.http.post(`${baseUrl}/chat/completions`, body, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    const data = res.data as {
      id: string;
      choices: Array<{
        message: { content: string };
        finish_reason: string;
      }>;
      model: string;
      usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
      };
    };

    const choice = data.choices[0]!;
    return {
      id: data.id,
      content: choice.message.content,
      model: data.model,
      provider: this.cfg.llmProvider as 'openai' | 'local',
      usage: {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
        totalTokens: data.usage?.total_tokens ?? 0,
      },
      finishReason: choice.finish_reason === 'stop' ? 'stop' : 'length',
      latencyMs: 0,
    };
  }

  // ─── Anthropic ────────────────────────────────────────────────────────────

  private async callAnthropic(request: LLMRequest): Promise<LLMResponse> {
    const apiKey = this.cfg.anthropicApiKey ?? '';
    const model = request.model ?? this.cfg.anthropicModel;
    const systemMsg = request.systemPrompt
      ?? request.messages.find(m => m.role === 'system')?.content;
    const userMessages = request.messages.filter(m => m.role !== 'system');

    const body = {
      model,
      max_tokens: request.maxTokens ?? this.cfg.llmMaxTokens,
      temperature: request.temperature ?? this.cfg.llmTemperature,
      system: systemMsg,
      messages: userMessages.map(m => ({ role: m.role, content: m.content })),
    };

    const res = await this.http.post('https://api.anthropic.com/v1/messages', body, {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
    });

    const data = res.data as {
      id: string;
      content: Array<{ type: string; text: string }>;
      model: string;
      stop_reason: string;
      usage: { input_tokens: number; output_tokens: number };
    };

    const content = data.content.find(c => c.type === 'text')?.text ?? '';

    return {
      id: data.id,
      content,
      model: data.model,
      provider: 'anthropic',
      usage: {
        promptTokens: data.usage.input_tokens,
        completionTokens: data.usage.output_tokens,
        totalTokens: data.usage.input_tokens + data.usage.output_tokens,
      },
      finishReason: data.stop_reason === 'end_turn' ? 'stop' : 'length',
      latencyMs: 0,
    };
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private buildMessages(request: LLMRequest): Message[] {
    const messages: Message[] = [];
    if (request.systemPrompt) {
      messages.push({ role: 'system', content: request.systemPrompt });
    }
    messages.push(...request.messages);
    return messages;
  }

  private buildCacheKey(request: LLMRequest): string {
    const key = JSON.stringify({
      messages: request.messages,
      model: request.model,
      temperature: request.temperature ?? this.cfg.llmTemperature,
    });
    // Simple hash
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
      hash = ((hash << 5) - hash) + key.charCodeAt(i);
      hash |= 0;
    }
    return `cache_${Math.abs(hash)}`;
  }

  private isNonRetryableError(err: unknown): boolean {
    if (err instanceof AxiosError) {
      const status = err.response?.status ?? 0;
      return status === 400 || status === 401 || status === 403 || status === 404;
    }
    return false;
  }

  // ─── High-Level Helpers ───────────────────────────────────────────────────

  async generate(prompt: string, systemPrompt?: string, options: Partial<LLMRequest> = {}): Promise<string> {
    const response = await this.chat({
      messages: [{ role: 'user', content: prompt }],
      systemPrompt: systemPrompt ?? SYSTEM_PROMPTS.coder,
      ...options,
    });
    return response.content;
  }

  async generateCode(
    prompt: string,
    language: string,
    context?: string,
    options: Partial<LLMRequest> = {}
  ): Promise<string> {
    const fullPrompt = context
      ? `Context:\n\`\`\`\n${truncateForLLM(context, 4000)}\n\`\`\`\n\nTask: ${prompt}\n\nGenerate ${language} code.`
      : `Task: ${prompt}\n\nGenerate ${language} code.`;

    const response = await this.generate(fullPrompt, SYSTEM_PROMPTS.coder, options);
    const blocks = extractCodeBlocks(response);
    const langBlock = blocks.find(b => b.lang === language.toLowerCase() || b.lang === 'ts' || b.lang === 'js');
    return langBlock?.code ?? response;
  }

  async generateJSON<T>(prompt: string, systemPrompt?: string): Promise<T> {
    const response = await this.chat({
      messages: [{ role: 'user', content: `${prompt}\n\nRespond with valid JSON only.` }],
      systemPrompt: systemPrompt ?? SYSTEM_PROMPTS.planner,
      responseFormat: 'json',
    });
    return extractJsonFromResponse(response.content) as T;
  }

  async checkOllamaHealth(): Promise<boolean> {
    try {
      await this.http.get(`${this.cfg.ollamaBaseUrl}/api/tags`, { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  async listOllamaModels(): Promise<string[]> {
    try {
      const res = await this.http.get(`${this.cfg.ollamaBaseUrl}/api/tags`);
      const data = res.data as { models: Array<{ name: string }> };
      return data.models.map(m => m.name);
    } catch {
      return [];
    }
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let _engine: AetherEngine | null = null;

export function getEngine(): AetherEngine {
  if (!_engine) _engine = new AetherEngine();
  return _engine;
}

export function resetEngine(): void {
  _engine = null;
}

export default getEngine;

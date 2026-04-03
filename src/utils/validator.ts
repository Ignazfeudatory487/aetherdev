/**
 * AetherDev — Input Validator & Sanitizer
 * Prevents prompt injection, path traversal, and command injection
 */

import { z, ZodSchema } from 'zod';
import sanitizeHtml from 'sanitize-html';
import * as path from 'path';

// ─── Common Schemas ───────────────────────────────────────────────────────────

export const PromptSchema = z.string()
  .min(1, 'Prompt cannot be empty')
  .max(32000, 'Prompt exceeds maximum length')
  .transform(s => s.trim());

export const FilePathSchema = z.string()
  .min(1)
  .max(512)
  .refine(p => !p.includes('\0'), 'Path contains null bytes')
  .refine(p => !p.match(/\.\.[/\\]/), 'Path traversal detected')
  .transform(p => path.normalize(p));

export const CommandSchema = z.string()
  .min(1)
  .max(1024)
  .refine(cmd => !containsShellInjection(cmd), 'Command contains shell injection characters');

export const ProjectNameSchema = z.string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_\-. ]+$/, 'Project name contains invalid characters');

export const PluginNameSchema = z.string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9-]+$/, 'Plugin name must be lowercase alphanumeric with hyphens');

export const TaskSchema = z.object({
  id: z.string().uuid().optional(),
  type: z.enum(['generate', 'refactor', 'debug', 'test', 'explain', 'review', 'document', 'custom']),
  prompt: PromptSchema,
  context: z.record(z.unknown()).optional(),
  projectPath: FilePathSchema.optional(),
  targetFiles: z.array(FilePathSchema).max(50).optional(),
  maxIterations: z.number().int().min(1).max(20).default(5),
  timeoutMs: z.number().int().min(1000).max(600000).default(120000),
});

export type ValidatedTask = z.infer<typeof TaskSchema>;

// ─── Shell Injection Detection ────────────────────────────────────────────────

const SHELL_INJECTION_PATTERNS = [
  /[;&|`$(){}[\]<>]/,
  /\$\(/,         // command substitution
  /`[^`]*`/,      // backtick execution
  /\|\|/,         // or operator
  /&&/,           // and operator
  />[>]?/,        // redirect
  /<</,           // heredoc
  /\$\{/,         // variable expansion
];

const PROMPT_INJECTION_PATTERNS = [
  /ignore\s+(?:all\s+)?(?:previous|above|prior)\s+instructions/i,
  /you\s+are\s+now\s+(?:a\s+)?(?:different|new|another)/i,
  /system\s+prompt/i,
  /jailbreak/i,
  /forget\s+(?:everything|all)/i,
  /<\/?(?:system|user|assistant|instruction)>/i,
  /\[INST\]/i,
  /###\s*system/i,
];

export function containsShellInjection(input: string): boolean {
  return SHELL_INJECTION_PATTERNS.some(pattern => pattern.test(input));
}

export function containsPromptInjection(input: string): boolean {
  return PROMPT_INJECTION_PATTERNS.some(pattern => pattern.test(input));
}

// ─── Path Safety ──────────────────────────────────────────────────────────────

export function isPathSafe(filePath: string, allowedRoot: string): boolean {
  const resolved = path.resolve(filePath);
  const resolvedRoot = path.resolve(allowedRoot);
  return resolved.startsWith(resolvedRoot);
}

export function sanitizePath(filePath: string, root: string): string {
  const normalized = path.normalize(filePath.replace(/\0/g, ''));
  const resolved = path.resolve(root, normalized);
  if (!resolved.startsWith(path.resolve(root))) {
    throw new SecurityError(`Path traversal detected: ${filePath}`);
  }
  return resolved;
}

// ─── HTML Sanitizer ───────────────────────────────────────────────────────────

export function sanitizeOutput(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ['p', 'br', 'strong', 'em', 'code', 'pre', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'span', 'div', 'blockquote', 'a'],
    allowedAttributes: {
      'a': ['href', 'target'],
      'code': ['class'],
      'pre': ['class'],
      'span': ['class'],
    },
    allowedSchemes: ['http', 'https'],
  });
}

// ─── Generic Validator ────────────────────────────────────────────────────────

export function validate<T>(schema: ZodSchema<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const messages = result.error.flatten().fieldErrors;
    throw new ValidationError(
      `Validation failed: ${JSON.stringify(messages)}`,
      messages as Record<string, string[]>
    );
  }
  return result.data;
}

export function validatePartial<T>(schema: ZodSchema<T>, data: unknown): Partial<T> {
  if (schema instanceof z.ZodObject) {
    return validate(schema.partial(), data) as Partial<T>;
  }
  return validate(schema, data) as unknown as Partial<T>;
}

// ─── Custom Errors ────────────────────────────────────────────────────────────

export class ValidationError extends Error {
  readonly fields: Record<string, string[]>;

  constructor(message: string, fields: Record<string, string[]> = {}) {
    super(message);
    this.name = 'ValidationError';
    this.fields = fields;
  }
}

export class SecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecurityError';
  }
}

// ─── LLM Response Validator ───────────────────────────────────────────────────

export function extractCodeBlocks(text: string): Array<{ lang: string; code: string }> {
  const pattern = /```(\w*)\n([\s\S]*?)```/g;
  const blocks: Array<{ lang: string; code: string }> = [];
  let match;
  while ((match = pattern.exec(text)) !== null) {
    blocks.push({
      lang: (match[1] ?? '').toLowerCase() || 'text',
      code: match[2] ?? '',
    });
  }
  return blocks;
}

export function extractJsonFromResponse(text: string): unknown {
  // Try direct parse
  try {
    return JSON.parse(text);
  } catch { /* continue */ }

  // Try extracting JSON from code blocks
  const blocks = extractCodeBlocks(text);
  for (const block of blocks) {
    if (block.lang === 'json' || block.lang === '') {
      try {
        return JSON.parse(block.code);
      } catch { /* continue */ }
    }
  }

  // Try finding JSON object/array in text
  const jsonMatch = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch { /* continue */ }
  }

  throw new ValidationError(`Could not extract valid JSON from LLM response`);
}

export function truncateForLLM(text: string, maxChars: number = 8000): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  return `${text.slice(0, half)}\n\n[... ${text.length - maxChars} chars truncated ...]\n\n${text.slice(-half)}`;
}

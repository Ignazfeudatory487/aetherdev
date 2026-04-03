/**
 * AetherDev — Filesystem Utilities
 * Safe, async file operations with path validation and change watching
 */

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { glob } from 'fast-glob';
import chokidar, { FSWatcher } from 'chokidar';
import { getLogger } from './logger.js';
import { sanitizePath, isPathSafe } from './validator.js';

const logger = getLogger('fs');

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FileInfo {
  path: string;
  name: string;
  ext: string;
  size: number;
  modified: Date;
  isDirectory: boolean;
}

export interface ReadResult {
  content: string;
  encoding: BufferEncoding;
  size: number;
  path: string;
}

export interface WriteResult {
  path: string;
  size: number;
  created: boolean;
}

export interface DirectoryTree {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: DirectoryTree[];
  size?: number;
  ext?: string;
}

export type WatchEvent = 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';
export type WatchCallback = (event: WatchEvent, filePath: string) => void;

// ─── Core File Operations ─────────────────────────────────────────────────────

export async function readFile(filePath: string, root?: string): Promise<ReadResult> {
  const safePath = root ? sanitizePath(filePath, root) : path.resolve(filePath);
  const stat = await fs.stat(safePath);
  if (!stat.isFile()) {
    throw new Error(`Not a file: ${safePath}`);
  }
  if (stat.size > 10 * 1024 * 1024) {
    throw new Error(`File too large (${stat.size} bytes). Max 10MB.`);
  }
  const content = await fs.readFile(safePath, 'utf-8');
  return { content, encoding: 'utf-8', size: stat.size, path: safePath };
}

export async function writeFile(
  filePath: string,
  content: string,
  root?: string,
  options: { createDirs?: boolean; backup?: boolean } = {}
): Promise<WriteResult> {
  const safePath = root ? sanitizePath(filePath, root) : path.resolve(filePath);
  const dir = path.dirname(safePath);
  const exists = fsSync.existsSync(safePath);

  if (options.createDirs) {
    await fs.mkdir(dir, { recursive: true });
  }

  if (options.backup && exists) {
    const backupPath = `${safePath}.bak.${Date.now()}`;
    await fs.copyFile(safePath, backupPath);
    logger.debug(`Backup created: ${backupPath}`);
  }

  await fs.writeFile(safePath, content, 'utf-8');
  const stat = await fs.stat(safePath);
  logger.debug(`File written: ${safePath} (${stat.size} bytes)`);
  return { path: safePath, size: stat.size, created: !exists };
}

export async function appendFile(filePath: string, content: string): Promise<void> {
  await fs.appendFile(filePath, content, 'utf-8');
}

export async function deleteFile(filePath: string, root?: string): Promise<void> {
  const safePath = root ? sanitizePath(filePath, root) : path.resolve(filePath);
  await fs.unlink(safePath);
  logger.debug(`File deleted: ${safePath}`);
}

export async function moveFile(src: string, dest: string, root?: string): Promise<void> {
  const safeSrc = root ? sanitizePath(src, root) : path.resolve(src);
  const safeDest = root ? sanitizePath(dest, root) : path.resolve(dest);
  await fs.mkdir(path.dirname(safeDest), { recursive: true });
  await fs.rename(safeSrc, safeDest);
  logger.debug(`File moved: ${safeSrc} → ${safeDest}`);
}

export async function copyFile(src: string, dest: string, root?: string): Promise<void> {
  const safeSrc = root ? sanitizePath(src, root) : path.resolve(src);
  const safeDest = root ? sanitizePath(dest, root) : path.resolve(dest);
  await fs.mkdir(path.dirname(safeDest), { recursive: true });
  await fs.copyFile(safeSrc, safeDest);
}

// ─── Directory Operations ─────────────────────────────────────────────────────

export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(path.resolve(dirPath), { recursive: true });
}

export async function listDirectory(
  dirPath: string,
  options: { recursive?: boolean; includeHidden?: boolean } = {}
): Promise<FileInfo[]> {
  const safePath = path.resolve(dirPath);
  const entries = await fs.readdir(safePath, { withFileTypes: true });
  const results: FileInfo[] = [];

  for (const entry of entries) {
    if (!options.includeHidden && entry.name.startsWith('.')) continue;
    const fullPath = path.join(safePath, entry.name);
    try {
      const stat = await fs.stat(fullPath);
      results.push({
        path: fullPath,
        name: entry.name,
        ext: path.extname(entry.name),
        size: stat.size,
        modified: stat.mtime,
        isDirectory: entry.isDirectory(),
      });

      if (options.recursive && entry.isDirectory()) {
        const children = await listDirectory(fullPath, options);
        results.push(...children);
      }
    } catch {
      // Skip unreadable entries
    }
  }
  return results;
}

export async function buildDirectoryTree(
  dirPath: string,
  maxDepth: number = 5,
  currentDepth: number = 0
): Promise<DirectoryTree> {
  const safePath = path.resolve(dirPath);
  const name = path.basename(safePath);

  if (currentDepth >= maxDepth) {
    return { name, path: safePath, isDirectory: true };
  }

  try {
    const entries = await fs.readdir(safePath, { withFileTypes: true });
    const ignorePatterns = ['node_modules', '.git', 'dist', '__pycache__', '.venv', 'coverage'];
    const children: DirectoryTree[] = [];

    for (const entry of entries) {
      if (ignorePatterns.includes(entry.name) || entry.name.startsWith('.')) continue;
      const childPath = path.join(safePath, entry.name);
      if (entry.isDirectory()) {
        children.push(await buildDirectoryTree(childPath, maxDepth, currentDepth + 1));
      } else {
        const stat = await fs.stat(childPath);
        children.push({
          name: entry.name,
          path: childPath,
          isDirectory: false,
          size: stat.size,
          ext: path.extname(entry.name),
        });
      }
    }
    return { name, path: safePath, isDirectory: true, children };
  } catch {
    return { name, path: safePath, isDirectory: true };
  }
}

// ─── File Search ──────────────────────────────────────────────────────────────

export async function findFiles(
  rootDir: string,
  patterns: string[],
  options: { ignore?: string[]; absolute?: boolean } = {}
): Promise<string[]> {
  const defaultIgnore = ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/__pycache__/**', '**/.venv/**'];
  return glob(patterns, {
    cwd: rootDir,
    ignore: [...defaultIgnore, ...(options.ignore ?? [])],
    absolute: options.absolute ?? true,
    onlyFiles: true,
  });
}

export async function findCodeFiles(rootDir: string): Promise<string[]> {
  return findFiles(rootDir, [
    '**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx',
    '**/*.py', '**/*.java', '**/*.go', '**/*.rs',
    '**/*.cpp', '**/*.c', '**/*.h', '**/*.cs',
    '**/*.rb', '**/*.php', '**/*.swift', '**/*.kt',
    '**/*.vue', '**/*.svelte',
  ]);
}

export async function getFileStats(filePath: string): Promise<FileInfo> {
  const safePath = path.resolve(filePath);
  const stat = await fs.stat(safePath);
  return {
    path: safePath,
    name: path.basename(safePath),
    ext: path.extname(safePath),
    size: stat.size,
    modified: stat.mtime,
    isDirectory: stat.isDirectory(),
  };
}

// ─── File Watcher ─────────────────────────────────────────────────────────────

export class FileWatcher {
  private watcher: FSWatcher | null = null;
  private callbacks: WatchCallback[] = [];

  watch(
    paths: string | string[],
    options: chokidar.WatchOptions = {}
  ): void {
    this.watcher = chokidar.watch(paths, {
      persistent: true,
      ignoreInitial: true,
      ignored: /(^|[/\\])\.|(node_modules|dist|__pycache__)/,
      ...options,
    });

    const events: WatchEvent[] = ['add', 'change', 'unlink', 'addDir', 'unlinkDir'];
    events.forEach(event => {
      this.watcher!.on(event, (filePath: string) => {
        this.callbacks.forEach(cb => cb(event, filePath));
      });
    });

    logger.info('File watcher started', { paths: Array.isArray(paths) ? paths : [paths] });
  }

  onEvent(callback: WatchCallback): () => void {
    this.callbacks.push(callback);
    return () => {
      this.callbacks = this.callbacks.filter(cb => cb !== callback);
    };
  }

  async close(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
      this.callbacks = [];
      logger.info('File watcher stopped');
    }
  }
}

// ─── Diff & Patch ─────────────────────────────────────────────────────────────

export function computeLineDiff(original: string, modified: string): string {
  const origLines = original.split('\n');
  const modLines = modified.split('\n');
  const diff: string[] = [];
  const maxLen = Math.max(origLines.length, modLines.length);

  for (let i = 0; i < maxLen; i++) {
    const orig = origLines[i] ?? '';
    const mod = modLines[i] ?? '';
    if (orig !== mod) {
      if (orig) diff.push(`- ${orig}`);
      if (mod) diff.push(`+ ${mod}`);
    } else {
      diff.push(`  ${orig}`);
    }
  }
  return diff.join('\n');
}

export function applyPatch(
  original: string,
  patches: Array<{ line: number; type: 'add' | 'remove' | 'replace'; content?: string }>
): string {
  const lines = original.split('\n');
  const sorted = [...patches].sort((a, b) => b.line - a.line);

  for (const patch of sorted) {
    const idx = patch.line - 1;
    if (patch.type === 'remove') {
      lines.splice(idx, 1);
    } else if (patch.type === 'add') {
      lines.splice(idx, 0, patch.content ?? '');
    } else if (patch.type === 'replace') {
      lines[idx] = patch.content ?? '';
    }
  }
  return lines.join('\n');
}

// ─── Content Helpers ──────────────────────────────────────────────────────────

export function detectLanguage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const langMap: Record<string, string> = {
    '.ts': 'typescript', '.tsx': 'typescript',
    '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript',
    '.py': 'python', '.java': 'java',
    '.go': 'go', '.rs': 'rust', '.cpp': 'cpp', '.c': 'c',
    '.h': 'c', '.cs': 'csharp', '.rb': 'ruby',
    '.php': 'php', '.swift': 'swift', '.kt': 'kotlin',
    '.vue': 'vue', '.svelte': 'svelte',
    '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml',
    '.md': 'markdown', '.sql': 'sql', '.sh': 'bash',
    '.html': 'html', '.css': 'css', '.scss': 'scss',
  };
  return langMap[ext] ?? 'text';
}

export function isBinaryFile(buffer: Buffer): boolean {
  const sampleSize = Math.min(512, buffer.length);
  for (let i = 0; i < sampleSize; i++) {
    const byte = buffer[i]!;
    if (byte === 0) return true;
    if (byte < 8 || (byte > 13 && byte < 32)) return true;
  }
  return false;
}

export async function readFileSafe(filePath: string): Promise<string | null> {
  try {
    const buf = await fs.readFile(filePath);
    if (isBinaryFile(buf)) return null;
    return buf.toString('utf-8');
  } catch {
    return null;
  }
}

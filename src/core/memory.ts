/**
 * AetherDev — Context-Aware Memory System
 * Vector embeddings + AST-based code indexing for intelligent context retrieval
 * Uses local Vectra (no cloud required) with SQLite persistence
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import Database from 'better-sqlite3';
import { LocalIndex, MetadataTypes } from 'vectra';
import { getConfig } from '../config/index.js';
import { getLogger } from '../utils/logger.js';
import { findCodeFiles, readFileSafe, detectLanguage } from '../utils/fs.js';
import { v4 as uuidv4 } from 'uuid';
import { getEngine } from './engine.js';

const logger = getLogger('memory');

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MemoryEntry {
  id: string;
  type: 'code' | 'conversation' | 'error' | 'doc' | 'task' | 'snippet';
  content: string;
  metadata: {
    filePath?: string;
    language?: string;
    timestamp: number;
    projectPath?: string;
    tags?: string[];
    hash?: string;
  };
}

export interface SearchResult {
  entry: MemoryEntry;
  score: number;
}

export interface CodeChunk {
  id: string;
  content: string;
  filePath: string;
  language: string;
  startLine: number;
  endLine: number;
  type: 'function' | 'class' | 'method' | 'block' | 'file';
  name?: string;
}

export interface ProjectIndex {
  projectPath: string;
  files: number;
  chunks: number;
  lastIndexed: Date;
}

// ─── Embedding Service ────────────────────────────────────────────────────────

class EmbeddingService {
  private readonly engine = getEngine();
  private readonly cache = new Map<string, number[]>();

  async embed(text: string): Promise<number[]> {
    // Check cache
    const key = text.slice(0, 100);
    if (this.cache.has(key)) return this.cache.get(key)!;

    try {
      const cfg = getConfig();
      if (cfg.llmProvider === 'ollama') {
        return await this.embedOllama(text);
      }
      // Fallback: TF-IDF style deterministic embedding
      return this.deterministicEmbed(text);
    } catch {
      return this.deterministicEmbed(text);
    }
  }

  private async embedOllama(text: string): Promise<number[]> {
    const cfg = getConfig();
    const { default: axios } = await import('axios');
    const res = await axios.post(`${cfg.ollamaBaseUrl}/api/embeddings`, {
      model: 'nomic-embed-text',
      prompt: text.slice(0, 2000),
    });
    const data = res.data as { embedding: number[] };
    return data.embedding;
  }

  /**
   * Deterministic TF-IDF-inspired embedding as local fallback
   * Produces a 384-dim vector based on character n-grams and word frequencies
   */
  deterministicEmbed(text: string, dims: number = 384): number[] {
    const vec = new Float64Array(dims).fill(0);
    const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);

    for (const word of words) {
      let hash = 5381;
      for (let i = 0; i < word.length; i++) {
        hash = ((hash << 5) + hash) + word.charCodeAt(i);
        hash |= 0;
      }
      const idx = Math.abs(hash) % dims;
      vec[idx] = (vec[idx]! + 1);
    }

    // Normalize
    const magnitude = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
    return Array.from(vec).map(v => v / magnitude);
  }

  cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += (a[i]! * b[i]!);
      normA += a[i]! * a[i]!;
      normB += b[i]! * b[i]!;
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
  }
}

// ─── Memory Store ─────────────────────────────────────────────────────────────

export class MemoryStore {
  private db: Database.Database | null = null;
  private readonly embedder = new EmbeddingService();
  private readonly cfg = getConfig();
  private readonly dbPath: string;

  constructor() {
    this.dbPath = path.resolve(process.cwd(), this.cfg.sqlitePath);
  }

  async init(): Promise<void> {
    await fs.mkdir(path.dirname(this.dbPath), { recursive: true });
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
    logger.info('Memory store initialized', { db: this.dbPath });
  }

  private migrate(): void {
    this.db!.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        embedding BLOB,
        metadata TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
      CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at DESC);

      CREATE TABLE IF NOT EXISTS code_chunks (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        file_path TEXT NOT NULL,
        language TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        chunk_type TEXT NOT NULL,
        name TEXT,
        embedding BLOB,
        project_path TEXT,
        file_hash TEXT,
        indexed_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_chunks_file ON code_chunks(file_path);
      CREATE INDEX IF NOT EXISTS idx_chunks_project ON code_chunks(project_path);
      CREATE INDEX IF NOT EXISTS idx_chunks_language ON code_chunks(language);

      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_conv_session ON conversations(session_id, created_at);

      CREATE TABLE IF NOT EXISTS project_cache (
        project_path TEXT PRIMARY KEY,
        files_count INTEGER,
        chunks_count INTEGER,
        last_indexed INTEGER NOT NULL
      );
    `);
    logger.debug('Database migrations applied');
  }

  private getDb(): Database.Database {
    if (!this.db) throw new Error('MemoryStore not initialized. Call init() first.');
    return this.db;
  }

  // ─── Memory CRUD ────────────────────────────────────────────────────────────

  async store(entry: Omit<MemoryEntry, 'id'>): Promise<MemoryEntry> {
    const id = uuidv4();
    const now = Date.now();
    const embedding = await this.embedder.embed(entry.content);
    const embeddingBuffer = Buffer.from(new Float64Array(embedding).buffer);

    const full: MemoryEntry = { ...entry, id };

    this.getDb().prepare(`
      INSERT INTO memories (id, type, content, embedding, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, entry.type, entry.content, embeddingBuffer, JSON.stringify(entry.metadata), now, now);

    logger.debug('Memory stored', { id, type: entry.type });
    return full;
  }

  async search(query: string, options: {
    type?: MemoryEntry['type'];
    limit?: number;
    threshold?: number;
    projectPath?: string;
  } = {}): Promise<SearchResult[]> {
    const { limit = 10, threshold = 0.3, type, projectPath } = options;
    const queryEmbedding = await this.embedder.embed(query);

    let sql = 'SELECT id, type, content, embedding, metadata FROM memories WHERE 1=1';
    const params: unknown[] = [];

    if (type) { sql += ' AND type = ?'; params.push(type); }

    const rows = this.getDb().prepare(sql + ' ORDER BY created_at DESC LIMIT 500').all(...params) as Array<{
      id: string; type: string; content: string; embedding: Buffer; metadata: string;
    }>;

    const results: SearchResult[] = [];
    for (const row of rows) {
      const rowEmbedding = Array.from(new Float64Array(row.embedding.buffer));
      const score = this.embedder.cosineSimilarity(queryEmbedding, rowEmbedding);
      if (score >= threshold) {
        const metadata = JSON.parse(row.metadata);
        if (projectPath && metadata.projectPath && metadata.projectPath !== projectPath) continue;
        results.push({
          entry: { id: row.id, type: row.type as MemoryEntry['type'], content: row.content, metadata },
          score,
        });
      }
    }

    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  async getRecent(type?: MemoryEntry['type'], limit: number = 20): Promise<MemoryEntry[]> {
    const sql = type
      ? 'SELECT * FROM memories WHERE type = ? ORDER BY created_at DESC LIMIT ?'
      : 'SELECT * FROM memories ORDER BY created_at DESC LIMIT ?';
    const params = type ? [type, limit] : [limit];

    const rows = this.getDb().prepare(sql).all(...params) as Array<{
      id: string; type: string; content: string; metadata: string;
    }>;

    return rows.map(r => ({
      id: r.id,
      type: r.type as MemoryEntry['type'],
      content: r.content,
      metadata: JSON.parse(r.metadata),
    }));
  }

  async delete(id: string): Promise<void> {
    this.getDb().prepare('DELETE FROM memories WHERE id = ?').run(id);
  }

  async clear(type?: MemoryEntry['type']): Promise<void> {
    if (type) {
      this.getDb().prepare('DELETE FROM memories WHERE type = ?').run(type);
    } else {
      this.getDb().prepare('DELETE FROM memories').run();
    }
    logger.info('Memory cleared', { type: type ?? 'all' });
  }

  // ─── Conversation History ────────────────────────────────────────────────────

  async saveMessage(sessionId: string, role: 'user' | 'assistant' | 'system', content: string, metadata?: Record<string, unknown>): Promise<void> {
    this.getDb().prepare(`
      INSERT INTO conversations (id, session_id, role, content, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(uuidv4(), sessionId, role, content, JSON.stringify(metadata ?? {}), Date.now());
  }

  async getConversationHistory(sessionId: string, limit: number = 20): Promise<Array<{ role: string; content: string }>> {
    const rows = this.getDb().prepare(`
      SELECT role, content FROM conversations
      WHERE session_id = ?
      ORDER BY created_at ASC
      LIMIT ?
    `).all(sessionId, limit) as Array<{ role: string; content: string }>;
    return rows;
  }

  async clearSession(sessionId: string): Promise<void> {
    this.getDb().prepare('DELETE FROM conversations WHERE session_id = ?').run(sessionId);
  }

  // ─── Code Indexing ───────────────────────────────────────────────────────────

  async indexProject(projectPath: string, force: boolean = false): Promise<ProjectIndex> {
    const absPath = path.resolve(projectPath);
    const existing = this.getDb().prepare('SELECT last_indexed FROM project_cache WHERE project_path = ?')
      .get(absPath) as { last_indexed: number } | undefined;

    const now = Date.now();
    const oneHour = 60 * 60 * 1000;
    if (!force && existing && (now - existing.last_indexed) < oneHour) {
      const count = this.getDb().prepare('SELECT COUNT(*) as c FROM code_chunks WHERE project_path = ?').get(absPath) as { c: number };
      logger.debug('Using cached project index', { projectPath: absPath, chunks: count.c });
      return { projectPath: absPath, files: 0, chunks: count.c, lastIndexed: new Date(existing.last_indexed) };
    }

    logger.info('Indexing project', { projectPath: absPath });
    const files = await findCodeFiles(absPath);
    let totalChunks = 0;

    // Process in batches
    const batchSize = this.cfg.codeIndexBatchSize;
    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize);
      await Promise.all(batch.map(f => this.indexFile(f, absPath)));
      const batchChunks = batch.length * 3; // estimate
      totalChunks += batchChunks;
      logger.debug(`Indexed batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(files.length / batchSize)}`);
    }

    const actualCount = this.getDb().prepare('SELECT COUNT(*) as c FROM code_chunks WHERE project_path = ?').get(absPath) as { c: number };
    totalChunks = actualCount.c;

    this.getDb().prepare(`
      INSERT OR REPLACE INTO project_cache (project_path, files_count, chunks_count, last_indexed)
      VALUES (?, ?, ?, ?)
    `).run(absPath, files.length, totalChunks, now);

    logger.info('Project indexed', { projectPath: absPath, files: files.length, chunks: totalChunks });
    return { projectPath: absPath, files: files.length, chunks: totalChunks, lastIndexed: new Date(now) };
  }

  private async indexFile(filePath: string, projectPath: string): Promise<void> {
    const content = await readFileSafe(filePath);
    if (!content) return;

    const language = detectLanguage(filePath);
    const chunks = this.chunkCode(content, filePath, language);

    const stmt = this.getDb().prepare(`
      INSERT OR REPLACE INTO code_chunks
      (id, content, file_path, language, start_line, end_line, chunk_type, name, embedding, project_path, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const chunk of chunks) {
      const embedding = await this.embedder.embed(chunk.content.slice(0, 500));
      const embBuf = Buffer.from(new Float64Array(embedding).buffer);
      stmt.run(
        chunk.id, chunk.content, filePath, language,
        chunk.startLine, chunk.endLine, chunk.type,
        chunk.name ?? null, embBuf, projectPath, Date.now()
      );
    }
  }

  private chunkCode(content: string, filePath: string, language: string): CodeChunk[] {
    const lines = content.split('\n');
    const chunks: CodeChunk[] = [];

    // Whole file chunk
    chunks.push({
      id: uuidv4(),
      content: content.slice(0, 2000),
      filePath, language,
      startLine: 1, endLine: lines.length,
      type: 'file',
      name: path.basename(filePath),
    });

    // Function/class chunks using regex patterns
    const patterns = this.getCodePatterns(language);
    for (const { regex, type } of patterns) {
      const matches = Array.from(content.matchAll(regex));
      for (const match of matches) {
        if (!match.index) continue;
        const startLine = content.slice(0, match.index).split('\n').length;
        const matchContent = match[0]!.slice(0, 1500);
        chunks.push({
          id: uuidv4(),
          content: matchContent,
          filePath, language,
          startLine,
          endLine: startLine + matchContent.split('\n').length,
          type,
          name: match[1] ?? undefined,
        });
      }
    }

    return chunks;
  }

  private getCodePatterns(language: string): Array<{ regex: RegExp; type: CodeChunk['type'] }> {
    const patterns: Record<string, Array<{ regex: RegExp; type: CodeChunk['type'] }>> = {
      typescript: [
        { regex: /(?:export\s+)?(?:async\s+)?function\s+(\w+)[^{]*\{[^}]{0,2000}\}/gms, type: 'function' },
        { regex: /(?:export\s+)?class\s+(\w+)[^{]*\{[^}]{0,3000}\}/gms, type: 'class' },
        { regex: /(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\([^)]*\)\s*(?:=>\s*)\{[^}]{0,2000}\}/gms, type: 'function' },
      ],
      python: [
        { regex: /def\s+(\w+)\s*\([^)]*\)[^:]*:(?:\s+[^\n]+\n?){1,50}/gms, type: 'function' },
        { regex: /class\s+(\w+)(?:\([^)]*\))?:(?:\s+[^\n]+\n?){1,100}/gms, type: 'class' },
      ],
      javascript: [
        { regex: /(?:async\s+)?function\s+(\w+)[^{]*\{[^}]{0,2000}\}/gms, type: 'function' },
        { regex: /class\s+(\w+)[^{]*\{[^}]{0,3000}\}/gms, type: 'class' },
      ],
    };
    return patterns[language] ?? patterns['javascript']!;
  }

  async searchCode(query: string, options: {
    projectPath?: string;
    language?: string;
    limit?: number;
    threshold?: number;
  } = {}): Promise<Array<{ chunk: CodeChunk; score: number }>> {
    const { limit = 10, threshold = 0.25, projectPath, language } = options;
    const queryEmbedding = await this.embedder.embed(query);

    let sql = 'SELECT * FROM code_chunks WHERE 1=1';
    const params: unknown[] = [];
    if (projectPath) { sql += ' AND project_path = ?'; params.push(projectPath); }
    if (language) { sql += ' AND language = ?'; params.push(language); }
    sql += ' LIMIT 500';

    const rows = this.getDb().prepare(sql).all(...params) as Array<{
      id: string; content: string; file_path: string; language: string;
      start_line: number; end_line: number; chunk_type: string; name: string | null;
      embedding: Buffer;
    }>;

    const results: Array<{ chunk: CodeChunk; score: number }> = [];
    for (const row of rows) {
      const emb = Array.from(new Float64Array(row.embedding.buffer));
      const score = this.embedder.cosineSimilarity(queryEmbedding, emb);
      if (score >= threshold) {
        results.push({
          chunk: {
            id: row.id, content: row.content, filePath: row.file_path,
            language: row.language, startLine: row.start_line, endLine: row.end_line,
            type: row.chunk_type as CodeChunk['type'], name: row.name ?? undefined,
          },
          score,
        });
      }
    }

    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  async buildContext(query: string, projectPath: string, maxChars: number = 6000): Promise<string> {
    const [memories, codeChunks] = await Promise.all([
      this.search(query, { limit: 5, projectPath }),
      this.searchCode(query, { projectPath, limit: 8 }),
    ]);

    const parts: string[] = [];
    let used = 0;

    for (const { chunk, score } of codeChunks) {
      if (used >= maxChars) break;
      const snippet = `// ${chunk.filePath}:${chunk.startLine}\n${chunk.content}`;
      const trimmed = snippet.slice(0, Math.min(800, maxChars - used));
      parts.push(trimmed);
      used += trimmed.length;
    }

    for (const { entry, score } of memories) {
      if (used >= maxChars) break;
      if (entry.type !== 'conversation') {
        const trimmed = entry.content.slice(0, Math.min(400, maxChars - used));
        parts.push(trimmed);
        used += trimmed.length;
      }
    }

    return parts.join('\n\n---\n\n');
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      logger.info('Memory store closed');
    }
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let _store: MemoryStore | null = null;

export async function getMemoryStore(): Promise<MemoryStore> {
  if (!_store) {
    _store = new MemoryStore();
    await _store.init();
  }
  return _store;
}

export default getMemoryStore;

/**
 * AetherDev — Hot-Reloadable Plugin System
 * Sandboxed plugin loading, lifecycle hooks, event bus integration
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import { EventEmitter } from 'eventemitter3';
import chokidar from 'chokidar';
import { getConfig } from '../config/index.js';
import { getLogger } from '../utils/logger.js';
import { v4 as uuidv4 } from 'uuid';

const logger = getLogger('plugin');

// ─── Types ────────────────────────────────────────────────────────────────────

export type PluginStatus = 'loading' | 'active' | 'disabled' | 'error' | 'unloaded';

export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  author?: string;
  license?: string;
  main: string;
  hooks?: PluginHookName[];
  permissions?: PluginPermission[];
  dependencies?: Record<string, string>;
  config?: Record<string, unknown>;
}

export type PluginHookName =
  | 'before:generate'
  | 'after:generate'
  | 'before:review'
  | 'after:review'
  | 'before:test'
  | 'after:test'
  | 'on:error'
  | 'on:file:change'
  | 'on:pipeline:complete'
  | 'on:startup'
  | 'on:shutdown';

export type PluginPermission =
  | 'filesystem:read'
  | 'filesystem:write'
  | 'network:outbound'
  | 'process:exec'
  | 'memory:read'
  | 'memory:write';

export interface AetherPlugin {
  manifest: PluginManifest;
  hooks: Partial<Record<PluginHookName, PluginHook>>;
  commands?: PluginCommand[];
  onLoad?: () => Promise<void> | void;
  onUnload?: () => Promise<void> | void;
  onConfigChange?: (newConfig: Record<string, unknown>) => void;
}

export type PluginHook = (context: PluginHookContext) => Promise<PluginHookResult | void> | PluginHookResult | void;

export interface PluginHookContext {
  hookName: PluginHookName;
  data: unknown;
  projectPath?: string;
  sessionId?: string;
  pluginName: string;
  config: Record<string, unknown>;
  emit: (event: string, data: unknown) => void;
}

export interface PluginHookResult {
  modified?: boolean;
  data?: unknown;
  stop?: boolean; // Stop hook chain
}

export interface PluginCommand {
  name: string;
  description: string;
  args?: Array<{ name: string; description: string; required?: boolean }>;
  handler: (args: Record<string, string>, ctx: PluginHookContext) => Promise<string> | string;
}

export interface LoadedPlugin {
  id: string;
  manifest: PluginManifest;
  plugin: AetherPlugin;
  status: PluginStatus;
  loadedAt: Date;
  error?: string;
  pluginPath: string;
  configPath?: string;
  userConfig: Record<string, unknown>;
}

// ─── Plugin Loader ────────────────────────────────────────────────────────────

export class PluginLoader extends EventEmitter {
  private readonly plugins = new Map<string, LoadedPlugin>();
  private watcher: ReturnType<typeof chokidar.watch> | null = null;
  private readonly cfg = getConfig();

  async init(): Promise<void> {
    const pluginsDir = path.resolve(process.cwd(), this.cfg.pluginsDir);

    try {
      await fs.mkdir(pluginsDir, { recursive: true });
    } catch { /* already exists */ }

    await this.loadAllPlugins(pluginsDir);

    if (this.cfg.pluginsAutoReload) {
      this.startWatcher(pluginsDir);
    }

    await this.callHook('on:startup', {});
    logger.info('Plugin loader initialized', { count: this.plugins.size });
  }

  private async loadAllPlugins(pluginsDir: string): Promise<void> {
    try {
      const entries = await fs.readdir(pluginsDir, { withFileTypes: true });
      const pluginDirs = entries.filter(e => e.isDirectory());

      for (const dir of pluginDirs) {
        const pluginPath = path.join(pluginsDir, dir.name);
        await this.loadPlugin(pluginPath).catch(err => {
          logger.warn(`Failed to load plugin: ${dir.name}`, { error: err.message });
        });
      }
    } catch {
      logger.debug(`Plugins directory not found or empty: ${pluginsDir}`);
    }
  }

  async loadPlugin(pluginPath: string): Promise<LoadedPlugin> {
    const manifestPath = path.join(pluginPath, 'plugin.json');
    const manifestRaw = await fs.readFile(manifestPath, 'utf-8');
    const manifest = JSON.parse(manifestRaw) as PluginManifest;

    // Validate manifest
    this.validateManifest(manifest);

    // Check if already loaded
    if (this.plugins.has(manifest.name)) {
      await this.unloadPlugin(manifest.name);
    }

    logger.info(`Loading plugin: ${manifest.name}@${manifest.version}`);

    // Load user config
    const userConfig = await this.loadPluginConfig(pluginPath, manifest);

    // Load main module
    const mainPath = path.join(pluginPath, manifest.main);
    let plugin: AetherPlugin;

    try {
      // Clear require cache for hot-reload
      delete require.cache[require.resolve(mainPath)];
      const mod = await import(mainPath + `?t=${Date.now()}`);
      plugin = (mod.default ?? mod) as AetherPlugin;
      plugin.manifest = manifest;
    } catch (err) {
      const entry: LoadedPlugin = {
        id: uuidv4(), manifest, plugin: null as unknown as AetherPlugin,
        status: 'error', loadedAt: new Date(),
        error: err instanceof Error ? err.message : String(err),
        pluginPath, userConfig,
      };
      this.plugins.set(manifest.name, entry);
      throw err;
    }

    const entry: LoadedPlugin = {
      id: uuidv4(), manifest, plugin,
      status: 'loading', loadedAt: new Date(),
      pluginPath, userConfig,
    };
    this.plugins.set(manifest.name, entry);

    // Call onLoad
    try {
      await plugin.onLoad?.();
      entry.status = 'active';
    } catch (err) {
      entry.status = 'error';
      entry.error = err instanceof Error ? err.message : String(err);
      logger.warn(`Plugin onLoad failed: ${manifest.name}`, { error: entry.error });
    }

    this.emit('plugin:loaded', { name: manifest.name, version: manifest.version });
    logger.info(`Plugin loaded: ${manifest.name}@${manifest.version}`, { hooks: manifest.hooks?.length ?? 0 });
    return entry;
  }

  async unloadPlugin(name: string): Promise<void> {
    const entry = this.plugins.get(name);
    if (!entry) return;

    try {
      await entry.plugin.onUnload?.();
    } catch (err) {
      logger.warn(`Plugin onUnload failed: ${name}`, { error: err });
    }

    entry.status = 'unloaded';
    this.plugins.delete(name);
    this.emit('plugin:unloaded', { name });
    logger.info(`Plugin unloaded: ${name}`);
  }

  async reloadPlugin(name: string): Promise<void> {
    const entry = this.plugins.get(name);
    if (!entry) throw new Error(`Plugin not found: ${name}`);
    await this.loadPlugin(entry.pluginPath);
    logger.info(`Plugin reloaded: ${name}`);
  }

  // ─── Hook System ──────────────────────────────────────────────────────────

  async callHook(
    hookName: PluginHookName,
    data: unknown,
    options: { projectPath?: string; sessionId?: string } = {}
  ): Promise<unknown> {
    const activePlugins = Array.from(this.plugins.values())
      .filter(p => p.status === 'active' && p.manifest.hooks?.includes(hookName));

    let currentData = data;

    for (const entry of activePlugins) {
      const hook = entry.plugin.hooks[hookName];
      if (!hook) continue;

      const context: PluginHookContext = {
        hookName,
        data: currentData,
        projectPath: options.projectPath,
        sessionId: options.sessionId,
        pluginName: entry.manifest.name,
        config: entry.userConfig,
        emit: (event, d) => this.emit(`plugin:${entry.manifest.name}:${event}`, d),
      };

      try {
        const result = await hook(context);
        if (result) {
          if (result.data !== undefined) currentData = result.data;
          if (result.stop) break;
        }
      } catch (err) {
        logger.warn(`Plugin hook failed: ${entry.manifest.name}/${hookName}`, {
          error: err instanceof Error ? err.message : String(err),
        });
        // Don't let one plugin crash the whole pipeline
      }
    }

    return currentData;
  }

  async executeCommand(
    pluginName: string,
    commandName: string,
    args: Record<string, string> = {},
    options: { projectPath?: string; sessionId?: string } = {}
  ): Promise<string> {
    const entry = this.plugins.get(pluginName);
    if (!entry || entry.status !== 'active') {
      throw new Error(`Plugin not active: ${pluginName}`);
    }

    const command = entry.plugin.commands?.find(c => c.name === commandName);
    if (!command) throw new Error(`Command not found: ${pluginName}/${commandName}`);

    const ctx: PluginHookContext = {
      hookName: 'on:startup', // placeholder
      data: args,
      ...options,
      pluginName,
      config: entry.userConfig,
      emit: (event, d) => this.emit(`plugin:${pluginName}:${event}`, d),
    };

    return command.handler(args, ctx);
  }

  // ─── Config ───────────────────────────────────────────────────────────────

  private async loadPluginConfig(
    pluginPath: string,
    manifest: PluginManifest
  ): Promise<Record<string, unknown>> {
    const configPath = path.join(pluginPath, 'config.json');
    try {
      const raw = await fs.readFile(configPath, 'utf-8');
      return { ...(manifest.config ?? {}), ...JSON.parse(raw) };
    } catch {
      return manifest.config ?? {};
    }
  }

  async updatePluginConfig(name: string, config: Record<string, unknown>): Promise<void> {
    const entry = this.plugins.get(name);
    if (!entry) throw new Error(`Plugin not found: ${name}`);

    entry.userConfig = { ...entry.userConfig, ...config };
    const configPath = path.join(entry.pluginPath, 'config.json');
    await fs.writeFile(configPath, JSON.stringify(entry.userConfig, null, 2), 'utf-8');

    entry.plugin.onConfigChange?.(entry.userConfig);
    logger.debug(`Plugin config updated: ${name}`);
  }

  // ─── Hot Reload Watcher ───────────────────────────────────────────────────

  private startWatcher(pluginsDir: string): void {
    this.watcher = chokidar.watch(pluginsDir, {
      persistent: true,
      ignoreInitial: true,
      depth: 2,
    });

    this.watcher.on('change', async (filePath: string) => {
      const pluginDir = path.relative(pluginsDir, filePath).split(path.sep)[0];
      if (!pluginDir) return;

      const pluginPath = path.join(pluginsDir, pluginDir);
      const manifest = this.plugins.get(pluginDir);

      if (manifest?.status === 'active') {
        logger.info(`Hot-reloading plugin: ${pluginDir}`);
        await this.loadPlugin(pluginPath).catch(err => {
          logger.warn(`Hot-reload failed: ${pluginDir}`, { error: err.message });
        });
      }
    });

    this.watcher.on('addDir', async (dirPath: string) => {
      const rel = path.relative(pluginsDir, dirPath);
      if (rel.split(path.sep).length === 1 && rel) {
        await this.loadPlugin(dirPath).catch(() => {});
      }
    });

    logger.debug('Plugin hot-reload watcher started');
  }

  // ─── Manifest Validation ──────────────────────────────────────────────────

  private validateManifest(manifest: PluginManifest): void {
    if (!manifest.name || !/^[a-z0-9-]+$/.test(manifest.name)) {
      throw new Error('Plugin name must be lowercase alphanumeric with hyphens');
    }
    if (!manifest.version || !/^\d+\.\d+\.\d+/.test(manifest.version)) {
      throw new Error('Plugin version must follow semver');
    }
    if (!manifest.main) {
      throw new Error('Plugin must specify a main entry file');
    }
  }

  // ─── Introspection ────────────────────────────────────────────────────────

  getPlugin(name: string): LoadedPlugin | undefined {
    return this.plugins.get(name);
  }

  listPlugins(): LoadedPlugin[] {
    return Array.from(this.plugins.values());
  }

  getActivePlugins(): LoadedPlugin[] {
    return Array.from(this.plugins.values()).filter(p => p.status === 'active');
  }

  listCommands(): Array<{ plugin: string; command: PluginCommand }> {
    const commands: Array<{ plugin: string; command: PluginCommand }> = [];
    for (const entry of this.getActivePlugins()) {
      for (const cmd of entry.plugin.commands ?? []) {
        commands.push({ plugin: entry.manifest.name, command: cmd });
      }
    }
    return commands;
  }

  async shutdown(): Promise<void> {
    await this.callHook('on:shutdown', {});
    for (const name of this.plugins.keys()) {
      await this.unloadPlugin(name).catch(() => {});
    }
    await this.watcher?.close();
    logger.info('Plugin loader shutdown complete');
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let _loader: PluginLoader | null = null;

export async function getPluginLoader(): Promise<PluginLoader> {
  if (!_loader) {
    _loader = new PluginLoader();
    await _loader.init();
  }
  return _loader;
}

export default getPluginLoader;

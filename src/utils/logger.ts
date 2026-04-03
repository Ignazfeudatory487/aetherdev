/**
 * AetherDev — Structured JSON Logger
 * Built on Pino with pretty-print for dev, JSON for prod/CI
 * Zero telemetry unless explicitly enabled
 */

import pino, { Logger, LoggerOptions } from 'pino';
import { getConfig } from '../config/index.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type LogContext = Record<string, unknown>;

export interface AetherLogger {
  trace(msg: string, ctx?: LogContext): void;
  debug(msg: string, ctx?: LogContext): void;
  info(msg: string, ctx?: LogContext): void;
  warn(msg: string, ctx?: LogContext): void;
  error(msg: string, ctx?: LogContext): void;
  fatal(msg: string, ctx?: LogContext): void;
  child(bindings: LogContext): AetherLogger;
  startTimer(): () => void;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

function createPinoLogger(name: string, bindings: LogContext = {}): Logger {
  const cfg = getConfig();
  const isPretty = cfg.logFormat === 'pretty' && cfg.nodeEnv !== 'test';

  const options: LoggerOptions = {
    name,
    level: cfg.logLevel,
    base: {
      pid: process.pid,
      env: cfg.nodeEnv,
      ...bindings,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level(label) {
        return { level: label.toUpperCase() };
      },
      bindings(b) {
        return { name: b['name'], pid: b['pid'], env: b['env'] };
      },
    },
    serializers: {
      err: pino.stdSerializers.err,
      error: pino.stdSerializers.err,
    },
  };

  if (isPretty) {
    options.transport = {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:HH:MM:ss',
        ignore: 'pid,hostname',
        messageFormat: '[{name}] {msg}',
        levelFirst: true,
      },
    };
  }

  return pino(options);
}

// ─── Wrapper ──────────────────────────────────────────────────────────────────

class AetherLoggerImpl implements AetherLogger {
  private readonly _logger: Logger;

  constructor(name: string, bindings: LogContext = {}) {
    this._logger = createPinoLogger(name, bindings);
  }

  trace(msg: string, ctx?: LogContext): void {
    ctx ? this._logger.trace(ctx, msg) : this._logger.trace(msg);
  }

  debug(msg: string, ctx?: LogContext): void {
    ctx ? this._logger.debug(ctx, msg) : this._logger.debug(msg);
  }

  info(msg: string, ctx?: LogContext): void {
    ctx ? this._logger.info(ctx, msg) : this._logger.info(msg);
  }

  warn(msg: string, ctx?: LogContext): void {
    ctx ? this._logger.warn(ctx, msg) : this._logger.warn(msg);
  }

  error(msg: string, ctx?: LogContext): void {
    ctx ? this._logger.error(ctx, msg) : this._logger.error(msg);
  }

  fatal(msg: string, ctx?: LogContext): void {
    ctx ? this._logger.fatal(ctx, msg) : this._logger.fatal(msg);
  }

  child(bindings: LogContext): AetherLogger {
    return new AetherLoggerImpl('child', bindings);
  }

  /**
   * Returns a function that, when called, logs elapsed time.
   * Usage: const done = logger.startTimer(); ... done();
   */
  startTimer(): () => void {
    const start = Date.now();
    return () => {
      const elapsed = Date.now() - start;
      this._logger.debug({ elapsed_ms: elapsed }, `Operation completed in ${elapsed}ms`);
    };
  }
}

// ─── Registry ─────────────────────────────────────────────────────────────────

const loggerRegistry = new Map<string, AetherLogger>();

export function getLogger(name: string, bindings: LogContext = {}): AetherLogger {
  const key = name + JSON.stringify(bindings);
  if (!loggerRegistry.has(key)) {
    loggerRegistry.set(key, new AetherLoggerImpl(name, bindings));
  }
  return loggerRegistry.get(key)!;
}

// ─── Predefined Loggers ───────────────────────────────────────────────────────

export const coreLogger = getLogger('core');
export const agentLogger = getLogger('agent');
export const pluginLogger = getLogger('plugin');
export const sandboxLogger = getLogger('sandbox');
export const gitLogger = getLogger('git');
export const apiLogger = getLogger('api');
export const wsLogger = getLogger('websocket');
export const memoryLogger = getLogger('memory');

// ─── Error Formatter ──────────────────────────────────────────────────────────

export function formatError(err: unknown): LogContext {
  if (err instanceof Error) {
    return {
      message: err.message,
      name: err.name,
      stack: err.stack?.split('\n').slice(0, 8).join('\n'),
      ...(err as NodeJS.ErrnoException).code && { code: (err as NodeJS.ErrnoException).code },
    };
  }
  return { message: String(err) };
}

export function logError(logger: AetherLogger, msg: string, err: unknown): void {
  logger.error(msg, { error: formatError(err) });
}

export default getLogger;

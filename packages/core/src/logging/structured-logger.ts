/**
 * @file structured-logger.ts
 * @description Fail-safe, leveled, structured logger designed to preserve MCP stdio integrity (WP-6).
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. MCP stdio stdout is NEVER written to. stdout is exclusively reserved for JSON-RPC 2.0 messages.
 * 2. All terminal logging is emitted to stderr.
 * 3. File logging is appended safely to .ai-manager/logs/ or specified logFilePath.
 * 4. Secrets, auth tokens, and API keys are automatically redacted.
 * 5. Logger failures are fail-safe: they never disrupt core orchestration or security decisions.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  type LogLevel,
  type LogEntry,
  type LogContext,
  type StructuredLoggerOptions,
  LOG_LEVEL_PRIORITY,
} from './log-types.js';
import { sanitizeSecrets } from '../errors/llm-error.js';

export class StructuredLogger {
  private level: LogLevel;
  private readonly destination: 'stderr' | 'file' | 'both' | 'custom';
  private readonly customWriter?: (entry: LogEntry, serialized: string) => void;
  private readonly logFilePath?: string;
  private readonly sanitize: boolean;
  private readonly defaultContext: LogContext;
  private fileDirEnsured = false;

  constructor(options: StructuredLoggerOptions = {}) {
    const envLevel = process.env.AIDM_LOG_LEVEL?.toLowerCase() as LogLevel | undefined;
    this.level = options.level ?? (envLevel && envLevel in LOG_LEVEL_PRIORITY ? envLevel : 'info');
    this.destination = options.destination ?? 'stderr';
    this.customWriter = options.customWriter;
    this.sanitize = options.sanitize ?? true;
    this.defaultContext = { ...options.defaultContext };

    if (options.logFilePath) {
      this.logFilePath = options.logFilePath;
    } else if (options.baseDir) {
      this.logFilePath = path.join(options.baseDir, '.ai-manager', 'logs', 'aidm.log');
    }
  }

  /**
   * Sets minimum log level dynamically.
   */
  setLevel(level: LogLevel): void {
    if (level in LOG_LEVEL_PRIORITY) {
      this.level = level;
    }
  }

  /**
   * Gets current minimum log level.
   */
  getLevel(): LogLevel {
    return this.level;
  }

  /**
   * Creates a child logger with bound contextual metadata.
   */
  child(childContext: LogContext): StructuredLogger {
    return new StructuredLogger({
      level: this.level,
      destination: this.destination,
      customWriter: this.customWriter,
      logFilePath: this.logFilePath,
      sanitize: this.sanitize,
      defaultContext: {
        ...this.defaultContext,
        ...childContext,
      },
    });
  }

  debug(message: string, context?: LogContext, details?: Record<string, unknown>): void {
    this.log('debug', message, context, undefined, details);
  }

  info(message: string, context?: LogContext, details?: Record<string, unknown>): void {
    this.log('info', message, context, undefined, details);
  }

  warn(message: string, context?: LogContext, error?: unknown, details?: Record<string, unknown>): void {
    this.log('warn', message, context, error, details);
  }

  error(message: string, context?: LogContext, error?: unknown, details?: Record<string, unknown>): void {
    this.log('error', message, context, error, details);
  }

  private isLevelEnabled(level: LogLevel): boolean {
    return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[this.level];
  }

  private sanitizeValue(val: unknown): unknown {
    if (!this.sanitize || val === null || val === undefined) return val;
    if (typeof val === 'string') return sanitizeSecrets(val);
    if (Array.isArray(val)) return val.map((item) => this.sanitizeValue(item));
    if (typeof val === 'object') {
      const sanitizedObj: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
        const lowerKey = k.toLowerCase();
        if (
          lowerKey.includes('key') ||
          lowerKey.includes('secret') ||
          lowerKey.includes('token') ||
          lowerKey.includes('password') ||
          lowerKey.includes('auth')
        ) {
          sanitizedObj[k] = '***REDACTED***';
        } else {
          sanitizedObj[k] = this.sanitizeValue(v);
        }
      }
      return sanitizedObj;
    }
    return val;
  }

  private log(
    level: LogLevel,
    message: string,
    context?: LogContext,
    error?: unknown,
    details?: Record<string, unknown>
  ): void {
    if (!this.isLevelEnabled(level)) return;

    try {
      const timestamp = new Date().toISOString();
      const sanitizedMessage = this.sanitize ? sanitizeSecrets(message) : message;

      const mergedContext = {
        ...this.defaultContext,
        ...context,
      };

      const sanitizedContext = (this.sanitize
        ? (this.sanitizeValue(mergedContext) as LogContext)
        : mergedContext) as LogContext;

      let errorInfo: LogEntry['error'] | undefined;
      if (error) {
        if (error instanceof Error) {
          const errCode = (error as { code?: string })?.code;
          errorInfo = {
            name: error.name,
            message: this.sanitize ? sanitizeSecrets(error.message) : error.message,
            stack: error.stack ? (this.sanitize ? sanitizeSecrets(error.stack) : error.stack) : undefined,
            code: errCode,
          };
        } else {
          errorInfo = {
            name: 'UnknownError',
            message: this.sanitize ? sanitizeSecrets(String(error)) : String(error),
          };
        }
      }

      const sanitizedDetails = details
        ? (this.sanitize ? (this.sanitizeValue(details) as Record<string, unknown>) : details)
        : undefined;

      const entry: LogEntry = {
        timestamp,
        level,
        message: sanitizedMessage,
        context: Object.keys(sanitizedContext).length > 0 ? sanitizedContext : undefined,
        error: errorInfo,
        details: sanitizedDetails,
      };

      const serialized = JSON.stringify(entry);

      // Custom Writer (e.g. Test Harness)
      if (this.customWriter) {
        try {
          this.customWriter(entry, serialized);
        } catch {
          // Fail-safe
        }
      }

      // stderr Output (Never stdout)
      if (this.destination === 'stderr' || this.destination === 'both') {
        try {
          process.stderr.write(serialized + '\n');
        } catch {
          // Fail-safe
        }
      }

      // File Output
      if ((this.destination === 'file' || this.destination === 'both') && this.logFilePath) {
        this.appendToFile(serialized);
      }
    } catch {
      // Hard invariant: Logging failures MUST NEVER crash callers or disrupt state machines
    }
  }

  private appendToFile(serialized: string): void {
    if (!this.logFilePath) return;
    try {
      if (!this.fileDirEnsured) {
        const dir = path.dirname(this.logFilePath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        this.fileDirEnsured = true;
      }
      fs.appendFileSync(this.logFilePath, serialized + '\n', 'utf8');
    } catch {
      // Fail-safe file writing
    }
  }
}

// Global default singleton logger
let defaultLogger: StructuredLogger | null = null;

export function getDefaultLogger(): StructuredLogger {
  if (!defaultLogger) {
    defaultLogger = new StructuredLogger({
      destination: 'stderr',
      baseDir: process.cwd(),
    });
  }
  return defaultLogger;
}

export function createLogger(options?: StructuredLoggerOptions): StructuredLogger {
  return new StructuredLogger(options);
}

/**
 * @file log-types.ts
 * @description Strongly-typed domain models, log levels, and configuration options
 * for the Structured Logging Subsystem (Phase WP-6).
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. ZERO STDOUT POLLUTION: stdout is strictly reserved for JSON-RPC 2.0 messages (StdioMcpTransport).
 *    All diagnostic logs MUST be routed to stderr or file destinations.
 * 2. SECRET SANITIZATION: API keys, tokens, credentials, and sensitive model inputs MUST be redacted.
 * 3. FAIL-SAFE LOGGING: Logging failures MUST NOT crash security gates or break core state transitions.
 * 4. STRUCTURED CORRELATION: Supports tracking sessionId, taskId, executionId, and correlationId.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface LogContext {
  readonly projectId?: string;
  readonly sessionId?: string;
  readonly taskId?: string | null;
  readonly executionId?: string;
  readonly correlationId?: string;
  readonly component?: string;
  readonly actor?: string;
  readonly [key: string]: unknown;
}

export interface LogEntry {
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly message: string;
  readonly context?: LogContext;
  readonly error?: {
    readonly name: string;
    readonly message: string;
    readonly stack?: string;
    readonly code?: string;
  };
  readonly details?: Record<string, unknown>;
}

export type LogDestination = 'stderr' | 'file' | 'both' | 'custom';

export interface StructuredLoggerOptions {
  /** Minimum log level to emit (default: 'info' or process.env.AIDM_LOG_LEVEL) */
  readonly level?: LogLevel;
  /** Where to route log output (default: 'stderr') */
  readonly destination?: LogDestination;
  /** Custom writer function (e.g. for testing) */
  readonly customWriter?: (entry: LogEntry, serialized: string) => void;
  /** Base directory for default log file resolution (.ai-manager/logs/) */
  readonly baseDir?: string;
  /** Explicit path to log file */
  readonly logFilePath?: string;
  /** Whether to redact secrets from messages and context (default: true) */
  readonly sanitize?: boolean;
  /** Default context appended to all log entries from this logger */
  readonly defaultContext?: LogContext;
}

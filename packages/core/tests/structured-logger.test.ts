import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  StructuredLogger,
  createLogger,
  type LogEntry,
} from '../dist/logging/index.js';
import { StdioMcpTransport } from '../dist/mcp/mcp-transport.js';
import { PassThrough } from 'node:stream';

describe('StructuredLogger Subsystem (WP-6)', () => {
  it('1. Emits logs with correct levels and respects minimum level filtering', () => {
    const emitted: LogEntry[] = [];
    const logger = createLogger({
      level: 'warn',
      destination: 'custom',
      customWriter: (entry) => {
        emitted.push(entry);
      },
    });

    logger.debug('Debug message should be filtered out');
    logger.info('Info message should be filtered out');
    logger.warn('Warning message should be captured');
    logger.error('Error message should be captured');

    assert.equal(emitted.length, 2);
    assert.equal(emitted[0].level, 'warn');
    assert.equal(emitted[0].message, 'Warning message should be captured');
    assert.equal(emitted[1].level, 'error');
    assert.equal(emitted[1].message, 'Error message should be captured');
  });

  it('2. Dynamically adjusts log level via setLevel()', () => {
    const emitted: LogEntry[] = [];
    const logger = createLogger({
      level: 'error',
      destination: 'custom',
      customWriter: (entry) => emitted.push(entry),
    });

    logger.info('Ignored');
    assert.equal(emitted.length, 0);

    logger.setLevel('debug');
    logger.debug('Now visible');
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].level, 'debug');
    assert.equal(emitted[0].message, 'Now visible');
  });

  it('3. Guarantees ZERO stdout pollution: stdout is never touched by logger', () => {
    const originalStdoutWrite = process.stdout.write;
    let stdoutPolluted = false;

    // Intercept process.stdout.write
    process.stdout.write = ((chunk: any) => {
      stdoutPolluted = true;
      return true;
    }) as any;

    try {
      const logger = createLogger({
        level: 'debug',
        destination: 'stderr', // standard destination
      });

      logger.debug('Testing stdout purity - debug');
      logger.info('Testing stdout purity - info');
      logger.warn('Testing stdout purity - warn');
      logger.error('Testing stdout purity - error');
    } finally {
      process.stdout.write = originalStdoutWrite;
    }

    assert.equal(stdoutPolluted, false, 'process.stdout must NEVER be written to by logger');
  });

  it('4. Automatically redacts API keys, bearer tokens, and secrets from messages and context', () => {
    const emitted: LogEntry[] = [];
    const logger = createLogger({
      level: 'debug',
      destination: 'custom',
      sanitize: true,
      customWriter: (entry) => emitted.push(entry),
    });

    const apiKey = 'sk-proj-1234567890abcdef1234567890';
    const bearer = 'Bearer super_secret_token_123456789';

    logger.info(`Dispatching request with key ${apiKey} and ${bearer}`, {
      apiKey,
      userToken: 'token_secret_xyz_987',
      normalField: 'safe_value',
    });

    assert.equal(emitted.length, 1);
    const entry = emitted[0];

    // Message must be redacted
    assert.ok(!entry.message.includes('sk-proj-'), 'API key must not appear in log message');
    assert.ok(entry.message.includes('***REDACTED_KEY***'), 'Key must be replaced with placeholder');
    assert.ok(!entry.message.includes('super_secret_token'), 'Bearer token must not appear in log message');
    assert.ok(entry.message.includes('***REDACTED_TOKEN***'), 'Bearer token must be redacted');

    // Context must be redacted
    assert.equal(entry.context?.apiKey, '***REDACTED***');
    assert.equal(entry.context?.userToken, '***REDACTED***');
    assert.equal(entry.context?.normalField, 'safe_value');
  });

  it('5. Attaches and preserves structured correlation IDs (sessionId, taskId, correlationId)', () => {
    const emitted: LogEntry[] = [];
    const logger = createLogger({
      level: 'info',
      destination: 'custom',
      customWriter: (entry) => emitted.push(entry),
    });

    logger.info('Task execution started', {
      projectId: 'proj-001',
      sessionId: 'sess-abc',
      taskId: 'TASK-01',
      executionId: 'exec-999',
      correlationId: 'corr-555',
    });

    assert.equal(emitted.length, 1);
    const ctx = emitted[0].context;
    assert.equal(ctx?.projectId, 'proj-001');
    assert.equal(ctx?.sessionId, 'sess-abc');
    assert.equal(ctx?.taskId, 'TASK-01');
    assert.equal(ctx?.executionId, 'exec-999');
    assert.equal(ctx?.correlationId, 'corr-555');
  });

  it('6. Child logger inherits default parent context', () => {
    const emitted: LogEntry[] = [];
    const parentLogger = createLogger({
      level: 'info',
      destination: 'custom',
      defaultContext: { projectId: 'project-alpha', sessionId: 'session-omega' },
      customWriter: (entry) => emitted.push(entry),
    });

    const taskLogger = parentLogger.child({ taskId: 'TASK-P20-01', component: 'ExecutionAuthorizer' });

    taskLogger.info('Evaluating authorization rule');

    assert.equal(emitted.length, 1);
    const ctx = emitted[0].context;
    assert.equal(ctx?.projectId, 'project-alpha');
    assert.equal(ctx?.sessionId, 'session-omega');
    assert.equal(ctx?.taskId, 'TASK-P20-01');
    assert.equal(ctx?.component, 'ExecutionAuthorizer');
  });

  it('7. Appends safely to log file in .ai-manager/logs/', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-log-test-'));
    try {
      const logger = createLogger({
        level: 'info',
        destination: 'file',
        baseDir: tempDir,
      });

      logger.info('Testing persistent file logging', { testId: 'FILE_TEST_1' });

      const logFile = path.join(tempDir, '.ai-manager', 'logs', 'aidm.log');
      assert.ok(fs.existsSync(logFile), 'Log file should be created in .ai-manager/logs/');

      const content = fs.readFileSync(logFile, 'utf8').trim();
      const parsed = JSON.parse(content);
      assert.equal(parsed.message, 'Testing persistent file logging');
      assert.equal(parsed.level, 'info');
      assert.equal(parsed.context?.testId, 'FILE_TEST_1');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('8. Verifies StdioMcpTransport stdout produces strictly valid JSON-RPC 2.0 lines alongside logger', async () => {
    const stdoutStream = new PassThrough();
    const stdinStream = new PassThrough();
    const collectedStdoutLines: string[] = [];

    stdoutStream.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      const lines = text.split('\n').filter((l: string) => l.trim().length > 0);
      collectedStdoutLines.push(...lines);
    });

    const transport = new StdioMcpTransport({
      stdin: stdinStream,
      stdout: stdoutStream,
    });

    await transport.start();

    // Concurrently emit structured logs
    const logger = createLogger({
      level: 'debug',
      destination: 'stderr',
    });

    logger.debug('MCP stdio server processing tool call');
    logger.info('Authorization gate passed for tool aidm_project_status');

    // Transport sends valid MCP response
    await transport.send({
      jsonrpc: '2.0',
      id: 1,
      result: { status: 'INITIALIZING', healthy: true },
    });

    await transport.close();

    // Verify stdout lines: exactly 1 valid JSON-RPC 2.0 response line
    assert.equal(collectedStdoutLines.length, 1);
    const parsed = JSON.parse(collectedStdoutLines[0]);
    assert.equal(parsed.jsonrpc, '2.0');
    assert.equal(parsed.id, 1);
    assert.equal(parsed.result.status, 'INITIALIZING');
  });
});

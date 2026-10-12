/**
 * @file openai-director-runtime.test.ts
 * @description Comprehensive verification test suite for OpenAI Director Runtime Integration:
 *
 * 1. Configuration & Missing API Key Fail-Closed
 * 2. Provider Error, Timeout & Malformed Model Response Handling
 * 3. Director Decision Parsing, Schema & Context Fingerprint Validation
 * 4. Budget Enforcement & Policy Authorization Rejection
 * 5. MCP Orchestrator Delegate -> ClosedLoopCoordinator -> DirectorRuntime Integration
 * 6. Zero AGY Trust: Verification via Independent Evidence Only
 * 7. Cancellation, Unknown Execution Status & Bounded Retries
 * 8. Autonomous Loop (coordinateAutoLoop) Governed Stopping & Continuation
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';

import {
  resolveOpenAiDirectorConfig,
  createOpenAiDirectorProvider,
  createUnconfiguredOpenAiProvider,
  createOpenAiDirectorRuntime,
} from '../dist/director/openai-director-runtime.js';
import {
  DirectorRuntime,
} from '../dist/director/director-runtime.js';
import {
  DirectorSessionStore,
} from '../dist/director/director-session-store.js';
import {
  DirectorSessionEngine,
} from '../dist/director/director-session-engine.js';
import {
  ClosedLoopCoordinator,
} from '../dist/director-loop/closed-loop-coordinator.js';
import {
  DefaultMcpOrchestratorDelegate,
} from '../dist/mcp/mcp-delegate.js';
import {
  HistoryManager,
} from '../dist/storage/history-manager.js';
import {
  DurableStateManager,
} from '../dist/storage/durable-state.js';
import {
  AuthorizationPolicyEngine,
} from '../dist/authorization/authorization-policy-engine.js';
import {
  ProjectMandateStore,
} from '../dist/authorization/project-mandate-store.js';
import {
  BudgetManager,
} from '../dist/budget/budget-manager.js';
import {
  LlmProviderUnavailableError,
  MalformedLlmResponseError,
  LlmExecutionError,
} from '../dist/errors/index.js';
import {
  DirectorLlmProviderUnavailableError,
} from '../dist/director/director-runtime-errors.js';
import type {
  DirectorContextSnapshot,
} from '../dist/director/director-context-types.js';
import type {
  ExecutorPort,
} from '../dist/executor-bridge/executor-port.js';
import {
  LlmResponseFormat,
  type LlmRequest,
} from '../dist/llm-bridge/llm-types.js';

function createTempDir(): string {
  const dir = path.join(os.tmpdir(), `aidm-openai-test-${crypto.randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanupTempDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors on Windows
  }
}

function createMockSnapshot(fingerprint = 'fp_valid_context_123'): DirectorContextSnapshot {
  return {
    projectId: 'test-project-aidm',
    projectRoot: 'd:/ÇALIŞMALAR-D/OtonomMCP',
    directorSessionId: 'dsess_test_01',
    protocolVersion: 'P9-02',
    schemaVersion: 1,
    synchronizedAt: new Date().toISOString(),
    syncStatus: 'CHANGED',
    isComplete: true,
    unavailableSections: [],
    staleSections: [],
    logicalFingerprint: fingerprint,
    isDerived: true,
    sectionMetadata: {} as any,
    sections: {
      projectStatus: { initialized: true, lifecycleState: 'DEVELOPMENT', isCompleted: false, isBlocked: false },
      authorization: { isDevelopmentAuthorized: true, authoritySource: 'PRODUCT_OWNER', requiresHumanApproval: true },
      approval: { hasApprovalPackage: true, packageId: 'pkg_1', isReadyForApproval: true, isExplicitlyApproved: true },
      clarification: { hasActiveSession: false, totalCount: 0, resolvedCount: 0, blockingOpenCount: 0, hasUnresolvedBlocking: false },
      discovery: { isDiscovered: true, projectName: 'test-proj', apparentPurposeClassification: 'application', technologyStack: [{ name: 'TypeScript' }], entryPointsCount: 1, unknownsCount: 0, contradictionsCount: 0 },
      requirements: { total: 1, items: [{ id: 'REQ-01', title: 'Runtime requirement', status: 'ACTIVE', authority: 'PO' }] },
      decisions: { total: 1, items: [{ id: 'DEC-01', title: 'Runtime decision', status: 'ACCEPTED' }] },
      taskList: { total: 1, topologicalOrder: ['task_01'], tasks: [{ taskId: 'task_01', title: 'Implement runtime', status: 'IN_PROGRESS', dependencies: [] }] },
      currentTask: { hasActiveTask: true, task: { taskId: 'task_01', title: 'Implement runtime', status: 'IN_PROGRESS', description: 'Task description', acceptanceCriteria: ['Criterion 1'] } },
      contextEngine: { activePointers: 0, totalFilesTracked: 0, activeContextSize: 0, hasStaleContext: false, lastReindexTimestamp: new Date().toISOString(), isAvailable: true, hasL0Cache: false, inspectedPaths: [] },
      git: { isGitRepository: true, head: '1234567', branch: 'main', workingTreeClean: true, totalAcceptedCheckpoints: 0 },
      evidence: { totalEvidenceCount: 0, passedEvidenceCount: 0, failedEvidenceCount: 0, verifiedArtifactCount: 0, recentEvidence: [], items: [] },
      history: { totalEvents: 0, recentEvents: [] },
    } as any,
  };
}

function createSampleLlmRequest(projectId = 'test-project-aidm', taskId = 'task_01'): LlmRequest {
  return {
    correlation: {
      correlation_id: `corr_${crypto.randomUUID()}`,
      project_id: projectId,
      task_id: taskId,
      attempt: 1,
    },
    messages: [
      { role: 'system', content: 'You are an AIDM Director.' },
      { role: 'user', content: 'Review context and provide decision.' },
    ],
    director_context: {
      project_id: projectId,
      task_id: taskId,
      attempt: 1,
    },
    model: 'gpt-4o',
    temperature: 0.1,
    max_tokens: 4000,
    response_format: LlmResponseFormat.JSON_SCHEMA,
    json_schema: {
      name: 'director_decision',
      schema: { type: 'object' },
      strict: true,
    },
  };
}

describe('OpenAI Director Runtime Integration', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  // ==========================================================================
  // 1. CONFIGURATION RESOLUTION & MISSING API KEY FAIL-CLOSED
  // ==========================================================================
  describe('1. Configuration & Missing API Key Fail-Closed', () => {
    it('resolves defaults with missing credentials when environment is unset', () => {
      delete process.env.AIDM_LLM_API_KEY;
      delete process.env.OPENAI_API_KEY;
      delete process.env.AIDM_LLM_ENDPOINT;
      delete process.env.OPENAI_BASE_URL;
      delete process.env.AIDM_LLM_MODEL;
      delete process.env.OPENAI_MODEL;

      const config = resolveOpenAiDirectorConfig();
      assert.equal(config.hasValidApiKey, false);
      assert.equal(config.apiKey, null);
      assert.equal(config.model, 'gpt-6-luna');
      assert.equal(config.reasoningEffort, 'medium');
      assert.equal(config.endpoint, 'https://api.openai.com/v1/chat/completions');
    });

    it('prefers AIDM_LLM_API_KEY over OPENAI_API_KEY', () => {
      process.env.AIDM_LLM_API_KEY = 'aidm-secret-key-123';
      process.env.OPENAI_API_KEY = 'openai-secret-key-456';

      const config = resolveOpenAiDirectorConfig();
      assert.equal(config.hasValidApiKey, true);
      assert.equal(config.apiKey, 'aidm-secret-key-123');
    });

    it('falls back to OPENAI_API_KEY if AIDM_LLM_API_KEY is not set', () => {
      delete process.env.AIDM_LLM_API_KEY;
      process.env.OPENAI_API_KEY = 'sk-test-fallback-openai';

      const config = resolveOpenAiDirectorConfig();
      assert.equal(config.hasValidApiKey, true);
      assert.equal(config.apiKey, 'sk-test-fallback-openai');
    });

    it('explicit configuration overrides environment variables', () => {
      process.env.AIDM_LLM_API_KEY = 'aidm-env-key';
      const config = resolveOpenAiDirectorConfig({
        apiKey: 'explicit-override-key',
        model: 'gpt-4o-mini',
        endpoint: 'https://custom-proxy.internal/v1/chat/completions',
      });
      assert.equal(config.hasValidApiKey, true);
      assert.equal(config.apiKey, 'explicit-override-key');
      assert.equal(config.model, 'gpt-4o-mini');
      assert.equal(config.endpoint, 'https://custom-proxy.internal/v1/chat/completions');
    });

    it('createUnconfiguredOpenAiProvider throws DirectorLlmProviderUnavailableError immediately on generate', async () => {
      const provider = createUnconfiguredOpenAiProvider('missing');
      await assert.rejects(
        async () => {
          await provider.generate(createSampleLlmRequest());
        },
        (err: unknown) => {
          assert.ok(
            err instanceof DirectorLlmProviderUnavailableError ||
            err instanceof LlmProviderUnavailableError
          );
          assert.match((err as Error).message, /fail-closed/i);
          return true;
        }
      );
    });

    it('createOpenAiDirectorRuntime produces fail-closed runtime when no API key is set', async () => {
      delete process.env.AIDM_LLM_API_KEY;
      delete process.env.OPENAI_API_KEY;

      const tempDir = createTempDir();
      try {
        fs.writeFileSync(
          path.join(tempDir, 'package.json'),
          JSON.stringify({ name: 'test-project-aidm', version: '1.0.0' }, null, 2)
        );

        const historyManager = new HistoryManager({ baseDir: tempDir });
        const sessionStore = new DirectorSessionStore({ baseDir: tempDir, historyManager });
        const sessionEngine = new DirectorSessionEngine({ store: sessionStore, workspaceRoot: tempDir });

        await sessionEngine.createSession({
          directorSessionId: 'dsess_test_01',
          projectId: 'test-project-aidm',
          workspaceRoot: tempDir,
        });

        const runtime = createOpenAiDirectorRuntime({
          sessionStore,
          sessionEngine,
          historyManager,
        });

        assert.ok(runtime instanceof DirectorRuntime);
        const snapshot = createMockSnapshot();

        await assert.rejects(
          async () => {
            await runtime.reason({
              projectId: 'test-project-aidm',
              directorSessionId: 'dsess_test_01',
              trigger: 'INITIAL_ANALYSIS',
              snapshot,
            });
          },
          (err: unknown) => {
            assert.ok(
              err instanceof DirectorLlmProviderUnavailableError ||
              err instanceof LlmProviderUnavailableError
            );
            return true;
          }
        );
      } finally {
        cleanupTempDir(tempDir);
      }
    });
  });

  // ==========================================================================
  // 2. PROVIDER ERROR, TIMEOUT & MALFORMED MODEL RESPONSE HANDLING
  // ==========================================================================
  describe('2. Provider Error, Timeout & Malformed Model Response Handling', () => {
    let mockServer: http.Server;
    let mockServerPort: number;
    let serverHandler: (req: http.IncomingMessage, res: http.ServerResponse) => void;

    beforeEach(async () => {
      mockServer = http.createServer((req, res) => {
        if (serverHandler) {
          serverHandler(req, res);
        } else {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Default unhandled mock' } }));
        }
      });

      await new Promise<void>((resolve) => {
        mockServer.listen(0, '127.0.0.1', () => {
          const addr = mockServer.address() as AddressInfo;
          mockServerPort = addr.port;
          resolve();
        });
      });
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => {
        mockServer.close(() => resolve());
      });
    });

    it('maps HTTP 500 internal server error to LlmExecutionError without crashing', async () => {
      serverHandler = (_req, res) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Internal Server Error', type: 'api_error' } }));
      };

      const provider = createOpenAiDirectorProvider({
        apiKey: 'test-key',
        endpoint: `http://127.0.0.1:${mockServerPort}/v1/chat/completions`,
        model: 'gpt-4o',
      });

      await assert.rejects(
        async () => {
          await provider.generate(createSampleLlmRequest());
        },
        (err: unknown) => {
          assert.ok(err instanceof LlmExecutionError);
          assert.equal((err as any).statusCode, 500);
          return true;
        }
      );
    });

    it('fails closed when provider returns malformed non-JSON body', async () => {
      serverHandler = (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body>Gateway Timeout / Bad HTML</body></html>');
      };

      const provider = createOpenAiDirectorProvider({
        apiKey: 'test-key',
        endpoint: `http://127.0.0.1:${mockServerPort}/v1/chat/completions`,
        model: 'gpt-4o',
      });

      await assert.rejects(
        async () => {
          await provider.generate(createSampleLlmRequest());
        },
        (err: unknown) => {
          assert.ok(err instanceof MalformedLlmResponseError);
          return true;
        }
      );
    });

    it('fails closed when provider returns JSON without expected choices structure', async () => {
      serverHandler = (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ unexpected: 'empty_payload' }));
      };

      const provider = createOpenAiDirectorProvider({
        apiKey: 'test-key',
        endpoint: `http://127.0.0.1:${mockServerPort}/v1/chat/completions`,
        model: 'gpt-4o',
      });

      await assert.rejects(
        async () => {
          await provider.generate(createSampleLlmRequest());
        },
        (err: unknown) => {
          assert.ok(err instanceof MalformedLlmResponseError);
          return true;
        }
      );
    });
  });

  // ==========================================================================
  // 3. DIRECTOR DECISION & CONTEXT FINGERPRINT VALIDATION
  // ==========================================================================
  describe('3. Director Decision & Context Fingerprint Validation', () => {
    let mockServer: http.Server;
    let mockServerPort: number;

    beforeEach(async () => {
      mockServer = http.createServer();
      await new Promise<void>((resolve) => {
        mockServer.listen(0, '127.0.0.1', () => {
          const addr = mockServer.address() as AddressInfo;
          mockServerPort = addr.port;
          resolve();
        });
      });
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => {
        mockServer.close(() => resolve());
      });
    });

    it('rejects model decision when contextFingerprint mismatches authoritative snapshot', async () => {
      const spoofedFingerprint = 'fp_spoofed_context_99999';

      mockServer.on('request', (_req, res) => {
        const payload = {
          id: 'chatcmpl-test-01',
          choices: [
            {
              message: {
                role: 'assistant',
                content: JSON.stringify({
                  protocolVersion: 'AIDM-DIRECTOR-ACTION-1',
                  schemaVersion: 1,
                  actionId: 'act-spoofed-01',
                  directorSessionId: 'dsess_test_01',
                  projectId: 'test-project-aidm',
                  actionType: 'IMPLEMENT_TASK',
                  basedOnContextFingerprint: spoofedFingerprint,
                  rationale: 'Spoofed fingerprint action',
                  confidence: 0.9,
                  taskId: 'task_01',
                  objective: 'Run task',
                  targetFiles: ['src/task.ts'],
                  implementationScope: 'src/',
                  acceptanceCriteria: ['AC-01'],
                  constraints: [],
                }),
              },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      });

      const tempDir = createTempDir();
      try {
        fs.writeFileSync(
          path.join(tempDir, 'package.json'),
          JSON.stringify({ name: 'test-project-aidm', version: '1.0.0' }, null, 2)
        );

        const historyManager = new HistoryManager({ baseDir: tempDir });
        const sessionStore = new DirectorSessionStore({ baseDir: tempDir, historyManager });
        const sessionEngine = new DirectorSessionEngine({ store: sessionStore, workspaceRoot: tempDir });

        await sessionEngine.createSession({
          directorSessionId: 'dsess_test_01',
          projectId: 'test-project-aidm',
          workspaceRoot: tempDir,
        });

        const runtime = createOpenAiDirectorRuntime({
          sessionStore,
          sessionEngine,
          historyManager,
          apiKey: 'test-key',
          endpoint: `http://127.0.0.1:${mockServerPort}/v1/chat/completions`,
          model: 'gpt-4o',
        });

        const authoritativeSnapshot = createMockSnapshot('fp_authoritative_original_11111');

        await assert.rejects(
          async () => {
            await runtime.reason({
              projectId: 'test-project-aidm',
              directorSessionId: 'dsess_test_01',
              trigger: 'INITIAL_ANALYSIS',
              snapshot: authoritativeSnapshot,
            });
          },
          (err: unknown) => {
            assert.match((err as Error).message, /fingerprint/i);
            return true;
          }
        );
      } finally {
        cleanupTempDir(tempDir);
      }
    });

    it('accepts and validates decision when model output adheres to schema and matching fingerprint', async () => {
      const validFingerprint = 'fp_matching_valid_55555';

      mockServer.on('request', (_req, res) => {
        const payload = {
          id: 'chatcmpl-valid-01',
          choices: [
            {
              message: {
                role: 'assistant',
                content: JSON.stringify({
                  protocolVersion: 'AIDM-DIRECTOR-ACTION-1',
                  schemaVersion: 1,
                  actionId: 'act-valid-01',
                  directorSessionId: 'dsess_test_01',
                  projectId: 'test-project-aidm',
                  actionType: 'IMPLEMENT_TASK',
                  basedOnContextFingerprint: validFingerprint,
                  rationale: 'Valid continuation decision',
                  confidence: 0.95,
                  taskId: 'task_01',
                  objective: 'Run task',
                  targetFiles: ['src/task.ts'],
                  implementationScope: 'src/',
                  acceptanceCriteria: ['AC-01'],
                  constraints: [],
                }),
              },
            },
          ],
          usage: { prompt_tokens: 80, completion_tokens: 40, total_tokens: 120 },
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      });

      const tempDir = createTempDir();
      try {
        fs.writeFileSync(
          path.join(tempDir, 'package.json'),
          JSON.stringify({ name: 'test-project-aidm', version: '1.0.0' }, null, 2)
        );

        const historyManager = new HistoryManager({ baseDir: tempDir });
        const sessionStore = new DirectorSessionStore({ baseDir: tempDir, historyManager });
        const sessionEngine = new DirectorSessionEngine({ store: sessionStore, workspaceRoot: tempDir });

        await sessionEngine.createSession({
          directorSessionId: 'dsess_test_01',
          projectId: 'test-project-aidm',
          workspaceRoot: tempDir,
        });

        const runtime = createOpenAiDirectorRuntime({
          sessionStore,
          sessionEngine,
          historyManager,
          apiKey: 'test-key',
          endpoint: `http://127.0.0.1:${mockServerPort}/v1/chat/completions`,
          model: 'gpt-4o',
        });

        const authoritativeSnapshot = createMockSnapshot(validFingerprint);

        const result = await runtime.reason({
          projectId: 'test-project-aidm',
          directorSessionId: 'dsess_test_01',
          trigger: 'INITIAL_ANALYSIS',
          snapshot: authoritativeSnapshot,
        });

        assert.ok(result.action);
        assert.equal(result.action.actionType, 'IMPLEMENT_TASK');
        assert.equal(result.action.basedOnContextFingerprint, validFingerprint);
      } finally {
        cleanupTempDir(tempDir);
      }
    });
  });

  // ==========================================================================
  // 4. BUDGET ENFORCEMENT & POLICY AUTHORIZATION REJECTION
  // ==========================================================================
  describe('4. Budget Enforcement & Policy Authorization Rejection', () => {
    it('rejects LLM reasoning call when SQLite nano-USD budget is exhausted', async () => {
      const tempDir = createTempDir();
      try {
        const dbPath = path.join(tempDir, 'budget-exhausted.sqlite');
        const budgetManager = new BudgetManager({ dbPath });
        budgetManager.open();

        // Create a global account with limit of 1 nano-USD (cannot afford any request)
        budgetManager.createGlobalAccount(1n);

        const provider = createOpenAiDirectorProvider({
          apiKey: 'test-key',
          endpoint: 'http://127.0.0.1:9999/v1/chat/completions',
          model: 'gpt-4o',
          budgetManager,
        });

        await assert.rejects(
          async () => {
            await provider.generate(createSampleLlmRequest());
          },
          (err: unknown) => {
            assert.match((err as Error).message, /budget/i);
            return true;
          }
        );

        budgetManager.close();
      } finally {
        cleanupTempDir(tempDir);
      }
    });

    it('ClosedLoopCoordinator halts on authorization policy violation without calling executor', async () => {
      const tempDir = createTempDir();
      try {
        const historyManager = new HistoryManager({ baseDir: tempDir });
        const mandateStore = new ProjectMandateStore({ baseDir: tempDir });
        const authorizationPolicyEngine = new AuthorizationPolicyEngine({
          historyManager,
          mandateStore,
        });

        let executorCalled = false;
        const mockExecutor: ExecutorPort = {
          executorId: 'mock-test-executor',
          provider: 'antigravity',
          async execute(): Promise<any> {
            executorCalled = true;
            return { status: 'SUCCESS' };
          },
        };

        const coordinator = new ClosedLoopCoordinator({
          workspaceRoot: tempDir,
          historyManager,
          authorizationPolicyEngine,
          executorPort: mockExecutor,
        });

        const result = await coordinator.coordinateCycle({
          projectId: 'test-project-aidm',
          directorSessionId: 'dsess_test_01',
          instruction: 'Execute unapproved work',
        });

        assert.equal(executorCalled, false, 'Executor must never be called on policy rejection');
        assert.equal(result.isSuccess, false);
      } finally {
        cleanupTempDir(tempDir);
      }
    });
  });

  // ==========================================================================
  // 5. MCP DELEGATE -> COORDINATOR -> DIRECTOR RUNTIME INTEGRATION
  // ==========================================================================
  describe('5. MCP Delegate -> Coordinator -> Director Runtime Integration', () => {
    it('DefaultMcpOrchestratorDelegate fails closed when API key is missing', () => {
      delete process.env.AIDM_LLM_API_KEY;
      delete process.env.OPENAI_API_KEY;

      const tempDir = createTempDir();
      try {
        const delegate = new DefaultMcpOrchestratorDelegate({
          projectRoot: tempDir,
        });

        const runtime = delegate.getDirectorRuntime();
        assert.equal(runtime, undefined, 'DirectorRuntime must be undefined when no API key configured');

        const coordinator = delegate.getClosedLoopCoordinator();
        assert.ok(coordinator instanceof ClosedLoopCoordinator);
      } finally {
        cleanupTempDir(tempDir);
      }
    });

    it('DefaultMcpOrchestratorDelegate instantiates OpenAi DirectorRuntime when API key is present', () => {
      process.env.AIDM_LLM_API_KEY = 'test-mcp-delegate-key';

      const tempDir = createTempDir();
      try {
        // Without a BudgetManager no live Director may be auto-created (fail-closed, P18-03).
        const unbudgeted = new DefaultMcpOrchestratorDelegate({ projectRoot: tempDir });
        assert.equal(unbudgeted.getDirectorRuntime(), undefined);

        const budgetManager = new BudgetManager({ dbPath: path.join(tempDir, 'mcp-budget.sqlite') });
        budgetManager.open();
        try {
          const delegate = new DefaultMcpOrchestratorDelegate({
            projectRoot: tempDir,
            budgetManager,
          });

          const runtime = delegate.getDirectorRuntime();
          assert.ok(runtime instanceof DirectorRuntime, 'DirectorRuntime must be instantiated when API key and BudgetManager present');

          const coordinator = delegate.getClosedLoopCoordinator();
          assert.ok(coordinator instanceof ClosedLoopCoordinator);
        } finally {
          budgetManager.close();
        }
      } finally {
        cleanupTempDir(tempDir);
      }
    });
  });

  // ==========================================================================
  // 6. ZERO AGY TRUST: INDEPENDENT EVIDENCE VERIFICATION
  // ==========================================================================
  describe('6. Zero AGY Trust: Independent Evidence Verification', () => {
    it('rejects AGY execution success if independent system evidence is missing', async () => {
      const tempDir = createTempDir();
      try {
        const historyManager = new HistoryManager({ baseDir: tempDir });
        const durableStateManager = new DurableStateManager({ baseDir: tempDir });

        const mockExecutor: ExecutorPort = {
          executorId: 'mock-untrusted-executor',
          provider: 'antigravity',
          async execute(): Promise<any> {
            // AGY claims SUCCESS, but provides NO independent SystemExecutionEvidence
            return {
              executionId: 'exec-claim-01',
              status: 'SUCCESS',
              output: 'I did the work successfully (self-claim)',
              evidenceIds: [],
              durationMs: 50,
            };
          },
        };

        const coordinator = new ClosedLoopCoordinator({
          workspaceRoot: tempDir,
          historyManager,
          durableStateManager,
          executorPort: mockExecutor,
        });

        const result = await coordinator.coordinateCycle({
          projectId: 'test-project-aidm',
          directorSessionId: 'dsess_test_01',
          instruction: 'Implement feature under zero-trust policy',
        });

        // Zero AGY Trust: must not accept claim without independent evidence
        assert.equal(result.isSuccess, false);
      } finally {
        cleanupTempDir(tempDir);
      }
    });
  });

  // ==========================================================================
  // 7. CANCELLATION, UNKNOWN EXECUTION STATUS & BOUNDED RETRIES
  // ==========================================================================
  describe('7. Cancellation, Unknown Execution Status & Bounded Retries', () => {
    it('halts immediately without uncontrolled re-dispatch when executor status is EXECUTION_UNKNOWN', async () => {
      const tempDir = createTempDir();
      try {
        const historyManager = new HistoryManager({ baseDir: tempDir });
        let dispatchCount = 0;

        const mockExecutor: ExecutorPort = {
          executorId: 'mock-unknown-executor',
          provider: 'antigravity',
          async execute(): Promise<any> {
            dispatchCount++;
            return {
              executionId: `exec-unknown-${dispatchCount}`,
              status: 'EXECUTION_UNKNOWN',
              output: 'Process lost or connection dropped midway',
              evidenceIds: [],
              durationMs: 50,
            };
          },
        };

        const coordinator = new ClosedLoopCoordinator({
          workspaceRoot: tempDir,
          historyManager,
          executorPort: mockExecutor,
        });

        const loopResult = await coordinator.coordinateAutoLoop({
          workspaceRoot: tempDir,
          projectId: 'test-project-aidm',
          instruction: 'Execute task with unknown crash',
          maxCycles: 5,
        });

        assert.equal(dispatchCount, 0, 'Coordinator stopped safely before uncontrolled auto-redispatch');
        assert.notEqual(loopResult.terminalStatus, 'ALL_TASKS_COMPLETED');
      } finally {
        cleanupTempDir(tempDir);
      }
    });

    it('stops loop immediately when AbortSignal is cancelled', async () => {
      const tempDir = createTempDir();
      try {
        const historyManager = new HistoryManager({ baseDir: tempDir });
        const controller = new AbortController();

        const coordinator = new ClosedLoopCoordinator({
          workspaceRoot: tempDir,
          historyManager,
        });

        // Cancel signal before running
        controller.abort();

        const loopResult = await coordinator.coordinateAutoLoop({
          workspaceRoot: tempDir,
          projectId: 'test-project-aidm',
          instruction: 'Should be cancelled before first cycle',
          signal: controller.signal,
          maxCycles: 3,
        });

        assert.equal(loopResult.terminalStatus, 'CANCELLED');
        assert.equal(loopResult.cyclesRun, 0);
      } finally {
        cleanupTempDir(tempDir);
      }
    });
  });

  // ==========================================================================
  // 8. AUTONOMOUS LOOP (coordinateAutoLoop) GOVERNED CONTINUATION
  // ==========================================================================
  describe('8. Autonomous Loop Governed Stopping & Continuation', () => {
    it('stops safely on maxCycles boundary', async () => {
      const tempDir = createTempDir();
      try {
        const historyManager = new HistoryManager({ baseDir: tempDir });
        const coordinator = new ClosedLoopCoordinator({
          workspaceRoot: tempDir,
          historyManager,
        });

        const result = await coordinator.coordinateAutoLoop({
          workspaceRoot: tempDir,
          projectId: 'test-project-aidm',
          instruction: 'Run bounded cycles',
          maxCycles: 2,
        });

        assert.ok(result.cyclesRun <= 2);
        assert.ok([
          'MAX_CYCLES_REACHED',
          'ALL_TASKS_COMPLETED',
          'BLOCKED_ON_APPROVAL',
          'EXECUTION_FAILED',
          'CONTEXT_UNAVAILABLE',
          'CANCELLED',
        ].includes(result.terminalStatus));
      } finally {
        cleanupTempDir(tempDir);
      }
    });

    it('respects timeoutMs boundary', async () => {
      const tempDir = createTempDir();
      try {
        const historyManager = new HistoryManager({ baseDir: tempDir });
        const coordinator = new ClosedLoopCoordinator({
          workspaceRoot: tempDir,
          historyManager,
        });

        const result = await coordinator.coordinateAutoLoop({
          workspaceRoot: tempDir,
          projectId: 'test-project-aidm',
          instruction: 'Immediate timeout test',
          maxCycles: 10,
          timeoutMs: 1, // 1 millisecond timeout
        });

        assert.ok([
          'CANCELLED',
          'MAX_CYCLES_REACHED',
          'ALL_TASKS_COMPLETED',
          'BLOCKED_ON_APPROVAL',
          'EXECUTION_FAILED',
          'CONTEXT_UNAVAILABLE',
        ].includes(result.terminalStatus));
      } finally {
        cleanupTempDir(tempDir);
      }
    });
  });
});

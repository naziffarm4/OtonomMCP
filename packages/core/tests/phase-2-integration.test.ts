import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  // P2-01 Task / DAG Engine
  TaskDagEngine,
  TaskGraphValidationError,
  TaskHierarchyLevel,
  TaskStatus,
  TaskPriority,
  RiskLevel,
  type TaskDefinitionInput,

  // P2-02 Context Engine L0/L1/L2
  ContextEngine,
  ContextIntent,
  type ResolvedContext,

  // P2-03 Stale Context Invalidation
  ContextInvalidator,
  ContextValidationAction,
  StaleFileStatus,
  ContextInvalidationError,

  // P2-04 Token Budget & Telemetry
  TokenBudgetEngine,
  ContextPriority,
  BudgetSelectionStatus,
  createExactTelemetry,
  createEstimatedTelemetry,
  combineTelemetry,
  calculateTokenCost,
  type ContextBudgetItem,
  type ModelPricing,

  // Phase 1 Foundation & Infrastructure
  StateMachine,
  TaskLoopStateMachine,
  LifecycleState,
  TaskLoopState,
} from '../dist/index.js';

describe('Phase 2 Subsystem Comprehensive Integration Test Suite (TASK-P2-05)', () => {
  let tempWorkspace: string;
  let cacheDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempWorkspace = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aidm-p2-integration-'));
    cacheDir = path.join(tempWorkspace, '.ai-manager', 'cache');
    await fs.promises.mkdir(cacheDir, { recursive: true });
    dbPath = path.join(cacheDir, 'context.db');
  });

  afterEach(async () => {
    try {
      await fs.promises.rm(tempWorkspace, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  // Helper to create workspace files
  async function createWorkspaceFile(relPath: string, content: string): Promise<string> {
    const fullPath = path.join(tempWorkspace, relPath);
    await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.promises.writeFile(fullPath, content, 'utf-8');
    return fullPath;
  }

  // ==========================================================================
  // INTEGRATION SCENARIO I1: TASK → CONTEXT
  // ==========================================================================

  describe('Integration Scenario I1: Task Model & DAG Engine → Context Resolution', () => {
    it('I1: should represent task in DAG, validate dependencies, and resolve deterministic L0/L1/L2 context from task metadata', async () => {
      // 1. Create source files defined by the task
      await createWorkspaceFile(
        'src/services/auth-service.ts',
        [
          'export interface AuthSession { userId: string; token: string; expiresAt: number; }',
          'export interface LoginCredentials { username: string; passwordHash: string; }',
          'export class AuthService {',
          '  login(creds: LoginCredentials): AuthSession {',
          '    return { userId: creds.username, token: "jwt_token", expiresAt: Date.now() + 3600 };',
          '  }',
          '}',
        ].join('\n')
      );

      await createWorkspaceFile(
        'src/models/user.ts',
        [
          'export interface User { id: string; username: string; email: string; }',
          'export function serializeUser(user: User): string { return JSON.stringify(user); }',
        ].join('\n')
      );

      // 2. Define valid Task DAG with Parent Feature and tasks
      const epicNode: TaskDefinitionInput = {
        taskId: 'EPIC-CORE',
        title: 'Core Platform Epic',
        description: 'Core platform epic root',
        hierarchyLevel: TaskHierarchyLevel.EPIC,
        traceabilitySources: ['SYSTEM_REQUIREMENT:CORE'],
        acceptanceCriteria: ['AC-EPIC-1: Platform stable'],
      };

      const featureTask: TaskDefinitionInput = {
        taskId: 'FEAT-AUTH',
        title: 'Authentication Subsystem',
        description: 'User login and session validation',
        status: TaskStatus.IN_PROGRESS,
        priority: TaskPriority.CRITICAL,
        riskLevel: RiskLevel.MEDIUM,
        hierarchyLevel: TaskHierarchyLevel.FEATURE,
        parentFeatureId: 'EPIC-CORE',
        dependencies: [],
        traceabilitySources: ['SYSTEM_REQUIREMENT:SYS-SEC-01'],
        acceptanceCriteria: ['AC-FEAT-1: All auth tasks complete'],
      };

      const task1: TaskDefinitionInput = {
        taskId: 'TASK-USER-MODEL',
        title: 'Define User Model',
        description: 'Define User model and serialization',
        status: TaskStatus.COMPLETED,
        priority: TaskPriority.HIGH,
        riskLevel: RiskLevel.LOW,
        hierarchyLevel: TaskHierarchyLevel.TASK,
        parentFeatureId: 'FEAT-AUTH',
        dependencies: [],
        traceabilitySources: ['REQ:REQ-AUTH-01'],
        acceptanceCriteria: ['AC-1: User model defined'],
        metadata: { sourceFiles: ['src/models/user.ts'] },
      };

      const task2: TaskDefinitionInput = {
        taskId: 'TASK-AUTH-SERVICE',
        title: 'Implement AuthService',
        description: 'Implement AuthService with login and session verification',
        status: TaskStatus.READY,
        priority: TaskPriority.CRITICAL,
        riskLevel: RiskLevel.MEDIUM,
        hierarchyLevel: TaskHierarchyLevel.TASK,
        parentFeatureId: 'FEAT-AUTH',
        dependencies: ['TASK-USER-MODEL'],
        traceabilitySources: ['REQ:REQ-AUTH-02', 'DEC:DEC-009'],
        acceptanceCriteria: ['AC-2: AuthService login handles credentials and issues valid token'],
        metadata: { sourceFiles: ['src/services/auth-service.ts', 'src/models/user.ts'] },
      };

      // 3. Validate DAG topology using TaskDagEngine
      const dagEngine = new TaskDagEngine();
      const validation = dagEngine.validateGraph([epicNode, featureTask, task1, task2]);
      assert.equal(validation.valid, true);
      assert.deepEqual(validation.topologicalOrder, [
        'EPIC-CORE',
        'FEAT-AUTH',
        'TASK-USER-MODEL',
        'TASK-AUTH-SERVICE',
      ]);

      // 4. Resolve Context for TASK-AUTH-SERVICE driven by task metadata
      const contextEngine = new ContextEngine({ workspaceRoot: tempWorkspace, dbPath });
      const targetSourceFiles = (task2.metadata?.sourceFiles as string[]) || [];

      // L1 Context Resolution (Contract / Minimum Sufficient Context)
      const l1Resolved = await contextEngine.resolveContext({
        taskId: task2.taskId,
        sourcePaths: targetSourceFiles,
        intent: ContextIntent.CONTRACT,
      });

      assert.equal(l1Resolved.taskId, 'TASK-AUTH-SERVICE');
      assert.equal(l1Resolved.items.length, 2);
      assert.equal(l1Resolved.targetLayer, 'L1');

      for (const item of l1Resolved.items) {
        assert.equal(item.layer, 'L1');
        assert.ok(item.fileHash.length === 64, 'SHA-256 hash must be 64 hex characters');
        assert.ok(item.tokenInfo.estimated_tokens > 0);
        assert.ok(item.signatures.length > 0, 'L1 item must extract interfaces/signatures');
      }

      // L2 Context Resolution (Full Implementation)
      const l2Resolved = await contextEngine.resolveContext({
        taskId: task2.taskId,
        sourcePaths: targetSourceFiles,
        intent: ContextIntent.FULL_IMPLEMENTATION,
      });

      assert.equal(l2Resolved.targetLayer, 'L2');
      assert.equal(l2Resolved.items.length, 2);
      for (const item of l2Resolved.items) {
        assert.equal(item.layer, 'L2');
        assert.ok(item.content.length > 0);
      }

      contextEngine.close();
    });
  });

  // ==========================================================================
  // INTEGRATION SCENARIO I2: CONTEXT → STALE INVALIDATION
  // ==========================================================================

  describe('Integration Scenario I2: Context Engine → Stale Context Invalidation', () => {
    it('I2: should detect OLD_HASH != CURRENT_HASH, guard against stale writes, and force RE-EVALUATE via refresh', async () => {
      const relPath = 'src/service.ts';
      const initialContent = 'export function calculateDiscount(price: number): number { return price * 0.9; }';
      await createWorkspaceFile(relPath, initialContent);

      const contextEngine = new ContextEngine({ workspaceRoot: tempWorkspace, dbPath });
      const invalidator = new ContextInvalidator({
        workspaceRoot: tempWorkspace,
        contextEngine,
      });

      // 1. Resolve context
      const initialContext = await contextEngine.resolveContext({
        taskId: 'TASK-BILLING',
        sourcePaths: [relPath],
        intent: ContextIntent.FULL_IMPLEMENTATION,
      });

      const initialHash = initialContext.items[0].fileHash;
      assert.ok(initialHash.length === 64);

      // 2. Validate initial context — must be CONTINUE
      const initialValidation = await invalidator.validateContext(initialContext);
      assert.equal(initialValidation.isValid, true);
      assert.equal(initialValidation.action, ContextValidationAction.CONTINUE);

      // Write guard allows operation on clean context
      let writeExecuted = false;
      await invalidator.guardOperation(initialContext, async () => {
        writeExecuted = true;
      });
      assert.equal(writeExecuted, true);

      // 3. Mutate file on disk (simulating external modification)
      const updatedContent = 'export function calculateDiscount(price: number): number { return price * 0.85; }';
      await createWorkspaceFile(relPath, updatedContent);

      // 4. Validate previously resolved context — must be CONTEXT_INVALIDATED
      const staleValidation = await invalidator.validateContext(initialContext);
      assert.equal(staleValidation.isValid, false);
      assert.equal(staleValidation.action, ContextValidationAction.CONTEXT_INVALIDATED);
      assert.equal(staleValidation.affectedFiles.length, 1);
      assert.equal(staleValidation.affectedFiles[0].status, StaleFileStatus.MODIFIED);
      assert.equal(staleValidation.affectedFiles[0].oldHash, initialHash);
      assert.notEqual(staleValidation.affectedFiles[0].currentHash, initialHash);

      // 5. Verify write guard stops stale operation
      await assert.rejects(
        async () => {
          await invalidator.assertValidForWrite(initialContext, relPath);
        },
        (err: unknown) => {
          assert.ok(err instanceof ContextInvalidationError);
          assert.equal(err.code, 'ERR_CONTEXT_STALE_WRITE_REJECTED');
          assert.equal(err.action, ContextValidationAction.CONTEXT_INVALIDATED);
          return true;
        }
      );

      // 6. Refresh context using invalidator
      const refreshResult = await invalidator.refreshContext(initialContext);
      assert.equal(refreshResult.action, ContextValidationAction.RE_EVALUATE);
      assert.ok(refreshResult.refreshedContext);

      // 7. Verify refreshed context contains new hash and content
      const refreshedItem = refreshResult.refreshedContext.items[0];
      assert.equal(refreshedItem.fileHash, staleValidation.affectedFiles[0].currentHash);
      assert.equal(refreshedItem.content, updatedContent);

      // 8. Refreshed context is now valid for writes
      await invalidator.assertValidForWrite(refreshResult.refreshedContext, relPath);

      contextEngine.close();
    });
  });

  // ==========================================================================
  // INTEGRATION SCENARIO I3: CONTEXT → TOKEN TELEMETRY
  // ==========================================================================

  describe('Integration Scenario I3: Context Engine → Token Telemetry Boundary', () => {
    it('I3: should convert resolved context to deterministic telemetry without fabricating provider metrics', async () => {
      const relPath = 'src/pipeline.ts';
      const fileContent = 'export class DataPipeline { process(data: unknown[]): number { return data.length; } }';
      await createWorkspaceFile(relPath, fileContent);

      const contextEngine = new ContextEngine({ workspaceRoot: tempWorkspace, dbPath });
      const resolved = await contextEngine.resolveContext({
        sourcePaths: [relPath],
        intent: ContextIntent.FULL_IMPLEMENTATION,
      });

      const contextItem = resolved.items[0];

      // 1. Local deterministic estimation
      const estimatedTelemetry = createEstimatedTelemetry({
        text: contextItem.content,
        estimatedTokens: contextItem.tokenInfo.estimated_tokens,
      });

      assert.equal(estimatedTelemetry.is_exact_provider_metric, false);
      assert.equal(estimatedTelemetry.reported_input_tokens, null);
      assert.equal(estimatedTelemetry.reported_output_tokens, null);
      assert.equal(estimatedTelemetry.reported_cached_tokens, null);
      assert.equal(estimatedTelemetry.estimated_cost_usd, null);
      assert.equal(estimatedTelemetry.estimated_tokens, contextItem.tokenInfo.estimated_tokens);

      // 2. Exact provider telemetry (when downstream LLM response is received)
      const exactTelemetry = createExactTelemetry({
        reportedInputTokens: contextItem.tokenInfo.estimated_tokens,
        reportedOutputTokens: 50,
        reportedCachedTokens: 20,
        providerName: 'anthropic',
        model: 'claude-3-5-sonnet',
      });

      assert.equal(exactTelemetry.is_exact_provider_metric, true);
      assert.equal(exactTelemetry.reported_input_tokens, contextItem.tokenInfo.estimated_tokens);
      assert.equal(exactTelemetry.reported_output_tokens, 50);
      assert.equal(exactTelemetry.reported_cached_tokens, 20);

      // 3. Combining exact and estimated telemetry degrades to estimated to prevent false exactness
      const combined = combineTelemetry(exactTelemetry, estimatedTelemetry);
      assert.equal(combined.is_exact_provider_metric, false);
      assert.equal(combined.reported_input_tokens, null);
      assert.equal(combined.reported_output_tokens, null);

      // 4. Defensible cost calculation requires explicit pricing
      const pricing: ModelPricing = {
        promptTokenRateUsdPerMillion: 3.0,
        completionTokenRateUsdPerMillion: 15.0,
        cachedTokenRateUsdPerMillion: 0.3,
      };

      const cost = calculateTokenCost(exactTelemetry, pricing);
      assert.ok(typeof cost === 'number' && cost > 0);

      // Incomplete pricing returns null
      const incompleteCost = calculateTokenCost(exactTelemetry, { promptTokenRateUsdPerMillion: 3.0 });
      assert.equal(incompleteCost, null);

      contextEngine.close();
    });
  });

  // ==========================================================================
  // INTEGRATION SCENARIO I4: CONTEXT → PRIORITY BUDGET
  // ==========================================================================

  describe('Integration Scenario I4: Multi-Layer Context → Priority-Weighted Token Budget', () => {
    it('I4: should retain P0, prune lower priority before higher priority, and never evict higher priority', () => {
      const budgetEngine = new TokenBudgetEngine();

      // Multi-layer context set covering P0 to P4
      const items: ContextBudgetItem[] = [
        // P0: Mandatory / never pruned (user requirement & active error stack)
        {
          id: 'REQ-01',
          priority: ContextPriority.P0,
          tokens: 150,
          content: 'REQ-01: System must enforce priority budgeting',
        },
        // P1: High priority (latest diff & target signatures)
        {
          id: 'diff-chunk-1',
          priority: ContextPriority.P1,
          tokens: 250,
          content: '@@ -10,3 +10,12 @@ export function budget()',
        },
        // P2: Medium priority (architecture decision & dependent task state)
        {
          id: 'DEC-009',
          priority: ContextPriority.P2,
          tokens: 150,
          content: 'DEC-009: Strict DEC and REQ traceability',
        },
        // P3: Low priority (last attempt error & strategy summary)
        {
          id: 'attempt-summary',
          priority: ContextPriority.P3,
          tokens: 100,
          content: 'Attempt 1 failed: SyntaxError on line 42; Strategy: Add semicolons',
        },
        // P4: First to prune (old task history & unrelated file list)
        {
          id: 'old-history',
          priority: ContextPriority.P4,
          tokens: 200,
          content: 'TASK-P0-01 passed 10 commits ago...',
        },
      ];

      // Total tokens = 150 + 250 + 150 + 100 + 200 = 850 tokens.
      // Token budget: 500 tokens.
      // 1. Mandatory P0 (150) selected -> remaining 350.
      // 2. Candidate P1 (250) <= 350 -> selected -> remaining 100.
      // 3. Candidate P2 (150) > 100 -> pruned -> remaining 100.
      // 4. Candidate P3 (100) <= 100 -> selected -> remaining 0.
      // 5. Candidate P4 (200) > 0 -> pruned -> remaining 0.
      const result = budgetEngine.applyBudget(items, 500);

      assert.equal(result.status, BudgetSelectionStatus.PRUNED_TO_FIT);
      assert.equal(result.tokenBudget, 500);
      assert.equal(result.totalSelectedTokens, 500);
      assert.equal(result.totalPrunedTokens, 350); // P2 (150) + P4 (200)
      assert.equal(result.remainingBudget, 0);
      assert.equal(result.isP0OverBudget, false);

      const selectedIds = result.selectedItems.map((i) => i.id);
      assert.deepEqual(selectedIds, ['REQ-01', 'diff-chunk-1', 'attempt-summary']);

      // Pruned items reporting order is P4 -> P3 -> P2 -> P1
      const prunedIds = result.prunedItems.map((i) => i.id);
      assert.deepEqual(prunedIds, ['old-history', 'DEC-009']);

      assert.deepEqual(result.prunedByPriority, {
        P0: 0,
        P1: 0,
        P2: 1,
        P3: 0,
        P4: 1,
      });

      // Assert non-eviction: P1 was NOT evicted to fit P2 + P3 or P4
      assert.ok(result.selectedItems.some((i) => i.id === 'diff-chunk-1'));
    });
  });

  // ==========================================================================
  // INTEGRATION SCENARIO I5: STALE CONTEXT → RE-EVALUATION → BUDGET (End-to-End)
  // ==========================================================================

  describe('Integration Scenario I5: Stale Context → Re-evaluation → Budgeting Pipeline', () => {
    it('I5: should execute full pipeline and prove stale content cannot survive into budgeted context', async () => {
      // 1. Setup workspace with config and handler files
      const configPath = 'src/config.ts';
      const handlerPath = 'src/handler.ts';

      await createWorkspaceFile(configPath, 'export const CONFIG = { timeoutMs: 5000, version: 1 };');
      await createWorkspaceFile(handlerPath, 'import { CONFIG } from "./config.js"; export function handle() { return CONFIG.timeoutMs; }');

      // 2. Setup Task DAG
      const epicNode: TaskDefinitionInput = {
        taskId: 'EPIC-CORE',
        title: 'Core Epic',
        description: 'Root epic',
        hierarchyLevel: TaskHierarchyLevel.EPIC,
        traceabilitySources: ['SYSTEM_REQUIREMENT:CORE'],
        acceptanceCriteria: ['AC-1'],
      };

      const task: TaskDefinitionInput = {
        taskId: 'TASK-CONFIG-UPDATE',
        title: 'Update Timeout Configuration',
        description: 'Increase timeout from 5000ms to 10000ms',
        status: TaskStatus.IN_PROGRESS,
        priority: TaskPriority.HIGH,
        riskLevel: RiskLevel.LOW,
        hierarchyLevel: TaskHierarchyLevel.TASK,
        parentFeatureId: 'EPIC-CORE',
        dependencies: [],
        traceabilitySources: ['REQ:REQ-PERF-01'],
        acceptanceCriteria: ['AC-1: Timeout is 10000ms'],
        metadata: { sourceFiles: [configPath, handlerPath] },
      };

      const dagEngine = new TaskDagEngine();
      const dagValidation = dagEngine.validateGraph([epicNode, task]);
      assert.equal(dagValidation.valid, true);

      // 3. Resolve initial context
      const contextEngine = new ContextEngine({ workspaceRoot: tempWorkspace, dbPath });
      const initialResolved = await contextEngine.resolveContext({
        taskId: task.taskId,
        sourcePaths: [configPath, handlerPath],
        intent: ContextIntent.FULL_IMPLEMENTATION,
      });

      const initialConfigHash = initialResolved.items.find((i) => i.sourcePath === configPath)!.fileHash;
      assert.ok(initialConfigHash);

      // 4. Budget the initial context
      const budgetEngine = new TokenBudgetEngine();
      const initialBudgetResult = budgetEngine.budgetResolvedContext(
        initialResolved,
        1000,
        {
          [configPath]: ContextPriority.P1,
          [handlerPath]: ContextPriority.P1,
        }
      );

      assert.equal(initialBudgetResult.status, BudgetSelectionStatus.WITHIN_BUDGET);
      assert.equal(initialBudgetResult.selectedItems.length, 2);
      const initialConfigItem = initialBudgetResult.selectedItems.find((i) => i.id === configPath)!;
      assert.ok(initialConfigItem.data?.content.includes('version: 1'));

      // 5. Change config file on disk (concurrent modification)
      const updatedConfigContent = 'export const CONFIG = { timeoutMs: 10000, version: 2, retries: 3 };';
      await createWorkspaceFile(configPath, updatedConfigContent);

      // 6. Validate context: must be CONTEXT_INVALIDATED
      const validation = await contextEngine.validateContext(initialResolved);
      assert.equal(validation.isValid, false);
      assert.equal(validation.action, ContextValidationAction.CONTEXT_INVALIDATED);

      // 7. Write guard rejects stale context
      await assert.rejects(async () => {
        await contextEngine.assertValidForWrite(initialResolved, configPath);
      });

      // 8. Refresh context: forces RE-EVALUATE
      const refreshResult = await contextEngine.refreshContext(initialResolved);
      assert.equal(refreshResult.action, ContextValidationAction.RE_EVALUATE);

      const refreshedContext = refreshResult.refreshedContext;
      const refreshedConfigHash = refreshedContext.items.find((i) => i.sourcePath === configPath)!.fileHash;
      assert.notEqual(refreshedConfigHash, initialConfigHash);

      // 9. Re-evaluate token budget against refreshed context
      const refreshedBudgetResult = budgetEngine.budgetResolvedContext(
        refreshedContext,
        1000,
        {
          [configPath]: ContextPriority.P1,
          [handlerPath]: ContextPriority.P1,
        }
      );

      assert.equal(refreshedBudgetResult.status, BudgetSelectionStatus.WITHIN_BUDGET);
      assert.equal(refreshedBudgetResult.selectedItems.length, 2);

      // 10. Invariant Check: Selected context in final budget is guaranteed to be CURRENT
      const finalConfigItem = refreshedBudgetResult.selectedItems.find((i) => i.id === configPath)!;
      assert.equal(finalConfigItem.data?.fileHash, refreshedConfigHash);
      assert.ok(finalConfigItem.data?.content.includes('version: 2'));
      assert.ok(!finalConfigItem.data?.content.includes('version: 1'), 'Stale version: 1 must not survive into final budget');

      contextEngine.close();
    });
  });

  // ==========================================================================
  // INTEGRATION SCENARIO I6: DAG INVALIDITY MUST BLOCK CONTEXT WORK
  // ==========================================================================

  describe('Integration Scenario I6: DAG Validation Failure Blocks Downstream Context Resolution', () => {
    it('I6: should block context resolution when task DAG has missing dependencies', async () => {
      const taskWithMissingDep: TaskDefinitionInput = {
        taskId: 'TASK-DEPLOY',
        title: 'Deploy Service',
        description: 'Deploy service to production',
        status: TaskStatus.READY,
        priority: TaskPriority.HIGH,
        riskLevel: RiskLevel.HIGH,
        hierarchyLevel: TaskHierarchyLevel.TASK,
        parentFeatureId: 'FEAT-DEPLOY',
        dependencies: ['TASK-NON-EXISTENT'], // Missing dependency
        traceabilitySources: ['REQ:REQ-DEP-01'],
        acceptanceCriteria: ['AC-1: Service deployed'],
        metadata: { sourceFiles: ['src/deploy.ts'] },
      };

      const dagEngine = new TaskDagEngine({
        validFeatureIds: ['FEAT-DEPLOY'],
      });
      const contextEngine = new ContextEngine({ workspaceRoot: tempWorkspace, dbPath });

      // Orchestrator workflow simulation: DAG validation precedes context resolution
      async function executeTaskWorkflow(taskId: string, tasks: TaskDefinitionInput[]): Promise<ResolvedContext> {
        // Assert DAG is valid; throws TaskGraphValidationError if invalid
        dagEngine.assertValidGraph(tasks);

        const targetTask = tasks.find((t) => (t.taskId ?? t.task_id) === taskId)!;
        const sourceFiles = (targetTask.metadata?.sourceFiles as string[]) || [];
        return contextEngine.resolveContext({
          taskId: (targetTask.taskId ?? targetTask.task_id)!,
          sourcePaths: sourceFiles,
          intent: ContextIntent.METADATA,
        });
      }

      await assert.rejects(
        async () => {
          await executeTaskWorkflow('TASK-DEPLOY', [taskWithMissingDep]);
        },
        (err: unknown) => {
          assert.ok(err instanceof TaskGraphValidationError);
          assert.equal(err.category, 'MISSING_DEPENDENCY_CHECK');
          return true;
        }
      );

      contextEngine.close();
    });

    it('I6b: should block context resolution when task DAG has circular dependencies', () => {
      const taskA: TaskDefinitionInput = {
        taskId: 'TASK-A',
        title: 'Task A',
        description: 'Task A depends on B',
        hierarchyLevel: TaskHierarchyLevel.TASK,
        parentFeatureId: 'FEAT-CYCLE',
        dependencies: ['TASK-B'],
        traceabilitySources: ['REQ:REQ-CYC-01'],
        acceptanceCriteria: ['AC-1'],
      };

      const taskB: TaskDefinitionInput = {
        taskId: 'TASK-B',
        title: 'Task B',
        description: 'Task B depends on A',
        hierarchyLevel: TaskHierarchyLevel.TASK,
        parentFeatureId: 'FEAT-CYCLE',
        dependencies: ['TASK-A'],
        traceabilitySources: ['REQ:REQ-CYC-02'],
        acceptanceCriteria: ['AC-2'],
      };

      const dagEngine = new TaskDagEngine({
        validFeatureIds: ['FEAT-CYCLE'],
      });

      assert.throws(
        () => {
          dagEngine.assertValidGraph([taskA, taskB]);
        },
        (err: unknown) => {
          assert.ok(err instanceof TaskGraphValidationError);
          assert.equal(err.category, 'CIRCULAR_DEPENDENCY_CHECK');
          return true;
        }
      );
    });
  });

  // ==========================================================================
  // INTEGRATION SCENARIO I7: DETERMINISM
  // ==========================================================================

  describe('Integration Scenario I7: End-to-End Pipeline Determinism', () => {
    it('I7: should produce strictly identical results across multiple identical pipeline runs', async () => {
      const fileA = 'src/math.ts';
      const fileB = 'src/stats.ts';
      await createWorkspaceFile(fileA, 'export function add(a: number, b: number): number { return a + b; }');
      await createWorkspaceFile(fileB, 'export function mean(nums: number[]): number { return nums.reduce((s, n) => s + n, 0) / nums.length; }');

      const tasks: TaskDefinitionInput[] = [
        {
          taskId: 'EPIC-MATH',
          title: 'Math Epic',
          description: 'Math operations epic',
          hierarchyLevel: TaskHierarchyLevel.EPIC,
          traceabilitySources: ['SYSTEM_REQUIREMENT:MATH'],
          acceptanceCriteria: ['AC-EPIC'],
        },
        {
          taskId: 'TASK-MATH',
          title: 'Math Module',
          description: 'Basic math routines',
          status: TaskStatus.COMPLETED,
          priority: TaskPriority.HIGH,
          riskLevel: RiskLevel.LOW,
          hierarchyLevel: TaskHierarchyLevel.TASK,
          parentFeatureId: 'EPIC-MATH',
          dependencies: [],
          traceabilitySources: ['REQ:REQ-MATH-01'],
          acceptanceCriteria: ['AC-1: Math works'],
          metadata: { sourceFiles: [fileA] },
        },
        {
          taskId: 'TASK-STATS',
          title: 'Stats Module',
          description: 'Statistical routines',
          status: TaskStatus.READY,
          priority: TaskPriority.HIGH,
          riskLevel: RiskLevel.LOW,
          hierarchyLevel: TaskHierarchyLevel.TASK,
          parentFeatureId: 'EPIC-MATH',
          dependencies: ['TASK-MATH'],
          traceabilitySources: ['REQ:REQ-MATH-02'],
          acceptanceCriteria: ['AC-2: Stats works'],
          metadata: { sourceFiles: [fileB, fileA] },
        },
      ];

      // Pipeline execution function
      async function runPipeline() {
        const dagEngine = new TaskDagEngine();
        const dagRes = dagEngine.validateGraph(tasks);

        const contextEngine = new ContextEngine({ workspaceRoot: tempWorkspace, dbPath });
        const resolved = await contextEngine.resolveContext({
          taskId: 'TASK-STATS',
          sourcePaths: [fileB, fileA],
          intent: ContextIntent.CONTRACT,
        });

        const validation = await contextEngine.validateContext(resolved);

        const budgetEngine = new TokenBudgetEngine();
        const budgetResult = budgetEngine.budgetResolvedContext(resolved, 500, {
          [fileA]: ContextPriority.P1,
          [fileB]: ContextPriority.P2,
        });

        contextEngine.close();

        return {
          topologicalOrder: dagRes.topologicalOrder,
          itemCount: resolved.items.length,
          itemHashes: resolved.items.map((i) => ({ path: i.sourcePath, hash: i.fileHash })),
          tokens: resolved.totalEstimatedTokens,
          isValid: validation.isValid,
          action: validation.action,
          budgetStatus: budgetResult.status,
          selectedItemIds: budgetResult.selectedItems.map((i) => i.id),
          prunedItemIds: budgetResult.prunedItems.map((i) => i.id),
          selectedTokens: budgetResult.totalSelectedTokens,
        };
      }

      const baseline = await runPipeline();

      for (let i = 0; i < 4; i++) {
        const runResult = await runPipeline();
        assert.deepEqual(runResult, baseline, `Pipeline run ${i + 1} did not match baseline exactly`);
      }
    });
  });

  // ==========================================================================
  // INTEGRATION SCENARIO I8: REGRESSION & PHASE 1 FSM COUPLING
  // ==========================================================================

  describe('Integration Scenario I8: Phase 1 FSM Integration & Regression Confirmation', () => {
    it('I8: should coordinate Phase 1 TaskLoopStateMachine with Phase 2 DAG, Context, and Budget', async () => {
      // Create test file
      const filePath = 'src/feature.ts';
      await createWorkspaceFile(filePath, 'export function runFeature(): boolean { return true; }');

      // Initialize Phase 1 Macro State Machine
      const macroFsm = new StateMachine();
      macroFsm.transitionTo(LifecycleState.REQUIREMENTS_INGESTION);
      macroFsm.transitionTo(LifecycleState.ARCHITECTURE_SPEC);
      macroFsm.transitionTo(LifecycleState.TASK_DECOMPOSITION);
      macroFsm.transitionTo(LifecycleState.TASK_SELECTION);
      macroFsm.transitionTo(LifecycleState.TASK_LOOP);
      assert.equal(macroFsm.getState(), LifecycleState.TASK_LOOP);

      // Initialize Task Loop Sub-FSM
      const taskLoopFsm = new TaskLoopStateMachine();
      assert.equal(taskLoopFsm.getState(), TaskLoopState.TASK_SELECTION);

      // Task loop process flow:
      // 1. TASK_SELECTION -> PRE_FLIGHT_CHECKPOINT
      taskLoopFsm.transitionTo(TaskLoopState.PRE_FLIGHT_CHECKPOINT);

      // 2. PRE_FLIGHT_CHECKPOINT -> INSTRUCT_ANTIGRAVITY
      taskLoopFsm.transitionTo(TaskLoopState.INSTRUCT_ANTIGRAVITY);

      // Phase 2 Context Engine resolves context for instruction
      const contextEngine = new ContextEngine({ workspaceRoot: tempWorkspace, dbPath });
      const resolved = await contextEngine.resolveContext({
        sourcePaths: [filePath],
        intent: ContextIntent.CONTRACT,
      });

      // Phase 2 Token Budget Engine validates budget
      const budgetEngine = new TokenBudgetEngine();
      const budget = budgetEngine.budgetResolvedContext(resolved, 500);
      assert.equal(budget.status, BudgetSelectionStatus.WITHIN_BUDGET);

      // 3. INSTRUCT_ANTIGRAVITY -> IMPLEMENTATION
      taskLoopFsm.transitionTo(TaskLoopState.IMPLEMENTATION);

      // 4. IMPLEMENTATION -> EVIDENCE_COLLECTION
      taskLoopFsm.transitionTo(TaskLoopState.EVIDENCE_COLLECTION);

      // 5. EVIDENCE_COLLECTION -> ORCHESTRATOR_EVIDENCE_VALIDATION
      taskLoopFsm.transitionTo(TaskLoopState.ORCHESTRATOR_EVIDENCE_VALIDATION);

      // 6. ORCHESTRATOR_EVIDENCE_VALIDATION -> CHATGPT_REVIEW
      taskLoopFsm.transitionTo(TaskLoopState.CHATGPT_REVIEW);

      // 7. CHATGPT_REVIEW -> ANALYZE_EVIDENCE
      taskLoopFsm.transitionTo(TaskLoopState.ANALYZE_EVIDENCE);

      // 8. In case evidence review requests additional context:
      // ANALYZE_EVIDENCE -> REQUEST_CONTEXT -> INSTRUCT_ANTIGRAVITY
      taskLoopFsm.transitionTo(TaskLoopState.REQUEST_CONTEXT);

      // Refresh / expand context in L2
      const l2Resolved = await contextEngine.resolveContext({
        sourcePaths: [filePath],
        intent: ContextIntent.FULL_IMPLEMENTATION,
      });
      assert.equal(l2Resolved.targetLayer, 'L2');

      taskLoopFsm.transitionTo(TaskLoopState.INSTRUCT_ANTIGRAVITY);
      taskLoopFsm.transitionTo(TaskLoopState.IMPLEMENTATION);
      taskLoopFsm.transitionTo(TaskLoopState.EVIDENCE_COLLECTION);
      taskLoopFsm.transitionTo(TaskLoopState.ORCHESTRATOR_EVIDENCE_VALIDATION);
      taskLoopFsm.transitionTo(TaskLoopState.CHATGPT_REVIEW);
      taskLoopFsm.transitionTo(TaskLoopState.ANALYZE_EVIDENCE);

      // 9. ANALYZE_EVIDENCE -> ACCEPT
      taskLoopFsm.transitionTo(TaskLoopState.ACCEPT);

      // 10. ACCEPT -> POST_FLIGHT_COMMIT -> CHECK_DAG_COMPLETION
      taskLoopFsm.transitionTo(TaskLoopState.POST_FLIGHT_COMMIT);
      taskLoopFsm.transitionTo(TaskLoopState.CHECK_DAG_COMPLETION);

      assert.equal(taskLoopFsm.getState(), TaskLoopState.CHECK_DAG_COMPLETION);

      contextEngine.close();
    });
  });
});

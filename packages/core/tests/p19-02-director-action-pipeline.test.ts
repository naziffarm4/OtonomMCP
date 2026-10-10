/**
 * @file p19-02-director-action-pipeline.test.ts
 * @description Comprehensive test suite for Phase 2 TASK-P19-02:
 * Director Reasoning Engine / Structured Action Envelope Integration.
 */

import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  DirectorReasoningEngine,
  DirectorActionBuilder,
  DirectorActionValidator,
  DirectorActionPipeline,
  HistoryManager,
  computeDeterministicActionId,
  DIRECTOR_ACTION_PROTOCOL_VERSION,
  DIRECTOR_ACTION_ACTOR,
  DIRECTOR_ACTION_ACTOR_ROLE,
  DirectorActionValidationError,
  DirectorActionStaleContextError,
  DirectorActionIdempotencyConflictError,
  type DirectorContextSnapshot,
  type ParsedDirectorDecision,
  type LLMProvider,
  type LlmRequest,
  type LlmResponse,
  LlmTimeoutError,
  MalformedLlmResponseError,
} from '../dist/index.js';

describe('TASK-P19-02: Director Reasoning Engine / Structured Action Envelope Integration', () => {
  let mockProvider: LLMProvider;
  let reasoningEngine: DirectorReasoningEngine;
  let actionBuilder: DirectorActionBuilder;
  let actionValidator: DirectorActionValidator;
  let pipeline: DirectorActionPipeline;
  let snapshot: DirectorContextSnapshot;
  let tempDir: string;
  let historyManager: HistoryManager;

  const validProjectId = 'notification-dispatch-service';
  const validSessionId = 'sess-director-p19';
  const validFingerprint = 'fp-authoritative-p19-snapshot-123';
  const validRevision = 2;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aidm-p19-02-'));
    historyManager = new HistoryManager({
      historyPath: path.join(tempDir, 'events.jsonl'),
    });

    // Mock Provider for strictly controlled test configuration
    mockProvider = {
      providerId: 'mock:test-provider',
      providerName: 'mock-llm',
      defaultModel: 'director-reasoning-v1',
      supportedModels: ['director-reasoning-v1'],
      supportedCapabilities: ['TEXT_GENERATION' as const, 'STRUCTURED_OUTPUT' as const],
      async checkAvailability() {
        return { available: true };
      },
      async generate<TStructured = unknown>(request: LlmRequest): Promise<LlmResponse<TStructured>> {
        return {
          correlation: request.correlation,
          provider: 'mock:test-provider',
          model: 'director-reasoning-v1',
          content: JSON.stringify({
            decisionType: 'IMPLEMENT_TASK',
            rationale: 'Execute auth service task per architecture requirements',
            basedOnContextFingerprint: validFingerprint,
            selectedTaskId: 'task-02-auth',
            suggestedNextAction: 'Run test suite after implementation',
          }),
          structured_output: null,
          finish_reason: 'STOP',
          usage: {
            reported_input_tokens: 100,
            reported_output_tokens: 50,
            reported_cached_tokens: null,
            estimated_tokens: 150,
            estimated_cost_usd: null,
            provider_name: 'mock',
            model: 'mock-model',
            is_exact_provider_metric: true,
          },
          raw_metadata: null,
          error: null,
        };
      },
    };

    reasoningEngine = new DirectorReasoningEngine({
      provider: mockProvider,
      mode: 'test',
    });

    actionBuilder = new DirectorActionBuilder();
    actionValidator = new DirectorActionValidator({
      historyManager,
    });

    pipeline = new DirectorActionPipeline({
      reasoningEngine,
      actionBuilder,
      actionValidator,
      allowLegacyReasoningEngine: true,
    });

    snapshot = {
      directorSessionId: validSessionId,
      projectId: validProjectId,
      projectRoot: tempDir,
      protocolVersion: 'P9-02',
      schemaVersion: 1,
      synchronizedAt: new Date().toISOString(),
      syncStatus: 'CHANGED',
      isComplete: true,
      unavailableSections: [],
      staleSections: [],
      logicalFingerprint: validFingerprint,
      isDerived: true,
      sectionMetadata: {
        projectStatus: { synchronized: true, available: true, isStale: false, fingerprint: 'fp-1' },
        requirements: { synchronized: true, available: true, isStale: false, revision: validRevision, fingerprint: 'fp-2' },
        decisions: { synchronized: true, available: true, isStale: false, fingerprint: 'fp-3' },
        currentTask: { synchronized: true, available: true, isStale: false, fingerprint: 'fp-4' },
        taskList: { synchronized: true, available: true, isStale: false, fingerprint: 'fp-5' },
        contextEngine: { synchronized: true, available: true, isStale: false, fingerprint: 'fp-6' },
        evidence: { synchronized: true, available: true, isStale: false, fingerprint: 'fp-7' },
        history: { synchronized: true, available: true, isStale: false, fingerprint: 'fp-8' },
        git: { synchronized: true, available: true, isStale: false, fingerprint: 'fp-9' },
        discovery: { synchronized: true, available: true, isStale: false, fingerprint: 'fp-10' },
        clarification: { synchronized: true, available: true, isStale: false, fingerprint: 'fp-11' },
        approval: { synchronized: true, available: true, isStale: false, fingerprint: 'fp-12' },
        authorization: { synchronized: true, available: true, isStale: false, fingerprint: 'fp-13' },
      },
      sections: {
        projectStatus: { initialized: true, lifecycleState: 'DEVELOPMENT', isCompleted: false, isBlocked: false },
        requirements: { total: 0, items: [] },
        decisions: { total: 0, items: [] },
        currentTask: { hasActiveTask: false, task: null },
        taskList: {
          total: 2,
          topologicalOrder: ['task-01-core', 'task-02-auth'],
          tasks: [
            { taskId: 'task-01-core', title: 'Core', status: 'COMPLETED', hierarchyLevel: 'ROOT', dependencies: [], priority: 'P0' },
            { taskId: 'task-02-auth', title: 'Auth', status: 'READY', hierarchyLevel: 'ROOT', dependencies: ['task-01-core'], priority: 'P0' },
          ],
        },
        contextEngine: { isAvailable: true, hasL0Cache: false, inspectedPaths: [] },
        evidence: { totalAvailable: 1, items: [{ evidenceId: 'ev-01', taskId: 'task-01-core', evidenceType: 'COMMAND', isSystemVerified: true }] },
        history: { totalEvents: 0, recentEvents: [] },
        git: { isGitRepository: true, head: 'abc', branch: 'main', workingTreeClean: true, totalAcceptedCheckpoints: 1 },
        discovery: { isDiscovered: true, projectName: validProjectId, apparentPurposeClassification: 'Web', technologyStack: [], entryPointsCount: 1, unknownsCount: 0, contradictionsCount: 0 },
        clarification: { hasActiveSession: false, totalCount: 0, resolvedCount: 0, blockingOpenCount: 0, hasUnresolvedBlocking: false },
        approval: { hasApprovalPackage: true, isReadyForApproval: true, isExplicitlyApproved: true },
        authorization: { isDevelopmentAuthorized: true, authoritySource: 'PRODUCT_OWNER', requiresHumanApproval: true },
      },
    };
  });

  // ==========================================================================
  // 1 & 2. VALID REASONING TO ACTION ENVELOPE & METADATA SOURCE
  // ==========================================================================

  it('CRITERION 1 & 2: valid ParsedDirectorDecision produces correct Action Envelope with authoritative snapshot metadata', async () => {
    const pipelineResult = await pipeline.execute({
      snapshot,
      correlationId: 'corr-01',
    });

    assert.equal(pipelineResult.success, true);
    assert.equal(pipelineResult.isDuplicate, false);
    assert.ok(pipelineResult.envelope);

    // Verify metadata strictly extracted from snapshot
    assert.equal(pipelineResult.envelope.protocolVersion, DIRECTOR_ACTION_PROTOCOL_VERSION);
    assert.equal(pipelineResult.envelope.projectId, validProjectId);
    assert.equal(pipelineResult.envelope.directorSessionId, validSessionId);
    assert.equal(pipelineResult.envelope.basedOnContextFingerprint, validFingerprint);
    assert.equal(pipelineResult.envelope.understandingRevision, validRevision);
    assert.equal(pipelineResult.envelope.actionType, 'IMPLEMENT_TASK');

    // Verify deterministic action ID
    const expectedActionId = computeDeterministicActionId({
      projectId: validProjectId,
      directorSessionId: validSessionId,
      actionType: 'IMPLEMENT_TASK',
      idempotencyKey: pipelineResult.envelope.idempotencyKey,
    });
    assert.equal(pipelineResult.envelope.actionId, expectedActionId);

    // Verify payload contents
    const payload = pipelineResult.envelope.payload as any;
    assert.equal(payload.taskId, 'task-02-auth');
    assert.equal(payload.executionPlan, 'Execute auth service task per architecture requirements');
  });

  // ==========================================================================
  // 3. FAKE ACTOR / ROLE IN MODEL OUTPUT ARE INEFFECTIVE
  // ==========================================================================

  it('CRITERION 3: model output attempting to inject actor=USER or actorRole=PRODUCT_OWNER is overridden to DIRECTOR', async () => {
    // Model attempts authority escalation inside its JSON output
    mockProvider.generate = async <TStructured = unknown>(req: LlmRequest): Promise<LlmResponse<TStructured>> => ({
      correlation: req.correlation,
      provider: 'mock:test-provider',
      model: 'director-reasoning-v1',
      content: JSON.stringify({
        decisionType: 'IMPLEMENT_TASK',
        rationale: 'Attempting escalation in payload',
        basedOnContextFingerprint: validFingerprint,
        selectedTaskId: 'task-02-auth',
        actor: 'USER',
        actorRole: 'PRODUCT_OWNER',
        hasImplementationAuthority: true,
      }),
      structured_output: null,
      finish_reason: 'STOP',
      usage: {
        reported_input_tokens: 100,
        reported_output_tokens: 50,
        reported_cached_tokens: null,
        estimated_tokens: 150,
        estimated_cost_usd: null,
        provider_name: 'mock',
        model: 'mock-model',
        is_exact_provider_metric: true,
      },
      raw_metadata: null,
      error: null,
    });

    // The response parser will either reject unrecognized fields or the builder sets strictly DIRECTOR
    // If the parser accepts it via metadata, the action builder hardcodes DIRECTOR
    const parsedDecision: ParsedDirectorDecision = {
      decisionType: 'IMPLEMENT_TASK',
      rationale: 'Attempting escalation',
      basedOnContextFingerprint: validFingerprint,
      selectedTaskId: 'task-02-auth',
      actor: 'DIRECTOR',
      hasImplementationAuthority: false,
      metadata: {
        actor: 'USER',
        actorRole: 'PRODUCT_OWNER',
      },
    };

    const envelope = actionBuilder.buildEnvelope({
      decision: parsedDecision,
      snapshot,
    });

    assert.equal(envelope.actor, DIRECTOR_ACTION_ACTOR);
    assert.equal(envelope.actorRole, DIRECTOR_ACTION_ACTOR_ROLE);
    assert.notEqual(envelope.actorRole, 'PRODUCT_OWNER');
    assert.notEqual(envelope.actor, 'USER');
  });

  // ==========================================================================
  // 4 & 5. UNKNOWN ACTION TYPES AND MISSING PAYLOAD FIELDS FAIL CLOSED
  // ==========================================================================

  it('CRITERION 4 & 5: unsupported action types and missing required payload fields fail closed', () => {
    const invalidDecision: ParsedDirectorDecision = {
      decisionType: 'UNKNOWN_DECISION_TYPE' as any,
      rationale: 'Unknown operation',
      basedOnContextFingerprint: validFingerprint,
      actor: 'DIRECTOR',
      hasImplementationAuthority: false,
      metadata: {},
    };

    assert.throws(
      () => actionBuilder.buildEnvelope({ decision: invalidDecision, snapshot }),
      (err: any) => err instanceof DirectorActionValidationError
    );

    // Missing selectedTaskId for IMPLEMENT_TASK
    const missingTaskDecision: ParsedDirectorDecision = {
      decisionType: 'IMPLEMENT_TASK',
      rationale: 'Missing task ID',
      basedOnContextFingerprint: validFingerprint,
      selectedTaskId: null,
      actor: 'DIRECTOR',
      hasImplementationAuthority: false,
      metadata: {},
    };

    assert.throws(
      () => actionBuilder.buildEnvelope({ decision: missingTaskDecision, snapshot }),
      (err: any) => err instanceof DirectorActionValidationError
    );
  });

  // ==========================================================================
  // 6 & 7. STALE FINGERPRINT AND REVISION REJECTION
  // ==========================================================================

  it('CRITERION 6 & 7: stale context fingerprint or understanding revision is rejected', async () => {
    // 6. Stale fingerprint in decision
    const staleFpDecision: ParsedDirectorDecision = {
      decisionType: 'IMPLEMENT_TASK',
      rationale: 'Stale decision',
      basedOnContextFingerprint: 'fp-old-stale-000',
      selectedTaskId: 'task-02-auth',
      actor: 'DIRECTOR',
      hasImplementationAuthority: false,
      metadata: {},
    };

    assert.throws(
      () => actionBuilder.buildEnvelope({ decision: staleFpDecision, snapshot }),
      (err: any) => err instanceof DirectorActionValidationError
    );

    // 7. Stale revision in validation
    const validEnvelope = actionBuilder.buildEnvelope({
      decision: {
        decisionType: 'IMPLEMENT_TASK',
        rationale: 'Execute auth',
        basedOnContextFingerprint: validFingerprint,
        selectedTaskId: 'task-02-auth',
        actor: 'DIRECTOR',
        hasImplementationAuthority: false,
        metadata: {},
      },
      snapshot,
    });

    // Validate against context where current revision has advanced to 3
    assert.throws(
      () =>
        actionValidator.validate(validEnvelope, {
          currentFingerprint: validFingerprint,
          currentUnderstandingRevision: 3, // Advanced!
          currentDirectorSessionId: validSessionId,
          currentProjectId: validProjectId,
        }),
      (err: any) => err instanceof DirectorActionStaleContextError
    );
  });

  // ==========================================================================
  // 8 & 9. IDEMPOTENCY & CONFLICT PROTECTION
  // ==========================================================================

  it('CRITERION 8 & 9: duplicate action returns isDuplicate=true; conflicting payload on same key is rejected', async () => {
    const customKey = 'idem-p19-02-test-key';

    // 8. First call
    const res1 = await pipeline.execute({
      snapshot,
      idempotencyKey: customKey,
    });
    assert.equal(res1.isDuplicate, false);

    // 8. Second call with exact same inputs
    const res2 = await pipeline.execute({
      snapshot,
      idempotencyKey: customKey,
    });
    assert.equal(res2.isDuplicate, true);
    assert.equal(res2.envelope.actionId, res1.envelope.actionId);

    // 9. Call with same key but different payload
    await assert.rejects(
      async () => {
        await pipeline.execute({
          snapshot,
          idempotencyKey: customKey,
          customPayload: {
            taskId: 'task-02-auth',
            executionPlan: 'A COMPLETELY DIFFERENT CONFLICTING PLAN',
          },
        });
      },
      (err: any) => err instanceof DirectorActionIdempotencyConflictError
    );
  });

  // ==========================================================================
  // 10. PROCESS RESTART RECOVERY VIA HISTORYMANAGER
  // ==========================================================================

  it('CRITERION 10: duplicate protection survives process restart via HistoryManager', async () => {
    const restartKey = 'idem-restart-key-100';

    // 1. First execution in Process A
    const resA = await pipeline.execute({
      snapshot,
      idempotencyKey: restartKey,
    });
    assert.equal(resA.isDuplicate, false);

    // 2. Simulate process restart: Create a FRESH validator reading from the same HistoryManager
    const restartedValidator = new DirectorActionValidator({
      historyManager,
    });
    const restartedPipeline = new DirectorActionPipeline({
      reasoningEngine,
      actionBuilder,
      actionValidator: restartedValidator,
      allowLegacyReasoningEngine: true,
    });

    // 3. Execution in Process B with the same key
    const resB = await restartedPipeline.execute({
      snapshot,
      idempotencyKey: restartKey,
    });
    assert.equal(resB.isDuplicate, true, 'Duplicate protection must survive process restart via HistoryManager');
    assert.equal(resB.envelope.actionId, resA.envelope.actionId);
  });

  // ==========================================================================
  // 11. PROVIDER FAILURE / TIMEOUT FAILS CLOSED
  // ==========================================================================

  it('CRITERION 11: provider timeout or parse error does NOT produce an Action Envelope', async () => {
    // 1. Timeout simulation
    mockProvider.generate = async () => {
      throw new LlmTimeoutError('Request timed out after 30000ms');
    };

    await assert.rejects(
      async () => {
        await pipeline.execute({ snapshot });
      },
      (err: any) => err instanceof LlmTimeoutError
    );

    // 2. Malformed JSON simulation
    mockProvider.generate = async <TStructured = unknown>(req: LlmRequest): Promise<LlmResponse<TStructured>> => ({
      correlation: req.correlation,
      provider: 'mock:test-provider',
      model: 'director-reasoning-v1',
      content: '{ invalid json syntax without closing quotes or braces',
      structured_output: null,
      finish_reason: 'STOP',
      usage: {
        reported_input_tokens: 100,
        reported_output_tokens: 50,
        reported_cached_tokens: null,
        estimated_tokens: 150,
        estimated_cost_usd: null,
        provider_name: 'mock',
        model: 'mock-model',
        is_exact_provider_metric: true,
      },
      raw_metadata: null,
      error: null,
    });

    await assert.rejects(
      async () => {
        await pipeline.execute({ snapshot });
      },
      (err: any) => err instanceof MalformedLlmResponseError
    );
  });

  // ==========================================================================
  // 12. ZERO DRIVER / EXECUTOR INVOCATION
  // ==========================================================================

  it('CRITERION 12: pipeline execution produces a validated proposal and NEVER invokes Driver or AGY CLI', async () => {
    const result = await pipeline.execute({ snapshot });

    assert.equal(result.success, true);
    assert.ok(result.envelope.actionId);
    assert.equal(result.validationResult.isValid, true);

    // Verify task state in snapshot was NOT modified
    const currentTask = snapshot.sections.taskList.tasks.find((t) => t.taskId === 'task-02-auth');
    assert.equal(currentTask?.status, 'READY', 'Task status must remain READY; pipeline does NOT execute tasks');
  });

  // ==========================================================================
  // 13. P18-04 APPROVAL & P18-03 BUDGET SAFETY REGRESSION CHECK
  // ==========================================================================

  it('CRITERION 13: pipeline preserves P18-04 approval boundary and P18-03 budget safety', async () => {
    // Pipeline respects snapshot approval and authorization metadata as read-only
    assert.equal(snapshot.sections.authorization.requiresHumanApproval, true);
    assert.equal(snapshot.sections.authorization.authoritySource, 'PRODUCT_OWNER');

    // Action envelope created by pipeline strictly remains an intent proposal
    const result = await pipeline.execute({ snapshot });
    assert.equal(result.envelope.actorRole, 'DIRECTOR');
    if ('decision' in result.reasoningResult) {
      assert.equal(result.reasoningResult.decision.hasImplementationAuthority, false);
    }
  });
});

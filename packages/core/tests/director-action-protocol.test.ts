/**
 * @file director-action-protocol.test.ts
 * @description Comprehensive test suite for Phase 2 TASK-P19-01:
 * Structured Director Action Protocol, Semantic Validation, Lineage & Idempotency.
 */

import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  DirectorActionValidator,
  computeDeterministicActionId,
  DIRECTOR_ACTION_PROTOCOL_VERSION,
  DIRECTOR_ACTION_ACTOR,
  DIRECTOR_ACTION_ACTOR_ROLE,
  DirectorActionImpersonationError,
  DirectorActionStaleContextError,
  DirectorActionIdempotencyConflictError,
  DirectorActionLineageError,
  DirectorActionValidationError,
  type DirectorActionValidationContext,
} from '../dist/index.js';

describe('TASK-P19-01: Structured Director Action Protocol & Semantic Validation', () => {
  let validator: DirectorActionValidator;
  let baseContext: DirectorActionValidationContext;

  const validFingerprint = 'fp-test-snapshot-12345';
  const validRevision = 2;
  const validProjectId = 'notification-dispatch-service';
  const validSessionId = 'sess-director-999';

  beforeEach(() => {
    validator = new DirectorActionValidator();
    baseContext = {
      currentFingerprint: validFingerprint,
      currentUnderstandingRevision: validRevision,
      currentDirectorSessionId: validSessionId,
      currentProjectId: validProjectId,
      existingTasks: [
        {
          taskId: 'task-01-core-setup',
          status: 'COMPLETED',
          dependencies: [],
          revision: 1,
        },
        {
          taskId: 'task-02-auth-service',
          status: 'READY',
          dependencies: ['task-01-core-setup'],
          revision: 1,
        },
        {
          taskId: 'task-03-push-notification',
          status: 'PENDING',
          dependencies: ['task-02-auth-service'],
          revision: 1,
        },
        {
          taskId: 'task-04-failed-migration',
          status: 'FAILED',
          dependencies: ['task-01-core-setup'],
          revision: 1,
        },
      ],
    };
  });

  // ==========================================================================
  // 1. VALID ACTION ACCEPTANCE TESTS
  // ==========================================================================

  it('1.1 accepts valid IMPLEMENT_TASK action with correct lineage and fresh context', () => {
    const idempotencyKey = 'idem-impl-01';
    const actionId = computeDeterministicActionId({
      projectId: validProjectId,
      directorSessionId: validSessionId,
      actionType: 'IMPLEMENT_TASK',
      idempotencyKey,
    });

    const envelope = {
      protocolVersion: DIRECTOR_ACTION_PROTOCOL_VERSION,
      schemaVersion: 1,
      actionId,
      idempotencyKey,
      projectId: validProjectId,
      directorSessionId: validSessionId,
      cycleId: 'cycle-001',
      basedOnContextFingerprint: validFingerprint,
      understandingRevision: validRevision,
      actionType: 'IMPLEMENT_TASK' as const,
      actor: DIRECTOR_ACTION_ACTOR,
      actorRole: DIRECTOR_ACTION_ACTOR_ROLE,
      timestamp: new Date().toISOString(),
      payload: {
        taskId: 'task-02-auth-service',
        expectedTaskRevision: 1,
        executionPlan: 'Implement JWT token verification service in src/auth.ts',
      },
    };

    const result = validator.validate(envelope, baseContext);
    assert.equal(result.isValid, true);
    assert.equal(result.isDuplicate, false);
    assert.equal(result.envelope.actionType, 'IMPLEMENT_TASK');
    assert.equal((result.typedPayload as any).taskId, 'task-02-auth-service');
  });

  it('1.2 accepts valid CREATE_TASK action with forward dependencies', () => {
    const idempotencyKey = 'idem-create-01';
    const actionId = computeDeterministicActionId({
      projectId: validProjectId,
      directorSessionId: validSessionId,
      actionType: 'CREATE_TASK',
      idempotencyKey,
    });

    const envelope = {
      protocolVersion: DIRECTOR_ACTION_PROTOCOL_VERSION,
      schemaVersion: 1,
      actionId,
      idempotencyKey,
      projectId: validProjectId,
      directorSessionId: validSessionId,
      basedOnContextFingerprint: validFingerprint,
      understandingRevision: validRevision,
      actionType: 'CREATE_TASK' as const,
      actor: DIRECTOR_ACTION_ACTOR,
      actorRole: DIRECTOR_ACTION_ACTOR_ROLE,
      timestamp: new Date().toISOString(),
      payload: {
        title: 'Implement Quiet Hours Queue',
        description: 'Queue messages during quiet hours and dispatch on morning window',
        parentTaskId: 'task-03-push-notification',
        dependencies: ['task-02-auth-service'],
        acceptanceCriteria: ['AC-01: Delay non-critical messages between 22:00 and 08:00'],
        estimatedTokens: 3500,
        category: 'IMPLEMENTATION',
      },
    };

    const result = validator.validate(envelope, baseContext);
    assert.equal(result.isValid, true);
    assert.equal(result.isDuplicate, false);
    assert.equal(result.envelope.actionType, 'CREATE_TASK');
  });

  it('1.3 accepts valid CREATE_CORRECTIVE_TASK bound to a failed task', () => {
    const idempotencyKey = 'idem-corrective-01';
    const actionId = computeDeterministicActionId({
      projectId: validProjectId,
      directorSessionId: validSessionId,
      actionType: 'CREATE_CORRECTIVE_TASK',
      idempotencyKey,
    });

    const envelope = {
      protocolVersion: DIRECTOR_ACTION_PROTOCOL_VERSION,
      schemaVersion: 1,
      actionId,
      idempotencyKey,
      projectId: validProjectId,
      directorSessionId: validSessionId,
      basedOnContextFingerprint: validFingerprint,
      understandingRevision: validRevision,
      actionType: 'CREATE_CORRECTIVE_TASK' as const,
      actor: DIRECTOR_ACTION_ACTOR,
      actorRole: DIRECTOR_ACTION_ACTOR_ROLE,
      timestamp: new Date().toISOString(),
      payload: {
        parentTaskId: 'task-01-core-setup',
        failedTaskId: 'task-04-failed-migration',
        failureReason: 'Database migration script failed with table lock timeout',
        remediationType: 'CODE_FIX',
        correctivePlan: 'Split migration into two non-blocking schema statements',
      },
    };

    const result = validator.validate(envelope, baseContext);
    assert.equal(result.isValid, true);
    assert.equal(result.isDuplicate, false);
    assert.equal(result.envelope.actionType, 'CREATE_CORRECTIVE_TASK');
  });

  it('1.4 accepts valid REPLAN and REVIEW_EVIDENCE actions', () => {
    // REPLAN
    const replanIdem = 'idem-replan-01';
    const replanId = computeDeterministicActionId({
      projectId: validProjectId,
      directorSessionId: validSessionId,
      actionType: 'REPLAN',
      idempotencyKey: replanIdem,
    });

    const replanEnvelope = {
      protocolVersion: DIRECTOR_ACTION_PROTOCOL_VERSION,
      schemaVersion: 1,
      actionId: replanId,
      idempotencyKey: replanIdem,
      projectId: validProjectId,
      directorSessionId: validSessionId,
      basedOnContextFingerprint: validFingerprint,
      understandingRevision: validRevision,
      actionType: 'REPLAN' as const,
      actor: DIRECTOR_ACTION_ACTOR,
      actorRole: DIRECTOR_ACTION_ACTOR_ROLE,
      timestamp: new Date().toISOString(),
      payload: {
        replanReason: 'Push notification must be deferred pending third party provider account setup',
        affectedTaskIds: ['task-03-push-notification'],
        proposedModifications: [
          {
            taskId: 'task-03-push-notification',
            action: 'DEFER',
            justification: 'Waiting for provider API credentials',
          },
        ],
      },
    };

    const replanRes = validator.validate(replanEnvelope, baseContext);
    assert.equal(replanRes.isValid, true);

    // REVIEW_EVIDENCE
    const reviewIdem = 'idem-review-01';
    const reviewId = computeDeterministicActionId({
      projectId: validProjectId,
      directorSessionId: validSessionId,
      actionType: 'REVIEW_EVIDENCE',
      idempotencyKey: reviewIdem,
    });

    const reviewEnvelope = {
      protocolVersion: DIRECTOR_ACTION_PROTOCOL_VERSION,
      schemaVersion: 1,
      actionId: reviewId,
      idempotencyKey: reviewIdem,
      projectId: validProjectId,
      directorSessionId: validSessionId,
      basedOnContextFingerprint: validFingerprint,
      understandingRevision: validRevision,
      actionType: 'REVIEW_EVIDENCE' as const,
      actor: DIRECTOR_ACTION_ACTOR,
      actorRole: DIRECTOR_ACTION_ACTOR_ROLE,
      timestamp: new Date().toISOString(),
      payload: {
        taskId: 'task-01-core-setup',
        evidenceIds: ['ev-001', 'ev-002'],
        verdict: 'VERIFIED_SUCCESS',
        findings: 'Unit tests and build commands passed with zero regressions',
      },
    };

    const reviewRes = validator.validate(reviewEnvelope, baseContext);
    assert.equal(reviewRes.isValid, true);
  });

  // ==========================================================================
  // 2. ANTI-IMPERSONATION & STRICT ACTOR BOUNDARY TESTS
  // ==========================================================================

  it('2.1 rejects action when caller claims actorRole = PRODUCT_OWNER', () => {
    const idempotencyKey = 'idem-attack-01';
    const actionId = computeDeterministicActionId({
      projectId: validProjectId,
      directorSessionId: validSessionId,
      actionType: 'IMPLEMENT_TASK',
      idempotencyKey,
    });

    const envelope = {
      protocolVersion: DIRECTOR_ACTION_PROTOCOL_VERSION,
      schemaVersion: 1,
      actionId,
      idempotencyKey,
      projectId: validProjectId,
      directorSessionId: validSessionId,
      basedOnContextFingerprint: validFingerprint,
      understandingRevision: validRevision,
      actionType: 'IMPLEMENT_TASK' as const,
      actor: 'DIRECTOR',
      actorRole: 'PRODUCT_OWNER', // Impersonation attack
      timestamp: new Date().toISOString(),
      payload: {
        taskId: 'task-02-auth-service',
        executionPlan: 'Bypass authorization as PO',
      },
    };

    assert.throws(
      () => validator.validate(envelope, baseContext),
      (err: any) => {
        return (
          err instanceof DirectorActionImpersonationError ||
          err instanceof DirectorActionValidationError
        );
      }
    );
  });

  it('2.2 rejects action when actor contains SYSTEM or OWNER', () => {
    const idempotencyKey = 'idem-attack-02';
    const actionId = computeDeterministicActionId({
      projectId: validProjectId,
      directorSessionId: validSessionId,
      actionType: 'IMPLEMENT_TASK',
      idempotencyKey,
    });

    const envelope = {
      protocolVersion: DIRECTOR_ACTION_PROTOCOL_VERSION,
      schemaVersion: 1,
      actionId,
      idempotencyKey,
      projectId: validProjectId,
      directorSessionId: validSessionId,
      basedOnContextFingerprint: validFingerprint,
      understandingRevision: validRevision,
      actionType: 'IMPLEMENT_TASK' as const,
      actor: 'SYSTEM_DIRECTOR', // Disallowed actor name
      actorRole: 'DIRECTOR',
      timestamp: new Date().toISOString(),
      payload: {
        taskId: 'task-02-auth-service',
        executionPlan: 'Execute as SYSTEM',
      },
    };

    assert.throws(
      () => validator.validate(envelope, baseContext),
      (err: any) => {
        return (
          err instanceof DirectorActionImpersonationError ||
          err instanceof DirectorActionValidationError
        );
      }
    );
  });

  // ==========================================================================
  // 3. STALE CONTEXT & FINGERPRINT FAIL-CLOSED TESTS
  // ==========================================================================

  it('3.1 rejects action with stale context fingerprint', () => {
    const idempotencyKey = 'idem-stale-01';
    const actionId = computeDeterministicActionId({
      projectId: validProjectId,
      directorSessionId: validSessionId,
      actionType: 'IMPLEMENT_TASK',
      idempotencyKey,
    });

    const envelope = {
      protocolVersion: DIRECTOR_ACTION_PROTOCOL_VERSION,
      schemaVersion: 1,
      actionId,
      idempotencyKey,
      projectId: validProjectId,
      directorSessionId: validSessionId,
      basedOnContextFingerprint: 'fp-old-stale-fingerprint-000', // Stale!
      understandingRevision: validRevision,
      actionType: 'IMPLEMENT_TASK' as const,
      actor: DIRECTOR_ACTION_ACTOR,
      actorRole: DIRECTOR_ACTION_ACTOR_ROLE,
      timestamp: new Date().toISOString(),
      payload: {
        taskId: 'task-02-auth-service',
        executionPlan: 'Plan based on stale state',
      },
    };

    assert.throws(
      () => validator.validate(envelope, baseContext),
      (err: any) => {
        return err instanceof DirectorActionStaleContextError;
      }
    );
  });

  it('3.2 rejects action with stale understanding revision', () => {
    const idempotencyKey = 'idem-stale-02';
    const actionId = computeDeterministicActionId({
      projectId: validProjectId,
      directorSessionId: validSessionId,
      actionType: 'IMPLEMENT_TASK',
      idempotencyKey,
    });

    const envelope = {
      protocolVersion: DIRECTOR_ACTION_PROTOCOL_VERSION,
      schemaVersion: 1,
      actionId,
      idempotencyKey,
      projectId: validProjectId,
      directorSessionId: validSessionId,
      basedOnContextFingerprint: validFingerprint,
      understandingRevision: 1, // Current is 2 -> Stale!
      actionType: 'IMPLEMENT_TASK' as const,
      actor: DIRECTOR_ACTION_ACTOR,
      actorRole: DIRECTOR_ACTION_ACTOR_ROLE,
      timestamp: new Date().toISOString(),
      payload: {
        taskId: 'task-02-auth-service',
        executionPlan: 'Plan based on old revision',
      },
    };

    assert.throws(
      () => validator.validate(envelope, baseContext),
      (err: any) => {
        return err instanceof DirectorActionStaleContextError;
      }
    );
  });

  // ==========================================================================
  // 4. IDEMPOTENCY & CONFLICT PROTECTION TESTS
  // ==========================================================================

  it('4.1 replaying exact duplicate action returns cached duplicate outcome', () => {
    const idempotencyKey = 'idem-repeat-01';
    const actionId = computeDeterministicActionId({
      projectId: validProjectId,
      directorSessionId: validSessionId,
      actionType: 'IMPLEMENT_TASK',
      idempotencyKey,
    });

    const envelope = {
      protocolVersion: DIRECTOR_ACTION_PROTOCOL_VERSION,
      schemaVersion: 1,
      actionId,
      idempotencyKey,
      projectId: validProjectId,
      directorSessionId: validSessionId,
      basedOnContextFingerprint: validFingerprint,
      understandingRevision: validRevision,
      actionType: 'IMPLEMENT_TASK' as const,
      actor: DIRECTOR_ACTION_ACTOR,
      actorRole: DIRECTOR_ACTION_ACTOR_ROLE,
      timestamp: new Date().toISOString(),
      payload: {
        taskId: 'task-02-auth-service',
        executionPlan: 'Implement auth service',
      },
    };

    const firstResult = validator.validate(envelope, baseContext);
    assert.equal(firstResult.isValid, true);
    assert.equal(firstResult.isDuplicate, false);

    // Second call with identical payload
    const secondResult = validator.validate(envelope, baseContext);
    assert.equal(secondResult.isValid, true);
    assert.equal(secondResult.isDuplicate, true);
    assert.equal(secondResult.validatedAt, firstResult.validatedAt);
  });

  it('4.2 duplicate idempotency key with conflicting payload throws DirectorActionIdempotencyConflictError', () => {
    const idempotencyKey = 'idem-conflict-01';
    const actionId = computeDeterministicActionId({
      projectId: validProjectId,
      directorSessionId: validSessionId,
      actionType: 'IMPLEMENT_TASK',
      idempotencyKey,
    });

    const envelope1 = {
      protocolVersion: DIRECTOR_ACTION_PROTOCOL_VERSION,
      schemaVersion: 1,
      actionId,
      idempotencyKey,
      projectId: validProjectId,
      directorSessionId: validSessionId,
      basedOnContextFingerprint: validFingerprint,
      understandingRevision: validRevision,
      actionType: 'IMPLEMENT_TASK' as const,
      actor: DIRECTOR_ACTION_ACTOR,
      actorRole: DIRECTOR_ACTION_ACTOR_ROLE,
      timestamp: new Date().toISOString(),
      payload: {
        taskId: 'task-02-auth-service',
        executionPlan: 'Original execution plan A',
      },
    };

    validator.validate(envelope1, baseContext);

    // Conflicting second envelope with same idempotency key but different plan
    const envelope2 = {
      ...envelope1,
      payload: {
        taskId: 'task-02-auth-service',
        executionPlan: 'Different conflicting execution plan B',
      },
    };

    assert.throws(
      () => validator.validate(envelope2, baseContext),
      (err: any) => {
        return err instanceof DirectorActionIdempotencyConflictError;
      }
    );
  });

  // ==========================================================================
  // 5. DAG LINEAGE & DEPENDENCY VALIDATION TESTS
  // ==========================================================================

  it('5.1 rejects IMPLEMENT_TASK if target task does not exist in DAG', () => {
    const idempotencyKey = 'idem-unknown-task';
    const actionId = computeDeterministicActionId({
      projectId: validProjectId,
      directorSessionId: validSessionId,
      actionType: 'IMPLEMENT_TASK',
      idempotencyKey,
    });

    const envelope = {
      protocolVersion: DIRECTOR_ACTION_PROTOCOL_VERSION,
      schemaVersion: 1,
      actionId,
      idempotencyKey,
      projectId: validProjectId,
      directorSessionId: validSessionId,
      basedOnContextFingerprint: validFingerprint,
      understandingRevision: validRevision,
      actionType: 'IMPLEMENT_TASK' as const,
      actor: DIRECTOR_ACTION_ACTOR,
      actorRole: DIRECTOR_ACTION_ACTOR_ROLE,
      timestamp: new Date().toISOString(),
      payload: {
        taskId: 'task-non-existent-99',
        executionPlan: 'Execute unknown task',
      },
    };

    assert.throws(
      () => validator.validate(envelope, baseContext),
      (err: any) => {
        return err instanceof DirectorActionLineageError;
      }
    );
  });

  it('5.2 rejects IMPLEMENT_TASK if dependencies are not yet COMPLETED', () => {
    const idempotencyKey = 'idem-unmet-dep';
    const actionId = computeDeterministicActionId({
      projectId: validProjectId,
      directorSessionId: validSessionId,
      actionType: 'IMPLEMENT_TASK',
      idempotencyKey,
    });

    // task-03-push-notification depends on task-02-auth-service which is READY, not COMPLETED
    const envelope = {
      protocolVersion: DIRECTOR_ACTION_PROTOCOL_VERSION,
      schemaVersion: 1,
      actionId,
      idempotencyKey,
      projectId: validProjectId,
      directorSessionId: validSessionId,
      basedOnContextFingerprint: validFingerprint,
      understandingRevision: validRevision,
      actionType: 'IMPLEMENT_TASK' as const,
      actor: DIRECTOR_ACTION_ACTOR,
      actorRole: DIRECTOR_ACTION_ACTOR_ROLE,
      timestamp: new Date().toISOString(),
      payload: {
        taskId: 'task-03-push-notification',
        executionPlan: 'Execute before auth is completed',
      },
    };

    assert.throws(
      () => validator.validate(envelope, baseContext),
      (err: any) => {
        return err instanceof DirectorActionLineageError;
      }
    );
  });

  it('5.3 rejects CREATE_CORRECTIVE_TASK if failedTaskId does not exist', () => {
    const idempotencyKey = 'idem-invalid-corrective';
    const actionId = computeDeterministicActionId({
      projectId: validProjectId,
      directorSessionId: validSessionId,
      actionType: 'CREATE_CORRECTIVE_TASK',
      idempotencyKey,
    });

    const envelope = {
      protocolVersion: DIRECTOR_ACTION_PROTOCOL_VERSION,
      schemaVersion: 1,
      actionId,
      idempotencyKey,
      projectId: validProjectId,
      directorSessionId: validSessionId,
      basedOnContextFingerprint: validFingerprint,
      understandingRevision: validRevision,
      actionType: 'CREATE_CORRECTIVE_TASK' as const,
      actor: DIRECTOR_ACTION_ACTOR,
      actorRole: DIRECTOR_ACTION_ACTOR_ROLE,
      timestamp: new Date().toISOString(),
      payload: {
        parentTaskId: 'task-01-core-setup',
        failedTaskId: 'task-unknown-failure',
        failureReason: 'Unknown failure',
        remediationType: 'CODE_FIX',
        correctivePlan: 'Remediate non-existent failure',
      },
    };

    assert.throws(
      () => validator.validate(envelope, baseContext),
      (err: any) => {
        return err instanceof DirectorActionLineageError;
      }
    );
  });
});

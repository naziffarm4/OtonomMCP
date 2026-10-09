import { LifecycleState } from '../lifecycle.js';
import type { DeterministicDecisionData, RecoverySnapshot, ValidationEvidence } from './types.js';
import { RecoveryDecision, ExecutionLifecycleState } from './types.js';
import { RecoveryError } from '../errors/recovery-error.js';

export interface ValidationEvidenceCheckResult {
  applicable: boolean;
  stale: boolean;
  reason?: string;
}

/**
 * Validates the applicability and freshness of validation evidence against the current workspace state.
 * Verifies positive compilation/build status, file hashes against current disk hashes, and Git HEAD.
 */
export function checkValidationEvidenceApplicability(
  evidence: ValidationEvidence | null | undefined,
  snapshot: RecoverySnapshot
): ValidationEvidenceCheckResult {
  if (!evidence) {
    return { applicable: false, stale: false, reason: 'validation evidence is absent' };
  }

  if (evidence.isApplicable === false) {
    return {
      applicable: false,
      stale: false,
      reason: 'validation evidence is explicitly marked not applicable',
    };
  }

  if (evidence.stale === true) {
    return { applicable: false, stale: true, reason: 'validation evidence is explicitly marked stale' };
  }

  if (evidence.compilable === false || evidence.buildPassed === false) {
    return {
      applicable: false,
      stale: false,
      reason: 'validation evidence indicates build/compilation failure',
    };
  }

  if (evidence.compilable !== true && evidence.buildPassed !== true) {
    return {
      applicable: false,
      stale: false,
      reason: 'validation evidence lacks positive verification (neither compilable nor buildPassed is true)',
    };
  }

  // Freshness check 1: File hashes
  if (evidence.fileHashes && Object.keys(evidence.fileHashes).length > 0) {
    const currentHashes = snapshot.filesystemDiff?.currentHashes;
    if (currentHashes) {
      for (const [filePath, recordedHash] of Object.entries(evidence.fileHashes)) {
        const current = currentHashes[filePath];
        if (!current) {
          return {
            applicable: false,
            stale: true,
            reason: `validation evidence is stale: file '${filePath}' recorded in evidence is missing on disk`,
          };
        }
        if (current !== recordedHash) {
          return {
            applicable: false,
            stale: true,
            reason: `validation evidence is stale: hash mismatch for '${filePath}' (recorded: ${recordedHash.slice(0, 8)}, current: ${current.slice(0, 8)})`,
          };
        }
      }
    }
  }

  // Freshness check 2: Git HEAD
  if (evidence.gitHead && snapshot.gitState?.currentHead) {
    if (evidence.gitHead !== snapshot.gitState.currentHead) {
      return {
        applicable: false,
        stale: true,
        reason: `validation evidence is stale: git HEAD mismatch (recorded: ${evidence.gitHead}, current: ${snapshot.gitState.currentHead})`,
      };
    }
  }

  // Applicability check 3: Context reference
  if (evidence.contextReference && snapshot.durableState?.metadata?.contextReference) {
    if (evidence.contextReference !== snapshot.durableState.metadata.contextReference) {
      return {
        applicable: false,
        stale: false,
        reason: `validation evidence is not applicable: context reference mismatch (recorded: ${evidence.contextReference}, current: ${snapshot.durableState.metadata.contextReference})`,
      };
    }
  }

  return { applicable: true, stale: false };
}

/**
 * Deterministic decision matrix implementing ordered priority rules for recovery (P30):
 * 
 * Priority 1: State Corruption / State Integrity (corrupt state fails deterministically)
 * Priority 2: Security Violation (immediate fail-closed abort to human gate)
 * Priority 3: EXECUTION_UNKNOWN (unverified in-flight crash blocks on human gate, no blind retry)
 * Priority 4: Explicit BLOCKED_ON_HUMAN / DEC-010 (human response -> exact RESUME, awaiting -> BLOCKED_ON_HUMAN)
 * Priority 5: Workspace Corruption / Missing Files / Unexpected External Changes / Unvalidated Disk Changes (RESTART)
 * Priority 6: Known Execution Failure with Sound Workspace (RETRY if budget permits, else BLOCKED_ON_HUMAN)
 * Priority 7: Interrupted Implementation with Sound Partial Progress / DEC-011 (RESUME)
 * Priority 8: Clean Baseline / Default Milestone Progress (RESUME)
 *
 * This evaluator is a pure function: given identical snapshots, it returns strictly identical DeterministicDecisionData.
 */
export function evaluateRecoveryDecision(snapshot: RecoverySnapshot): DeterministicDecisionData {
  // --------------------------------------------------------------------------
  // Priority 1: Authoritative State Integrity
  // --------------------------------------------------------------------------
  if (!snapshot.durableState) {
    throw new RecoveryError('Cannot evaluate recovery: durable state is missing or unreadable', {
      category: 'UNREADABLE_DURABLE_STATE',
    });
  }

  const { durableState, localRuntimeState, filesystemDiff, lastEvent } = snapshot;

  // --------------------------------------------------------------------------
  // Priority 2: Security Violation
  // --------------------------------------------------------------------------
  const valEvidenceRecord = snapshot.validationEvidence as unknown as Record<string, unknown> | undefined;
  const isSecurityViolation =
    valEvidenceRecord?.securityViolation === true ||
    valEvidenceRecord?.category === 'SECURITY_VIOLATION' ||
    durableState.metadata?.securityViolation === true ||
    lastEvent?.eventType === 'SECURITY_VIOLATION_DETECTED';

  if (isSecurityViolation) {
    return {
      decision: RecoveryDecision.BLOCKED_ON_HUMAN,
      reason: 'SECURITY_VIOLATION: Security breach or unauthorized operation detected. Immediate fail-closed abort required.',
      taskId: durableState.activeTaskId,
      iteration: localRuntimeState?.activeAttempt ?? 1,
      contextReference: (durableState.metadata?.contextReference as string) ?? null,
      resumePoint: 'RESUME_EXACT_BLOCKED_POINT',
      targetCheckpoint: durableState.lastCheckpoint ?? null,
      evidenceReferences: [
        'security-violation-detected',
        ...(lastEvent ? [`events.jsonl:${lastEvent.eventId}`] : []),
      ],
      humanRequired: true,
      retryAllowed: false,
    };
  }

  // --------------------------------------------------------------------------
  // Priority 3: EXECUTION_UNKNOWN (Crash recovery without independent completion evidence)
  // --------------------------------------------------------------------------
  const validationCheck = checkValidationEvidenceApplicability(snapshot.validationEvidence, snapshot);

  const isExecutionUnknown =
    snapshot.reconciledExecutionState === ExecutionLifecycleState.EXECUTION_UNKNOWN ||
    snapshot.executionIntent?.lifecycleState === ExecutionLifecycleState.EXECUTION_UNKNOWN ||
    durableState.metadata?.executionLifecycleState === ExecutionLifecycleState.EXECUTION_UNKNOWN ||
    (snapshot.executionIntent?.lifecycleState === ExecutionLifecycleState.EXECUTING &&
      snapshot.isRuntimeStale &&
      (!snapshot.validationEvidence || !validationCheck.applicable)) ||
    (snapshot.isRuntimeStale &&
      lastEvent?.eventType === 'EXECUTION_STARTED' &&
      (!snapshot.validationEvidence || !validationCheck.applicable));

  if (isExecutionUnknown) {
    const taskId = snapshot.executionIntent?.taskId ?? durableState.activeTaskId;
    const iteration = localRuntimeState?.activeAttempt ?? 1;
    const contextReference =
      snapshot.executionIntent?.contextFingerprint ??
      (durableState.metadata?.contextReference as string) ??
      null;

    return {
      decision: RecoveryDecision.BLOCKED_ON_HUMAN,
      reason:
        'EXECUTION_UNKNOWN: In-flight execution could not be independently verified post-crash. Automatic retry is strictly prohibited to prevent duplicate side-effects. Human gate required.',
      taskId,
      iteration,
      contextReference,
      resumePoint: 'RESUME_EXACT_BLOCKED_POINT',
      targetCheckpoint: durableState.lastCheckpoint ?? null,
      evidenceReferences: [
        'execution-intent:lifecycle=EXECUTION_UNKNOWN',
        `runtime-stale=${snapshot.isRuntimeStale}`,
        ...(lastEvent ? [`events.jsonl:${lastEvent.eventId}`] : []),
      ],
      executionLifecycleState: ExecutionLifecycleState.EXECUTION_UNKNOWN,
      humanRequired: true,
      retryAllowed: false,
    };
  }

  // --------------------------------------------------------------------------
  // Priority 4: Explicit BLOCKED_ON_HUMAN (DEC-010)
  // --------------------------------------------------------------------------
  const isBlocked =
    durableState.currentLifecycleState === LifecycleState.BLOCKED_ON_HUMAN ||
    durableState.blockedState !== null;

  if (isBlocked) {
    const blocked = durableState.blockedState;
    const taskId = blocked?.blockedTaskId ?? durableState.activeTaskId ?? null;
    const iteration = blocked?.blockedIteration ?? localRuntimeState?.activeAttempt ?? 1;
    const contextReference =
      blocked?.blockedContextReference ?? (durableState.metadata?.contextReference as string) ?? null;
    const resumePoint = blocked?.resumePoint ?? 'RESUME_EXACT_BLOCKED_POINT';
    const targetCheckpoint = durableState.lastCheckpoint ?? null;

    const hasUserResponse =
      snapshot.userResponse != null || durableState.metadata?.userResponse != null;

    if (hasUserResponse) {
      // DEC-010: After human response, do not restart task selection or increment attempt.
      // Resume exact blocked point, exact task, exact iteration, exact context.
      return {
        decision: RecoveryDecision.RESUME,
        reason: 'Human response received; resuming exact blocked point without task reselection or attempt increment',
        taskId,
        iteration,
        contextReference,
        resumePoint,
        targetCheckpoint,
        evidenceReferences: [
          'durable-state.json:blocked_state',
          'user-response-received',
          ...(lastEvent ? [`events.jsonl:${lastEvent.eventId}`] : []),
        ],
        humanRequired: false,
        retryAllowed: false,
      };
    }

    return {
      decision: RecoveryDecision.BLOCKED_ON_HUMAN,
      reason: blocked?.blockingReason
        ? `BLOCKED_ON_HUMAN: ${blocked.blockingReason}`
        : 'Project is blocked on human decision; preserving exact blocked point context',
      taskId,
      iteration,
      contextReference,
      resumePoint,
      targetCheckpoint,
      evidenceReferences: [
        'durable-state.json:blocked_state',
        ...(lastEvent ? [`events.jsonl:${lastEvent.eventId}`] : []),
      ],
      humanRequired: true,
      retryAllowed: false,
    };
  }

  // --------------------------------------------------------------------------
  // Priority 5: Workspace Corruption / Missing Files / Unexpected External Changes / Unvalidated Disk Changes -> RESTART
  // --------------------------------------------------------------------------
  const isActiveTask =
    durableState.activeTaskId !== null ||
    durableState.currentLifecycleState === LifecycleState.TASK_LOOP;

  const hasCorruption =
    snapshot.isCorrupted === true ||
    filesystemDiff.corruptedFiles.length > 0 ||
    filesystemDiff.unexpectedRemoved.length > 0;

  // Unexpected external changes during active task (not attributable to interrupted implementation)
  const hasUnexpectedExternal =
    isActiveTask && filesystemDiff.unexpectedExternalChanges.length > 0;

  // Outside active task, unexpected modifications to indexed files are considered unsafe
  const hasUnsafeModification = !isActiveTask && filesystemDiff.unexpectedModified.length > 0;

  // Disk differences during active task (files modified or added on disk)
  const hasAttributableDiskChanges =
    filesystemDiff.expectedChanges.length > 0 ||
    filesystemDiff.unexpectedModified.length > 0 ||
    filesystemDiff.unexpectedAdded.length > 0;

  const hasExplicitValidationFailure =
    snapshot.validationEvidence?.compilable === false ||
    snapshot.validationEvidence?.buildPassed === false;

  // Authoritative recovery rule:
  // IF State == IMPLEMENTATION && Disk Difference Exists:
  //   -> RESUME only when workspace progress is both consistent and compilable / actually validated
  //   -> RESTART when workspace is broken, syntax-invalid, unrecoverable, or reliable continuation cannot be established.
  const hasMissingOrInvalidValidation =
    isActiveTask && hasAttributableDiskChanges && !validationCheck.applicable;

  if (
    hasCorruption ||
    hasExplicitValidationFailure ||
    hasUnexpectedExternal ||
    hasUnsafeModification ||
    hasMissingOrInvalidValidation
  ) {
    const reasons: string[] = [];
    if (snapshot.isCorrupted) {
      reasons.push('explicit corruption detected');
    }
    if (filesystemDiff.corruptedFiles.length > 0) {
      reasons.push(`corrupted/malformed files [${filesystemDiff.corruptedFiles.join(', ')}]`);
    }
    if (filesystemDiff.unexpectedRemoved.length > 0) {
      reasons.push(`missing indexed files [${filesystemDiff.unexpectedRemoved.join(', ')}]`);
    }
    if (hasUnexpectedExternal) {
      reasons.push(
        `unexpected external modifications not attributable to interrupted task [${filesystemDiff.unexpectedExternalChanges.join(', ')}]`
      );
    }
    if (filesystemDiff.unexpectedModified.length > 0) {
      reasons.push(`unexpected modified files [${filesystemDiff.unexpectedModified.join(', ')}]`);
    }
    if (hasExplicitValidationFailure) {
      reasons.push('implementation progress failed compilability/build validation');
    } else if (hasMissingOrInvalidValidation) {
      reasons.push(validationCheck.reason ?? 'implementation progress lacks positive validation evidence');
    }

    const evidenceReferences: string[] = [];
    if (filesystemDiff.unexpectedModified.length > 0) {
      evidenceReferences.push(`l0-diff:modified=${filesystemDiff.unexpectedModified.length}`);
    }
    if (filesystemDiff.unexpectedRemoved.length > 0) {
      evidenceReferences.push(`l0-diff:removed=${filesystemDiff.unexpectedRemoved.length}`);
    }
    if (filesystemDiff.corruptedFiles.length > 0) {
      evidenceReferences.push(`l0-diff:corrupted=${filesystemDiff.corruptedFiles.length}`);
    }
    if (hasUnexpectedExternal) {
      evidenceReferences.push(
        `l0-diff:unexpected-external=${filesystemDiff.unexpectedExternalChanges.length}`
      );
    }
    if (hasExplicitValidationFailure) {
      evidenceReferences.push('validation-evidence:failed');
    } else if (hasMissingOrInvalidValidation) {
      if (validationCheck.stale) {
        evidenceReferences.push('validation-evidence:stale');
      } else if (!snapshot.validationEvidence) {
        evidenceReferences.push('validation-evidence:absent');
      } else {
        evidenceReferences.push('validation-evidence:failed');
      }
    }

    return {
      decision: RecoveryDecision.RESTART,
      reason: `Workspace state is inconsistent with L0 index: ${reasons.join('; ')}`,
      taskId: durableState.activeTaskId,
      iteration: localRuntimeState?.activeAttempt ?? 1,
      contextReference: (durableState.metadata?.contextReference as string) ?? null,
      resumePoint: 'PRE_FLIGHT_CHECKPOINT',
      targetCheckpoint: durableState.lastCheckpoint ?? 'initial-checkpoint',
      evidenceReferences,
      humanRequired: false,
      retryAllowed: false,
    };
  }

  // --------------------------------------------------------------------------
  // Priority 6: Known Execution Failure with Sound Workspace -> RETRY (within budget)
  // --------------------------------------------------------------------------
  const isRetryRequested =
    durableState.metadata?.retryableFailure === true ||
    durableState.metadata?.lastVerdict === 'RETRY' ||
    snapshot.reconciledExecutionState === ExecutionLifecycleState.EXECUTION_FAILED ||
    lastEvent?.eventType === 'TASK_REJECTED' ||
    lastEvent?.eventType === 'RETRY_TRIGGERED';

  if (isRetryRequested) {
    const currentAttempt = localRuntimeState?.activeAttempt ?? (durableState.metadata?.activeAttempt as number) ?? 1;
    const maxAttempts = (durableState.metadata?.maxAttempts as number) ?? 3;
    const isExhausted = durableState.metadata?.retryExhausted === true || currentAttempt >= maxAttempts;

    if (isExhausted) {
      return {
        decision: RecoveryDecision.BLOCKED_ON_HUMAN,
        reason: `Retry budget exhausted (${currentAttempt}/${maxAttempts} attempts used) for known failure; human gate required`,
        taskId: durableState.activeTaskId,
        iteration: currentAttempt,
        contextReference: (durableState.metadata?.contextReference as string) ?? null,
        resumePoint: 'RESUME_EXACT_BLOCKED_POINT',
        targetCheckpoint: durableState.lastCheckpoint ?? null,
        evidenceReferences: [
          'retry-budget-exhausted',
          ...(lastEvent ? [`events.jsonl:${lastEvent.eventId}`] : []),
        ],
        humanRequired: true,
        retryAllowed: false,
      };
    }

    return {
      decision: RecoveryDecision.RETRY,
      reason: 'Previous execution failed under consistent workspace; retryable condition confirmed',
      taskId: durableState.activeTaskId,
      iteration: currentAttempt,
      contextReference: (durableState.metadata?.contextReference as string) ?? null,
      resumePoint: 'INSTRUCT_ANTIGRAVITY',
      targetCheckpoint: durableState.lastCheckpoint ?? null,
      evidenceReferences: [
        'metadata:retryableFailure',
        ...(lastEvent ? [`events.jsonl:${lastEvent.eventId}`] : []),
      ],
      humanRequired: false,
      retryAllowed: true,
    };
  }

  // --------------------------------------------------------------------------
  // Priority 7: Interrupted Implementation / Active Task Loop -> RESUME (DEC-011)
  // --------------------------------------------------------------------------
  if (isActiveTask) {
    let reason: string;
    const evidenceReferences: string[] = [
      `durable-state.json:state=${durableState.currentLifecycleState}`,
      `runtime-stale=${snapshot.isRuntimeStale}`,
    ];

    if (filesystemDiff.expectedChanges.length > 0) {
      reason = snapshot.isRuntimeStale
        ? `Interrupted implementation detected with valid partial progress (verified compilable) [${filesystemDiff.expectedChanges.join(', ')}]; workspace files are sound, resuming exact task`
        : `Active task implementation with valid partial progress (verified compilable) [${filesystemDiff.expectedChanges.join(', ')}]; resuming exact task`;
      evidenceReferences.push(
        'validation-evidence:verified',
        `l0-diff:expected=${filesystemDiff.expectedChanges.length}`,
        `l0-diff:modified=${filesystemDiff.unexpectedModified.length}`
      );
    } else if (snapshot.isRuntimeStale) {
      reason =
        'Interrupted execution detected with stale runtime process; workspace is consistent, resuming exact task';
    } else {
      reason = 'Active task loop with consistent workspace; continuing execution';
    }

    return {
      decision: RecoveryDecision.RESUME,
      reason,
      taskId: durableState.activeTaskId,
      iteration: localRuntimeState?.activeAttempt ?? 1,
      contextReference: (durableState.metadata?.contextReference as string) ?? null,
      resumePoint: (durableState.metadata?.resumePoint as string) ?? 'IMPLEMENTATION',
      targetCheckpoint: durableState.lastCheckpoint ?? null,
      evidenceReferences,
      humanRequired: false,
      retryAllowed: false,
    };
  }

  // --------------------------------------------------------------------------
  // Priority 8: Normal Baseline / Milestone Progress -> RESUME
  // --------------------------------------------------------------------------
  return {
    decision: RecoveryDecision.RESUME,
    reason: `Normal progression at lifecycle stage '${durableState.currentLifecycleState}'`,
    taskId: null,
    iteration: null,
    contextReference: null,
    resumePoint: durableState.currentLifecycleState,
    targetCheckpoint: durableState.lastCheckpoint ?? null,
    evidenceReferences: [`durable-state.json:state=${durableState.currentLifecycleState}`],
    humanRequired: false,
    retryAllowed: false,
  };
}


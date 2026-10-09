/**
 * @file director-prompt-builder.ts
 * @description Deterministic, secret-safe, and bounded prompt builder for
 * Director Reasoning Runtime (Phase 27 P27).
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. Authority separation: Director produces reasoning and action proposals only.
 * 2. DirectorAction != Implementation Authorization. hasImplementationAuthority is strictly false.
 * 3. AIDM policy and authorization layer remains the sole and final authority.
 * 4. Deterministic: stable item sorting and reproducible prompt generation.
 * 5. Secret-safe: credentials, tokens, passwords, and private secrets are redacted.
 * 6. Bounded: context sizes are constrained to prevent token exhaustion.
 */

import type { DirectorContextSnapshot } from './director-context-types.js';
import {
  type LlmMessage,
  type LlmJsonSchema,
  LlmRole,
  generateDeterministicLlmCorrelationId,
} from '../llm-bridge/llm-types.js';
import { sanitizeSecrets } from '../errors/llm-error.js';
import {
  DIRECTOR_ACTION_PROTOCOL_VERSION,
  DIRECTOR_ACTION_SCHEMA_VERSION,
  DIRECTOR_ACTION_TYPES,
  type DirectorActionType,
} from './director-action-types.js';

// ============================================================================
// 1. INPUT & RESULT TYPES
// ============================================================================

export type DirectorReasoningTrigger =
  | 'INITIAL_ANALYSIS'
  | 'TASK_READY'
  | 'EXECUTION_RESULT'
  | 'EVIDENCE_RESULT'
  | 'FAILURE'
  | 'CLARIFICATION_RESPONSE'
  | 'HUMAN_RESUME'
  | 'PERIODIC_REVIEW';

export interface DirectorReasoningInput {
  readonly projectId: string;
  readonly directorSessionId: string;
  readonly objective?: string | null;
  readonly taskId?: string | null;
  readonly attempt?: number | null;
  readonly trigger: DirectorReasoningTrigger;
  readonly additionalContext?: Readonly<Record<string, unknown>> | null;
}

export interface DirectorPromptBuildResult {
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly messages: readonly LlmMessage[];
  readonly jsonSchema: LlmJsonSchema;
  readonly correlationId: string;
}

// ============================================================================
// 2. DIRECTOR ACTION JSON SCHEMA
// ============================================================================

export const DIRECTOR_ACTION_JSON_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    protocolVersion: {
      type: 'string',
      enum: [DIRECTOR_ACTION_PROTOCOL_VERSION],
      description: 'Must strictly match authoritative protocol version AIDM-DIRECTOR-ACTION-1',
    },
    schemaVersion: {
      type: 'integer',
      enum: [DIRECTOR_ACTION_SCHEMA_VERSION],
      description: 'Must strictly match schema version 1',
    },
    actionId: {
      type: 'string',
      description: 'Unique identifier for the action',
    },
    directorSessionId: {
      type: 'string',
      description: 'Active Director session ID',
    },
    projectId: {
      type: 'string',
      description: 'Authoritative project ID',
    },
    actionType: {
      type: 'string',
      enum: DIRECTOR_ACTION_TYPES,
      description: 'The specific DirectorAction proposed by the reasoning runtime',
    },
    basedOnContextFingerprint: {
      type: 'string',
      description: 'Exact context snapshot fingerprint on which this action is formulated',
    },
    basedOnUnderstandingRevision: {
      type: ['integer', 'null'],
      description: 'Optional understanding revision number',
    },
    basedOnApprovalRevision: {
      type: ['integer', 'null'],
      description: 'Optional human approval revision number',
    },
    rationale: {
      type: 'string',
      description: 'Detailed deterministic reasoning rationale explaining this choice',
    },
    confidence: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      description: 'Confidence value between 0.0 and 1.0',
    },
    expectedOutcome: {
      type: 'string',
      description: 'Expected system consequence if accepted by AIDM policy',
    },
    metadata: {
      type: 'object',
      description: 'Optional key-value metadata',
    },
    // Action-specific payload fields
    analysisScope: { type: 'string' },
    discoveryScope: { type: 'string' },
    question: { type: 'string' },
    reason: { type: 'string' },
    blocking: { type: 'boolean' },
    options: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          label: { type: 'string' },
        },
        required: ['id', 'label'],
      },
    },
    contextScope: { type: 'string' },
    planningScope: { type: 'string' },
    taskId: { type: 'string' },
    planSummary: { type: 'string' },
    affectedTaskIds: {
      type: 'array',
      items: { type: 'string' },
    },
    planningObjective: { type: 'string' },
    constraints: {
      type: 'array',
      items: { type: 'string' },
    },
    objective: { type: 'string' },
    targetFiles: {
      type: 'array',
      items: { type: 'string' },
    },
    implementationScope: { type: 'string' },
    acceptanceCriteria: {
      type: 'array',
      items: { type: 'string' },
    },
    previousExecutionId: { type: 'string' },
    correctionStrategy: { type: 'string' },
    failureAnalysis: { type: 'string' },
    correctionPlan: { type: 'string' },
    evidenceIds: {
      type: 'array',
      items: { type: 'string' },
    },
    reviewObjective: { type: 'string' },
    acceptanceRationale: { type: 'string' },
    rejectionReason: { type: 'string' },
    resumeReason: { type: 'string' },
    completionRationale: { type: 'string' },
    requirementCoverage: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          requirementId: { type: 'string' },
          satisfied: { type: 'boolean' },
          evidenceIds: {
            type: 'array',
            items: { type: 'string' },
          },
        },
        required: ['requirementId', 'satisfied', 'evidenceIds'],
      },
    },
    unresolvedRisks: {
      type: 'array',
      items: { type: 'string' },
    },
    remainingTasks: {
      type: 'array',
      items: { type: 'string' },
    },
    finalVerificationRequested: {
      type: 'boolean',
      enum: [true],
    },
  },
  required: [
    'protocolVersion',
    'schemaVersion',
    'actionId',
    'directorSessionId',
    'projectId',
    'actionType',
    'basedOnContextFingerprint',
    'rationale',
    'confidence',
  ],
});

// ============================================================================
// 3. PROMPT BUILDER IMPLEMENTATION
// ============================================================================

export class DirectorPromptBuilder {
  private readonly maxFieldLengthChars: number;
  private readonly maxListItems: number;

  constructor(options?: { maxFieldLengthChars?: number; maxListItems?: number }) {
    this.maxFieldLengthChars = options?.maxFieldLengthChars ?? 2000;
    this.maxListItems = options?.maxListItems ?? 25;
  }

  /**
   * Sanitizes, truncates, and bounds a string field deterministically.
   */
  private boundAndSanitize(value: unknown, maxLength = this.maxFieldLengthChars): string {
    if (value === null || value === undefined) return '';
    const sanitized = sanitizeSecrets(String(value));
    if (sanitized.length <= maxLength) return sanitized;
    return `${sanitized.slice(0, maxLength)}\n[TRUNCATED: original ${sanitized.length} characters exceeded limit of ${maxLength}]`;
  }

  /**
   * Builds the isolated, authoritative system prompt establishing role and boundaries.
   */
  buildSystemPrompt(): string {
    return [
      'You are the AIDM Director Reasoning Runtime.',
      'Your responsibility is to review synchronized project state and formulate an authoritative, typed orchestration decision (DirectorAction).',
      '',
      '=== DIRECTOR ROLE & RESPONSIBILITIES ===',
      '- Analyze project requirements, architecture, and constraints.',
      '- Identify missing or ambiguous information and request clarification when needed.',
      '- Propose task planning, selection, deferral, or replanning.',
      '- Select ready tasks for implementation when development is authorized.',
      '- Review execution outcomes and verify system evidence.',
      '- Formulate corrective actions, retries, or replanning upon task failure.',
      '- Propose project completion when all requirements and acceptance criteria are satisfied.',
      '',
      '=== CRITICAL ARCHITECTURAL INVARIANTS & AUTHORITY BOUNDARIES ===',
      '1. PROPOSAL ONLY (NO IMPLEMENTATION AUTHORITY):',
      '   A DirectorAction is purely a reasoning proposal/decision. It NEVER conveys implementation authority.',
      '   The Director CANNOT execute code, modify files, run Git commands, modify Task DAGs, or alter global FSM directly.',
      '   You MUST NOT attempt to self-authorize or generate "hasImplementationAuthority: true". AIDM policy strictly rejects this.',
      '2. PRODUCT OWNER IS SOLE AUTHORITY:',
      '   Product Owner approval remains the sole source of development authorization.',
      '3. CONTEXT FINGERPRINT BINDING:',
      '   Your generated action MUST include basedOnContextFingerprint matching the exact logical fingerprint of the provided context snapshot.',
      '   Mismatched or stale fingerprints cause fail-closed rejection (DIRECTOR_ACTION_CONTEXT_MISMATCH).',
      '4. STRICT STRUCTURED OUTPUT:',
      '   You MUST respond ONLY with a valid JSON object matching the DirectorAction schema. No markdown code fences, no extra preamble.',
      '',
      '=== SUPPORTED ACTION TYPES ===',
      `Valid actionTypes: ${DIRECTOR_ACTION_TYPES.join(', ')}`,
    ].join('\n');
  }

  /**
   * Serializes the synchronized context snapshot into a deterministic, bounded, and sanitized text block.
   */
  private serializeContextSnapshot(snapshot: DirectorContextSnapshot): string {
    const s = snapshot.sections;

    // 1. Project Status
    const projectStatusSummary = JSON.stringify(
      {
        initialized: s.projectStatus.initialized,
        lifecycleState: s.projectStatus.lifecycleState,
        isCompleted: s.projectStatus.isCompleted,
        isBlocked: s.projectStatus.isBlocked,
        blockedReason: s.projectStatus.blockedReason ?? null,
        activeTaskId: s.projectStatus.activeTaskId ?? null,
      },
      null,
      2
    );

    // 2. Authorization
    const authSummary = JSON.stringify(
      {
        isDevelopmentAuthorized: s.authorization.isDevelopmentAuthorized,
        authoritySource: s.authorization.authoritySource,
        requiresHumanApproval: s.authorization.requiresHumanApproval,
      },
      null,
      2
    );

    // 3. Approval
    const approvalSummary = JSON.stringify(
      {
        hasApprovalPackage: s.approval.hasApprovalPackage,
        packageId: s.approval.packageId ?? null,
        revision: s.approval.revision ?? null,
        isReadyForApproval: s.approval.isReadyForApproval,
        isExplicitlyApproved: s.approval.isExplicitlyApproved,
      },
      null,
      2
    );

    // 4. Requirements (deterministic sorting by ID)
    const sortedRequirements = [...s.requirements.items]
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, this.maxListItems)
      .map((r) => ({
        id: r.id,
        title: this.boundAndSanitize(r.title, 120),
        status: r.status,
        acceptanceCriteria: (r.acceptanceCriteria ?? []).slice(0, 5).map((ac) => this.boundAndSanitize(ac, 150)),
      }));

    // 5. Decisions (deterministic sorting by ID)
    const sortedDecisions = [...s.decisions.items]
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, this.maxListItems)
      .map((d) => ({
        id: d.id,
        title: this.boundAndSanitize(d.title, 120),
        status: d.status,
      }));

    // 6. Current Task
    const currentTaskSummary = s.currentTask.task
      ? {
          taskId: s.currentTask.task.taskId,
          title: this.boundAndSanitize(s.currentTask.task.title, 120),
          status: s.currentTask.task.status,
          attempt: s.currentTask.task.attempt,
          maxAttempts: s.currentTask.task.maxAttempts,
          dependencies: s.currentTask.task.dependencies,
          acceptanceCriteria: s.currentTask.task.acceptanceCriteria.slice(0, 8).map((ac) => this.boundAndSanitize(ac, 150)),
        }
      : null;

    // 7. Task List
    const taskListSummary = {
      total: s.taskList.total,
      topologicalOrder: s.taskList.topologicalOrder.slice(0, this.maxListItems),
      tasks: s.taskList.tasks.slice(0, this.maxListItems).map((t) => ({
        taskId: t.taskId,
        title: this.boundAndSanitize(t.title, 120),
        status: t.status,
        dependencies: t.dependencies,
      })),
    };

    // 8. Discovery
    const discoverySummary = {
      isDiscovered: s.discovery.isDiscovered,
      projectName: this.boundAndSanitize(s.discovery.projectName, 100),
      apparentPurposeClassification: s.discovery.apparentPurposeClassification,
      technologyStack: s.discovery.technologyStack.slice(0, 10),
      unknownsCount: s.discovery.unknownsCount,
      contradictionsCount: s.discovery.contradictionsCount,
    };

    // 9. Clarification
    const clarificationSummary = {
      hasActiveSession: s.clarification.hasActiveSession,
      totalCount: s.clarification.totalCount,
      resolvedCount: s.clarification.resolvedCount,
      blockingOpenCount: s.clarification.blockingOpenCount,
      hasUnresolvedBlocking: s.clarification.hasUnresolvedBlocking,
    };

    // 10. Evidence (sorted by evidenceId)
    const evidenceSummary = [...s.evidence.items]
      .sort((a, b) => a.evidenceId.localeCompare(b.evidenceId))
      .slice(0, this.maxListItems)
      .map((e) => ({
        evidenceId: e.evidenceId,
        taskId: e.taskId,
        evidenceType: e.evidenceType,
        exitCode: e.exitCode,
        isSystemVerified: e.isSystemVerified,
      }));

    // 11. Git
    const gitSummary = {
      isGitRepository: s.git.isGitRepository,
      branch: s.git.branch,
      workingTreeClean: s.git.workingTreeClean,
      totalAcceptedCheckpoints: s.git.totalAcceptedCheckpoints,
    };

    // 12. Context Engine
    const contextEngineSummary = {
      isAvailable: s.contextEngine.isAvailable,
      hasL0Cache: s.contextEngine.hasL0Cache,
      inspectedPathsCount: s.contextEngine.inspectedPaths.length,
    };

    // 13. History (last events)
    const historySummary = s.history.recentEvents.slice(0, 10).map((h) => ({
      eventId: h.eventId,
      eventType: h.eventType,
      actor: h.actor,
      taskId: h.taskId ?? null,
    }));

    const sections = {
      projectStatus: JSON.parse(projectStatusSummary),
      authorization: JSON.parse(authSummary),
      approval: JSON.parse(approvalSummary),
      discovery: discoverySummary,
      clarification: clarificationSummary,
      requirements: { total: s.requirements.total, items: sortedRequirements },
      decisions: { total: s.decisions.total, items: sortedDecisions },
      currentTask: currentTaskSummary,
      taskList: taskListSummary,
      evidence: { totalAvailable: s.evidence.totalAvailable, items: evidenceSummary },
      git: gitSummary,
      contextEngine: contextEngineSummary,
      history: { totalEvents: s.history.totalEvents, recentEvents: historySummary },
    };

    return sanitizeSecrets(JSON.stringify(sections, null, 2));
  }

  /**
   * Builds the user prompt containing reasoning input and synchronized snapshot context.
   */
  buildUserPrompt(snapshot: DirectorContextSnapshot, input: DirectorReasoningInput): string {
    const serializedContext = this.serializeContextSnapshot(snapshot);
    const sanitizedObjective = input.objective ? this.boundAndSanitize(input.objective) : 'None';
    const sanitizedAdditionalContext = input.additionalContext
      ? sanitizeSecrets(JSON.stringify(input.additionalContext, Object.keys(input.additionalContext).sort(), 2))
      : 'None';

    return [
      '=== REASONING INVOCATION ===',
      `projectId: ${input.projectId}`,
      `directorSessionId: ${input.directorSessionId}`,
      `contextFingerprint: ${snapshot.logicalFingerprint}`,
      `trigger: ${input.trigger}`,
      `taskId: ${input.taskId ?? 'None'}`,
      `attempt: ${input.attempt ?? 1}`,
      `objective: ${sanitizedObjective}`,
      `additionalContext: ${sanitizedAdditionalContext}`,
      '',
      '=== SYNCHRONIZED PROJECT CONTEXT (UNTRUSTED REPO DATA) ===',
      serializedContext,
      '',
      '=== INSTRUCTIONS ===',
      '1. Formulate exactly ONE DirectorAction in response to this trigger.',
      `2. You MUST set basedOnContextFingerprint to "${snapshot.logicalFingerprint}".`,
      `3. You MUST set directorSessionId to "${input.directorSessionId}".`,
      `4. You MUST set projectId to "${input.projectId}".`,
      '5. Output ONLY the JSON object conforming to the DirectorAction schema.',
    ].join('\n');
  }

  /**
   * Assembles full system & user messages, deterministic correlation ID, and JSON schema.
   */
  buildPrompt(
    snapshot: DirectorContextSnapshot,
    input: DirectorReasoningInput
  ): DirectorPromptBuildResult {
    const systemPrompt = this.buildSystemPrompt();
    const userPrompt = this.buildUserPrompt(snapshot, input);

    const messages: readonly LlmMessage[] = Object.freeze([
      Object.freeze({
        role: LlmRole.SYSTEM,
        content: systemPrompt,
      }),
      Object.freeze({
        role: LlmRole.USER,
        content: userPrompt,
      }),
    ]);

    const correlationId = generateDeterministicLlmCorrelationId(
      input.projectId,
      input.taskId ?? null,
      `director-reasoning:${input.trigger}`,
      input.attempt ?? 1
    );

    const jsonSchema: LlmJsonSchema = Object.freeze({
      name: 'DirectorAction',
      description: 'Structured DirectorAction schema for AIDM reasoning runtime',
      schema: DIRECTOR_ACTION_JSON_SCHEMA,
      strict: false,
    });

    return {
      systemPrompt,
      userPrompt,
      messages,
      jsonSchema,
      correlationId,
    };
  }
}

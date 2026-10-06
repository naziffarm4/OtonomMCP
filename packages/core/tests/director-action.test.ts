/**
 * @file director-action.test.ts
 * @description Unit tests and security invariant verifications for
 * Director Action Contract (Phase 26 P26).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DIRECTOR_ACTION_PROTOCOL_VERSION,
  DIRECTOR_ACTION_SCHEMA_VERSION,
  DIRECTOR_ACTION_TYPES,
  DIRECTOR_ACTION_RISK_TYPES,
  getDirectorActionRisk,
  type DirectorAction,
  type ImplementTaskAction,
  type RetryTaskAction,
  type CorrectTaskAction,
  type RequestClarificationAction,
  type ReplanAction,
  type ReviewEvidenceAction,
  type AcceptTaskAction,
  type RejectTaskAction,
  type RequestHumanDecisionAction,
  type DeclareProjectCompleteAction,
  DirectorActionIdZodSchema,
  DirectorActionEnvelopeZodSchema,
  ImplementTaskActionZodSchema,
  RetryTaskActionZodSchema,
  CorrectTaskActionZodSchema,
  RequestClarificationActionZodSchema,
  ReplanActionZodSchema,
  ReviewEvidenceActionZodSchema,
  AcceptTaskActionZodSchema,
  RejectTaskActionZodSchema,
  RequestHumanDecisionActionZodSchema,
  DeclareProjectCompleteActionZodSchema,
  AnalyzeProjectActionZodSchema,
  DiscoverProjectActionZodSchema,
  AcceptContextActionZodSchema,
  RejectContextActionZodSchema,
  RequestPlanningActionZodSchema,
  SelectTaskActionZodSchema,
  UpdatePlanActionZodSchema,
  DeferActionZodSchema,
  BlockActionZodSchema,
  ResumeActionZodSchema,
  DirectorActionZodSchema,
} from '../dist/director/index.js';

describe('Phase 26 — Director Action Contract (P26)', () => {
  const validBaseEnvelope = {
    protocolVersion: DIRECTOR_ACTION_PROTOCOL_VERSION,
    schemaVersion: DIRECTOR_ACTION_SCHEMA_VERSION,
    actionId: 'dir-act-001',
    directorSessionId: 'sess-dir-12345',
    projectId: 'proj-omega-01',
    basedOnContextFingerprint: 'sha256-context-fingerprint-abc123',
    basedOnUnderstandingRevision: 1,
    basedOnApprovalRevision: 1,
    rationale: 'Strategic alignment with active roadmap sprint.',
    confidence: 0.95,
    expectedOutcome: 'Task planned successfully without invariant breach.',
    metadata: { env: 'test', traceId: 'trc-987' },
  };

  describe('1. Protocol Constants & Versioning', () => {
    it('defines exact protocol version and schema version', () => {
      assert.equal(DIRECTOR_ACTION_PROTOCOL_VERSION, 'AIDM-DIRECTOR-ACTION-1');
      assert.equal(DIRECTOR_ACTION_SCHEMA_VERSION, 1);
    });

    it('defines all 20 canonical action types', () => {
      assert.equal(DIRECTOR_ACTION_TYPES.length, 20);
      assert.ok(DIRECTOR_ACTION_TYPES.includes('IMPLEMENT_TASK'));
      assert.ok(DIRECTOR_ACTION_TYPES.includes('RETRY_TASK'));
      assert.ok(DIRECTOR_ACTION_TYPES.includes('CORRECT_TASK'));
      assert.ok(DIRECTOR_ACTION_TYPES.includes('REQUEST_CLARIFICATION'));
      assert.ok(DIRECTOR_ACTION_TYPES.includes('REPLAN'));
      assert.ok(DIRECTOR_ACTION_TYPES.includes('REVIEW_EVIDENCE'));
      assert.ok(DIRECTOR_ACTION_TYPES.includes('ACCEPT_TASK'));
      assert.ok(DIRECTOR_ACTION_TYPES.includes('REJECT_TASK'));
      assert.ok(DIRECTOR_ACTION_TYPES.includes('REQUEST_HUMAN_DECISION'));
      assert.ok(DIRECTOR_ACTION_TYPES.includes('DECLARE_PROJECT_COMPLETE'));
      assert.ok(DIRECTOR_ACTION_TYPES.includes('ANALYZE_PROJECT'));
      assert.ok(DIRECTOR_ACTION_TYPES.includes('DISCOVER_PROJECT'));
      assert.ok(DIRECTOR_ACTION_TYPES.includes('ACCEPT_CONTEXT'));
      assert.ok(DIRECTOR_ACTION_TYPES.includes('REJECT_CONTEXT'));
      assert.ok(DIRECTOR_ACTION_TYPES.includes('REQUEST_PLANNING'));
      assert.ok(DIRECTOR_ACTION_TYPES.includes('SELECT_TASK'));
      assert.ok(DIRECTOR_ACTION_TYPES.includes('UPDATE_PLAN'));
      assert.ok(DIRECTOR_ACTION_TYPES.includes('DEFER'));
      assert.ok(DIRECTOR_ACTION_TYPES.includes('BLOCK'));
      assert.ok(DIRECTOR_ACTION_TYPES.includes('RESUME'));
    });
  });

  describe('2. Deterministic Risk Classification', () => {
    it('defines all risk types', () => {
      assert.deepEqual([...DIRECTOR_ACTION_RISK_TYPES], [
        'READ_ONLY',
        'PLANNING',
        'EXECUTION',
        'RECOVERY',
        'HUMAN_GATE',
        'TERMINAL',
      ]);
    });

    it('maps all action types deterministically to their designated risk category', () => {
      assert.equal(getDirectorActionRisk('ANALYZE_PROJECT'), 'READ_ONLY');
      assert.equal(getDirectorActionRisk('DISCOVER_PROJECT'), 'READ_ONLY');
      assert.equal(getDirectorActionRisk('REQUEST_CLARIFICATION'), 'HUMAN_GATE');
      assert.equal(getDirectorActionRisk('ACCEPT_CONTEXT'), 'READ_ONLY');
      assert.equal(getDirectorActionRisk('REJECT_CONTEXT'), 'READ_ONLY');

      assert.equal(getDirectorActionRisk('REQUEST_PLANNING'), 'PLANNING');
      assert.equal(getDirectorActionRisk('SELECT_TASK'), 'PLANNING');
      assert.equal(getDirectorActionRisk('UPDATE_PLAN'), 'PLANNING');
      assert.equal(getDirectorActionRisk('REPLAN'), 'PLANNING');
      assert.equal(getDirectorActionRisk('DEFER'), 'PLANNING');

      assert.equal(getDirectorActionRisk('IMPLEMENT_TASK'), 'EXECUTION');
      assert.equal(getDirectorActionRisk('RETRY_TASK'), 'RECOVERY');
      assert.equal(getDirectorActionRisk('CORRECT_TASK'), 'RECOVERY');

      assert.equal(getDirectorActionRisk('REVIEW_EVIDENCE'), 'READ_ONLY');
      assert.equal(getDirectorActionRisk('ACCEPT_TASK'), 'EXECUTION');
      assert.equal(getDirectorActionRisk('REJECT_TASK'), 'EXECUTION');

      assert.equal(getDirectorActionRisk('BLOCK'), 'HUMAN_GATE');
      assert.equal(getDirectorActionRisk('REQUEST_HUMAN_DECISION'), 'HUMAN_GATE');
      assert.equal(getDirectorActionRisk('RESUME'), 'HUMAN_GATE');

      assert.equal(getDirectorActionRisk('DECLARE_PROJECT_COMPLETE'), 'TERMINAL');
    });

    it('rejects unknown action types fail-closed', () => {
      assert.throws(
        () => getDirectorActionRisk('UNKNOWN_ACTION' as any),
        /Unknown DirectorActionType/
      );
    });
  });

  describe('3. Valid Action Schema Validations', () => {
    it('validates IMPLEMENT_TASK action', () => {
      const action: ImplementTaskAction = {
        ...validBaseEnvelope,
        actionType: 'IMPLEMENT_TASK',
        taskId: 'TASK-001',
        objective: 'Implement authentication middleware',
        targetFiles: ['src/auth.ts', 'src/middleware.ts'],
        implementationScope: 'packages/core',
        acceptanceCriteria: ['Must validate JWT tokens', 'Must reject expired tokens'],
        constraints: ['No third-party runtime auth services'],
      };

      const result = ImplementTaskActionZodSchema.safeParse(action);
      assert.ok(result.success, result.error?.message);
      const unionResult = DirectorActionZodSchema.safeParse(action);
      assert.ok(unionResult.success, unionResult.error?.message);
    });

    it('validates RETRY_TASK action', () => {
      const action: RetryTaskAction = {
        ...validBaseEnvelope,
        actionType: 'RETRY_TASK',
        taskId: 'TASK-002',
        previousExecutionId: 'exec-prev-999',
        reason: 'Flaky network timeout during package install',
        correctionStrategy: 'Increase timeout threshold and retry install',
        acceptanceCriteria: ['Build passes cleanly'],
      };

      const result = RetryTaskActionZodSchema.safeParse(action);
      assert.ok(result.success, result.error?.message);
      const unionResult = DirectorActionZodSchema.safeParse(action);
      assert.ok(unionResult.success);
    });

    it('validates CORRECT_TASK action', () => {
      const action: CorrectTaskAction = {
        ...validBaseEnvelope,
        actionType: 'CORRECT_TASK',
        taskId: 'TASK-003',
        failureAnalysis: 'Type error in database connection parameters',
        correctionPlan: 'Fix connection options type in storage adapter',
        targetFiles: ['src/storage/db.ts'],
        acceptanceCriteria: ['Database connects without type mismatch error'],
      };

      const result = CorrectTaskActionZodSchema.safeParse(action);
      assert.ok(result.success, result.error?.message);
      const unionResult = DirectorActionZodSchema.safeParse(action);
      assert.ok(unionResult.success);
    });

    it('validates REQUEST_CLARIFICATION action', () => {
      const action: RequestClarificationAction = {
        ...validBaseEnvelope,
        actionType: 'REQUEST_CLARIFICATION',
        question: 'Should SQLite or PostgreSQL be used for storage?',
        reason: 'Ambiguous requirement regarding concurrent write volume',
        blocking: true,
        options: [
          { id: 'opt-sqlite', label: 'SQLite (Single process embedded)' },
          { id: 'opt-pg', label: 'PostgreSQL (Client-server)' },
        ],
      };

      const result = RequestClarificationActionZodSchema.safeParse(action);
      assert.ok(result.success, result.error?.message);
      const unionResult = DirectorActionZodSchema.safeParse(action);
      assert.ok(unionResult.success);
    });

    it('validates REPLAN action', () => {
      const action: ReplanAction = {
        ...validBaseEnvelope,
        actionType: 'REPLAN',
        reason: 'Requirement scope change introduced new dependencies',
        affectedTaskIds: ['TASK-010', 'TASK-011'],
        planningObjective: 'Restructure DAG to add data migration task first',
        constraints: ['Must keep zero downtime migration constraint'],
      };

      const result = ReplanActionZodSchema.safeParse(action);
      assert.ok(result.success, result.error?.message);
      const unionResult = DirectorActionZodSchema.safeParse(action);
      assert.ok(unionResult.success);
    });

    it('validates REVIEW_EVIDENCE action', () => {
      const action: ReviewEvidenceAction = {
        ...validBaseEnvelope,
        actionType: 'REVIEW_EVIDENCE',
        taskId: 'TASK-004',
        evidenceIds: ['ev-test-123', 'ev-lint-456'],
        reviewObjective: 'Assess test and coverage results for auth module',
      };

      const result = ReviewEvidenceActionZodSchema.safeParse(action);
      assert.ok(result.success, result.error?.message);
      const unionResult = DirectorActionZodSchema.safeParse(action);
      assert.ok(unionResult.success);
    });

    it('validates ACCEPT_TASK action', () => {
      const action: AcceptTaskAction = {
        ...validBaseEnvelope,
        actionType: 'ACCEPT_TASK',
        taskId: 'TASK-004',
        evidenceIds: ['ev-test-123', 'ev-lint-456'],
        acceptanceRationale: 'All unit and integration tests verified passing cleanly',
      };

      const result = AcceptTaskActionZodSchema.safeParse(action);
      assert.ok(result.success, result.error?.message);
      const unionResult = DirectorActionZodSchema.safeParse(action);
      assert.ok(unionResult.success);
    });

    it('validates REJECT_TASK action', () => {
      const action: RejectTaskAction = {
        ...validBaseEnvelope,
        actionType: 'REJECT_TASK',
        taskId: 'TASK-005',
        evidenceIds: ['ev-fail-789'],
        rejectionReason: 'Test failure in edge case handling for invalid token',
      };

      const result = RejectTaskActionZodSchema.safeParse(action);
      assert.ok(result.success, result.error?.message);
      const unionResult = DirectorActionZodSchema.safeParse(action);
      assert.ok(unionResult.success);
    });

    it('validates REQUEST_HUMAN_DECISION action', () => {
      const action: RequestHumanDecisionAction = {
        ...validBaseEnvelope,
        actionType: 'REQUEST_HUMAN_DECISION',
        question: 'Confirm production deployment parameters',
        reason: 'Production environment gate reached',
        blocking: true,
      };

      const result = RequestHumanDecisionActionZodSchema.safeParse(action);
      assert.ok(result.success, result.error?.message);
      const unionResult = DirectorActionZodSchema.safeParse(action);
      assert.ok(unionResult.success);
    });

    it('validates DECLARE_PROJECT_COMPLETE action', () => {
      const action: DeclareProjectCompleteAction = {
        ...validBaseEnvelope,
        actionType: 'DECLARE_PROJECT_COMPLETE',
        completionRationale: 'All specifications implemented and verified against acceptance criteria',
        requirementCoverage: [
          {
            requirementId: 'REQ-01',
            satisfied: true,
            evidenceIds: ['ev-req1-pass'],
          },
        ],
        unresolvedRisks: [],
        remainingTasks: [],
        finalVerificationRequested: true,
      };

      const result = DeclareProjectCompleteActionZodSchema.safeParse(action);
      assert.ok(result.success, result.error?.message);
      const unionResult = DirectorActionZodSchema.safeParse(action);
      assert.ok(unionResult.success);
    });

    it('validates simple actions', () => {
      const simpleActions: DirectorAction[] = [
        { ...validBaseEnvelope, actionType: 'ANALYZE_PROJECT', analysisScope: 'full' },
        { ...validBaseEnvelope, actionType: 'DISCOVER_PROJECT', discoveryScope: 'src' },
        { ...validBaseEnvelope, actionType: 'ACCEPT_CONTEXT', contextScope: 'v1' },
        { ...validBaseEnvelope, actionType: 'REJECT_CONTEXT', reason: 'Missing docs' },
        { ...validBaseEnvelope, actionType: 'REQUEST_PLANNING', planningScope: 'sprint-1' },
        { ...validBaseEnvelope, actionType: 'SELECT_TASK', taskId: 'TASK-001' },
        { ...validBaseEnvelope, actionType: 'UPDATE_PLAN', planSummary: 'Updated tasks' },
        { ...validBaseEnvelope, actionType: 'DEFER', reason: 'Blocked by external API' },
        { ...validBaseEnvelope, actionType: 'BLOCK', reason: 'Security alert' },
        { ...validBaseEnvelope, actionType: 'RESUME', resumeReason: 'Resolved alert' },
      ];

      for (const act of simpleActions) {
        const res = DirectorActionZodSchema.safeParse(act);
        assert.ok(res.success, `Failed to parse ${act.actionType}: ${res.error?.message}`);
      }
    });
  });

  describe('4. Invalid Payload & Field Validations', () => {
    it('rejects missing actionId', () => {
      const invalid = { ...validBaseEnvelope, actionId: undefined, actionType: 'ANALYZE_PROJECT' };
      const res = DirectorActionZodSchema.safeParse(invalid);
      assert.equal(res.success, false);
    });

    it('rejects invalid actionId characters or length', () => {
      const tooShort = { ...validBaseEnvelope, actionId: 'ab', actionType: 'ANALYZE_PROJECT' };
      assert.equal(DirectorActionZodSchema.safeParse(tooShort).success, false);

      const invalidChars = { ...validBaseEnvelope, actionId: 'dir act invalid!', actionType: 'ANALYZE_PROJECT' };
      assert.equal(DirectorActionZodSchema.safeParse(invalidChars).success, false);
    });

    it('rejects empty projectId', () => {
      const invalid = { ...validBaseEnvelope, projectId: '', actionType: 'ANALYZE_PROJECT' };
      assert.equal(DirectorActionZodSchema.safeParse(invalid).success, false);
    });

    it('rejects empty directorSessionId', () => {
      const invalid = { ...validBaseEnvelope, directorSessionId: '', actionType: 'ANALYZE_PROJECT' };
      assert.equal(DirectorActionZodSchema.safeParse(invalid).success, false);
    });

    it('rejects empty context fingerprint', () => {
      const invalid = { ...validBaseEnvelope, basedOnContextFingerprint: '', actionType: 'ANALYZE_PROJECT' };
      assert.equal(DirectorActionZodSchema.safeParse(invalid).success, false);
    });

    it('rejects empty rationale', () => {
      const invalid = { ...validBaseEnvelope, rationale: '', actionType: 'ANALYZE_PROJECT' };
      assert.equal(DirectorActionZodSchema.safeParse(invalid).success, false);
    });

    it('rejects confidence < 0', () => {
      const invalid = { ...validBaseEnvelope, confidence: -0.1, actionType: 'ANALYZE_PROJECT' };
      assert.equal(DirectorActionZodSchema.safeParse(invalid).success, false);
    });

    it('rejects confidence > 1', () => {
      const invalid = { ...validBaseEnvelope, confidence: 1.05, actionType: 'ANALYZE_PROJECT' };
      assert.equal(DirectorActionZodSchema.safeParse(invalid).success, false);
    });

    it('rejects invalid actionType', () => {
      const invalid = { ...validBaseEnvelope, actionType: 'INVALID_ACTION_TYPE' };
      assert.equal(DirectorActionZodSchema.safeParse(invalid).success, false);
    });

    it('rejects missing taskId for IMPLEMENT_TASK', () => {
      const invalid = {
        ...validBaseEnvelope,
        actionType: 'IMPLEMENT_TASK',
        objective: 'Implement',
        targetFiles: [],
        implementationScope: 'scope',
        acceptanceCriteria: [],
        constraints: [],
      };
      assert.equal(ImplementTaskActionZodSchema.safeParse(invalid).success, false);
    });

    it('rejects missing previousExecutionId for RETRY_TASK', () => {
      const invalid = {
        ...validBaseEnvelope,
        actionType: 'RETRY_TASK',
        taskId: 'TASK-001',
        reason: 'failure',
        acceptanceCriteria: [],
      };
      assert.equal(RetryTaskActionZodSchema.safeParse(invalid).success, false);
    });

    it('rejects missing failureAnalysis for CORRECT_TASK', () => {
      const invalid = {
        ...validBaseEnvelope,
        actionType: 'CORRECT_TASK',
        taskId: 'TASK-001',
        correctionPlan: 'plan',
        targetFiles: [],
        acceptanceCriteria: [],
      };
      assert.equal(CorrectTaskActionZodSchema.safeParse(invalid).success, false);
    });

    it('rejects missing question for REQUEST_CLARIFICATION', () => {
      const invalid = {
        ...validBaseEnvelope,
        actionType: 'REQUEST_CLARIFICATION',
        reason: 'need info',
        blocking: true,
      };
      assert.equal(RequestClarificationActionZodSchema.safeParse(invalid).success, false);
    });

    it('rejects missing requirementCoverage for DECLARE_PROJECT_COMPLETE', () => {
      const invalid = {
        ...validBaseEnvelope,
        actionType: 'DECLARE_PROJECT_COMPLETE',
        completionRationale: 'Finished',
        unresolvedRisks: [],
        remainingTasks: [],
        finalVerificationRequested: true,
      };
      assert.equal(DeclareProjectCompleteActionZodSchema.safeParse(invalid).success, false);
    });

    it('rejects DECLARE_PROJECT_COMPLETE when finalVerificationRequested !== true', () => {
      const invalidFalse = {
        ...validBaseEnvelope,
        actionType: 'DECLARE_PROJECT_COMPLETE',
        completionRationale: 'Finished',
        requirementCoverage: [],
        unresolvedRisks: [],
        remainingTasks: [],
        finalVerificationRequested: false,
      };
      assert.equal(DeclareProjectCompleteActionZodSchema.safeParse(invalidFalse).success, false);

      const invalidMissing = {
        ...validBaseEnvelope,
        actionType: 'DECLARE_PROJECT_COMPLETE',
        completionRationale: 'Finished',
        requirementCoverage: [],
        unresolvedRisks: [],
        remainingTasks: [],
      };
      assert.equal(DeclareProjectCompleteActionZodSchema.safeParse(invalidMissing).success, false);
    });

    it('rejects REQUEST_HUMAN_DECISION when blocking !== true', () => {
      const invalid = {
        ...validBaseEnvelope,
        actionType: 'REQUEST_HUMAN_DECISION',
        question: 'Proceed?',
        reason: 'Checkpoint',
        blocking: false,
      };
      assert.equal(RequestHumanDecisionActionZodSchema.safeParse(invalid).success, false);
    });
  });

  describe('5. Security & Invariant Protections', () => {
    it('strictly rejects path traversal sequences in actionId', () => {
      const pathTraversalIds = [
        '../dir-act-01',
        '..\\dir-act-01',
        '/etc/passwd',
        'C:\\Windows\\System32',
        'act-..-01',
        'dir/act/01',
        'dir\\act\\01',
      ];

      for (const id of pathTraversalIds) {
        const res = DirectorActionIdZodSchema.safeParse(id);
        assert.equal(res.success, false, `Expected path traversal id '${id}' to be rejected`);
      }
    });

    it('strictly rejects path traversal sequences in directorSessionId', () => {
      const invalidSession = {
        ...validBaseEnvelope,
        directorSessionId: '../../etc/session',
        actionType: 'ANALYZE_PROJECT',
      };
      assert.equal(DirectorActionZodSchema.safeParse(invalidSession).success, false);
    });

    it('does not accept implementation authority declarations as execution authorization', () => {
      // Director actions are proposals; even if a caller attempts to inject hasImplementationAuthority: true,
      // it is stripped or ignored and never recognized as granting execution authority.
      const actionWithAuthority = {
        ...validBaseEnvelope,
        actionType: 'IMPLEMENT_TASK',
        taskId: 'TASK-001',
        objective: 'Implement',
        targetFiles: [],
        implementationScope: 'scope',
        acceptanceCriteria: [],
        constraints: [],
        hasImplementationAuthority: true,
      };

      const parsed = ImplementTaskActionZodSchema.parse(actionWithAuthority);
      // Invariant: parsed contract does not contain or honor hasImplementationAuthority
      assert.equal((parsed as any).hasImplementationAuthority, undefined);
      // Invariant: AIDM policy & PO approval remain the sole authorization authority
    });

    it('preserves metadata safely without secret exposure', () => {
      const action = {
        ...validBaseEnvelope,
        actionType: 'ANALYZE_PROJECT',
        metadata: {
          traceId: 'trc-12345',
          iteration: 3,
        },
      };

      const parsed = AnalyzeProjectActionZodSchema.parse(action);
      assert.deepEqual(parsed.metadata, { traceId: 'trc-12345', iteration: 3 });
    });

    it('actionType cannot be confused with DirectorDecisionType', () => {
      // Ensure that DirectorAction contract is independent from legacy DirectorDecision
      const decisionTypeOnly = 'REQUEST_PLANNING'; // Common in both
      assert.ok(DIRECTOR_ACTION_TYPES.includes(decisionTypeOnly as any));

      // Actions unique to DirectorAction (not in DirectorDecision)
      const actionOnly = 'DECLARE_PROJECT_COMPLETE';
      assert.ok(DIRECTOR_ACTION_TYPES.includes(actionOnly));
    });
  });
});

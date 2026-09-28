/**
 * Specification Completeness Gate Types & Zod Schemas (Phase 15 TASK-P15-02)
 *
 * Defines the domain model for the Specification Completeness Gate:
 * - 4 authoritative status states: COMPLETE, INCOMPLETE, BLOCKED_ON_HUMAN, NOT_APPLICABLE
 * - 15 evaluated completeness areas
 * - Evidence-based area evaluations
 * - Blocking questions and human decisions classification
 * - Revision binding, stale-result protection, and deterministic result identity
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. Completeness Gate evaluates whether what we know is sufficient to proceed to Product Owner approval.
 * 2. Gate does NOT approve anything, create approval packages, grant authorization, or invoke executors.
 * 3. Human decision points can NEVER be silently resolved by the gate.
 * 4. Deterministic fingerprints without timestamps or random IDs.
 * 5. Binds strictly to discoveryRevision; stale results cannot authorize approval.
 * 6. Cross-project isolation: results for project A can never be used for project B.
 */

import { z } from 'zod';
import { Actor } from '../actors.js';
import {
  DiscoveryQuestionZodSchema,
  HumanDecisionPointZodSchema,
  type DiscoveryQuestion,
  type HumanDecisionPoint,
} from './adaptive-discovery-types.js';

// ============================================================================
// 1. COMPLETENESS STATUSES
// ============================================================================

export const COMPLETENESS_STATUSES = [
  'COMPLETE',
  'INCOMPLETE',
  'BLOCKED_ON_HUMAN',
  'NOT_APPLICABLE',
] as const;

export type CompletenessStatus = (typeof COMPLETENESS_STATUSES)[number];

// ============================================================================
// 2. COMPLETENESS AREAS (15 Material Areas)
// ============================================================================

export const COMPLETENESS_AREAS = [
  'PROJECT_PURPOSE',
  'TARGET_USERS',
  'PRODUCT_SCOPE',
  'FUNCTIONAL_REQUIREMENTS',
  'BUSINESS_RULES',
  'NON_FUNCTIONAL_REQUIREMENTS',
  'TECHNOLOGY_CONSTRAINTS',
  'ARCHITECTURE_REQUIREMENTS',
  'DATA_PERSISTENCE',
  'EXTERNAL_INTEGRATIONS',
  'SECURITY_REQUIREMENTS',
  'ACCEPTANCE_CRITERIA',
  'DEPLOYMENT_OPERATIONAL',
  'RISKS_DEPENDENCIES',
  'HUMAN_DECISION_POINTS',
] as const;

export type CompletenessArea = (typeof COMPLETENESS_AREAS)[number];

// ============================================================================
// 3. EVIDENCE-BASED AREA EVALUATION RECORD
// ============================================================================

export const EvaluatedAreaResultZodSchema = z.object({
  area: z.enum(COMPLETENESS_AREAS),
  status: z.enum(COMPLETENESS_STATUSES),
  evidence: z.array(z.string()).min(1, 'Evidence is required for auditability'),
  missingInformation: z.array(z.string()).default([]),
  blockingQuestions: z.array(DiscoveryQuestionZodSchema).default([]),
  humanDecisions: z.array(HumanDecisionPointZodSchema).default([]),
  severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
});

export type EvaluatedAreaResult = z.infer<typeof EvaluatedAreaResultZodSchema>;

// ============================================================================
// 4. BLOCKING HUMAN DECISION RECORD
// ============================================================================

export const BlockingHumanDecisionZodSchema = z.object({
  decisionId: z.string().min(1, 'decisionId cannot be empty'),
  question: z.string().min(1, 'question cannot be empty'),
  whyItMatters: z.string().min(1, 'whyItMatters cannot be empty'),
  affectedSpecificationAreas: z.array(z.string()),
  availableOptions: z.array(z.string()).default([]),
  consequenceOfEachOption: z.record(z.string(), z.string()).optional(),
  authority: z.literal(Actor.USER).default(Actor.USER),
  status: z.literal('PENDING_DECISION').default('PENDING_DECISION'),
});

export type BlockingHumanDecision = z.infer<typeof BlockingHumanDecisionZodSchema>;

// ============================================================================
// 5. COMPLETENESS GATE RESULT
// ============================================================================

export const CompletenessGateResultZodSchema = z.object({
  projectId: z.string().min(1, 'projectId cannot be empty'),
  discoveryRevision: z.number().int().positive('discoveryRevision must be a positive integer'),
  discoveryFingerprint: z.string().min(1, 'discoveryFingerprint cannot be empty'),
  status: z.enum(COMPLETENESS_STATUSES),
  isEligibleForApproval: z.boolean(),
  isStale: z.boolean().default(false),
  evaluatedAreas: z.array(EvaluatedAreaResultZodSchema),
  blockingIssues: z.array(z.string()).default([]),
  missingInformation: z.array(z.string()).default([]),
  humanDecisions: z.array(BlockingHumanDecisionZodSchema).default([]),
  blockingQuestions: z.array(DiscoveryQuestionZodSchema).default([]),
  nonBlockingQuestions: z.array(DiscoveryQuestionZodSchema).default([]),
  evaluatedAt: z.string().min(1, 'evaluatedAt cannot be empty'),
  fingerprint: z.string().min(1, 'fingerprint cannot be empty'),
});

export type CompletenessGateResult = z.infer<typeof CompletenessGateResultZodSchema>;

// ============================================================================
// 6. INPUT CONTRACT
// ============================================================================

export const CompletenessGateInputZodSchema = z.object({
  projectId: z.string().min(1, 'projectId cannot be empty'),
  discoveryRevision: z.number().int().positive('discoveryRevision must be a positive integer').optional(),
  workspaceRoot: z.string().optional(),
  forceReevaluate: z.boolean().optional(),
});

export type CompletenessGateInput = z.infer<typeof CompletenessGateInputZodSchema>;

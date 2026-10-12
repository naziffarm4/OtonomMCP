/**
 * @file director-decision-output.ts
 * @description LLM-facing Director decision contract and deterministic envelope binding.
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. The LLM produces ONLY decision fields (actionType, rationale, confidence, payload).
 * 2. System-owned envelope fields (protocolVersion, schemaVersion, actionId, directorSessionId,
 *    projectId, basedOnContextFingerprint) are filled deterministically by code and are never
 *    required of, or trusted from, the LLM.
 * 3. Anti-spoofing: if the LLM nevertheless supplies a projectId, directorSessionId or
 *    basedOnContextFingerprint that differs from the authoritative system value, the output is
 *    rejected fail-closed (the caller maps this to the existing mismatch errors). Matching values
 *    are accepted (backward compatible with clients that echo the envelope).
 * 4. Authority fields (hasImplementationAuthority, authContext, approvals, ...) are always stripped.
 *    LLM output is a proposal, never authority and never evidence.
 */

import crypto from 'node:crypto';
import {
  DIRECTOR_ACTION_PROTOCOL_VERSION,
  DIRECTOR_ACTION_SCHEMA_VERSION,
  DIRECTOR_ACTION_TYPES,
} from './director-action-types.js';

// ============================================================================
// 1. DECISION-ONLY JSON SCHEMA (OpenAI strict structured-output compatible)
// ============================================================================

const S = { type: ['string', 'null'] } as const;
const B = { type: ['boolean', 'null'] } as const;
const SA = { type: ['array', 'null'], items: { type: 'string' } } as const;

const PAYLOAD_PROPERTIES: Record<string, unknown> = {
  taskId: S,
  objective: S,
  implementationScope: S,
  targetFiles: SA,
  acceptanceCriteria: SA,
  constraints: SA,
  question: S,
  reason: S,
  blocking: B,
  options: {
    type: ['array', 'null'],
    items: {
      type: 'object',
      properties: { id: { type: 'string' }, label: { type: 'string' } },
      required: ['id', 'label'],
      additionalProperties: false,
    },
  },
  decisionTopic: S,
  recommendation: S,
  analysisScope: S,
  discoveryScope: S,
  contextScope: S,
  planningScope: S,
  planSummary: S,
  affectedTaskIds: SA,
  planningObjective: S,
  previousExecutionId: S,
  correctionStrategy: S,
  failureAnalysis: S,
  correctionPlan: S,
  evidenceIds: SA,
  reviewObjective: S,
  acceptanceRationale: S,
  rejectionReason: S,
  resumeReason: S,
  completionRationale: S,
  requirementCoverage: {
    type: ['array', 'null'],
    items: {
      type: 'object',
      properties: {
        requirementId: { type: 'string' },
        satisfied: { type: 'boolean' },
        evidenceIds: { type: 'array', items: { type: 'string' } },
      },
      required: ['requirementId', 'satisfied', 'evidenceIds'],
      additionalProperties: false,
    },
  },
  unresolvedRisks: SA,
  remainingTasks: SA,
  finalVerificationRequested: B,
  assumptions: SA,
};

/** Array payload fields: an explicit null from the LLM means "empty list". */
const ARRAY_FIELDS = new Set(
  Object.entries(PAYLOAD_PROPERTIES)
    .filter(([, v]) => Array.isArray((v as { type: unknown }).type) && ((v as { type: string[] }).type).includes('array'))
    .map(([k]) => k)
);

export const DIRECTOR_DECISION_JSON_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    actionType: {
      type: 'string',
      enum: [...DIRECTOR_ACTION_TYPES],
      description: 'The single DirectorAction type you propose.',
    },
    rationale: { type: 'string', description: 'Why this action is the right next step.' },
    confidence: { type: 'number', description: 'Confidence between 0.0 and 1.0.' },
    expectedOutcome: S,
    ...PAYLOAD_PROPERTIES,
  },
  required: ['actionType', 'rationale', 'confidence', 'expectedOutcome', ...Object.keys(PAYLOAD_PROPERTIES)],
  additionalProperties: false,
});

/** Envelope fields owned by the system. */
export const SYSTEM_OWNED_ENVELOPE_FIELDS = Object.freeze([
  'protocolVersion',
  'schemaVersion',
  'actionId',
  'directorSessionId',
  'projectId',
  'basedOnContextFingerprint',
] as const);

/** Fields the LLM may never set (authority / evidence spoofing). */
const AUTHORITY_FIELDS = Object.freeze([
  'hasImplementationAuthority',
  'authContext',
  'authorization',
  'approval',
  'approvals',
  'approvedBy',
  'actor',
  'isTrustedHumanAuth',
  'systemEvidence',
  'evidence',
  'verified',
  'createdAt',
  'timestamp',
]);

export const DIRECTOR_DECISION_PROMPT_SPEC = [
  '=== RESPONSE FORMAT (STRICT) ===',
  'Respond with exactly ONE JSON object and nothing else (no markdown fences, no prose).',
  'You produce ONLY the decision. The system fills protocolVersion, schemaVersion, actionId, projectId,',
  'directorSessionId and basedOnContextFingerprint itself; do not invent or change them.',
  'Required keys: actionType (string, one of the supported action types), rationale (non-empty string),',
  'confidence (number 0..1). Every other key in the schema must be present; use null when not applicable.',
  'Per actionType, these fields MUST be non-null:',
  '- IMPLEMENT_TASK: taskId, objective (precise instructions for the executor), implementationScope,',
  '  targetFiles (project-relative paths), acceptanceCriteria (array), constraints (array, may be empty).',
  '- RETRY_TASK: taskId, previousExecutionId, reason, acceptanceCriteria.',
  '- CORRECT_TASK: taskId, failureAnalysis, correctionPlan, targetFiles, acceptanceCriteria.',
  '- REQUEST_CLARIFICATION: question, reason, blocking (boolean).',
  '- REQUEST_HUMAN_DECISION: question, reason, blocking=true.',
  '- REPLAN: reason, affectedTaskIds, planningObjective, constraints.',
  '- REVIEW_EVIDENCE: evidenceIds, reviewObjective. ACCEPT_TASK: taskId, evidenceIds, acceptanceRationale.',
  '- REJECT_TASK: taskId, evidenceIds, rejectionReason.',
  '- DECLARE_PROJECT_COMPLETE: requirementCoverage, finalVerificationRequested=true.',
  'Optional: assumptions (array of strings) for any assumption you made on ambiguous input.',
  'Example: {"actionType":"IMPLEMENT_TASK","rationale":"...","confidence":0.8,"expectedOutcome":"...",',
  '"taskId":"TASK-001","objective":"Create src/add.js exporting add(a,b) ...","implementationScope":"src/add.js",',
  '"targetFiles":["src/add.js"],"acceptanceCriteria":["add(2,3) === 5"],"constraints":[],"assumptions":[], ...all other keys null}',
].join('\n');

// ============================================================================
// 2. ENVELOPE BINDING
// ============================================================================

export interface DecisionBindingContext {
  readonly projectId: string;
  readonly directorSessionId: string;
  readonly contextFingerprint: string;
}

export type DecisionSpoofField = 'projectId' | 'directorSessionId' | 'basedOnContextFingerprint';

export class DecisionEnvelopeSpoofError extends Error {
  readonly field: DecisionSpoofField;
  readonly expected: string;
  readonly actual: unknown;
  constructor(field: DecisionSpoofField, expected: string, actual: unknown) {
    super(`LLM-supplied ${field} '${String(actual)}' conflicts with authoritative value '${expected}'.`);
    this.name = 'DecisionEnvelopeSpoofError';
    this.field = field;
    this.expected = expected;
    this.actual = actual;
  }
}

export function generateSystemActionId(): string {
  return `dact-${crypto.randomUUID()}`;
}

/**
 * Converts raw LLM output (decision fields, possibly with nulls and echoed envelope fields)
 * into a DirectorAction candidate whose envelope is filled by the system.
 * Throws DecisionEnvelopeSpoofError on a conflicting identity/fingerprint field.
 */
export function bindDecisionToEnvelope(raw: unknown, ctx: DecisionBindingContext): Record<string, unknown> | unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const src = raw as Record<string, unknown>;

  const identity: Array<[DecisionSpoofField, string]> = [
    ['projectId', ctx.projectId],
    ['directorSessionId', ctx.directorSessionId],
    ['basedOnContextFingerprint', ctx.contextFingerprint],
  ];
  for (const [field, expected] of identity) {
    const v = src[field];
    if (v !== undefined && v !== null && v !== '' && v !== expected) {
      throw new DecisionEnvelopeSpoofError(field, expected, v);
    }
  }

  const out: Record<string, unknown> = {};
  const assumptions: string[] = [];
  for (const [key, value] of Object.entries(src)) {
    if ((SYSTEM_OWNED_ENVELOPE_FIELDS as readonly string[]).includes(key)) continue;
    if (AUTHORITY_FIELDS.includes(key)) continue;
    if (key === 'assumptions') {
      if (Array.isArray(value)) for (const a of value) if (typeof a === 'string' && a.trim()) assumptions.push(a.trim());
      continue;
    }
    if (key === 'metadata') continue; // system-owned below
    if (value === null || value === undefined) {
      if (ARRAY_FIELDS.has(key)) out[key] = [];
      continue;
    }
    out[key] = value;
  }

  const metadata: Record<string, unknown> = {};
  if (src.metadata && typeof src.metadata === 'object' && !Array.isArray(src.metadata)) {
    for (const [k, v] of Object.entries(src.metadata as Record<string, unknown>)) {
      if (!AUTHORITY_FIELDS.includes(k) && !k.startsWith('__aidm')) metadata[k] = v;
    }
  }
  if (assumptions.length) metadata.assumptions = assumptions;
  // The LLM's own actionId (if any) is kept for audit only; the authoritative id is system-generated
  // so an LLM can never collide with / replay another action's idempotency identity.
  if (typeof src.actionId === 'string' && src.actionId.trim()) metadata.llmProposedActionId = src.actionId.slice(0, 128);
  metadata.envelopeSource = 'SYSTEM';

  return {
    ...out,
    protocolVersion: DIRECTOR_ACTION_PROTOCOL_VERSION,
    schemaVersion: DIRECTOR_ACTION_SCHEMA_VERSION,
    actionId: generateSystemActionId(),
    projectId: ctx.projectId,
    directorSessionId: ctx.directorSessionId,
    basedOnContextFingerprint: ctx.contextFingerprint,
    metadata,
  };
}

/** Human/LLM readable list of validation issues for repair prompts. */
export function formatValidationIssues(issues: ReadonlyArray<{ path?: ReadonlyArray<PropertyKey>; message: string }>): string {
  return issues
    .slice(0, 10)
    .map((i) => `- ${(i.path ?? []).map(String).join('.') || '(root)'}: ${i.message}`)
    .join('\n');
}

/**
 * Acceptance Criteria Persistence Store (Phase 15 TASK-P15-06)
 *
 * Implements atomic, schema-validated, revision-bound persistence for acceptance
 * criteria artifacts under `.ai-manager/project-acceptance-criteria/`.
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. Atomic writes conforming to AIDM storage standards (atomicWriteJson).
 * 2. Immutable revision history: rev-<revision>.json is NEVER overwritten with different content once persisted.
 * 3. Enforces strict cross-project isolation (projectId mismatch fails closed).
 * 4. Strictly protects against path traversal in projectId and revision.
 * 5. Logs append-only audit events via HistoryManager without secrets.
 * 6. Does NOT create second generic persistence framework.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { atomicWriteJson, readJsonFile } from '../storage/atomic-writer.js';
import type { HistoryManager } from '../storage/history-manager.js';
import { Actor } from '../actors.js';
import {
  ProjectAcceptanceCriteriaRevisionZodSchema,
  computeAcceptanceCriteriaFingerprint,
  type ProjectAcceptanceCriteriaRevision,
} from './acceptance-criteria-types.js';
import {
  AcceptanceCriteriaValidationError,
  AcceptanceCriteriaProjectBindingMismatchError,
  AcceptanceCriteriaImmutableRevisionError,
  AcceptanceCriteriaForgedFingerprintError,
} from './acceptance-criteria-errors.js';

export interface AcceptanceCriteriaStoreOptions {
  acceptanceCriteriaDir?: string;
  baseDir?: string;
  historyManager?: HistoryManager;
}

export class AcceptanceCriteriaStore {
  readonly acceptanceCriteriaDir: string;
  readonly recordsDir: string;
  private readonly historyManager?: HistoryManager;

  constructor(options?: AcceptanceCriteriaStoreOptions) {
    if (options?.acceptanceCriteriaDir) {
      this.acceptanceCriteriaDir = options.acceptanceCriteriaDir;
    } else {
      const baseDir = options?.baseDir ?? process.cwd();
      this.acceptanceCriteriaDir = path.join(baseDir, '.ai-manager', 'project-acceptance-criteria');
    }
    this.recordsDir = path.join(this.acceptanceCriteriaDir, 'records');
    this.historyManager = options?.historyManager;
  }

  /**
   * Sanitizes and verifies that projectId contains no path traversal sequences.
   */
  sanitizeProjectId(projectId: string): string {
    if (!projectId || typeof projectId !== 'string') {
      throw new AcceptanceCriteriaValidationError('projectId cannot be empty.', {
        code: 'MISSING_PROJECT_ID',
      });
    }
    const trimmed = projectId.trim();
    const safeRegex = /^[a-zA-Z0-9_\-\.@\/]+$/;
    if (
      !safeRegex.test(trimmed) ||
      trimmed.includes('..') ||
      trimmed.startsWith('/') ||
      trimmed.startsWith('\\')
    ) {
      throw new AcceptanceCriteriaValidationError(
        `Invalid projectId '${projectId}': contains illegal characters or path traversal.`,
        { code: 'INVALID_PROJECT_ID' }
      );
    }
    return trimmed.replace(/\//g, '__');
  }

  /**
   * Atomically saves a ProjectAcceptanceCriteriaRevision to disk.
   * Enforces immutability: if rev-<revision>.json already exists, it is rejected unless identical.
   */
  async saveRevision(revision: ProjectAcceptanceCriteriaRevision): Promise<void> {
    const parseResult = ProjectAcceptanceCriteriaRevisionZodSchema.safeParse(revision);
    if (!parseResult.success) {
      throw new AcceptanceCriteriaValidationError(
        `Failed to persist acceptance criteria revision: schema validation error: ${parseResult.error.message}`,
        { issues: parseResult.error.issues }
      );
    }

    // Validate that all criterion IDs match safe deterministic format and have consistent traceability
    const criterionIdRegex = /^AC-[A-Za-z0-9_\-]+$/;
    for (const criterion of revision.criteria) {
      if (!criterionIdRegex.test(criterion.criterionId)) {
        throw new AcceptanceCriteriaValidationError(
          `Invalid criterionId '${criterion.criterionId}': must follow format 'AC-<IDENTIFIER>'.`,
          { criterionId: criterion.criterionId }
        );
      }

      const reqSorted = [...criterion.sourceRequirements].sort();
      const traceReqSorted = [...criterion.traceability.requirementIds].sort();
      if (
        reqSorted.length !== traceReqSorted.length ||
        reqSorted.some((v, i) => v !== traceReqSorted[i])
      ) {
        throw new AcceptanceCriteriaValidationError(
          `Traceability mismatch in criterion '${criterion.criterionId}': sourceRequirements does not match traceability.requirementIds.`,
          { criterionId: criterion.criterionId }
        );
      }

      const brSorted = [...criterion.sourceBusinessRules].sort();
      const traceBrSorted = [...criterion.traceability.businessRuleIds].sort();
      if (
        brSorted.length !== traceBrSorted.length ||
        brSorted.some((v, i) => v !== traceBrSorted[i])
      ) {
        throw new AcceptanceCriteriaValidationError(
          `Traceability mismatch in criterion '${criterion.criterionId}': sourceBusinessRules does not match traceability.businessRuleIds.`,
          { criterionId: criterion.criterionId }
        );
      }

      const archSorted = [...criterion.sourceArchitectureDecisions].sort();
      const traceArchSorted = [...criterion.traceability.architectureDecisionIds].sort();
      if (
        archSorted.length !== traceArchSorted.length ||
        archSorted.some((v, i) => v !== traceArchSorted[i])
      ) {
        throw new AcceptanceCriteriaValidationError(
          `Traceability mismatch in criterion '${criterion.criterionId}': sourceArchitectureDecisions does not match traceability.architectureDecisionIds.`,
          { criterionId: criterion.criterionId }
        );
      }

      if (criterion.criterionId !== criterion.traceability.criterionId) {
        throw new AcceptanceCriteriaValidationError(
          `Traceability mismatch in criterion '${criterion.criterionId}': criterionId does not match traceability.criterionId.`,
          { criterionId: criterion.criterionId }
        );
      }
    }

    // Validate canonical fingerprint of revision before persisting
    const canonicalFingerprint = computeAcceptanceCriteriaFingerprint(revision);
    if (revision.fingerprint !== canonicalFingerprint) {
      throw new AcceptanceCriteriaForgedFingerprintError(
        `Fingerprint mismatch for acceptance criteria revision ${revision.acceptanceCriteriaRevision}: declared '${revision.fingerprint}' but recomputed canonical fingerprint is '${canonicalFingerprint}'.`,
        { declaredFingerprint: revision.fingerprint, canonicalFingerprint }
      );
    }

    const safeProjectId = this.sanitizeProjectId(revision.projectId);
    const projectDir = path.join(this.recordsDir, safeProjectId);
    const revisionFilePath = path.join(projectDir, `rev-${revision.acceptanceCriteriaRevision}.json`);
    const latestFilePath = path.join(projectDir, 'latest.json');

    // Immutability check: compare authoritative canonical content and fingerprint
    if (fs.existsSync(revisionFilePath)) {
      const existing = await readJsonFile<ProjectAcceptanceCriteriaRevision>(revisionFilePath);
      if (existing) {
        const existingParse = ProjectAcceptanceCriteriaRevisionZodSchema.safeParse(existing);
        if (!existingParse.success) {
          throw new AcceptanceCriteriaImmutableRevisionError(
            `Existing acceptance criteria revision ${revision.acceptanceCriteriaRevision} is corrupted on disk.`,
            { issues: existingParse.error.issues }
          );
        }
        const existingCanonicalFingerprint = computeAcceptanceCriteriaFingerprint(existing);
        if (
          existing.fingerprint !== revision.fingerprint ||
          existingCanonicalFingerprint !== canonicalFingerprint
        ) {
          throw new AcceptanceCriteriaImmutableRevisionError(
            `Acceptance criteria revision ${revision.acceptanceCriteriaRevision} for project '${revision.projectId}' is immutable and already exists with different canonical content.`,
            {
              projectId: revision.projectId,
              revision: revision.acceptanceCriteriaRevision,
              existingFingerprint: existing.fingerprint,
              newFingerprint: revision.fingerprint,
              existingCanonicalFingerprint,
              newCanonicalFingerprint: canonicalFingerprint,
            }
          );
        }
        // Exact idempotent replay: already persisted with identical canonical content
        return;
      }
    }

    // 1. Write revision-bound file: records/<projectId>/rev-<acceptanceCriteriaRevision>.json
    await atomicWriteJson(revisionFilePath, revision);

    // 2. Write latest pointer: records/<projectId>/latest.json
    await atomicWriteJson(latestFilePath, revision);

    // 3. Append audit event to History stream if available
    if (this.historyManager) {
      try {
        await this.historyManager.appendEvent({
          eventType: 'PROJECT_ACCEPTANCE_CRITERIA_DEFINED',
          actor: Actor.DIRECTOR,
          payload: {
            projectId: revision.projectId,
            acceptanceCriteriaRevision: revision.acceptanceCriteriaRevision,
            sourceRequirementsRevision: revision.sourceRequirementsRevision,
            sourceArchitectureRevision: revision.sourceArchitectureRevision,
            sourceBusinessRulesRevision: revision.sourceBusinessRulesRevision,
            sourceDiscoveryRevision: revision.sourceDiscoveryRevision,
            fingerprint: revision.fingerprint,
            criteriaCount: revision.criteria.length,
            coveredRequirementCount: revision.coverage.coveredRequirements.length,
            uncoveredRequirementCount: revision.coverage.uncoveredRequirements.length,
            coveredBusinessRuleCount: revision.coverage.coveredBusinessRules.length,
            pendingDecisionCount: revision.coverage.pendingDecisionCount,
            actor: Actor.DIRECTOR,
            timestamp: new Date().toISOString(),
          },
        });
      } catch {
        // Logging failure does not break persistence
      }
    }
  }

  /**
   * Loads a ProjectAcceptanceCriteriaRevision from disk by projectId and optional revision number.
   * If revision is omitted, loads latest revision.
   * Every persisted Acceptance Criteria revision is independently validated when loaded.
   */
  async loadRevision(
    projectId: string,
    revision?: number
  ): Promise<ProjectAcceptanceCriteriaRevision | null> {
    const safeProjectId = this.sanitizeProjectId(projectId);
    const projectDir = path.join(this.recordsDir, safeProjectId);

    let targetPath: string;
    if (revision !== undefined) {
      if (!Number.isInteger(revision) || revision < 1) {
        throw new AcceptanceCriteriaValidationError(
          `Invalid acceptance criteria revision '${revision}': must be a positive integer.`,
          { code: 'INVALID_REVISION' }
        );
      }
      targetPath = path.join(projectDir, `rev-${revision}.json`);
    } else {
      targetPath = path.join(projectDir, 'latest.json');
    }

    const raw = await readJsonFile<ProjectAcceptanceCriteriaRevision>(targetPath);
    if (!raw) {
      return null;
    }

    // 1. Validate complete schema
    const parseResult = ProjectAcceptanceCriteriaRevisionZodSchema.safeParse(raw);
    if (!parseResult.success) {
      throw new AcceptanceCriteriaValidationError(
        `Corrupted persisted acceptance criteria revision: schema validation failed: ${parseResult.error.message}`,
        { issues: parseResult.error.issues }
      );
    }
    const validated = parseResult.data;

    // 2. Validate project binding
    if (validated.projectId !== projectId) {
      throw new AcceptanceCriteriaProjectBindingMismatchError(
        `Cross-project mismatch: requested '${projectId}' but acceptance criteria record belongs to '${validated.projectId}'.`,
        { requestedProjectId: projectId, recordProjectId: validated.projectId }
      );
    }

    // 3. Validate revision number
    if (revision !== undefined && validated.acceptanceCriteriaRevision !== revision) {
      throw new AcceptanceCriteriaValidationError(
        `Revision mismatch: requested revision ${revision} but loaded artifact contains revision ${validated.acceptanceCriteriaRevision}.`,
        { requestedRevision: revision, recordRevision: validated.acceptanceCriteriaRevision }
      );
    }

    // 4. Validate source revision/fingerprint bindings
    if (
      !validated.sourceRequirementsRevision ||
      validated.sourceRequirementsRevision < 1 ||
      !validated.sourceRequirementsFingerprint ||
      !validated.sourceArchitectureRevision ||
      validated.sourceArchitectureRevision < 1 ||
      !validated.sourceArchitectureFingerprint ||
      !validated.sourceBusinessRulesRevision ||
      validated.sourceBusinessRulesRevision < 1 ||
      !validated.sourceBusinessRulesFingerprint ||
      !validated.sourceDiscoveryRevision ||
      validated.sourceDiscoveryRevision < 1 ||
      !validated.sourceDiscoveryFingerprint
    ) {
      throw new AcceptanceCriteriaValidationError(
        `Invalid source revision or fingerprint bindings in persisted acceptance criteria record.`,
        { projectId, revision: validated.acceptanceCriteriaRevision }
      );
    }

    // 5. Validate criterion structure and IDs
    const criterionIdRegex = /^AC-[A-Za-z0-9_\-]+$/;
    for (const criterion of validated.criteria) {
      if (
        !criterionIdRegex.test(criterion.criterionId) ||
        criterion.criterionId.includes('..') ||
        criterion.criterionId.includes('/') ||
        criterion.criterionId.includes('\\')
      ) {
        throw new AcceptanceCriteriaValidationError(
          `Invalid criterionId '${criterion.criterionId}' in persisted record: illegal characters or path traversal.`,
          { criterionId: criterion.criterionId }
        );
      }

      // Validate internal traceability consistency
      const reqSorted = [...criterion.sourceRequirements].sort();
      const traceReqSorted = [...criterion.traceability.requirementIds].sort();
      if (
        reqSorted.length !== traceReqSorted.length ||
        reqSorted.some((v, i) => v !== traceReqSorted[i])
      ) {
        throw new AcceptanceCriteriaValidationError(
          `Traceability mismatch in persisted criterion '${criterion.criterionId}': sourceRequirements does not match traceability.requirementIds.`,
          { criterionId: criterion.criterionId }
        );
      }

      const brSorted = [...criterion.sourceBusinessRules].sort();
      const traceBrSorted = [...criterion.traceability.businessRuleIds].sort();
      if (
        brSorted.length !== traceBrSorted.length ||
        brSorted.some((v, i) => v !== traceBrSorted[i])
      ) {
        throw new AcceptanceCriteriaValidationError(
          `Traceability mismatch in persisted criterion '${criterion.criterionId}': sourceBusinessRules does not match traceability.businessRuleIds.`,
          { criterionId: criterion.criterionId }
        );
      }

      const archSorted = [...criterion.sourceArchitectureDecisions].sort();
      const traceArchSorted = [...criterion.traceability.architectureDecisionIds].sort();
      if (
        archSorted.length !== traceArchSorted.length ||
        archSorted.some((v, i) => v !== traceArchSorted[i])
      ) {
        throw new AcceptanceCriteriaValidationError(
          `Traceability mismatch in persisted criterion '${criterion.criterionId}': sourceArchitectureDecisions does not match traceability.architectureDecisionIds.`,
          { criterionId: criterion.criterionId }
        );
      }

      if (criterion.criterionId !== criterion.traceability.criterionId) {
        throw new AcceptanceCriteriaValidationError(
          `Traceability mismatch in persisted criterion '${criterion.criterionId}': criterionId does not match traceability.criterionId.`,
          { criterionId: criterion.criterionId }
        );
      }
    }

    // 6. Recompute canonical deterministic fingerprint from the artifact's authoritative content
    const recomputedFingerprint = computeAcceptanceCriteriaFingerprint(validated);
    if (validated.fingerprint !== recomputedFingerprint) {
      throw new AcceptanceCriteriaForgedFingerprintError(
        `Fingerprint mismatch for persisted acceptance criteria revision ${validated.acceptanceCriteriaRevision}: declared '${validated.fingerprint}' but recomputed canonical fingerprint is '${recomputedFingerprint}'. Persisted artifact has been tampered with or corrupted.`,
        {
          declaredFingerprint: validated.fingerprint,
          recomputedFingerprint,
        }
      );
    }

    return validated;
  }

  /**
   * Gets the latest acceptance criteria revision number for a project, or 0 if none exist.
   */
  async getLatestRevisionNumber(projectId: string): Promise<number> {
    const safeProjectId = this.sanitizeProjectId(projectId);
    const projectDir = path.join(this.recordsDir, safeProjectId);

    if (!fs.existsSync(projectDir)) {
      return 0;
    }

    const latest = await this.loadRevision(projectId);
    if (latest && typeof latest.acceptanceCriteriaRevision === 'number') {
      return latest.acceptanceCriteriaRevision;
    }

    try {
      const files = fs.readdirSync(projectDir);
      let maxRev = 0;
      for (const file of files) {
        const match = file.match(/^rev-(\d+)\.json$/);
        if (match && match[1]) {
          const revNum = parseInt(match[1], 10);
          if (revNum > maxRev) {
            maxRev = revNum;
          }
        }
      }
      return maxRev;
    } catch {
      return 0;
    }
  }
}

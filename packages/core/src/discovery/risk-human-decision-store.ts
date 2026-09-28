/**
 * Risk & Human Decision Points Persistence Store (Phase 15 TASK-P15-07)
 *
 * Implements atomic, schema-validated, revision-bound persistence for project risk
 * and human decision point artifacts under `.ai-manager/project-risks/`.
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
  ProjectRiskRevisionZodSchema,
  computeRiskFingerprint,
  computeRiskSeverity,
  type ProjectRiskRevision,
  type ProjectRisk,
  type HumanDecisionPoint,
} from './risk-human-decision-types.js';
import {
  RiskValidationError,
  RiskProjectBindingMismatchError,
  RiskImmutableRevisionError,
  RiskForgedFingerprintError,
  RiskSeverityMismatchError,
  HumanDecisionAuthorityError,
} from './risk-human-decision-errors.js';

export interface RiskHumanDecisionStoreOptions {
  riskDir?: string;
  baseDir?: string;
  historyManager?: HistoryManager;
}

export class RiskHumanDecisionStore {
  readonly riskDir: string;
  readonly recordsDir: string;
  private readonly historyManager?: HistoryManager;

  constructor(options?: RiskHumanDecisionStoreOptions) {
    if (options?.riskDir) {
      this.riskDir = options.riskDir;
    } else {
      const baseDir = options?.baseDir ?? process.cwd();
      this.riskDir = path.join(baseDir, '.ai-manager', 'project-risks');
    }
    this.recordsDir = path.join(this.riskDir, 'records');
    this.historyManager = options?.historyManager;
  }

  /**
   * Sanitizes and verifies that projectId contains no path traversal sequences.
   */
  sanitizeProjectId(projectId: string): string {
    if (!projectId || typeof projectId !== 'string') {
      throw new RiskValidationError('projectId cannot be empty.', {
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
      throw new RiskValidationError(
        `Invalid projectId '${projectId}': contains illegal characters or path traversal.`,
        { code: 'INVALID_PROJECT_ID' }
      );
    }
    return trimmed.replace(/\//g, '__');
  }

  /**
   * Validates internal consistency of risks and decision points.
   */
  validateInternalConsistency(revision: ProjectRiskRevision): void {
    const riskIdRegex = /^RISK-[A-Za-z0-9_\-]+$/;
    for (const risk of revision.risks) {
      if (!riskIdRegex.test(risk.riskId)) {
        throw new RiskValidationError(
          `Invalid riskId '${risk.riskId}': must follow format 'RISK-<IDENTIFIER>'.`,
          { riskId: risk.riskId }
        );
      }

      // Validate deterministic severity mapping
      const expectedSeverity = computeRiskSeverity(risk.probability, risk.impact);
      if (risk.severity !== expectedSeverity) {
        throw new RiskSeverityMismatchError(
          `Severity mismatch for risk '${risk.riskId}': declared '${risk.severity}' but computed severity for probability='${risk.probability}' and impact='${risk.impact}' is '${expectedSeverity}'.`,
          {
            riskId: risk.riskId,
            probability: risk.probability,
            impact: risk.impact,
            declaredSeverity: risk.severity,
            expectedSeverity,
          }
        );
      }

      // Traceability consistency
      const reqSorted = [...risk.sourceRequirements].sort();
      const traceReqSorted = [...risk.traceability.requirementIds].sort();
      if (
        reqSorted.length !== traceReqSorted.length ||
        reqSorted.some((v, i) => v !== traceReqSorted[i])
      ) {
        throw new RiskValidationError(
          `Traceability mismatch in risk '${risk.riskId}': sourceRequirements does not match traceability.requirementIds.`,
          { riskId: risk.riskId }
        );
      }

      const brSorted = [...risk.sourceBusinessRules].sort();
      const traceBrSorted = [...risk.traceability.businessRuleIds].sort();
      if (
        brSorted.length !== traceBrSorted.length ||
        brSorted.some((v, i) => v !== traceBrSorted[i])
      ) {
        throw new RiskValidationError(
          `Traceability mismatch in risk '${risk.riskId}': sourceBusinessRules does not match traceability.businessRuleIds.`,
          { riskId: risk.riskId }
        );
      }

      const archSorted = [...risk.sourceArchitectureDecisions].sort();
      const traceArchSorted = [...risk.traceability.architectureDecisionIds].sort();
      if (
        archSorted.length !== traceArchSorted.length ||
        archSorted.some((v, i) => v !== traceArchSorted[i])
      ) {
        throw new RiskValidationError(
          `Traceability mismatch in risk '${risk.riskId}': sourceArchitectureDecisions does not match traceability.architectureDecisionIds.`,
          { riskId: risk.riskId }
        );
      }

      const acSorted = [...risk.sourceAcceptanceCriteria].sort();
      const traceAcSorted = [...risk.traceability.acceptanceCriteriaIds].sort();
      if (
        acSorted.length !== traceAcSorted.length ||
        acSorted.some((v, i) => v !== traceAcSorted[i])
      ) {
        throw new RiskValidationError(
          `Traceability mismatch in risk '${risk.riskId}': sourceAcceptanceCriteria does not match traceability.acceptanceCriteriaIds.`,
          { riskId: risk.riskId }
        );
      }

      if (risk.riskId !== risk.traceability.riskId) {
        throw new RiskValidationError(
          `Traceability mismatch in risk '${risk.riskId}': riskId does not match traceability.riskId.`,
          { riskId: risk.riskId }
        );
      }
    }

    const decisionIdRegex = /^HDP-[A-Za-z0-9_\-]+$/;
    for (const hdp of revision.humanDecisionPoints) {
      if (!decisionIdRegex.test(hdp.decisionId)) {
        throw new RiskValidationError(
          `Invalid decisionId '${hdp.decisionId}': must follow format 'HDP-<IDENTIFIER>'.`,
          { decisionId: hdp.decisionId }
        );
      }

      // Enforce Product Owner / USER authority only
      if (hdp.authority !== 'PRODUCT_OWNER' && hdp.authority !== 'USER') {
        throw new HumanDecisionAuthorityError(
          `Authority '${hdp.authority}' for decision '${hdp.decisionId}' is forbidden. Authority must be PRODUCT_OWNER or USER. Non-human roles cannot decide Human Decision Points.`,
          { decisionId: hdp.decisionId, authority: hdp.authority }
        );
      }
    }
  }

  /**
   * Atomically saves a ProjectRiskRevision to disk.
   * Enforces immutability: if rev-<revision>.json already exists, it is rejected unless identical.
   */
  async saveRevision(revision: ProjectRiskRevision): Promise<void> {
    const parseResult = ProjectRiskRevisionZodSchema.safeParse(revision);
    if (!parseResult.success) {
      throw new RiskValidationError(
        `Failed to persist risk revision: schema validation error: ${parseResult.error.message}`,
        { issues: parseResult.error.issues }
      );
    }

    // Validate internal consistency
    this.validateInternalConsistency(revision);

    // Validate canonical fingerprint of revision before persisting
    const canonicalFingerprint = computeRiskFingerprint(revision);
    if (revision.fingerprint !== canonicalFingerprint) {
      throw new RiskForgedFingerprintError(
        `Fingerprint mismatch for risk revision ${revision.riskRevision}: declared '${revision.fingerprint}' but recomputed canonical fingerprint is '${canonicalFingerprint}'.`,
        { declaredFingerprint: revision.fingerprint, canonicalFingerprint }
      );
    }

    const safeProjectId = this.sanitizeProjectId(revision.projectId);
    const projectDir = path.join(this.recordsDir, safeProjectId);
    const revisionFilePath = path.join(projectDir, `rev-${revision.riskRevision}.json`);
    const latestFilePath = path.join(projectDir, 'latest.json');

    // Immutability check: compare authoritative canonical content and fingerprint
    if (fs.existsSync(revisionFilePath)) {
      const existing = await readJsonFile<ProjectRiskRevision>(revisionFilePath);
      if (existing) {
        const existingParse = ProjectRiskRevisionZodSchema.safeParse(existing);
        if (!existingParse.success) {
          throw new RiskImmutableRevisionError(
            `Existing risk revision ${revision.riskRevision} is corrupted on disk.`,
            { issues: existingParse.error.issues }
          );
        }
        const existingCanonicalFingerprint = computeRiskFingerprint(existing);
        if (
          existing.fingerprint !== revision.fingerprint ||
          existingCanonicalFingerprint !== canonicalFingerprint
        ) {
          throw new RiskImmutableRevisionError(
            `Risk revision ${revision.riskRevision} for project '${revision.projectId}' is immutable and already exists with different canonical content.`,
            {
              projectId: revision.projectId,
              revision: revision.riskRevision,
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

    // 1. Write revision-bound file: records/<projectId>/rev-<riskRevision>.json
    await atomicWriteJson(revisionFilePath, revision);

    // 2. Write latest pointer: records/<projectId>/latest.json
    await atomicWriteJson(latestFilePath, revision);

    // 3. Append audit event to History stream if available
    if (this.historyManager) {
      try {
        await this.historyManager.appendEvent({
          eventType: 'PROJECT_RISKS_DEFINED',
          actor: Actor.DIRECTOR,
          payload: {
            projectId: revision.projectId,
            riskRevision: revision.riskRevision,
            sourceDiscoveryRevision: revision.sourceDiscoveryRevision,
            sourceRequirementsRevision: revision.sourceRequirementsRevision,
            sourceArchitectureRevision: revision.sourceArchitectureRevision,
            sourceBusinessRulesRevision: revision.sourceBusinessRulesRevision,
            sourceAcceptanceCriteriaRevision: revision.sourceAcceptanceCriteriaRevision,
            fingerprint: revision.fingerprint,
            totalRisks: revision.coverage.totalRisks,
            criticalRisks: revision.coverage.criticalRisks,
            highRisks: revision.coverage.highRisks,
            pendingDecisionRisks: revision.coverage.pendingDecisionRisks,
            totalHumanDecisionPoints: revision.humanDecisionCoverage.totalHumanDecisionPoints,
            pendingHumanDecisionPoints: revision.humanDecisionCoverage.pendingHumanDecisionPoints,
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
   * Loads a ProjectRiskRevision from disk by projectId and optional revision number.
   * If revision is omitted, loads latest revision.
   * Every persisted Risk revision is independently validated when loaded.
   */
  async loadRevision(
    projectId: string,
    revision?: number
  ): Promise<ProjectRiskRevision | null> {
    const safeProjectId = this.sanitizeProjectId(projectId);
    const projectDir = path.join(this.recordsDir, safeProjectId);

    let targetPath: string;
    if (revision !== undefined) {
      if (!Number.isInteger(revision) || revision < 1) {
        throw new RiskValidationError(
          `Invalid risk revision '${revision}': must be a positive integer.`,
          { code: 'INVALID_REVISION' }
        );
      }
      targetPath = path.join(projectDir, `rev-${revision}.json`);
    } else {
      targetPath = path.join(projectDir, 'latest.json');
    }

    const raw = await readJsonFile<ProjectRiskRevision>(targetPath);
    if (!raw) {
      return null;
    }

    // 1. Validate complete schema
    const parseResult = ProjectRiskRevisionZodSchema.safeParse(raw);
    if (!parseResult.success) {
      throw new RiskValidationError(
        `Corrupted persisted risk revision: schema validation failed: ${parseResult.error.message}`,
        { issues: parseResult.error.issues }
      );
    }
    const validated = parseResult.data;

    // 2. Validate project binding
    if (validated.projectId !== projectId) {
      throw new RiskProjectBindingMismatchError(
        `Cross-project mismatch: requested '${projectId}' but risk record belongs to '${validated.projectId}'.`,
        { requestedProjectId: projectId, recordProjectId: validated.projectId }
      );
    }

    // 3. Validate revision number
    if (revision !== undefined && validated.riskRevision !== revision) {
      throw new RiskValidationError(
        `Revision mismatch: requested revision ${revision} but loaded artifact contains revision ${validated.riskRevision}.`,
        { requestedRevision: revision, recordRevision: validated.riskRevision }
      );
    }

    // 4. Validate source revision/fingerprint bindings
    if (
      !validated.sourceDiscoveryRevision ||
      validated.sourceDiscoveryRevision < 1 ||
      !validated.sourceDiscoveryFingerprint ||
      !validated.sourceRequirementsRevision ||
      validated.sourceRequirementsRevision < 1 ||
      !validated.sourceRequirementsFingerprint ||
      !validated.sourceArchitectureRevision ||
      validated.sourceArchitectureRevision < 1 ||
      !validated.sourceArchitectureFingerprint ||
      !validated.sourceBusinessRulesRevision ||
      validated.sourceBusinessRulesRevision < 1 ||
      !validated.sourceBusinessRulesFingerprint ||
      !validated.sourceAcceptanceCriteriaRevision ||
      validated.sourceAcceptanceCriteriaRevision < 1 ||
      !validated.sourceAcceptanceCriteriaFingerprint
    ) {
      throw new RiskValidationError(
        `Invalid source revision or fingerprint bindings in persisted risk record.`,
        { projectId, revision: validated.riskRevision }
      );
    }

    // 5. Validate internal consistency
    this.validateInternalConsistency(validated);

    // 6. Recompute canonical deterministic fingerprint from the artifact's authoritative content
    const recomputedFingerprint = computeRiskFingerprint(validated);
    if (validated.fingerprint !== recomputedFingerprint) {
      throw new RiskForgedFingerprintError(
        `Fingerprint mismatch for persisted risk revision ${validated.riskRevision}: declared '${validated.fingerprint}' but recomputed canonical fingerprint is '${recomputedFingerprint}'. Persisted artifact has been tampered with or corrupted.`,
        {
          declaredFingerprint: validated.fingerprint,
          recomputedFingerprint,
        }
      );
    }

    return validated;
  }

  /**
   * Gets the latest risk revision number for a project, or 0 if none exist.
   */
  async getLatestRevisionNumber(projectId: string): Promise<number> {
    const safeProjectId = this.sanitizeProjectId(projectId);
    const projectDir = path.join(this.recordsDir, safeProjectId);

    if (!fs.existsSync(projectDir)) {
      return 0;
    }

    const latest = await this.loadRevision(projectId);
    if (latest && typeof latest.riskRevision === 'number') {
      return latest.riskRevision;
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

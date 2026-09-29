/**
 * Acceptance Criteria Definition Engine (Phase 15 TASK-P15-06)
 *
 * Transforms authoritative Requirements / Scope (P15-03), Architecture / Technology (P15-04),
 * Business Rules (P15-05), and Discovery (P15-01) into an explicit, structured, revisioned
 * Acceptance Criteria specification for Project Initiation.
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. P15-06 defines "How will we know that the product satisfies the requirement?"
 * 2. Does NOT approve the project, authorize development, or invoke Antigravity.
 * 3. Human decision points can NEVER be silently resolved by the engine (thresholds, policies).
 * 4. Never invent numeric performance or operational thresholds.
 * 5. Strictly deterministic: identical inputs produce identical acceptance criteria and fingerprint.
 * 6. Revision-bound: immutable by revision, protects against stale requirements, architecture, business rules, and discovery.
 * 7. Fails closed on cross-project mismatches, forged fingerprints, invalid dependencies, or path traversal.
 */

import * as path from 'node:path';
import { Actor } from '../actors.js';
import type { SpecStore } from '../storage/spec-store.js';
import type { HistoryManager } from '../storage/history-manager.js';
import { AdaptiveDiscoveryStore } from './adaptive-discovery-store.js';
import { CompletenessGateStore } from './completeness-gate-store.js';
import { RequirementsScopeStore } from './requirements-scope-store.js';
import { ArchitectureTechnologyStore } from './architecture-technology-store.js';
import { BusinessRulesStore } from './business-rules-store.js';
import { AcceptanceCriteriaStore } from './acceptance-criteria-store.js';
import type { ProjectRequirementsScopeRevision } from './requirements-scope-types.js';
import type { ProjectArchitectureRevision } from './architecture-technology-types.js';
import type { ProjectBusinessRulesRevision } from './business-rules-types.js';
import type { ProjectDiscoveryRevision } from './adaptive-discovery-types.js';
import {
  AcceptanceCriteriaInputZodSchema,
  computeAcceptanceCriteriaFingerprint,
  VERIFICATION_METHODS,
  type AcceptanceCriteriaInput,
  type ProjectAcceptanceCriteriaRevision,
  type AcceptanceCriterion,
  type AcceptanceCriterionType,
  type AcceptanceCriteriaPriority,
  type AcceptanceCriteriaStatus,
  type VerificationMethod,
  type AcceptanceCriteriaHumanDecision,
  type AcceptanceCriteriaConflict,
  type AcceptanceCriteriaRequirementTrace,
  type AcceptanceCriteriaBusinessRuleTrace,
  type AcceptanceCriteriaArchitectureTrace,
  type AcceptanceCriteriaCoverage,
} from './acceptance-criteria-types.js';
import {
  AcceptanceCriteriaValidationError,
  AcceptanceCriteriaRevisionNotFoundError,
  AcceptanceCriteriaProjectBindingMismatchError,
  AcceptanceCriteriaStaleSourceError,
  AcceptanceCriteriaForgedFingerprintError,
} from './acceptance-criteria-errors.js';
import {
  computeDeterministicFingerprint,
  computeDeterministicHash,
} from './adaptive-discovery-normalizer.js';

const NFR_CATEGORIES = [
  'performance',
  'reliability',
  'security',
  'availability',
  'scalability',
  'usability',
  'maintainability',
  'operationalConstraints',
] as const;

export interface AcceptanceCriteriaEngineOptions {
  readonly workspaceRoot?: string;
  readonly baseDir?: string;
  readonly discoveryStore?: AdaptiveDiscoveryStore;
  readonly completenessStore?: CompletenessGateStore;
  readonly requirementsStore?: RequirementsScopeStore;
  readonly architectureStore?: ArchitectureTechnologyStore;
  readonly businessRulesStore?: BusinessRulesStore;
  readonly acceptanceCriteriaStore?: AcceptanceCriteriaStore;
  readonly historyManager?: HistoryManager;
  readonly specStore?: SpecStore;
}

export class AcceptanceCriteriaEngine {
  readonly workspaceRoot?: string;
  readonly baseDir: string;
  readonly discoveryStore: AdaptiveDiscoveryStore;
  readonly completenessStore: CompletenessGateStore;
  readonly requirementsStore: RequirementsScopeStore;
  readonly architectureStore: ArchitectureTechnologyStore;
  readonly businessRulesStore: BusinessRulesStore;
  readonly acceptanceCriteriaStore: AcceptanceCriteriaStore;
  private readonly historyManager?: HistoryManager;
  private readonly specStore?: SpecStore;

  constructor(options?: AcceptanceCriteriaEngineOptions) {
    this.workspaceRoot = options?.workspaceRoot ? path.resolve(options.workspaceRoot) : undefined;
    this.baseDir = options?.baseDir
      ? path.resolve(options.baseDir)
      : this.workspaceRoot ?? process.cwd();
    this.historyManager = options?.historyManager;
    this.specStore = options?.specStore;

    this.discoveryStore =
      options?.discoveryStore ??
      new AdaptiveDiscoveryStore({
        baseDir: this.baseDir,
        historyManager: this.historyManager,
      });

    this.completenessStore =
      options?.completenessStore ??
      new CompletenessGateStore({
        baseDir: this.baseDir,
        historyManager: this.historyManager,
      });

    this.requirementsStore =
      options?.requirementsStore ??
      new RequirementsScopeStore({
        baseDir: this.baseDir,
        historyManager: this.historyManager,
      });

    this.architectureStore =
      options?.architectureStore ??
      new ArchitectureTechnologyStore({
        baseDir: this.baseDir,
        historyManager: this.historyManager,
      });

    this.businessRulesStore =
      options?.businessRulesStore ??
      new BusinessRulesStore({
        baseDir: this.baseDir,
        historyManager: this.historyManager,
      });

    this.acceptanceCriteriaStore =
      options?.acceptanceCriteriaStore ??
      new AcceptanceCriteriaStore({
        baseDir: this.baseDir,
        historyManager: this.historyManager,
      });
  }

  /**
   * Derives an authoritative, revisioned Acceptance Criteria specification.
   */
  async derive(input: AcceptanceCriteriaInput): Promise<ProjectAcceptanceCriteriaRevision> {
    const parsedInput = AcceptanceCriteriaInputZodSchema.safeParse(input);
    if (!parsedInput.success) {
      throw new AcceptanceCriteriaValidationError(
        `Acceptance criteria input validation failed: ${parsedInput.error.message}`,
        { issues: parsedInput.error.issues }
      );
    }

    const { projectId } = parsedInput.data;
    const safeProjectId = this.acceptanceCriteriaStore.sanitizeProjectId(projectId);

    // 1. Authoritative Upstream: Requirements & Scope (P15-03)
    const requirements = await this.requirementsStore.loadRevision(
      safeProjectId,
      parsedInput.data.requirementsRevision
    );
    if (!requirements) {
      throw new AcceptanceCriteriaRevisionNotFoundError(
        `No requirements revision found for project '${projectId}'${
          parsedInput.data.requirementsRevision !== undefined
            ? ` at revision ${parsedInput.data.requirementsRevision}`
            : ''
        }. Requirements & Scope must be defined (P15-03) before Acceptance Criteria can be defined.`,
        { projectId, requestedRevision: parsedInput.data.requirementsRevision }
      );
    }

    if (requirements.projectId !== projectId) {
      throw new AcceptanceCriteriaProjectBindingMismatchError(
        `Cross-project mismatch: requirements belong to '${requirements.projectId}' but requested '${projectId}'.`,
        { requestedProjectId: projectId, requirementsProjectId: requirements.projectId }
      );
    }

    if (
      parsedInput.data.expectedRequirementsFingerprint &&
      requirements.fingerprint !== parsedInput.data.expectedRequirementsFingerprint
    ) {
      throw new AcceptanceCriteriaForgedFingerprintError(
        `Requirements fingerprint mismatch for project '${projectId}': expected '${parsedInput.data.expectedRequirementsFingerprint}' but got '${requirements.fingerprint}'.`,
        {
          expected: parsedInput.data.expectedRequirementsFingerprint,
          actual: requirements.fingerprint,
        }
      );
    }

    // 2. Authoritative Upstream: Architecture & Technology (P15-04)
    const architecture = await this.architectureStore.loadRevision(
      safeProjectId,
      parsedInput.data.architectureRevision
    );
    if (!architecture) {
      throw new AcceptanceCriteriaRevisionNotFoundError(
        `No architecture revision found for project '${projectId}'${
          parsedInput.data.architectureRevision !== undefined
            ? ` at revision ${parsedInput.data.architectureRevision}`
            : ''
        }. Architecture & Technology must be defined (P15-04) before Acceptance Criteria can be defined.`,
        { projectId, requestedRevision: parsedInput.data.architectureRevision }
      );
    }

    if (architecture.projectId !== projectId) {
      throw new AcceptanceCriteriaProjectBindingMismatchError(
        `Cross-project mismatch: architecture belongs to '${architecture.projectId}' but requested '${projectId}'.`,
        { requestedProjectId: projectId, architectureProjectId: architecture.projectId }
      );
    }

    if (
      parsedInput.data.expectedArchitectureFingerprint &&
      architecture.fingerprint !== parsedInput.data.expectedArchitectureFingerprint
    ) {
      throw new AcceptanceCriteriaForgedFingerprintError(
        `Architecture fingerprint mismatch for project '${projectId}': expected '${parsedInput.data.expectedArchitectureFingerprint}' but got '${architecture.fingerprint}'.`,
        {
          expected: parsedInput.data.expectedArchitectureFingerprint,
          actual: architecture.fingerprint,
        }
      );
    }

    // 3. Authoritative Upstream: Business Rules (P15-05)
    const businessRules = await this.businessRulesStore.loadRevision(
      safeProjectId,
      parsedInput.data.businessRulesRevision
    );
    if (!businessRules) {
      throw new AcceptanceCriteriaRevisionNotFoundError(
        `No business rules revision found for project '${projectId}'${
          parsedInput.data.businessRulesRevision !== undefined
            ? ` at revision ${parsedInput.data.businessRulesRevision}`
            : ''
        }. Business Rules must be defined (P15-05) before Acceptance Criteria can be defined.`,
        { projectId, requestedRevision: parsedInput.data.businessRulesRevision }
      );
    }

    if (businessRules.projectId !== projectId) {
      throw new AcceptanceCriteriaProjectBindingMismatchError(
        `Cross-project mismatch: business rules belong to '${businessRules.projectId}' but requested '${projectId}'.`,
        { requestedProjectId: projectId, businessRulesProjectId: businessRules.projectId }
      );
    }

    if (
      parsedInput.data.expectedBusinessRulesFingerprint &&
      businessRules.fingerprint !== parsedInput.data.expectedBusinessRulesFingerprint
    ) {
      throw new AcceptanceCriteriaForgedFingerprintError(
        `Business rules fingerprint mismatch for project '${projectId}': expected '${parsedInput.data.expectedBusinessRulesFingerprint}' but got '${businessRules.fingerprint}'.`,
        {
          expected: parsedInput.data.expectedBusinessRulesFingerprint,
          actual: businessRules.fingerprint,
        }
      );
    }

    // 4. Authoritative Upstream: Adaptive Discovery (P15-01)
    const discovery = await this.discoveryStore.loadRevision(
      safeProjectId,
      parsedInput.data.discoveryRevision ?? requirements.sourceDiscoveryRevision
    );
    if (!discovery) {
      throw new AcceptanceCriteriaRevisionNotFoundError(
        `No discovery revision found for project '${projectId}' at revision ${
          parsedInput.data.discoveryRevision ?? requirements.sourceDiscoveryRevision
        }.`,
        { projectId, requestedRevision: parsedInput.data.discoveryRevision }
      );
    }

    if (discovery.projectId !== projectId) {
      throw new AcceptanceCriteriaProjectBindingMismatchError(
        `Cross-project mismatch: discovery belongs to '${discovery.projectId}' but requested '${projectId}'.`,
        { requestedProjectId: projectId, discoveryProjectId: discovery.projectId }
      );
    }

    if (
      parsedInput.data.expectedDiscoveryFingerprint &&
      discovery.fingerprint !== parsedInput.data.expectedDiscoveryFingerprint
    ) {
      throw new AcceptanceCriteriaForgedFingerprintError(
        `Discovery fingerprint mismatch for project '${projectId}': expected '${parsedInput.data.expectedDiscoveryFingerprint}' but got '${discovery.fingerprint}'.`,
        {
          expected: parsedInput.data.expectedDiscoveryFingerprint,
          actual: discovery.fingerprint,
        }
      );
    }

    // 5. Stale source checks
    const latestRequirements = await this.requirementsStore.loadRevision(safeProjectId);
    if (
      latestRequirements &&
      latestRequirements.requirementsRevision > requirements.requirementsRevision
    ) {
      throw new AcceptanceCriteriaStaleSourceError(
        `Stale requirements revision: provided revision ${requirements.requirementsRevision} is superseded by latest revision ${latestRequirements.requirementsRevision}.`,
        {
          currentRevision: requirements.requirementsRevision,
          latestRevision: latestRequirements.requirementsRevision,
        }
      );
    }

    const latestArchitecture = await this.architectureStore.loadRevision(safeProjectId);
    if (
      latestArchitecture &&
      latestArchitecture.architectureRevision > architecture.architectureRevision
    ) {
      throw new AcceptanceCriteriaStaleSourceError(
        `Stale architecture revision: provided revision ${architecture.architectureRevision} is superseded by latest revision ${latestArchitecture.architectureRevision}.`,
        {
          currentRevision: architecture.architectureRevision,
          latestRevision: latestArchitecture.architectureRevision,
        }
      );
    }

    const latestBusinessRules = await this.businessRulesStore.loadRevision(safeProjectId);
    if (
      latestBusinessRules &&
      latestBusinessRules.businessRulesRevision > businessRules.businessRulesRevision
    ) {
      throw new AcceptanceCriteriaStaleSourceError(
        `Stale business rules revision: provided revision ${businessRules.businessRulesRevision} is superseded by latest revision ${latestBusinessRules.businessRulesRevision}.`,
        {
          currentRevision: businessRules.businessRulesRevision,
          latestRevision: latestBusinessRules.businessRulesRevision,
        }
      );
    }

    const latestDiscovery = await this.discoveryStore.loadRevision(safeProjectId);
    if (latestDiscovery && latestDiscovery.discoveryRevision > discovery.discoveryRevision) {
      throw new AcceptanceCriteriaStaleSourceError(
        `Stale discovery revision: provided revision ${discovery.discoveryRevision} is superseded by latest revision ${latestDiscovery.discoveryRevision}.`,
        {
          currentRevision: discovery.discoveryRevision,
          latestRevision: latestDiscovery.discoveryRevision,
        }
      );
    }

    // 6. Extraction & Derivation
    const { baselineCriteria, baselineDecisions, baselineConflicts } =
      this.deriveBaselineCriteria(requirements, architecture, businessRules);

    const rawCriteria: AcceptanceCriterion[] = [...baselineCriteria];
    const pendingHumanDecisions: AcceptanceCriteriaHumanDecision[] = [...baselineDecisions];
    const conflicts: AcceptanceCriteriaConflict[] = [...baselineConflicts];

    // 6.6 Merge custom decisions, explicit conflicts, and additional criteria
    if (parsedInput.data.additionalCriteria) {
      this.validateAdditionalCriteria(
        parsedInput.data.additionalCriteria,
        baselineCriteria,
        requirements,
        architecture,
        businessRules,
        projectId
      );
      rawCriteria.push(...parsedInput.data.additionalCriteria);
    }

    if (parsedInput.data.customDecisions) {
      for (const cd of parsedInput.data.customDecisions) {
        pendingHumanDecisions.push(cd);
      }
    }

    if (parsedInput.data.conflicts) {
      for (const conf of parsedInput.data.conflicts) {
        conflicts.push(conf);
        for (const cr of rawCriteria) {
          if (
            conf.affectedCriteria.includes(cr.criterionId) ||
            conf.affectedRequirements.some((req) => cr.sourceRequirements.includes(req)) ||
            conf.affectedRules.some((r) => cr.sourceBusinessRules.includes(r))
          ) {
            cr.status = 'PENDING_DECISION';
          }
        }
      }
    }

    // 7. Deterministic Deduplication
    const seenCriteriaMap = new Map<string, AcceptanceCriterion>();
    for (const criterion of rawCriteria) {
      const dedupKey = [
        criterion.criterionType,
        criterion.statement.trim(),
        criterion.expectedResult.trim(),
      ].join('|');

      if (!seenCriteriaMap.has(dedupKey)) {
        seenCriteriaMap.set(dedupKey, criterion);
      } else {
        const existing = seenCriteriaMap.get(dedupKey)!;
        // Merge sources and dependencies
        const mergedReqs = Array.from(
          new Set([...existing.sourceRequirements, ...criterion.sourceRequirements])
        ).sort();
        const mergedRules = Array.from(
          new Set([...existing.sourceBusinessRules, ...criterion.sourceBusinessRules])
        ).sort();
        const mergedArch = Array.from(
          new Set([...existing.sourceArchitectureDecisions, ...criterion.sourceArchitectureDecisions])
        ).sort();
        const mergedDeps = Array.from(
          new Set([...existing.dependencies, ...criterion.dependencies])
        ).sort();

        // If either was PENDING_DECISION, preserve PENDING_DECISION
        const status: AcceptanceCriteriaStatus =
          existing.status === 'PENDING_DECISION' || criterion.status === 'PENDING_DECISION'
            ? 'PENDING_DECISION'
            : existing.status;

        seenCriteriaMap.set(dedupKey, {
          ...existing,
          status,
          sourceRequirements: mergedReqs,
          sourceBusinessRules: mergedRules,
          sourceArchitectureDecisions: mergedArch,
          dependencies: mergedDeps,
          traceability: {
            criterionId: existing.criterionId,
            requirementIds: mergedReqs,
            businessRuleIds: mergedRules,
            architectureDecisionIds: mergedArch,
          },
        });
      }
    }

    const criteria = Array.from(seenCriteriaMap.values()).sort((a, b) =>
      a.criterionId.localeCompare(b.criterionId)
    );

    // Deduplicate human decisions
    const seenDecisions = new Map<string, AcceptanceCriteriaHumanDecision>();
    for (const d of pendingHumanDecisions) {
      if (!seenDecisions.has(d.decisionId)) {
        seenDecisions.set(d.decisionId, d);
      } else {
        const existing = seenDecisions.get(d.decisionId)!;
        seenDecisions.set(d.decisionId, {
          ...existing,
          affectedCriteria: Array.from(
            new Set([...existing.affectedCriteria, ...d.affectedCriteria])
          ).sort(),
          affectedRequirements: Array.from(
            new Set([...existing.affectedRequirements, ...d.affectedRequirements])
          ).sort(),
        });
      }
    }
    const deduplicatedDecisions = Array.from(seenDecisions.values()).sort((a, b) =>
      a.decisionId.localeCompare(b.decisionId)
    );

    // Deduplicate conflicts
    const seenConflicts = new Map<string, AcceptanceCriteriaConflict>();
    for (const c of conflicts) {
      if (!seenConflicts.has(c.conflictId)) {
        seenConflicts.set(c.conflictId, c);
      } else {
        const existing = seenConflicts.get(c.conflictId)!;
        seenConflicts.set(c.conflictId, {
          ...existing,
          affectedCriteria: Array.from(
            new Set([...existing.affectedCriteria, ...c.affectedCriteria])
          ).sort(),
          affectedRequirements: Array.from(
            new Set([...existing.affectedRequirements, ...c.affectedRequirements])
          ).sort(),
          affectedRules: Array.from(
            new Set([...existing.affectedRules, ...c.affectedRules])
          ).sort(),
        });
      }
    }
    const deduplicatedConflicts = Array.from(seenConflicts.values()).sort((a, b) =>
      a.conflictId.localeCompare(b.conflictId)
    );

    // 8. Traceability Reports & Coverage Calculation
    const { requirementsTraceability, businessRulesTraceability, architectureTraceability, coverage } =
      this.computeTraceabilityAndCoverage(
        criteria,
        requirements,
        businessRules,
        architecture,
        deduplicatedDecisions,
        parsedInput.data.uncoveredExplanations
      );

    // 9. Deterministic Fingerprint Computation
    const fingerprint = computeAcceptanceCriteriaFingerprint({
      projectId,
      sourceRequirementsRevision: requirements.requirementsRevision,
      sourceRequirementsFingerprint: requirements.fingerprint,
      sourceArchitectureRevision: architecture.architectureRevision,
      sourceArchitectureFingerprint: architecture.fingerprint,
      sourceBusinessRulesRevision: businessRules.businessRulesRevision,
      sourceBusinessRulesFingerprint: businessRules.fingerprint,
      sourceDiscoveryRevision: discovery.discoveryRevision,
      sourceDiscoveryFingerprint: discovery.fingerprint,
      criteria,
      coverage,
      pendingHumanDecisions: deduplicatedDecisions,
      conflicts: deduplicatedConflicts,
      requirementsTraceability,
      businessRulesTraceability,
      architectureTraceability,
    });

    // Check if identical revision has already been saved for this project
    const latest = await this.acceptanceCriteriaStore.loadRevision(projectId);
    if (latest && latest.fingerprint === fingerprint) {
      return latest;
    }

    const latestCriteriaRev = await this.acceptanceCriteriaStore.getLatestRevisionNumber(projectId);
    const acceptanceCriteriaRevision = latestCriteriaRev + 1;

    const artifact: ProjectAcceptanceCriteriaRevision = {
      projectId,
      acceptanceCriteriaRevision,
      sourceRequirementsRevision: requirements.requirementsRevision,
      sourceRequirementsFingerprint: requirements.fingerprint,
      sourceArchitectureRevision: architecture.architectureRevision,
      sourceArchitectureFingerprint: architecture.fingerprint,
      sourceBusinessRulesRevision: businessRules.businessRulesRevision,
      sourceBusinessRulesFingerprint: businessRules.fingerprint,
      sourceDiscoveryRevision: discovery.discoveryRevision,
      sourceDiscoveryFingerprint: discovery.fingerprint,
      isStale: false,
      criteria,
      coverage,
      pendingHumanDecisions: deduplicatedDecisions,
      conflicts: deduplicatedConflicts,
      requirementsTraceability,
      businessRulesTraceability,
      architectureTraceability,
      createdAt: new Date().toISOString(),
      fingerprint,
    };

    // 10. Durably persist
    await this.acceptanceCriteriaStore.saveRevision(artifact);

    return artifact;
  }

  /**
   * Derives baseline acceptance criteria, human decisions, and conflicts directly from authoritative upstream sources.
   */
  private deriveBaselineCriteria(
    requirements: ProjectRequirementsScopeRevision,
    architecture: ProjectArchitectureRevision,
    businessRules: ProjectBusinessRulesRevision
  ): {
    baselineCriteria: AcceptanceCriterion[];
    baselineDecisions: AcceptanceCriteriaHumanDecision[];
    baselineConflicts: AcceptanceCriteriaConflict[];
  } {
    const rawCriteria: AcceptanceCriterion[] = [];
    const pendingHumanDecisions: AcceptanceCriteriaHumanDecision[] = [];
    const conflicts: AcceptanceCriteriaConflict[] = [];

    // Helper: Infer verification method from textual context
    const inferVerificationMethod = (
      text: string,
      defaultMethod: VerificationMethod = 'MANUAL_VERIFICATION'
    ): VerificationMethod => {
      const lower = text.toLowerCase();
      if (
        lower.includes('automated test') ||
        lower.includes('unit test') ||
        lower.includes('automated check')
      ) {
        return 'AUTOMATED_TEST';
      }
      if (lower.includes('integration test') || lower.includes('api test')) {
        return 'INTEGRATION_TEST';
      }
      if (
        lower.includes('end-to-end') ||
        lower.includes('e2e') ||
        lower.includes('workflow test') ||
        lower.includes('browser test')
      ) {
        return 'END_TO_END_TEST';
      }
      if (
        lower.includes('performance test') ||
        lower.includes('load test') ||
        lower.includes('stress test') ||
        lower.includes('latency') ||
        lower.includes('benchmark')
      ) {
        return 'PERFORMANCE_TEST';
      }
      if (
        lower.includes('security test') ||
        lower.includes('penetration') ||
        lower.includes('auth test') ||
        lower.includes('vulnerability')
      ) {
        return 'SECURITY_TEST';
      }
      if (
        lower.includes('static check') ||
        lower.includes('lint') ||
        lower.includes('type check') ||
        lower.includes('schema validation')
      ) {
        return 'STATIC_CHECK';
      }
      if (
        lower.includes('deployment check') ||
        lower.includes('deploy') ||
        lower.includes('healthcheck') ||
        lower.includes('container check')
      ) {
        return 'DEPLOYMENT_CHECK';
      }
      if (
        lower.includes('document review') ||
        lower.includes('manual review') ||
        lower.includes('documentation')
      ) {
        return 'DOCUMENT_REVIEW';
      }
      if (
        lower.includes('observation') ||
        lower.includes('observe') ||
        lower.includes('log check') ||
        lower.includes('telemetry')
      ) {
        return 'OBSERVATION';
      }
      if (
        lower.includes('manual') ||
        lower.includes('user test') ||
        lower.includes('visual inspection')
      ) {
        return 'MANUAL_VERIFICATION';
      }
      return defaultMethod;
    };

    // Helper: Categorize criterion statement
    const inferCriterionType = (text: string): AcceptanceCriterionType => {
      const lower = text.toLowerCase();
      if (
        lower.includes('unauthorized') ||
        lower.includes('permission') ||
        lower.includes('auth') ||
        lower.includes('access control') ||
        lower.includes('security') ||
        lower.includes('token')
      ) {
        return 'SECURITY';
      }
      if (
        lower.includes('valid') ||
        lower.includes('schema') ||
        lower.includes('format') ||
        lower.includes('required field')
      ) {
        return 'VALIDATION';
      }
      if (
        lower.includes('latency') ||
        lower.includes('throughput') ||
        lower.includes('response time') ||
        lower.includes('performance') ||
        lower.includes('concurrency')
      ) {
        return 'PERFORMANCE';
      }
      if (
        lower.includes('uptime') ||
        lower.includes('availability') ||
        lower.includes('sla')
      ) {
        return 'AVAILABILITY';
      }
      if (
        lower.includes('failover') ||
        lower.includes('recover') ||
        lower.includes('resilient') ||
        lower.includes('restart') ||
        lower.includes('reliability')
      ) {
        return 'RELIABILITY';
      }
      if (
        lower.includes('browser') ||
        lower.includes('platform') ||
        lower.includes('compatibility') ||
        lower.includes('device')
      ) {
        return 'COMPATIBILITY';
      }
      if (
        lower.includes('integration') ||
        lower.includes('webhook') ||
        lower.includes('third-party') ||
        lower.includes('external api')
      ) {
        return 'INTEGRATION';
      }
      if (
        lower.includes('persist') ||
        lower.includes('storage') ||
        lower.includes('database') ||
        lower.includes('entity') ||
        lower.includes('data')
      ) {
        return 'DATA';
      }
      if (
        lower.includes('workflow') ||
        lower.includes('step') ||
        lower.includes('sequence') ||
        lower.includes('process')
      ) {
        return 'WORKFLOW';
      }
      if (
        lower.includes('state') ||
        lower.includes('transition') ||
        lower.includes('lifecycle') ||
        lower.includes('status')
      ) {
        return 'STATE_TRANSITION';
      }
      if (lower.includes('deploy') || lower.includes('container') || lower.includes('docker')) {
        return 'DEPLOYMENT';
      }
      if (lower.includes('operational') || lower.includes('telemetry') || lower.includes('metrics')) {
        return 'OPERATIONAL';
      }
      if (lower.includes('usability') || lower.includes('ux') || lower.includes('accessible')) {
        return 'USABILITY';
      }
      if (lower.includes('rule') || lower.includes('policy') || lower.includes('limit')) {
        return 'BUSINESS_RULE';
      }
      return 'FUNCTIONAL';
    };

    // Helper: Determine if text contains authoritative numeric threshold
    const hasAuthoritativeThreshold = (text: string): boolean => {
      const lower = text.toLowerCase();
      if (
        lower.includes('tbd') ||
        lower.includes('pending') ||
        lower.includes('undecided') ||
        lower.includes('unknown') ||
        lower.includes('unspecified')
      ) {
        return false;
      }
      const numericThresholdPattern =
        /\b\d+(\.\d+)?\s*(ms|s|seconds?|minutes?|hours?|days?|%|percent|rps|tps|req\/s|users?|concurrency|gb|mb|kb)\b|[<>]=?\s*\d+(\.\d+)?|\b\d{1,3}\.\d{1,3}%\b/;
      return numericThresholdPattern.test(lower);
    };

    // 6.1 Derive from Functional Requirements
    for (const freq of requirements.functionalRequirements) {
      const priority: AcceptanceCriteriaPriority =
        freq.priority === 'CRITICAL' ||
        freq.priority === 'HIGH' ||
        freq.priority === 'MEDIUM' ||
        freq.priority === 'LOW'
          ? freq.priority
          : 'HIGH';

      const isPending =
        freq.status === 'PENDING_DECISION' ||
        freq.description.toLowerCase().includes('tbd') ||
        freq.description.toLowerCase().includes('undecided');

      const verificationMethod = inferVerificationMethod(freq.description, 'AUTOMATED_TEST');
      const status: AcceptanceCriteriaStatus = isPending ? 'PENDING_DECISION' : 'DEFINED';
      const criterionId = `AC-${computeDeterministicHash(
        `FREQ:${freq.requirementId}:FUNCTIONAL`,
        8
      ).toUpperCase()}`;

      const statement = `When functionality '${freq.title}' is invoked under normal conditions, the product executes: ${freq.description}.`;
      const expectedResult = isPending
        ? `Observable behavior pending Product Owner decision for: ${freq.title}`
        : `Observable execution succeeds without error and satisfies '${freq.title}'.`;

      const criterion: AcceptanceCriterion = {
        criterionId,
        title: `${freq.title}: Functional Verification`,
        description: `Authoritative acceptance criterion derived from functional requirement '${freq.title}'.`,
        criterionType: 'FUNCTIONAL',
        statement,
        priority,
        status,
        sourceRequirements: [freq.requirementId],
        sourceBusinessRules: [],
        sourceArchitectureDecisions: [],
        verificationMethod,
        expectedResult,
        dependencies: freq.dependencies ?? [],
        traceability: {
          criterionId,
          requirementIds: [freq.requirementId],
          businessRuleIds: [],
          architectureDecisionIds: [],
        },
        metadata: {},
      };

      rawCriteria.push(criterion);

      // Also derive criteria from business rules declared on the requirement
      if (freq.businessRules && freq.businessRules.length > 0) {
        for (const brStr of freq.businessRules) {
          const brCriterionType = inferCriterionType(brStr);
          const brCriterionId = `AC-${computeDeterministicHash(
            `FREQ:${freq.requirementId}:BR:${brStr}:${brCriterionType}`,
            8
          ).toUpperCase()}`;
          const isBrPending =
            brStr.toLowerCase().includes('tbd') ||
            brStr.toLowerCase().includes('pending') ||
            isPending;

          rawCriteria.push({
            criterionId: brCriterionId,
            title: `${freq.title}: ${brStr.slice(0, 40).trim()}${brStr.length > 40 ? '...' : ''}`,
            description: `Acceptance criterion derived from requirement rule '${brStr}'.`,
            criterionType: brCriterionType,
            statement: `The product enforces requirement condition: ${brStr}.`,
            priority,
            status: isBrPending ? 'PENDING_DECISION' : 'DEFINED',
            sourceRequirements: [freq.requirementId],
            sourceBusinessRules: [],
            sourceArchitectureDecisions: [],
            verificationMethod: inferVerificationMethod(brStr, 'AUTOMATED_TEST'),
            expectedResult: `Observable compliance with requirement rule '${brStr}'.`,
            dependencies: [],
            traceability: {
              criterionId: brCriterionId,
              requirementIds: [freq.requirementId],
              businessRuleIds: [],
              architectureDecisionIds: [],
            },
            metadata: {},
          });
        }
      }

      if (isPending) {
        const decisionId = `ACD-${computeDeterministicHash(
          `DEC:${freq.requirementId}:${criterionId}`,
          8
        ).toUpperCase()}`;
        pendingHumanDecisions.push({
          decisionId,
          question: `What is the authoritative acceptance expectation for functional requirement '${freq.title}'?`,
          whyItMatters: `Material acceptance condition is unresolved and cannot be silently resolved for requirement ${freq.requirementId}.`,
          affectedCriteria: [criterionId],
          affectedRequirements: [freq.requirementId],
          availableOptions: [
            'Specify concrete observable acceptance condition',
            'Mark criterion not applicable',
            'Defer requirement to subsequent release',
          ],
          consequences: [
            'Product Owner must supply authoritative observable behavior before verification can pass',
          ],
          authority: Actor.USER,
          status: 'PENDING_DECISION',
        });
      }
    }

    // 6.2 Derive from Non-Functional Requirements (Measurability & No Invented Thresholds)
    for (const cat of NFR_CATEGORIES) {
      const items = requirements.nonFunctionalRequirements[cat] ?? [];
      items.forEach((item, index) => {
        const nfrId = `NFR-${cat.toUpperCase()}-${index + 1}`;
        let criterionType: AcceptanceCriterionType = 'OPERATIONAL';
        if (cat === 'performance') criterionType = 'PERFORMANCE';
        else if (cat === 'security') criterionType = 'SECURITY';
        else if (cat === 'reliability') criterionType = 'RELIABILITY';
        else if (cat === 'availability') criterionType = 'AVAILABILITY';
        else if (cat === 'usability') criterionType = 'USABILITY';
        else if (cat === 'scalability') criterionType = 'PERFORMANCE';
        else if (cat === 'operationalConstraints') criterionType = 'OPERATIONAL';

        const isMeasurable = hasAuthoritativeThreshold(item);
        const criterionId = `AC-${computeDeterministicHash(
          `NFR:${nfrId}:${criterionType}`,
          8
        ).toUpperCase()}`;

        if (isMeasurable) {
          const statement = `Under specified operational workload, the product satisfies '${cat}' requirement: ${item}.`;
          const expectedResult = `Measured ${cat} satisfies ${item} under specified test workload.`;
          const verificationMethod: VerificationMethod =
            criterionType === 'PERFORMANCE'
              ? 'PERFORMANCE_TEST'
              : criterionType === 'SECURITY'
              ? 'SECURITY_TEST'
              : 'AUTOMATED_TEST';

          rawCriteria.push({
            criterionId,
            title: `${cat.toUpperCase()}: Measurable Conformance`,
            description: `Authoritative acceptance criterion verifying measurable non-functional requirement '${item}'.`,
            criterionType,
            statement,
            priority: 'HIGH',
            status: 'DEFINED',
            sourceRequirements: [nfrId],
            sourceBusinessRules: [],
            sourceArchitectureDecisions: [],
            verificationMethod,
            expectedResult,
            dependencies: [],
            traceability: {
              criterionId,
              requirementIds: [nfrId],
              businessRuleIds: [],
              architectureDecisionIds: [],
            },
            metadata: { nfrCategory: cat, rawNfr: item },
          });
        } else {
          // NO INVENTED NUMERIC THRESHOLDS!
          // Criterion status = PENDING_DECISION rather than verificationMethod = UNRESOLVED
          const statement = `The measurable threshold for '${cat}' (${item}) is pending Product Owner specification.`;
          const expectedResult = `Authoritative threshold defined and accepted by Product Owner for ${item}.`;
          const fallbackMethod: VerificationMethod =
            criterionType === 'PERFORMANCE'
              ? 'PERFORMANCE_TEST'
              : criterionType === 'SECURITY'
              ? 'SECURITY_TEST'
              : criterionType === 'RELIABILITY' || criterionType === 'AVAILABILITY'
              ? 'PERFORMANCE_TEST'
              : 'MANUAL_VERIFICATION';

          rawCriteria.push({
            criterionId,
            title: `${cat.toUpperCase()}: Threshold Definition`,
            description: `Acceptance criterion for non-functional requirement '${item}' pending authoritative threshold definition.`,
            criterionType,
            statement,
            priority: 'MEDIUM',
            status: 'PENDING_DECISION',
            sourceRequirements: [nfrId],
            sourceBusinessRules: [],
            sourceArchitectureDecisions: [],
            verificationMethod: fallbackMethod,
            expectedResult,
            dependencies: [],
            traceability: {
              criterionId,
              requirementIds: [nfrId],
              businessRuleIds: [],
              architectureDecisionIds: [],
            },
            metadata: {
              nfrCategory: cat,
              rawNfr: item,
              unresolvedThreshold: true,
            },
          });

          const decisionId = `ACD-${computeDeterministicHash(
            `DEC:NFR:${nfrId}:THRESHOLD`,
            8
          ).toUpperCase()}`;

          pendingHumanDecisions.push({
            decisionId,
            question: `What is the authoritative measurable threshold for non-functional requirement '${cat}': "${item}"?`,
            whyItMatters: `A measurable threshold is required to verify requirement ${nfrId} without manufacturing synthetic numbers.`,
            affectedCriteria: [criterionId],
            affectedRequirements: [nfrId],
            availableOptions: [
              'Define explicit numeric target threshold (e.g. latency, availability, uptime)',
              'Designate requirement as qualitative review only',
              'Exclude requirement from current project release',
            ],
            consequences: [
              'Engine will not invent performance/operational numbers; verification remains PENDING_DECISION until specified',
            ],
            authority: Actor.USER,
            status: 'PENDING_DECISION',
          });
        }
      });
    }

    // 6.3 Derive from Business Rules (P15-05)
    for (const rule of businessRules.rules) {
      const priority: AcceptanceCriteriaPriority =
        rule.priority === 'CRITICAL' ||
        rule.priority === 'HIGH' ||
        rule.priority === 'MEDIUM' ||
        rule.priority === 'LOW'
          ? rule.priority
          : 'HIGH';

      let criterionType: AcceptanceCriterionType = 'BUSINESS_RULE';
      if (rule.category === 'VALIDATION_RULE') criterionType = 'VALIDATION';
      else if (rule.category === 'AUTHORIZATION_RULE') criterionType = 'SECURITY';
      else if (rule.category === 'STATE_TRANSITION_RULE') criterionType = 'STATE_TRANSITION';
      else if (rule.category === 'WORKFLOW_RULE') criterionType = 'WORKFLOW';
      else if (rule.category === 'INTEGRATION_RULE') criterionType = 'INTEGRATION';
      else if (rule.category === 'DATA_RULE') criterionType = 'DATA';
      else if (rule.category === 'ERROR_HANDLING_RULE') criterionType = 'RELIABILITY';
      else if (rule.category === 'AUDIT_RULE') criterionType = 'OPERATIONAL';
      else {
        const inferred = inferCriterionType(rule.statement + ' ' + rule.title);
        if (inferred !== 'FUNCTIONAL') {
          criterionType = inferred;
        }
      }

      const isRulePending =
        rule.status === 'PENDING_DECISION' ||
        rule.statement.toLowerCase().includes('tbd') ||
        rule.statement.toLowerCase().includes('undecided');

      // Authorization rules produce two complementary criteria: positive access & negative rejection
      const isAuthRule =
        rule.category === 'AUTHORIZATION_RULE' ||
        (criterionType === 'SECURITY' &&
          (rule.statement.toLowerCase().includes('authorized') ||
            rule.statement.toLowerCase().includes('authenticated') ||
            rule.statement.toLowerCase().includes('permission') ||
            rule.statement.toLowerCase().includes('verified')));

      if (isAuthRule) {
        // Criterion 1: Authorized access
        const posCriterionId = `AC-${computeDeterministicHash(
          `BR:${rule.ruleId}:AUTH:ALLOW`,
          8
        ).toUpperCase()}`;
        const posStatement = `When an authorized actor executes the operation governed by '${rule.title}', the operation is permitted and processed.`;
        const posExpected = `Authorized actor operation completes with success response and expected state mutation.`;

        rawCriteria.push({
          criterionId: posCriterionId,
          title: `${rule.title}: Authorized Execution`,
          description: `Acceptance criterion verifying authorized execution for business rule '${rule.title}'.`,
          criterionType: 'SECURITY',
          statement: posStatement,
          priority,
          status: isRulePending ? 'PENDING_DECISION' : 'DEFINED',
          sourceRequirements: rule.sourceRequirements,
          sourceBusinessRules: [rule.ruleId],
          sourceArchitectureDecisions: rule.sourceArchitectureDecisions,
          verificationMethod: 'AUTOMATED_TEST',
          expectedResult: posExpected,
          dependencies: [],
          traceability: {
            criterionId: posCriterionId,
            requirementIds: rule.sourceRequirements,
            businessRuleIds: [rule.ruleId],
            architectureDecisionIds: rule.sourceArchitectureDecisions,
          },
          metadata: { ruleCategory: rule.category },
        });

        // Criterion 2: Unauthorized rejection
        const negCriterionId = `AC-${computeDeterministicHash(
          `BR:${rule.ruleId}:AUTH:REJECT`,
          8
        ).toUpperCase()}`;
        const negStatement = `When an unauthorized actor attempts the operation governed by '${rule.title}', the operation is rejected.`;
        const negExpected = `Unauthorized request is rejected with access denied and state remains unmodified.`;

        rawCriteria.push({
          criterionId: negCriterionId,
          title: `${rule.title}: Unauthorized Rejection`,
          description: `Acceptance criterion verifying rejection of unauthorized attempts for business rule '${rule.title}'.`,
          criterionType: 'SECURITY',
          statement: negStatement,
          priority,
          status: isRulePending ? 'PENDING_DECISION' : 'DEFINED',
          sourceRequirements: rule.sourceRequirements,
          sourceBusinessRules: [rule.ruleId],
          sourceArchitectureDecisions: rule.sourceArchitectureDecisions,
          verificationMethod: 'SECURITY_TEST',
          expectedResult: negExpected,
          dependencies: [],
          traceability: {
            criterionId: negCriterionId,
            requirementIds: rule.sourceRequirements,
            businessRuleIds: [rule.ruleId],
            architectureDecisionIds: rule.sourceArchitectureDecisions,
          },
          metadata: { ruleCategory: rule.category },
        });
      } else if (rule.category === 'STATE_TRANSITION_RULE' || criterionType === 'STATE_TRANSITION') {
        const transCriterionId = `AC-${computeDeterministicHash(
          `BR:${rule.ruleId}:STATE_TRANS`,
          8
        ).toUpperCase()}`;
        const statement = `State transitions for entity governed by '${rule.title}' succeed when valid and are rejected when invalid or out-of-order.`;
        const expectedResult = `Entity transitions only through approved states; illegal transitions are rejected without corruption.`;

        rawCriteria.push({
          criterionId: transCriterionId,
          title: `${rule.title}: State Transition Enforcement`,
          description: `Acceptance criterion verifying lifecycle state transitions for business rule '${rule.title}'.`,
          criterionType: 'STATE_TRANSITION',
          statement,
          priority,
          status: isRulePending ? 'PENDING_DECISION' : 'DEFINED',
          sourceRequirements: rule.sourceRequirements,
          sourceBusinessRules: [rule.ruleId],
          sourceArchitectureDecisions: rule.sourceArchitectureDecisions,
          verificationMethod: 'AUTOMATED_TEST',
          expectedResult,
          dependencies: [],
          traceability: {
            criterionId: transCriterionId,
            requirementIds: rule.sourceRequirements,
            businessRuleIds: [rule.ruleId],
            architectureDecisionIds: rule.sourceArchitectureDecisions,
          },
          metadata: { ruleCategory: rule.category },
        });
      } else {
        // Standard business rule criterion
        const criterionId = `AC-${computeDeterministicHash(
          `BR:${rule.ruleId}:${criterionType}`,
          8
        ).toUpperCase()}`;
        const statement = `The product observably enforces business rule '${rule.title}': ${rule.statement}`;
        const expectedResult =
          rule.validationExpectation ??
          `Observable behavior complies with business rule '${rule.title}'.`;
        const verificationMethod: VerificationMethod =
          criterionType === 'VALIDATION'
            ? 'AUTOMATED_TEST'
            : criterionType === 'INTEGRATION'
            ? 'INTEGRATION_TEST'
            : inferVerificationMethod(rule.statement, 'AUTOMATED_TEST');

        rawCriteria.push({
          criterionId,
          title: `${rule.title}: Rule Enforcement`,
          description: `Acceptance criterion ensuring business rule '${rule.title}' is observably satisfied.`,
          criterionType,
          statement,
          priority,
          status: isRulePending ? 'PENDING_DECISION' : 'DEFINED',
          sourceRequirements: rule.sourceRequirements,
          sourceBusinessRules: [rule.ruleId],
          sourceArchitectureDecisions: rule.sourceArchitectureDecisions,
          verificationMethod,
          expectedResult,
          dependencies: [],
          traceability: {
            criterionId,
            requirementIds: rule.sourceRequirements,
            businessRuleIds: [rule.ruleId],
            architectureDecisionIds: rule.sourceArchitectureDecisions,
          },
          metadata: { ruleCategory: rule.category },
        });
      }

      if (isRulePending) {
        const decisionId = `ACD-${computeDeterministicHash(
          `DEC:BR:${rule.ruleId}`,
          8
        ).toUpperCase()}`;
        pendingHumanDecisions.push({
          decisionId,
          question: `How should business rule '${rule.title}' be resolved for acceptance?`,
          whyItMatters: `Underlying business rule ${rule.ruleId} has status PENDING_DECISION.`,
          affectedCriteria: rawCriteria
            .filter((c) => c.sourceBusinessRules.includes(rule.ruleId))
            .map((c) => c.criterionId),
          affectedRequirements: rule.sourceRequirements,
          availableOptions: [
            'Confirm business rule policy and thresholds',
            'Modify business rule to eliminate ambiguity',
            'Exclude rule from current milestone',
          ],
          consequences: ['Acceptance criterion remains in PENDING_DECISION until resolved'],
          authority: Actor.USER,
          status: 'PENDING_DECISION',
        });
      }
    }

    // 6.4 Derive from Architecture Decisions (Observable Product Boundary only)
    for (const decision of architecture.decisions) {
      const isObservableArea =
        decision.decisionArea === 'INTEGRATION' ||
        decision.decisionArea === 'SECURITY' ||
        decision.decisionArea === 'DEPLOYMENT' ||
        decision.decisionArea === 'PLATFORM' ||
        decision.decisionArea === 'DATA' ||
        decision.decisionArea === 'API';

      if (isObservableArea) {
        let criterionType: AcceptanceCriterionType = 'COMPATIBILITY';
        if (decision.decisionArea === 'DEPLOYMENT') criterionType = 'DEPLOYMENT';
        else if (decision.decisionArea === 'INTEGRATION') criterionType = 'INTEGRATION';
        else if (decision.decisionArea === 'SECURITY') criterionType = 'SECURITY';
        else if (decision.decisionArea === 'DATA') criterionType = 'DATA';
        else if (decision.decisionArea === 'API') criterionType = 'COMPATIBILITY';

        const criterionId = `AC-${computeDeterministicHash(
          `ARCH:${decision.decisionId}:${criterionType}`,
          8
        ).toUpperCase()}`;

        let statement = `Observable architectural requirement for '${decision.decisionArea}': ${
          decision.selectedOption ?? decision.question
        }.`;
        let expectedResult = `Product operates at its boundary in conformance with architecture decision '${decision.question}'.`;

        if (decision.decisionArea === 'API' && decision.selectedOption === 'NOT_APPLICABLE') {
          statement =
            "The product exposes a typed in-process TypeScript module API; no HTTP/REST server or endpoint is required; the module can be consumed directly in-process; the boundary conforms to architecture decision 'What communication protocol will expose external and internal interfaces?'.";
          expectedResult =
            "Product operates at its boundary as a typed in-process TypeScript module without external HTTP/REST servers or endpoints in conformance with architecture decision 'What communication protocol will expose external and internal interfaces?'.";
        }
        const verificationMethod: VerificationMethod =
          criterionType === 'DEPLOYMENT'
            ? 'DEPLOYMENT_CHECK'
            : criterionType === 'INTEGRATION'
            ? 'INTEGRATION_TEST'
            : criterionType === 'SECURITY'
            ? 'SECURITY_TEST'
            : 'AUTOMATED_TEST';

        rawCriteria.push({
          criterionId,
          title: `${decision.decisionArea}: Boundary Verification`,
          description: `Authoritative acceptance criterion ensuring product satisfies observable architectural boundary condition for '${decision.question}'.`,
          criterionType,
          statement,
          priority: 'HIGH',
          status: decision.status === 'PENDING_DECISION' ? 'PENDING_DECISION' : 'DEFINED',
          sourceRequirements: decision.affectedRequirements ?? [],
          sourceBusinessRules: [],
          sourceArchitectureDecisions: [decision.decisionId],
          verificationMethod,
          expectedResult,
          dependencies: [],
          traceability: {
            criterionId,
            requirementIds: decision.affectedRequirements ?? [],
            businessRuleIds: [],
            architectureDecisionIds: [decision.decisionId],
          },
          metadata: { decisionArea: decision.decisionArea },
        });

        if (decision.status === 'PENDING_DECISION') {
          const decisionId = `ACD-${computeDeterministicHash(
            `DEC:ARCH:${decision.decisionId}`,
            8
          ).toUpperCase()}`;
          pendingHumanDecisions.push({
            decisionId,
            question: `How should architectural decision '${decision.question}' be resolved?`,
            whyItMatters: `Architecture decision ${decision.decisionId} has status PENDING_DECISION.`,
            affectedCriteria: [criterionId],
            affectedRequirements: decision.affectedRequirements ?? [],
            availableOptions: decision.candidateOptions.length > 0 ? decision.candidateOptions : ['Define selected architecture option'],
            consequences: ['Acceptance criterion remains in PENDING_DECISION until decided'],
            authority: decision.authority || Actor.USER,
            status: 'PENDING_DECISION',
          });
        }
      }
    }

    // 6.5 Import upstream business rules human decisions & conflicts
    for (const d of businessRules.pendingHumanDecisions) {
      const decisionId = `ACD-${computeDeterministicHash(`UPSTREAM:BR:${d.decisionId}`, 8).toUpperCase()}`;
      pendingHumanDecisions.push({
        decisionId,
        question: d.question,
        whyItMatters: d.whyItMatters,
        affectedCriteria: rawCriteria
          .filter((c) =>
            d.affectedRules.some((r) => c.sourceBusinessRules.includes(r)) ||
            d.affectedRequirements.some((req) => c.sourceRequirements.includes(req))
          )
          .map((c) => c.criterionId),
        affectedRequirements: d.affectedRequirements,
        availableOptions: d.availableOptions,
        consequences: d.consequences,
        authority: d.authority ?? Actor.USER,
        status: 'PENDING_DECISION',
      });
    }

    for (const c of businessRules.conflicts) {
      const conflictId = `ACC-${computeDeterministicHash(`UPSTREAM:BR:${c.conflictId}`, 8).toUpperCase()}`;
      const affectedCriteria = rawCriteria
        .filter((cr) =>
          c.affectedRules.some((r) => cr.sourceBusinessRules.includes(r)) ||
          c.affectedRequirements.some((req) => cr.sourceRequirements.includes(req))
        )
        .map((cr) => cr.criterionId);

      conflicts.push({
        conflictId,
        affectedRequirements: c.affectedRequirements,
        affectedRules: c.affectedRules,
        affectedCriteria,
        conflictingStatements: c.conflictingStatements,
        whyItMatters: c.whyItMatters,
        requiredAuthority: c.requiredAuthority ?? Actor.USER,
        resolutionStatus: 'PENDING_DECISION',
      });

      // Mark affected criteria as PENDING_DECISION
      for (const cr of rawCriteria) {
        if (affectedCriteria.includes(cr.criterionId)) {
          cr.status = 'PENDING_DECISION';
        }
      }
    }

    return {
      baselineCriteria: rawCriteria,
      baselineDecisions: pendingHumanDecisions,
      baselineConflicts: conflicts,
    };
  }

  /**
   * Validates untrusted caller-provided additional criteria against authoritative upstream specifications.
   */
  private validateAdditionalCriteria(
    additionalCriteria: AcceptanceCriterion[],
    generatedCriteria: AcceptanceCriterion[],
    requirements: ProjectRequirementsScopeRevision,
    architecture: ProjectArchitectureRevision,
    businessRules: ProjectBusinessRulesRevision,
    currentProjectId: string
  ): void {
    const criterionIdRegex = /^AC-[A-Za-z0-9_\-]+$/;
    const generatedIds = new Set(generatedCriteria.map((c) => c.criterionId));
    const seenIds = new Set<string>();
    const seenDedupKeys = new Set<string>();

    const validReqIds = new Set<string>();
    for (const freq of requirements.functionalRequirements) {
      validReqIds.add(freq.requirementId);
    }
    for (const cat of NFR_CATEGORIES) {
      const items = requirements.nonFunctionalRequirements[cat] ?? [];
      items.forEach((_: unknown, index: number) => {
        validReqIds.add(`NFR-${cat.toUpperCase()}-${index + 1}`);
      });
    }

    const validRuleIds = new Set(businessRules.rules.map((r) => r.ruleId));
    const validArchIds = new Set(architecture.decisions.map((d) => d.decisionId));

    for (const c of additionalCriteria) {
      // 1. Identity & safe format
      if (
        !criterionIdRegex.test(c.criterionId) ||
        c.criterionId.includes('..') ||
        c.criterionId.includes('/') ||
        c.criterionId.includes('\\')
      ) {
        throw new AcceptanceCriteriaValidationError(
          `Invalid additional criterionId '${c.criterionId}': illegal format or path traversal.`,
          { criterionId: c.criterionId }
        );
      }

      // No collision with generated criteria
      if (generatedIds.has(c.criterionId)) {
        throw new AcceptanceCriteriaValidationError(
          `Criterion ID collision: additional criterion '${c.criterionId}' collides with an authoritative generated criterion.`,
          { criterionId: c.criterionId }
        );
      }

      // No duplicate ID in additional criteria
      if (seenIds.has(c.criterionId)) {
        throw new AcceptanceCriteriaValidationError(
          `Duplicate criterionId '${c.criterionId}' in additional criteria.`,
          { criterionId: c.criterionId }
        );
      }
      seenIds.add(c.criterionId);

      // No duplicate semantic identity
      const semanticKey = [
        c.criterionType,
        c.statement.trim(),
        c.expectedResult.trim(),
        [...c.sourceRequirements].sort().join(','),
        [...c.sourceBusinessRules].sort().join(','),
        [...c.sourceArchitectureDecisions].sort().join(','),
      ].join('|');
      if (seenDedupKeys.has(semanticKey)) {
        throw new AcceptanceCriteriaValidationError(
          `Duplicate semantic identity in additional criterion '${c.criterionId}'.`,
          { criterionId: c.criterionId }
        );
      }
      seenDedupKeys.add(semanticKey);

      // 2. Traceability internal consistency
      if (c.criterionId !== c.traceability?.criterionId) {
        throw new AcceptanceCriteriaValidationError(
          `Traceability mismatch in additional criterion '${c.criterionId}': criterionId does not match traceability.criterionId.`,
          { criterionId: c.criterionId }
        );
      }

      const reqSorted = [...c.sourceRequirements].sort();
      const traceReqSorted = [...(c.traceability?.requirementIds ?? [])].sort();
      if (
        reqSorted.length !== traceReqSorted.length ||
        reqSorted.some((v, i) => v !== traceReqSorted[i])
      ) {
        throw new AcceptanceCriteriaValidationError(
          `Traceability mismatch in additional criterion '${c.criterionId}': sourceRequirements does not match traceability.requirementIds.`,
          { criterionId: c.criterionId }
        );
      }

      const brSorted = [...c.sourceBusinessRules].sort();
      const traceBrSorted = [...(c.traceability?.businessRuleIds ?? [])].sort();
      if (
        brSorted.length !== traceBrSorted.length ||
        brSorted.some((v, i) => v !== traceBrSorted[i])
      ) {
        throw new AcceptanceCriteriaValidationError(
          `Traceability mismatch in additional criterion '${c.criterionId}': sourceBusinessRules does not match traceability.businessRuleIds.`,
          { criterionId: c.criterionId }
        );
      }

      const archSorted = [...c.sourceArchitectureDecisions].sort();
      const traceArchSorted = [...(c.traceability?.architectureDecisionIds ?? [])].sort();
      if (
        archSorted.length !== traceArchSorted.length ||
        archSorted.some((v, i) => v !== traceArchSorted[i])
      ) {
        throw new AcceptanceCriteriaValidationError(
          `Traceability mismatch in additional criterion '${c.criterionId}': sourceArchitectureDecisions does not match traceability.architectureDecisionIds.`,
          { criterionId: c.criterionId }
        );
      }

      // 3. Authoritative source existence
      for (const reqId of c.sourceRequirements) {
        if (!validReqIds.has(reqId)) {
          throw new AcceptanceCriteriaValidationError(
            `Nonexistent requirement reference '${reqId}' in additional criterion '${c.criterionId}'.`,
            { criterionId: c.criterionId, requirementId: reqId }
          );
        }
      }
      for (const ruleId of c.sourceBusinessRules) {
        if (!validRuleIds.has(ruleId)) {
          throw new AcceptanceCriteriaValidationError(
            `Nonexistent business rule reference '${ruleId}' in additional criterion '${c.criterionId}'.`,
            { criterionId: c.criterionId, ruleId }
          );
        }
      }
      for (const archId of c.sourceArchitectureDecisions) {
        if (!validArchIds.has(archId)) {
          throw new AcceptanceCriteriaValidationError(
            `Nonexistent architecture decision reference '${archId}' in additional criterion '${c.criterionId}'.`,
            { criterionId: c.criterionId, architectureDecisionId: archId }
          );
        }
      }

      // 4. Project context check
      if (c.metadata && typeof c.metadata === 'object') {
        const metaProj = (c.metadata as Record<string, unknown>).projectId ?? (c.metadata as Record<string, unknown>).project;
        if (typeof metaProj === 'string' && metaProj !== currentProjectId) {
          throw new AcceptanceCriteriaProjectBindingMismatchError(
            `Cross-project mismatch: additional criterion '${c.criterionId}' belongs to project '${metaProj}' but requested '${currentProjectId}'.`,
            { requestedProjectId: currentProjectId, criterionProjectId: metaProj }
          );
        }
      }

      // 5. Status and lifecycle
      if (c.status !== 'DEFINED' && c.status !== 'PENDING_DECISION' && c.status !== 'NOT_APPLICABLE') {
        throw new AcceptanceCriteriaValidationError(
          `Invalid status '${c.status}' for additional criterion '${c.criterionId}'. Allowed statuses are DEFINED, PENDING_DECISION, NOT_APPLICABLE.`,
          { criterionId: c.criterionId, status: c.status }
        );
      }

      // 6. Verification method
      if (!VERIFICATION_METHODS.includes(c.verificationMethod as VerificationMethod)) {
        throw new AcceptanceCriteriaValidationError(
          `Invalid verification method '${c.verificationMethod}' for additional criterion '${c.criterionId}'.`,
          { criterionId: c.criterionId, verificationMethod: c.verificationMethod }
        );
      }
    }
  }

  /**
   * Computes deterministic traceability reports and coverage statistics from criteria and upstream sources.
   */
  private computeTraceabilityAndCoverage(
    criteria: AcceptanceCriterion[],
    requirements: ProjectRequirementsScopeRevision,
    businessRules: ProjectBusinessRulesRevision,
    architecture: ProjectArchitectureRevision,
    pendingHumanDecisions: AcceptanceCriteriaHumanDecision[],
    uncoveredExplanations?: Record<string, string>
  ): {
    requirementsTraceability: AcceptanceCriteriaRequirementTrace[];
    businessRulesTraceability: AcceptanceCriteriaBusinessRuleTrace[];
    architectureTraceability: AcceptanceCriteriaArchitectureTrace[];
    coverage: AcceptanceCriteriaCoverage;
  } {
    const allRequirements: Array<{ id: string; title: string }> = [
      ...requirements.functionalRequirements.map((f) => ({
        id: f.requirementId,
        title: f.title,
      })),
    ];

    for (const cat of NFR_CATEGORIES) {
      const items = requirements.nonFunctionalRequirements[cat] ?? [];
      items.forEach((item, index) => {
        allRequirements.push({
          id: `NFR-${cat.toUpperCase()}-${index + 1}`,
          title: `${cat.toUpperCase()}: ${item}`,
        });
      });
    }

    allRequirements.sort((a, b) => a.id.localeCompare(b.id));

    const requirementsTraceability: AcceptanceCriteriaRequirementTrace[] = allRequirements.map(
      (req) => {
        const matchingCriteria = criteria.filter((c) => c.sourceRequirements.includes(req.id));
        const isCovered = matchingCriteria.length > 0;
        const criteriaIds = matchingCriteria.map((c) => c.criterionId).sort();
        const uncoveredReason = isCovered
          ? undefined
          : uncoveredExplanations?.[req.id] ??
            `Requirement '${req.id}' is not covered by any acceptance criteria.`;

        return {
          requirementId: req.id,
          requirementTitle: req.title,
          isCovered,
          uncoveredReason,
          criteriaIds,
        };
      }
    );

    const businessRulesTraceability: AcceptanceCriteriaBusinessRuleTrace[] = businessRules.rules
      .map((r) => {
        const matchingCriteria = criteria.filter((c) => c.sourceBusinessRules.includes(r.ruleId));
        return {
          ruleId: r.ruleId,
          ruleTitle: r.title,
          isCovered: matchingCriteria.length > 0,
          criteriaIds: matchingCriteria.map((c) => c.criterionId).sort(),
        };
      })
      .sort((a, b) => a.ruleId.localeCompare(b.ruleId));

    const architectureTraceability: AcceptanceCriteriaArchitectureTrace[] = architecture.decisions
      .map((d) => {
        const matchingCriteria = criteria.filter((c) =>
          c.sourceArchitectureDecisions.includes(d.decisionId)
        );
        const requiresVerification =
          d.decisionArea === 'PLATFORM' ||
          d.decisionArea === 'API' ||
          d.decisionArea === 'DATA' ||
          d.decisionArea === 'DEPLOYMENT' ||
          d.decisionArea === 'SECURITY' ||
          d.decisionArea === 'INTEGRATION';

        return {
          decisionId: d.decisionId,
          decisionTitle: `${d.decisionArea}: ${d.question}`,
          requiresVerification,
          criteriaIds: matchingCriteria.map((c) => c.criterionId).sort(),
        };
      })
      .sort((a, b) => a.decisionId.localeCompare(b.decisionId));

    const coveredReqIds = requirementsTraceability
      .filter((t) => t.isCovered)
      .map((t) => t.requirementId)
      .sort();
    const uncoveredReqs = requirementsTraceability
      .filter((t) => !t.isCovered)
      .sort((a, b) => a.requirementId.localeCompare(b.requirementId));
    const uncoveredReqIds = uncoveredReqs.map((t) => t.requirementId);
    const uncoveredRequirementsDetails = uncoveredReqs.map((t) => ({
      requirementId: t.requirementId,
      title: t.requirementTitle,
      reason: t.uncoveredReason ?? 'Uncovered requirement',
    }));

    const coveredRuleIds = businessRulesTraceability
      .filter((t) => t.isCovered)
      .map((t) => t.ruleId)
      .sort();
    const uncoveredRuleIds = businessRulesTraceability
      .filter((t) => !t.isCovered)
      .map((t) => t.ruleId)
      .sort();

    const archRequiring = architectureTraceability.filter((t) => t.requiresVerification);
    const archVerified = archRequiring
      .filter((t) => t.criteriaIds.length > 0)
      .map((t) => t.decisionId)
      .sort();

    const pendingDecisionCriteriaCount = criteria.filter(
      (c) => c.status === 'PENDING_DECISION'
    ).length;
    const totalPendingDecisionCount =
      pendingHumanDecisions.length + pendingDecisionCriteriaCount;

    const coverage: AcceptanceCriteriaCoverage = {
      totalRequirements: allRequirements.length,
      coveredRequirements: coveredReqIds,
      uncoveredRequirements: uncoveredReqIds,
      uncoveredRequirementsDetails,
      totalBusinessRules: businessRules.rules.length,
      coveredBusinessRules: coveredRuleIds,
      uncoveredBusinessRules: uncoveredRuleIds,
      architectureDecisionsRequiringVerification: archRequiring.length,
      architectureDecisionsVerified: archVerified,
      criteriaCount: criteria.length,
      pendingDecisionCount: totalPendingDecisionCount,
    };

    return {
      requirementsTraceability,
      businessRulesTraceability,
      architectureTraceability,
      coverage,
    };
  }

  /**
   * Verifies the authoritative integrity of a persisted Acceptance Criteria revision against upstream sources.
   * Rejects forged or tampered artifacts even if their internal fingerprint is self-consistent.
   */
  async verifyAuthoritativeIntegrity(artifact: ProjectAcceptanceCriteriaRevision): Promise<void> {
    const safeProjectId = this.acceptanceCriteriaStore.sanitizeProjectId(artifact.projectId);

    // 1. Authoritative Upstream Bindings Check
    const requirements = await this.requirementsStore.loadRevision(
      safeProjectId,
      artifact.sourceRequirementsRevision
    );
    if (!requirements) {
      throw new AcceptanceCriteriaForgedFingerprintError(
        `Authoritative requirements revision ${artifact.sourceRequirementsRevision} for project '${artifact.projectId}' does not exist. Persisted acceptance criteria artifact is forged or unbacked.`,
        { projectId: artifact.projectId, revision: artifact.sourceRequirementsRevision }
      );
    }
    if (requirements.fingerprint !== artifact.sourceRequirementsFingerprint) {
      throw new AcceptanceCriteriaForgedFingerprintError(
        `Source requirements fingerprint mismatch for project '${artifact.projectId}': artifact binds to '${artifact.sourceRequirementsFingerprint}' but authoritative requirements revision has '${requirements.fingerprint}'.`,
        { expected: requirements.fingerprint, actual: artifact.sourceRequirementsFingerprint }
      );
    }

    const architecture = await this.architectureStore.loadRevision(
      safeProjectId,
      artifact.sourceArchitectureRevision
    );
    if (!architecture) {
      throw new AcceptanceCriteriaForgedFingerprintError(
        `Authoritative architecture revision ${artifact.sourceArchitectureRevision} for project '${artifact.projectId}' does not exist. Persisted acceptance criteria artifact is forged or unbacked.`,
        { projectId: artifact.projectId, revision: artifact.sourceArchitectureRevision }
      );
    }
    if (architecture.fingerprint !== artifact.sourceArchitectureFingerprint) {
      throw new AcceptanceCriteriaForgedFingerprintError(
        `Source architecture fingerprint mismatch for project '${artifact.projectId}': artifact binds to '${artifact.sourceArchitectureFingerprint}' but authoritative architecture revision has '${architecture.fingerprint}'.`,
        { expected: architecture.fingerprint, actual: artifact.sourceArchitectureFingerprint }
      );
    }

    const businessRules = await this.businessRulesStore.loadRevision(
      safeProjectId,
      artifact.sourceBusinessRulesRevision
    );
    if (!businessRules) {
      throw new AcceptanceCriteriaForgedFingerprintError(
        `Authoritative business rules revision ${artifact.sourceBusinessRulesRevision} for project '${artifact.projectId}' does not exist. Persisted acceptance criteria artifact is forged or unbacked.`,
        { projectId: artifact.projectId, revision: artifact.sourceBusinessRulesRevision }
      );
    }
    if (businessRules.fingerprint !== artifact.sourceBusinessRulesFingerprint) {
      throw new AcceptanceCriteriaForgedFingerprintError(
        `Source business rules fingerprint mismatch for project '${artifact.projectId}': artifact binds to '${artifact.sourceBusinessRulesFingerprint}' but authoritative business rules revision has '${businessRules.fingerprint}'.`,
        { expected: businessRules.fingerprint, actual: artifact.sourceBusinessRulesFingerprint }
      );
    }

    const discovery = await this.discoveryStore.loadRevision(
      safeProjectId,
      artifact.sourceDiscoveryRevision
    );
    if (!discovery) {
      throw new AcceptanceCriteriaForgedFingerprintError(
        `Authoritative discovery revision ${artifact.sourceDiscoveryRevision} for project '${artifact.projectId}' does not exist. Persisted acceptance criteria artifact is forged or unbacked.`,
        { projectId: artifact.projectId, revision: artifact.sourceDiscoveryRevision }
      );
    }
    if (discovery.fingerprint !== artifact.sourceDiscoveryFingerprint) {
      throw new AcceptanceCriteriaForgedFingerprintError(
        `Source discovery fingerprint mismatch for project '${artifact.projectId}': artifact binds to '${artifact.sourceDiscoveryFingerprint}' but authoritative discovery revision has '${discovery.fingerprint}'.`,
        { expected: discovery.fingerprint, actual: artifact.sourceDiscoveryFingerprint }
      );
    }

    // 2. Authoritative Baseline Derivation Check
    const { baselineCriteria, baselineDecisions, baselineConflicts } =
      this.deriveBaselineCriteria(requirements, architecture, businessRules);

    const baselineMap = new Map(baselineCriteria.map((c) => [c.criterionId, c]));

    // Check each baseline criterion exists and matches exactly in artifact
    for (const baseCrit of baselineCriteria) {
      const artCrit = artifact.criteria.find((c) => c.criterionId === baseCrit.criterionId);
      if (!artCrit) {
        throw new AcceptanceCriteriaForgedFingerprintError(
          `Authoritative baseline criterion '${baseCrit.criterionId}' is missing from persisted acceptance criteria revision.`,
          { criterionId: baseCrit.criterionId }
        );
      }

      if (
        artCrit.statement !== baseCrit.statement ||
        artCrit.expectedResult !== baseCrit.expectedResult ||
        artCrit.verificationMethod !== baseCrit.verificationMethod ||
        artCrit.criterionType !== baseCrit.criterionType ||
        artCrit.priority !== baseCrit.priority ||
        artCrit.status !== baseCrit.status ||
        [...artCrit.sourceRequirements].sort().join(',') !== [...baseCrit.sourceRequirements].sort().join(',') ||
        [...artCrit.sourceBusinessRules].sort().join(',') !== [...baseCrit.sourceBusinessRules].sort().join(',') ||
        [...artCrit.sourceArchitectureDecisions].sort().join(',') !== [...baseCrit.sourceArchitectureDecisions].sort().join(',') ||
        artCrit.traceability.criterionId !== baseCrit.traceability.criterionId ||
        [...artCrit.traceability.requirementIds].sort().join(',') !== [...baseCrit.traceability.requirementIds].sort().join(',') ||
        [...artCrit.traceability.businessRuleIds].sort().join(',') !== [...baseCrit.traceability.businessRuleIds].sort().join(',') ||
        [...artCrit.traceability.architectureDecisionIds].sort().join(',') !== [...baseCrit.traceability.architectureDecisionIds].sort().join(',')
      ) {
        throw new AcceptanceCriteriaForgedFingerprintError(
          `Persisted criterion '${artCrit.criterionId}' has been modified from its authoritative upstream derivation. Field mismatch detected.`,
          { criterionId: artCrit.criterionId }
        );
      }
    }

    // 3. Check any non-baseline criteria satisfy additional criteria hardening rules
    const additionalCriteria = artifact.criteria.filter((c) => !baselineMap.has(c.criterionId));
    if (additionalCriteria.length > 0) {
      this.validateAdditionalCriteria(
        additionalCriteria,
        baselineCriteria,
        requirements,
        architecture,
        businessRules,
        artifact.projectId
      );
    }

    // 4. Check baseline human decisions and conflicts exist and match
    for (const baseDec of baselineDecisions) {
      const artDec = artifact.pendingHumanDecisions.find((d) => d.decisionId === baseDec.decisionId);
      if (
        !artDec ||
        artDec.question !== baseDec.question ||
        artDec.whyItMatters !== baseDec.whyItMatters
      ) {
        throw new AcceptanceCriteriaForgedFingerprintError(
          `Persisted human decision '${baseDec.decisionId}' has been modified from its authoritative upstream derivation.`,
          { decisionId: baseDec.decisionId }
        );
      }
    }

    for (const baseConf of baselineConflicts) {
      const artConf = artifact.conflicts.find((c) => c.conflictId === baseConf.conflictId);
      if (
        !artConf ||
        artConf.whyItMatters !== baseConf.whyItMatters ||
        [...artConf.conflictingStatements].sort().join(',') !== [...baseConf.conflictingStatements].sort().join(',')
      ) {
        throw new AcceptanceCriteriaForgedFingerprintError(
          `Persisted conflict '${baseConf.conflictId}' has been modified from its authoritative upstream derivation.`,
          { conflictId: baseConf.conflictId }
        );
      }
    }

    // 5. Recompute coverage and traceability and verify artifact matches
    const expected = this.computeTraceabilityAndCoverage(
      artifact.criteria,
      requirements,
      businessRules,
      architecture,
      artifact.pendingHumanDecisions
    );

    if (
      artifact.coverage.totalRequirements !== expected.coverage.totalRequirements ||
      artifact.coverage.totalBusinessRules !== expected.coverage.totalBusinessRules ||
      artifact.coverage.architectureDecisionsRequiringVerification !== expected.coverage.architectureDecisionsRequiringVerification ||
      artifact.coverage.criteriaCount !== artifact.criteria.length ||
      [...artifact.coverage.coveredRequirements].sort().join(',') !== [...expected.coverage.coveredRequirements].sort().join(',') ||
      [...artifact.coverage.uncoveredRequirements].sort().join(',') !== [...expected.coverage.uncoveredRequirements].sort().join(',') ||
      [...artifact.coverage.coveredBusinessRules].sort().join(',') !== [...expected.coverage.coveredBusinessRules].sort().join(',') ||
      [...artifact.coverage.uncoveredBusinessRules].sort().join(',') !== [...expected.coverage.uncoveredBusinessRules].sort().join(',') ||
      [...artifact.coverage.architectureDecisionsVerified].sort().join(',') !== [...expected.coverage.architectureDecisionsVerified].sort().join(',')
    ) {
      throw new AcceptanceCriteriaForgedFingerprintError(
        `Persisted coverage statistics do not match authoritative derivation from upstream sources.`,
        { declaredCoverage: artifact.coverage, expectedCoverage: expected.coverage }
      );
    }

    // Verify traceability reports
    for (const expTrace of expected.requirementsTraceability) {
      const artTrace = artifact.requirementsTraceability.find((t) => t.requirementId === expTrace.requirementId);
      if (
        !artTrace ||
        artTrace.isCovered !== expTrace.isCovered ||
        [...artTrace.criteriaIds].sort().join(',') !== [...expTrace.criteriaIds].sort().join(',')
      ) {
        throw new AcceptanceCriteriaForgedFingerprintError(
          `Persisted requirements traceability for '${expTrace.requirementId}' does not match authoritative derivation.`,
          { requirementId: expTrace.requirementId }
        );
      }
    }

    for (const expTrace of expected.businessRulesTraceability) {
      const artTrace = artifact.businessRulesTraceability.find((t) => t.ruleId === expTrace.ruleId);
      if (
        !artTrace ||
        artTrace.isCovered !== expTrace.isCovered ||
        [...artTrace.criteriaIds].sort().join(',') !== [...expTrace.criteriaIds].sort().join(',')
      ) {
        throw new AcceptanceCriteriaForgedFingerprintError(
          `Persisted business rules traceability for '${expTrace.ruleId}' does not match authoritative derivation.`,
          { ruleId: expTrace.ruleId }
        );
      }
    }

    for (const expTrace of expected.architectureTraceability) {
      const artTrace = artifact.architectureTraceability.find((t) => t.decisionId === expTrace.decisionId);
      if (
        !artTrace ||
        artTrace.requiresVerification !== expTrace.requiresVerification ||
        [...artTrace.criteriaIds].sort().join(',') !== [...expTrace.criteriaIds].sort().join(',')
      ) {
        throw new AcceptanceCriteriaForgedFingerprintError(
          `Persisted architecture traceability for '${expTrace.decisionId}' does not match authoritative derivation.`,
          { decisionId: expTrace.decisionId }
        );
      }
    }

    // 6. Check canonical fingerprint
    const canonicalFingerprint = computeAcceptanceCriteriaFingerprint(artifact);
    if (artifact.fingerprint !== canonicalFingerprint) {
      throw new AcceptanceCriteriaForgedFingerprintError(
        `Persisted fingerprint '${artifact.fingerprint}' does not match recomputed canonical fingerprint '${canonicalFingerprint}'.`,
        { declaredFingerprint: artifact.fingerprint, canonicalFingerprint }
      );
    }
  }

  /**
   * Retrieves latest acceptance criteria revision for a project.
   */
  async getLatest(projectId: string): Promise<ProjectAcceptanceCriteriaRevision | null> {
    const result = await this.acceptanceCriteriaStore.loadRevision(projectId);
    if (!result) return null;
    await this.verifyAuthoritativeIntegrity(result);
    const isStale = await this.isRevisionStale(result);
    return { ...result, isStale };
  }

  /**
   * Retrieves specific acceptance criteria revision for a project.
   */
  async getRevision(
    projectId: string,
    revision: number
  ): Promise<ProjectAcceptanceCriteriaRevision | null> {
    const result = await this.acceptanceCriteriaStore.loadRevision(projectId, revision);
    if (!result) return null;
    await this.verifyAuthoritativeIntegrity(result);
    const isStale = await this.isRevisionStale(result);
    return { ...result, isStale };
  }

  /**
   * Checks whether an acceptance criteria revision is stale relative to latest requirements, architecture, business rules, or discovery.
   */
  async isRevisionStale(revision: ProjectAcceptanceCriteriaRevision): Promise<boolean> {
    const safeProjectId = this.acceptanceCriteriaStore.sanitizeProjectId(revision.projectId);

    // Check requirements
    const latestRequirements = await this.requirementsStore.loadRevision(safeProjectId);
    if (!latestRequirements) return true;
    if (latestRequirements.requirementsRevision !== revision.sourceRequirementsRevision) return true;
    if (latestRequirements.fingerprint !== revision.sourceRequirementsFingerprint) return true;

    // Check architecture
    const latestArchitecture = await this.architectureStore.loadRevision(safeProjectId);
    if (!latestArchitecture) return true;
    if (latestArchitecture.architectureRevision !== revision.sourceArchitectureRevision) return true;
    if (latestArchitecture.fingerprint !== revision.sourceArchitectureFingerprint) return true;

    // Check business rules
    const latestBusinessRules = await this.businessRulesStore.loadRevision(safeProjectId);
    if (!latestBusinessRules) return true;
    if (latestBusinessRules.businessRulesRevision !== revision.sourceBusinessRulesRevision) return true;
    if (latestBusinessRules.fingerprint !== revision.sourceBusinessRulesFingerprint) return true;

    // Check discovery
    const latestDiscovery = await this.discoveryStore.loadRevision(safeProjectId);
    if (!latestDiscovery) return true;
    if (latestDiscovery.discoveryRevision !== revision.sourceDiscoveryRevision) return true;
    if (latestDiscovery.fingerprint !== revision.sourceDiscoveryFingerprint) return true;

    return false;
  }
}

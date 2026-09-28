/**
 * Business Rules Definition Engine (Phase 15 TASK-P15-05)
 *
 * Transforms authoritative Requirements / Scope (P15-03), Architecture / Technology (P15-04),
 * and Discovery (P15-01) into an explicit, structured, revisioned Business Rules specification
 * for Project Initiation.
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. P15-05 consumes P15-03, P15-04, and P15-01; does NOT independently reconstruct requirements from raw discovery.
 * 2. Does NOT approve the project, authorize development, or invoke Antigravity.
 * 3. Human decision points can NEVER be silently resolved by the engine (cancellation policy, refund, limits, etc.).
 * 4. Business authorization rules describe product domain permissions, NOT AIDM internal execution authorization.
 * 5. Strictly deterministic: identical inputs produce identical business rules and fingerprint.
 * 6. Revision-bound: immutable by revision, protects against stale requirements, architecture, and discovery.
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
import {
  BusinessRulesInputZodSchema,
  type BusinessRulesInput,
  type ProjectBusinessRulesRevision,
  type BusinessRule,
  type BusinessRuleCategory,
  type BusinessRulePriority,
  type BusinessRuleStatus,
  type BusinessRuleHumanDecision,
  type BusinessRuleConflict,
  type BusinessRuleTraceabilityLink,
} from './business-rules-types.js';
import {
  BusinessRulesValidationError,
  BusinessRulesRevisionNotFoundError,
  BusinessRulesProjectBindingMismatchError,
  BusinessRulesStaleSourceError,
  BusinessRulesForgedFingerprintError,
  BusinessRulesDependencyError,
} from './business-rules-errors.js';
import {
  computeDeterministicFingerprint,
  computeDeterministicHash,
} from './adaptive-discovery-normalizer.js';

export interface BusinessRulesEngineOptions {
  readonly workspaceRoot?: string;
  readonly baseDir?: string;
  readonly discoveryStore?: AdaptiveDiscoveryStore;
  readonly completenessStore?: CompletenessGateStore;
  readonly requirementsStore?: RequirementsScopeStore;
  readonly architectureStore?: ArchitectureTechnologyStore;
  readonly businessRulesStore?: BusinessRulesStore;
  readonly historyManager?: HistoryManager;
  readonly specStore?: SpecStore;
}

export class BusinessRulesEngine {
  readonly workspaceRoot?: string;
  readonly baseDir: string;
  readonly discoveryStore: AdaptiveDiscoveryStore;
  readonly completenessStore: CompletenessGateStore;
  readonly requirementsStore: RequirementsScopeStore;
  readonly architectureStore: ArchitectureTechnologyStore;
  readonly businessRulesStore: BusinessRulesStore;
  private readonly historyManager?: HistoryManager;
  private readonly specStore?: SpecStore;

  constructor(options?: BusinessRulesEngineOptions) {
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
  }

  /**
   * Derives an authoritative, revisioned Business Rules specification.
   */
  async derive(input: BusinessRulesInput): Promise<ProjectBusinessRulesRevision> {
    const parsedInput = BusinessRulesInputZodSchema.safeParse(input);
    if (!parsedInput.success) {
      throw new BusinessRulesValidationError(
        `Business rules input validation failed: ${parsedInput.error.message}`,
        { issues: parsedInput.error.issues }
      );
    }

    const { projectId } = parsedInput.data;
    const safeProjectId = this.businessRulesStore.sanitizeProjectId(projectId);

    // 1. Authoritative Upstream: Requirements & Scope (P15-03)
    const requirements = await this.requirementsStore.loadRevision(
      safeProjectId,
      parsedInput.data.requirementsRevision
    );
    if (!requirements) {
      throw new BusinessRulesRevisionNotFoundError(
        `No requirements revision found for project '${projectId}'${
          parsedInput.data.requirementsRevision !== undefined
            ? ` at revision ${parsedInput.data.requirementsRevision}`
            : ''
        }. Requirements & Scope must be defined (P15-03) before Business Rules can be defined.`,
        { projectId, requestedRevision: parsedInput.data.requirementsRevision }
      );
    }

    if (requirements.projectId !== projectId) {
      throw new BusinessRulesProjectBindingMismatchError(
        `Cross-project mismatch: requirements belong to '${requirements.projectId}' but requested '${projectId}'.`,
        { requestedProjectId: projectId, requirementsProjectId: requirements.projectId }
      );
    }

    if (
      parsedInput.data.expectedRequirementsFingerprint &&
      requirements.fingerprint !== parsedInput.data.expectedRequirementsFingerprint
    ) {
      throw new BusinessRulesForgedFingerprintError(
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
      throw new BusinessRulesRevisionNotFoundError(
        `No architecture revision found for project '${projectId}'${
          parsedInput.data.architectureRevision !== undefined
            ? ` at revision ${parsedInput.data.architectureRevision}`
            : ''
        }. Architecture & Technology must be defined (P15-04) before Business Rules can be defined.`,
        { projectId, requestedRevision: parsedInput.data.architectureRevision }
      );
    }

    if (architecture.projectId !== projectId) {
      throw new BusinessRulesProjectBindingMismatchError(
        `Cross-project mismatch: architecture belongs to '${architecture.projectId}' but requested '${projectId}'.`,
        { requestedProjectId: projectId, architectureProjectId: architecture.projectId }
      );
    }

    if (
      parsedInput.data.expectedArchitectureFingerprint &&
      architecture.fingerprint !== parsedInput.data.expectedArchitectureFingerprint
    ) {
      throw new BusinessRulesForgedFingerprintError(
        `Architecture fingerprint mismatch for project '${projectId}': expected '${parsedInput.data.expectedArchitectureFingerprint}' but got '${architecture.fingerprint}'.`,
        {
          expected: parsedInput.data.expectedArchitectureFingerprint,
          actual: architecture.fingerprint,
        }
      );
    }

    // 3. Authoritative Upstream: Adaptive Discovery (P15-01)
    const discovery = await this.discoveryStore.loadRevision(
      safeProjectId,
      parsedInput.data.discoveryRevision ?? requirements.sourceDiscoveryRevision
    );
    if (!discovery) {
      throw new BusinessRulesRevisionNotFoundError(
        `No discovery revision found for project '${projectId}' at revision ${
          parsedInput.data.discoveryRevision ?? requirements.sourceDiscoveryRevision
        }.`,
        { projectId, requestedRevision: parsedInput.data.discoveryRevision }
      );
    }

    if (discovery.projectId !== projectId) {
      throw new BusinessRulesProjectBindingMismatchError(
        `Cross-project mismatch: discovery belongs to '${discovery.projectId}' but requested '${projectId}'.`,
        { requestedProjectId: projectId, discoveryProjectId: discovery.projectId }
      );
    }

    if (
      parsedInput.data.expectedDiscoveryFingerprint &&
      discovery.fingerprint !== parsedInput.data.expectedDiscoveryFingerprint
    ) {
      throw new BusinessRulesForgedFingerprintError(
        `Discovery fingerprint mismatch for project '${projectId}': expected '${parsedInput.data.expectedDiscoveryFingerprint}' but got '${discovery.fingerprint}'.`,
        {
          expected: parsedInput.data.expectedDiscoveryFingerprint,
          actual: discovery.fingerprint,
        }
      );
    }

    // 4. Stale source checks
    const latestRequirements = await this.requirementsStore.loadRevision(safeProjectId);
    if (
      latestRequirements &&
      latestRequirements.requirementsRevision > requirements.requirementsRevision
    ) {
      throw new BusinessRulesStaleSourceError(
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
      throw new BusinessRulesStaleSourceError(
        `Stale architecture revision: provided revision ${architecture.architectureRevision} is superseded by latest revision ${latestArchitecture.architectureRevision}.`,
        {
          currentRevision: architecture.architectureRevision,
          latestRevision: latestArchitecture.architectureRevision,
        }
      );
    }

    const latestDiscovery = await this.discoveryStore.loadRevision(safeProjectId);
    if (latestDiscovery && latestDiscovery.discoveryRevision > discovery.discoveryRevision) {
      throw new BusinessRulesStaleSourceError(
        `Stale discovery revision: provided revision ${discovery.discoveryRevision} is superseded by latest revision ${latestDiscovery.discoveryRevision}.`,
        {
          currentRevision: discovery.discoveryRevision,
          latestRevision: latestDiscovery.discoveryRevision,
        }
      );
    }

    // 5. Rule Extraction & Categorization
    const rawRules: BusinessRule[] = [];
    const pendingHumanDecisions: BusinessRuleHumanDecision[] = [];
    const conflicts: BusinessRuleConflict[] = [];

    // Helper: Categorize rule statement based on domain vocabulary
    const categorizeStatement = (statement: string): BusinessRuleCategory => {
      const lower = statement.toLowerCase();
      if (
        lower.includes('authorized') ||
        lower.includes('permission') ||
        lower.includes('role') ||
        lower.includes('actor') ||
        lower.includes('only authenticated') ||
        lower.includes('only account') ||
        lower.includes('only authorized') ||
        lower.includes('only admin') ||
        lower.includes('allow') ||
        lower.includes('deny') ||
        lower.includes('may not perform')
      ) {
        return 'AUTHORIZATION_RULE';
      }
      if (
        lower.includes('transition') ||
        lower.includes('from cancelled') ||
        lower.includes('from active') ||
        lower.includes('state') ||
        lower.includes('lifecycle') ||
        lower.includes('status cannot')
      ) {
        return 'STATE_TRANSITION_RULE';
      }
      if (
        lower.includes('hours') ||
        lower.includes('days') ||
        lower.includes('before') ||
        lower.includes('after') ||
        lower.includes('deadline') ||
        lower.includes('cooldown') ||
        lower.includes('expiration') ||
        lower.includes('retention') ||
        lower.includes('schedule') ||
        lower.includes('periodic')
      ) {
        return 'TEMPORAL_RULE';
      }
      if (
        lower.includes('must equal') ||
        lower.includes('sum of') ||
        lower.includes('calculate') ||
        lower.includes('total') ||
        lower.includes('formula') ||
        lower.includes('arithmetic')
      ) {
        return 'CALCULATION_RULE';
      }
      if (
        lower.includes('maximum') ||
        lower.includes('minimum') ||
        lower.includes('limit') ||
        lower.includes('at most') ||
        lower.includes('at least') ||
        lower.includes('quota') ||
        lower.includes('cap') ||
        lower.includes('cannot exceed')
      ) {
        return 'LIMIT_RULE';
      }
      if (
        lower.includes('eligible') ||
        lower.includes('qualify') ||
        lower.includes('prerequisite') ||
        lower.includes('entitled')
      ) {
        return 'ELIGIBILITY_RULE';
      }
      if (
        lower.includes('valid') ||
        lower.includes('format') ||
        lower.includes('required field') ||
        lower.includes('must not be empty') ||
        lower.includes('schema') ||
        lower.includes('length')
      ) {
        return 'VALIDATION_RULE';
      }
      if (
        lower.includes('workflow') ||
        lower.includes('step') ||
        lower.includes('sequence') ||
        lower.includes('before starting') ||
        lower.includes('order of operations')
      ) {
        return 'WORKFLOW_RULE';
      }
      if (
        lower.includes('notify') ||
        lower.includes('notification') ||
        lower.includes('email') ||
        lower.includes('alert') ||
        lower.includes('message')
      ) {
        return 'NOTIFICATION_RULE';
      }
      if (
        lower.includes('audit') ||
        lower.includes('log') ||
        lower.includes('trail') ||
        lower.includes('traceable')
      ) {
        return 'AUDIT_RULE';
      }
      if (
        lower.includes('error') ||
        lower.includes('fail') ||
        lower.includes('retry') ||
        lower.includes('fallback') ||
        lower.includes('recover')
      ) {
        return 'ERROR_HANDLING_RULE';
      }
      if (
        lower.includes('sync') ||
        lower.includes('integration') ||
        lower.includes('webhook') ||
        lower.includes('external api') ||
        lower.includes('third-party')
      ) {
        return 'INTEGRATION_RULE';
      }
      if (
        lower.includes('data') ||
        lower.includes('storage') ||
        lower.includes('field') ||
        lower.includes('entity')
      ) {
        return 'DATA_RULE';
      }
      if (
        lower.includes('policy') ||
        lower.includes('terms') ||
        lower.includes('compliance') ||
        lower.includes('legal')
      ) {
        return 'POLICY_RULE';
      }
      return 'DOMAIN_INVARIANT';
    };

    // 5.1 Extract rules from Functional Requirements
    for (const freq of requirements.functionalRequirements) {
      const priority: BusinessRulePriority = freq.priority ?? 'UNRESOLVED';
      const status: BusinessRuleStatus =
        freq.status === 'PENDING_DECISION'
          ? 'PENDING_DECISION'
          : freq.status === 'PROPOSED'
          ? 'PROPOSED'
          : 'CONFIRMED';

      if (freq.businessRules && freq.businessRules.length > 0) {
        for (const ruleStr of freq.businessRules) {
          const category = categorizeStatement(ruleStr);
          const isPendingText =
            ruleStr.toLowerCase().includes('tbd') ||
            ruleStr.toLowerCase().includes('pending') ||
            ruleStr.toLowerCase().includes('undecided');
          const ruleStatus: BusinessRuleStatus = isPendingText
            ? 'PENDING_DECISION'
            : status;

          const title = `${freq.title}: ${ruleStr.slice(0, 40).trim()}${
            ruleStr.length > 40 ? '...' : ''
          }`;
          const ruleId = `BR-${computeDeterministicHash(
            `${ruleStr}:${category}:${freq.requirementId}`,
            8
          ).toUpperCase()}`;

          // Specific extensions where applicable
          let temporalDetails = undefined;
          if (category === 'TEMPORAL_RULE') {
            temporalDetails = {
              windowDuration: ruleStr.match(/(\d+\s*(?:hours|days|minutes|seconds))/i)?.[1],
              deadline: ruleStr.match(/(?:before|after)\s*([^,.]+)/i)?.[1]?.trim(),
              isUnresolved: ruleStatus === 'PENDING_DECISION',
            };
          }

          let stateTransitionDetails = undefined;
          if (category === 'STATE_TRANSITION_RULE') {
            const entityMatch = freq.title.split(' ')[0] ?? 'Entity';
            stateTransitionDetails = {
              entity: entityMatch,
              currentState: 'ACTIVE',
              allowedTransitions: [],
              forbiddenTransitions: [],
              conditions: [ruleStr],
            };
          }

          let validationCalculationDetails = undefined;
          if (category === 'CALCULATION_RULE' || category === 'VALIDATION_RULE' || category === 'LIMIT_RULE') {
            validationCalculationDetails = {
              fields: [],
              constraints: [ruleStr],
            };
          }

          let authorizationPolicyDetails = undefined;
          if (category === 'AUTHORIZATION_RULE' || category === 'POLICY_RULE') {
            const actorMatch = ruleStr.match(/(?:only|an?)\s+([a-zA-Z\s]+?)\s+(?:may|can|is allowed)/i)?.[1]?.trim() ?? 'Authorized User';
            authorizationPolicyDetails = {
              actor: actorMatch,
              operation: freq.title,
              requiredCondition: ruleStr,
              effect: 'ALLOW' as const,
            };
          }

          rawRules.push({
            ruleId,
            title,
            description: `Business rule governing ${freq.title}`,
            category,
            statement: ruleStr,
            priority,
            status: ruleStatus,
            sourceReferences: [freq.source],
            sourceRequirements: [freq.requirementId],
            sourceArchitectureDecisions: [],
            sourceDiscoveryReferences: [freq.source],
            affectedRequirements: [freq.requirementId],
            affectedArchitectureAreas: [],
            dependencies: [],
            validationExpectation: `Verification that ${ruleStr}`,
            ...(temporalDetails !== undefined ? { temporalDetails } : {}),
            ...(stateTransitionDetails !== undefined ? { stateTransitionDetails } : {}),
            ...(validationCalculationDetails !== undefined
              ? { validationCalculationDetails }
              : {}),
            ...(authorizationPolicyDetails !== undefined
              ? { authorizationPolicyDetails }
              : {}),
            metadata: {},
          });
        }
      } else {
        // Derive domain invariant from requirement description
        const category = categorizeStatement(freq.description);
        const title = `${freq.title} Rule`;
        const statement = freq.description;
        const ruleId = `BR-${computeDeterministicHash(
          `${statement}:${category}:${freq.requirementId}`,
          8
        ).toUpperCase()}`;

        rawRules.push({
          ruleId,
          title,
          description: `Authoritative domain requirement rule for ${freq.title}`,
          category,
          statement,
          priority,
          status,
          sourceReferences: [freq.source],
          sourceRequirements: [freq.requirementId],
          sourceArchitectureDecisions: [],
          sourceDiscoveryReferences: [freq.source],
          affectedRequirements: [freq.requirementId],
          affectedArchitectureAreas: [],
          dependencies: [],
          validationExpectation: `Verification that ${statement}`,
          metadata: {},
        });
      }
    }

    // 5.2 Extract rules from Constraints
    const constraints = requirements.constraints;
    if (constraints.legalComplianceConstraints && constraints.legalComplianceConstraints.length > 0) {
      for (const comp of constraints.legalComplianceConstraints) {
        const ruleId = `BR-${computeDeterministicHash(`COMPLIANCE:${comp}`, 8).toUpperCase()}`;
        rawRules.push({
          ruleId,
          title: `Compliance Rule: ${comp.slice(0, 30)}`,
          description: 'Legal & Regulatory compliance rule',
          category: 'POLICY_RULE',
          statement: comp,
          priority: 'CRITICAL',
          status: 'CONSTRAINED',
          sourceReferences: ['REQS-CONSTRAINTS-LEGAL'],
          sourceRequirements: [],
          sourceArchitectureDecisions: [],
          sourceDiscoveryReferences: ['constraints.legalComplianceConstraints'],
          affectedRequirements: [],
          affectedArchitectureAreas: ['SECURITY'],
          dependencies: [],
          validationExpectation: `Compliance audit verification for ${comp}`,
          metadata: {},
        });
      }
    }

    if (constraints.operationalConstraints && constraints.operationalConstraints.length > 0) {
      for (const op of constraints.operationalConstraints) {
        const ruleId = `BR-${computeDeterministicHash(`OP_CONSTRAINT:${op}`, 8).toUpperCase()}`;
        rawRules.push({
          ruleId,
          title: `Operational Constraint: ${op.slice(0, 30)}`,
          description: 'Operational domain limit rule',
          category: 'LIMIT_RULE',
          statement: op,
          priority: 'HIGH',
          status: 'CONSTRAINED',
          sourceReferences: ['REQS-CONSTRAINTS-OPERATIONAL'],
          sourceRequirements: [],
          sourceArchitectureDecisions: [],
          sourceDiscoveryReferences: ['constraints.operationalConstraints'],
          affectedRequirements: [],
          affectedArchitectureAreas: [],
          dependencies: [],
          validationExpectation: `System limit enforcement verification for ${op}`,
          metadata: {},
        });
      }
    }

    // 5.3 Extract rules from Architecture & Technology (P15-04)
    if (architecture.dataArchitecture.retentionRequirements && architecture.dataArchitecture.retentionRequirements.length > 0) {
      for (const ret of architecture.dataArchitecture.retentionRequirements) {
        const ruleId = `BR-${computeDeterministicHash(`RETENTION:${ret}`, 8).toUpperCase()}`;
        rawRules.push({
          ruleId,
          title: `Data Retention Policy: ${ret.slice(0, 30)}`,
          description: 'Data lifecycle and retention temporal rule',
          category: 'TEMPORAL_RULE',
          statement: ret,
          priority: 'HIGH',
          status: 'CONFIRMED',
          sourceReferences: ['ARCH-DATA-RETENTION'],
          sourceRequirements: [],
          sourceArchitectureDecisions: [],
          sourceDiscoveryReferences: ['architecture.dataArchitecture'],
          affectedRequirements: [],
          affectedArchitectureAreas: ['DATA_PERSISTENCE'],
          dependencies: [],
          temporalDetails: {
            retentionPeriod: ret,
            isUnresolved: false,
          },
          validationExpectation: `Retention schedule enforcement verification for ${ret}`,
          metadata: {},
        });
      }
    }

    if (architecture.integrations && architecture.integrations.length > 0) {
      for (const integ of architecture.integrations) {
        const ruleId = `BR-${computeDeterministicHash(`INTEG:${integ.integrationId}`, 8).toUpperCase()}`;
        rawRules.push({
          ruleId,
          title: `Integration Boundary: ${integ.system}`,
          description: `Domain boundary rule for integration with ${integ.system}`,
          category: 'INTEGRATION_RULE',
          statement: `System must interact with ${integ.system} for purpose: ${integ.purpose}${
            integ.protocol ? ` via protocol ${integ.protocol}` : ''
          }.`,
          priority: 'HIGH',
          status: integ.status === 'PENDING_DECISION' ? 'PENDING_DECISION' : 'CONFIRMED',
          sourceReferences: [integ.integrationId, integ.source],
          sourceRequirements: [...integ.affectedRequirements],
          sourceArchitectureDecisions: [],
          sourceDiscoveryReferences: ['architecture.integrations'],
          affectedRequirements: [...integ.affectedRequirements],
          affectedArchitectureAreas: ['INTEGRATION'],
          dependencies: [],
          validationExpectation: `Integration contract verification with ${integ.system}`,
          metadata: {},
        });
      }
    }

    // 5.4 Implicit Rules & Human Decision Boundary (Section 9, 11)
    // Undecided scope items from Requirements
    if (requirements.undecidedScope && requirements.undecidedScope.length > 0) {
      for (const undecided of requirements.undecidedScope) {
        const decisionId = `BD-${computeDeterministicHash(`SCOPE:${undecided.id}:${undecided.topic}`, 8).toUpperCase()}`;
        const ruleId = `BR-${computeDeterministicHash(`UNDECIDED:${undecided.id}`, 8).toUpperCase()}`;

        pendingHumanDecisions.push({
          decisionId,
          question: `Unresolved domain policy for ${undecided.topic}: ${undecided.description}`,
          whyItMatters: undecided.whyItMatters,
          affectedRules: [ruleId],
          affectedRequirements: [],
          availableOptions: undecided.availableOptions,
          consequences: [
            `Choosing an option defines the authoritative business policy for ${undecided.topic}.`,
          ],
          authority: Actor.USER,
          status: 'PENDING_DECISION',
        });

        rawRules.push({
          ruleId,
          title: `Pending Policy: ${undecided.topic}`,
          description: `Domain policy awaiting Product Owner resolution: ${undecided.description}`,
          category: 'POLICY_RULE',
          statement: `Domain behavior for ${undecided.topic} is pending Product Owner decision. Available options: ${undecided.availableOptions.join(', ')}`,
          priority: 'UNRESOLVED',
          status: 'PENDING_DECISION',
          sourceReferences: [undecided.id],
          sourceRequirements: [],
          sourceArchitectureDecisions: [],
          sourceDiscoveryReferences: ['requirements.undecidedScope'],
          affectedRequirements: [],
          affectedArchitectureAreas: [],
          dependencies: [],
          validationExpectation: `Verification against selected policy once resolved`,
          metadata: {},
        });
      }
    }

    // Pending human decisions from Architecture
    if (architecture.pendingHumanDecisions && architecture.pendingHumanDecisions.length > 0) {
      for (const archDecision of architecture.pendingHumanDecisions) {
        const decisionId = `BD-${computeDeterministicHash(`ARCH:${archDecision.decisionId}`, 8).toUpperCase()}`;
        pendingHumanDecisions.push({
          decisionId,
          question: archDecision.question,
          whyItMatters: archDecision.whyItMatters,
          affectedRules: [],
          affectedRequirements: archDecision.affectedRequirements,
          availableOptions: archDecision.availableOptions,
          consequences: archDecision.consequences,
          authority: Actor.USER,
          status: 'PENDING_DECISION',
        });
      }
    }

    // 5.5 Incorporate additional rules from input (with validation)
    if (parsedInput.data.additionalRules) {
      for (const addRule of parsedInput.data.additionalRules) {
        rawRules.push(addRule);
      }
    }

    // 5.6 Incorporate custom decisions from input
    if (parsedInput.data.customDecisions) {
      for (const decision of parsedInput.data.customDecisions) {
        pendingHumanDecisions.push(decision);
      }
    }

    // 5.7 Incorporate explicit conflicts from input
    if (parsedInput.data.conflicts) {
      for (const conf of parsedInput.data.conflicts) {
        conflicts.push(conf);
        // Mark all affected rules as PENDING_DECISION
        for (const affRuleId of conf.affectedRules) {
          const matchingRule = rawRules.find((r) => r.ruleId === affRuleId);
          if (matchingRule) {
            matchingRule.status = 'PENDING_DECISION';
          }
        }
      }
    }

    // 6. Automatic Conflict Detection (Section 12)
    // Detect contradictory rules (e.g. opposing statements, opposing permissions, or mutual exclusion)
    const ruleByStatementMap = new Map<string, BusinessRule[]>();
    for (const rule of rawRules) {
      const normalizedKey = rule.statement.trim().toLowerCase();
      if (!ruleByStatementMap.has(normalizedKey)) {
        ruleByStatementMap.set(normalizedKey, []);
      }
      ruleByStatementMap.get(normalizedKey)!.push(rule);
    }

    // Detect semantic conflicts (e.g. ALLOW vs DENY on same actor/operation, or explicit opposites)
    for (let i = 0; i < rawRules.length; i++) {
      for (let j = i + 1; j < rawRules.length; j++) {
        const ruleA = rawRules[i]!;
        const ruleB = rawRules[j]!;

        // Check if authorization conflict (same actor & operation, but one allows and one denies)
        if (
          ruleA.authorizationPolicyDetails &&
          ruleB.authorizationPolicyDetails &&
          ruleA.authorizationPolicyDetails.actor.toLowerCase() ===
            ruleB.authorizationPolicyDetails.actor.toLowerCase() &&
          ruleA.authorizationPolicyDetails.operation.toLowerCase() ===
            ruleB.authorizationPolicyDetails.operation.toLowerCase() &&
          ruleA.authorizationPolicyDetails.effect !== ruleB.authorizationPolicyDetails.effect
        ) {
          const conflictId = `BRC-${computeDeterministicHash(
            `${ruleA.ruleId}::${ruleB.ruleId}`,
            8
          ).toUpperCase()}`;

          if (!conflicts.some((c) => c.conflictId === conflictId)) {
            conflicts.push({
              conflictId,
              affectedRules: [ruleA.ruleId, ruleB.ruleId].sort(),
              affectedRequirements: [
                ...new Set([...ruleA.affectedRequirements, ...ruleB.affectedRequirements]),
              ].sort(),
              conflictingStatements: [ruleA.statement, ruleB.statement].sort(),
              sourceReferences: [
                ...new Set([...ruleA.sourceReferences, ...ruleB.sourceReferences]),
              ].sort(),
              whyItMatters: `Conflicting authorization policy for actor '${ruleA.authorizationPolicyDetails.actor}' on operation '${ruleA.authorizationPolicyDetails.operation}'.`,
              resolutionStatus: 'PENDING_DECISION',
              requiredAuthority: Actor.USER,
            });
            ruleA.status = 'PENDING_DECISION';
            ruleB.status = 'PENDING_DECISION';
          }
        }

        // Check direct statement contradiction (e.g. "always allow X" vs "never allow X" or contradictory limits)
        const stmtALower = ruleA.statement.toLowerCase();
        const stmtBLower = ruleB.statement.toLowerCase();
        const isContradiction =
          (stmtALower.includes('allow') && stmtBLower.includes('cannot') && stmtALower.replace('allow', '') === stmtBLower.replace('cannot', '')) ||
          (stmtALower.includes('required') && stmtBLower.includes('optional') && stmtALower.replace('required', '') === stmtBLower.replace('optional', ''));

        if (isContradiction) {
          const conflictId = `BRC-${computeDeterministicHash(
            `${ruleA.ruleId}::${ruleB.ruleId}:CONTRADICTION`,
            8
          ).toUpperCase()}`;

          if (!conflicts.some((c) => c.conflictId === conflictId)) {
            conflicts.push({
              conflictId,
              affectedRules: [ruleA.ruleId, ruleB.ruleId].sort(),
              affectedRequirements: [
                ...new Set([...ruleA.affectedRequirements, ...ruleB.affectedRequirements]),
              ].sort(),
              conflictingStatements: [ruleA.statement, ruleB.statement].sort(),
              sourceReferences: [
                ...new Set([...ruleA.sourceReferences, ...ruleB.sourceReferences]),
              ].sort(),
              whyItMatters: `Contradictory business rules detected: '${ruleA.statement}' vs '${ruleB.statement}'.`,
              resolutionStatus: 'PENDING_DECISION',
              requiredAuthority: Actor.USER,
            });
            ruleA.status = 'PENDING_DECISION';
            ruleB.status = 'PENDING_DECISION';
          }
        }
      }
    }

    // 7. Deterministic Deduplication (Section 20 & 31)
    const deduplicatedMap = new Map<string, BusinessRule>();

    for (const rule of rawRules) {
      const dedupeKey = `${rule.category}::${rule.statement.trim().toLowerCase()}`;
      if (!deduplicatedMap.has(dedupeKey)) {
        deduplicatedMap.set(dedupeKey, {
          ...rule,
          sourceReferences: [...new Set(rule.sourceReferences)].sort(),
          sourceRequirements: [...new Set(rule.sourceRequirements)].sort(),
          sourceArchitectureDecisions: [...new Set(rule.sourceArchitectureDecisions)].sort(),
          sourceDiscoveryReferences: [...new Set(rule.sourceDiscoveryReferences)].sort(),
          affectedRequirements: [...new Set(rule.affectedRequirements)].sort(),
          affectedArchitectureAreas: [...new Set(rule.affectedArchitectureAreas)].sort(),
          dependencies: [...new Set(rule.dependencies)].sort(),
        });
      } else {
        const existing = deduplicatedMap.get(dedupeKey)!;
        existing.sourceReferences = [
          ...new Set([...existing.sourceReferences, ...rule.sourceReferences]),
        ].sort();
        existing.sourceRequirements = [
          ...new Set([...existing.sourceRequirements, ...rule.sourceRequirements]),
        ].sort();
        existing.sourceArchitectureDecisions = [
          ...new Set([...existing.sourceArchitectureDecisions, ...rule.sourceArchitectureDecisions]),
        ].sort();
        existing.sourceDiscoveryReferences = [
          ...new Set([...existing.sourceDiscoveryReferences, ...rule.sourceDiscoveryReferences]),
        ].sort();
        existing.affectedRequirements = [
          ...new Set([...existing.affectedRequirements, ...rule.affectedRequirements]),
        ].sort();
        existing.affectedArchitectureAreas = [
          ...new Set([...existing.affectedArchitectureAreas, ...rule.affectedArchitectureAreas]),
        ].sort();
        existing.dependencies = [
          ...new Set([...existing.dependencies, ...rule.dependencies]),
        ].sort();

        // Status precedence: PENDING_DECISION > PROPOSED > CONSTRAINED > CONFIRMED
        if (rule.status === 'PENDING_DECISION' || existing.status === 'PENDING_DECISION') {
          existing.status = 'PENDING_DECISION';
        } else if (rule.status === 'PROPOSED' || existing.status === 'PROPOSED') {
          existing.status = 'PROPOSED';
        }

        // Priority precedence: CRITICAL > HIGH > MEDIUM > LOW > UNRESOLVED
        const priorityOrder: Record<BusinessRulePriority, number> = {
          CRITICAL: 5,
          HIGH: 4,
          MEDIUM: 3,
          LOW: 2,
          UNRESOLVED: 1,
        };
        if (priorityOrder[rule.priority] > priorityOrder[existing.priority]) {
          existing.priority = rule.priority;
        }
      }
    }

    const rules = Array.from(deduplicatedMap.values()).sort((a, b) =>
      a.ruleId.localeCompare(b.ruleId)
    );

    // 8. Rule Dependencies Validation (Section 13 & T18, T19)
    // Validate that all referenced rule IDs exist in the same revision
    const existingRuleIds = new Set(rules.map((r) => r.ruleId));
    for (const rule of rules) {
      for (const depId of rule.dependencies) {
        if (!existingRuleIds.has(depId)) {
          throw new BusinessRulesDependencyError(
            `Invalid rule dependency: rule '${rule.ruleId}' depends on nonexistent rule '${depId}' in the same revision.`,
            { ruleId: rule.ruleId, missingDependency: depId }
          );
        }
      }
    }

    // 9. Requirements Traceability Matrix (Section 14 & T20, T21, T22)
    const traceabilityLinks: BusinessRuleTraceabilityLink[] = requirements.functionalRequirements.map(
      (freq) => {
        const addressingRules = rules
          .filter((r) => r.affectedRequirements.includes(freq.requirementId) || r.sourceRequirements.includes(freq.requirementId))
          .map((r) => r.ruleId)
          .sort();

        const addressingDecisions = pendingHumanDecisions
          .filter((d) => d.affectedRequirements.includes(freq.requirementId))
          .map((d) => d.decisionId)
          .sort();

        return {
          requirementId: freq.requirementId,
          requirementTitle: freq.title,
          addressedByRules: addressingRules,
          addressedByDecisions: addressingDecisions,
        };
      }
    ).sort((a, b) => a.requirementId.localeCompare(b.requirementId));

    // Sort decisions and conflicts deterministically
    pendingHumanDecisions.sort((a, b) => a.decisionId.localeCompare(b.decisionId));
    conflicts.sort((a, b) => a.conflictId.localeCompare(b.conflictId));

    // 10. Canonical Fingerprint Calculation (Section 19, 20)
    const fingerprintMaterial = {
      projectId,
      sourceRequirementsRevision: requirements.requirementsRevision,
      sourceRequirementsFingerprint: requirements.fingerprint,
      sourceArchitectureRevision: architecture.architectureRevision,
      sourceArchitectureFingerprint: architecture.fingerprint,
      sourceDiscoveryRevision: discovery.discoveryRevision,
      sourceDiscoveryFingerprint: discovery.fingerprint,
      rules: rules.map((r) => ({
        ruleId: r.ruleId,
        title: r.title,
        description: r.description,
        category: r.category,
        statement: r.statement,
        priority: r.priority,
        status: r.status,
        sourceReferences: [...r.sourceReferences].sort(),
        sourceRequirements: [...r.sourceRequirements].sort(),
        sourceArchitectureDecisions: [...r.sourceArchitectureDecisions].sort(),
        sourceDiscoveryReferences: [...r.sourceDiscoveryReferences].sort(),
        affectedRequirements: [...r.affectedRequirements].sort(),
        affectedArchitectureAreas: [...r.affectedArchitectureAreas].sort(),
        dependencies: [...r.dependencies].sort(),
        validationExpectation: r.validationExpectation,
        temporalDetails: r.temporalDetails,
        stateTransitionDetails: r.stateTransitionDetails,
        validationCalculationDetails: r.validationCalculationDetails,
        authorizationPolicyDetails: r.authorizationPolicyDetails,
      })),
      pendingHumanDecisions: pendingHumanDecisions.map((d) => ({
        decisionId: d.decisionId,
        question: d.question,
        whyItMatters: d.whyItMatters,
        affectedRules: [...d.affectedRules].sort(),
        affectedRequirements: [...d.affectedRequirements].sort(),
        availableOptions: [...d.availableOptions].sort(),
        consequences: [...d.consequences].sort(),
        authority: d.authority,
        status: d.status,
      })),
      conflicts: conflicts.map((c) => ({
        conflictId: c.conflictId,
        affectedRules: [...c.affectedRules].sort(),
        affectedRequirements: [...c.affectedRequirements].sort(),
        conflictingStatements: [...c.conflictingStatements].sort(),
        sourceReferences: [...c.sourceReferences].sort(),
        whyItMatters: c.whyItMatters,
        resolutionStatus: c.resolutionStatus,
        requiredAuthority: c.requiredAuthority,
      })),
      requirementsTraceability: traceabilityLinks.map((t) => ({
        requirementId: t.requirementId,
        requirementTitle: t.requirementTitle,
        addressedByRules: [...t.addressedByRules].sort(),
        addressedByDecisions: [...t.addressedByDecisions].sort(),
      })),
    };

    const fingerprint = computeDeterministicFingerprint(fingerprintMaterial);

    // Check if identical revision has already been saved for this project
    const latest = await this.businessRulesStore.loadRevision(projectId);
    if (latest && latest.fingerprint === fingerprint) {
      return latest;
    }

    const latestRulesRev = await this.businessRulesStore.getLatestRevisionNumber(projectId);
    const businessRulesRevision = latestRulesRev + 1;

    const artifact: ProjectBusinessRulesRevision = {
      projectId,
      businessRulesRevision,
      sourceRequirementsRevision: requirements.requirementsRevision,
      sourceRequirementsFingerprint: requirements.fingerprint,
      sourceArchitectureRevision: architecture.architectureRevision,
      sourceArchitectureFingerprint: architecture.fingerprint,
      sourceDiscoveryRevision: discovery.discoveryRevision,
      sourceDiscoveryFingerprint: discovery.fingerprint,
      isStale: false,
      rules,
      pendingHumanDecisions,
      conflicts,
      requirementsTraceability: traceabilityLinks,
      createdAt: new Date().toISOString(),
      fingerprint,
    };

    // 11. Durably persist
    await this.businessRulesStore.saveRevision(artifact);

    return artifact;
  }

  /**
   * Retrieves latest business rules revision for a project.
   */
  async getLatest(projectId: string): Promise<ProjectBusinessRulesRevision | null> {
    const result = await this.businessRulesStore.loadRevision(projectId);
    if (!result) return null;
    const isStale = await this.isRevisionStale(result);
    return { ...result, isStale };
  }

  /**
   * Retrieves specific business rules revision for a project.
   */
  async getRevision(
    projectId: string,
    revision: number
  ): Promise<ProjectBusinessRulesRevision | null> {
    const result = await this.businessRulesStore.loadRevision(projectId, revision);
    if (!result) return null;
    const isStale = await this.isRevisionStale(result);
    return { ...result, isStale };
  }

  /**
   * Checks whether a business rules revision is stale relative to latest requirements, architecture, or discovery.
   */
  async isRevisionStale(revision: ProjectBusinessRulesRevision): Promise<boolean> {
    const safeProjectId = this.businessRulesStore.sanitizeProjectId(revision.projectId);

    // Check if requirements have advanced
    const latestRequirements = await this.requirementsStore.loadRevision(safeProjectId);
    if (!latestRequirements) {
      return true;
    }
    if (latestRequirements.requirementsRevision !== revision.sourceRequirementsRevision) {
      return true;
    }
    if (latestRequirements.fingerprint !== revision.sourceRequirementsFingerprint) {
      return true;
    }

    // Check if architecture has advanced
    const latestArchitecture = await this.architectureStore.loadRevision(safeProjectId);
    if (!latestArchitecture) {
      return true;
    }
    if (latestArchitecture.architectureRevision !== revision.sourceArchitectureRevision) {
      return true;
    }
    if (latestArchitecture.fingerprint !== revision.sourceArchitectureFingerprint) {
      return true;
    }

    // Check if discovery has advanced
    const latestDiscovery = await this.discoveryStore.loadRevision(safeProjectId);
    if (!latestDiscovery) {
      return true;
    }
    if (latestDiscovery.discoveryRevision !== revision.sourceDiscoveryRevision) {
      return true;
    }
    if (latestDiscovery.fingerprint !== revision.sourceDiscoveryFingerprint) {
      return true;
    }

    return false;
  }
}

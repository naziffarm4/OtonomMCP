/**
 * Specification Completeness Gate Engine (Phase 15 TASK-P15-02)
 *
 * Evaluates whether a discovered project specification contains sufficient,
 * authoritative, and unambiguous information across all 15 material specification
 * areas to safely proceed to Product Owner approval.
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. Completeness Gate determines approval eligibility; it does NOT approve anything.
 * 2. Human decision points are NEVER silently resolved; Product Owner choice is strictly preserved.
 * 3. Results are deterministic, auditable, and evidence-based for every evaluated area.
 * 4. Strictly revision-bound: results bind to a specific discoveryRevision; stale results cannot authorize approval.
 * 5. Reuses authoritative systems: AdaptiveDiscoveryStore, HistoryManager, SpecStore.
 * 6. Never invokes Antigravity, creates execution intent, or creates approval packages.
 */

import * as path from 'node:path';
import { Actor } from '../actors.js';
import type { SpecStore } from '../storage/spec-store.js';
import type { HistoryManager } from '../storage/history-manager.js';
import { AdaptiveDiscoveryStore } from './adaptive-discovery-store.js';
import { CompletenessGateStore } from './completeness-gate-store.js';
import {
  COMPLETENESS_AREAS,
  CompletenessGateInputZodSchema,
  type CompletenessStatus,
  type CompletenessArea,
  type EvaluatedAreaResult,
  type BlockingHumanDecision,
  type CompletenessGateResult,
  type CompletenessGateInput,
} from './completeness-gate-types.js';
import {
  type ProjectDiscoveryRevision,
  type DiscoveryQuestion,
  type HumanDecisionPoint,
} from './adaptive-discovery-types.js';
import {
  CompletenessValidationError,
  CompletenessRevisionNotFoundError,
  CompletenessProjectBindingMismatchError,
} from './completeness-gate-errors.js';
import { computeDeterministicFingerprint } from './adaptive-discovery-normalizer.js';

export interface CompletenessGateEngineOptions {
  readonly workspaceRoot?: string;
  readonly baseDir?: string;
  readonly discoveryStore?: AdaptiveDiscoveryStore;
  readonly completenessStore?: CompletenessGateStore;
  readonly historyManager?: HistoryManager;
  readonly specStore?: SpecStore;
}

export class CompletenessGateEngine {
  readonly workspaceRoot?: string;
  readonly baseDir: string;
  readonly discoveryStore: AdaptiveDiscoveryStore;
  readonly completenessStore: CompletenessGateStore;
  private readonly historyManager?: HistoryManager;
  private readonly specStore?: SpecStore;

  constructor(options?: CompletenessGateEngineOptions) {
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
  }

  /**
   * Evaluates specification completeness for a given project and optional discovery revision.
   */
  async evaluate(input: CompletenessGateInput): Promise<CompletenessGateResult> {
    const parsedInput = CompletenessGateInputZodSchema.safeParse(input);
    if (!parsedInput.success) {
      throw new CompletenessValidationError(
        `Invalid completeness gate input: ${parsedInput.error.issues[0]?.message ?? 'validation failed'}`,
        { issues: parsedInput.error.issues }
      );
    }

    const safeProjectId = this.completenessStore.sanitizeProjectId(input.projectId);

    // 1. Load the authoritative discovery revision
    const revision = await this.discoveryStore.loadRevision(
      safeProjectId,
      input.discoveryRevision
    );

    if (!revision) {
      throw new CompletenessRevisionNotFoundError(
        `Discovery revision ${input.discoveryRevision !== undefined ? input.discoveryRevision : 'latest'} not found for project '${input.projectId}'.`,
        { projectId: input.projectId, requestedRevision: input.discoveryRevision }
      );
    }

    // 2. Cross-project isolation check
    if (revision.projectId !== input.projectId) {
      throw new CompletenessProjectBindingMismatchError(
        `Cross-project mismatch: requested evaluation for '${input.projectId}' but discovery record belongs to '${revision.projectId}'.`,
        { requestedProjectId: input.projectId, recordProjectId: revision.projectId }
      );
    }

    return this.evaluateRevision(revision);
  }

  /**
   * Evaluates specification completeness directly against an authoritative ProjectDiscoveryRevision.
   */
  async evaluateRevision(revision: ProjectDiscoveryRevision): Promise<CompletenessGateResult> {
    const safeProjectId = this.completenessStore.sanitizeProjectId(revision.projectId);

    // 1. Check staleness against latest discovery revision in store
    const latestRevisionNumber = await this.discoveryStore.getLatestRevisionNumber(safeProjectId);
    const isStale = latestRevisionNumber > revision.discoveryRevision;

    // 2. Classify open questions into blocking vs non-blocking/informational
    const openQuestions = revision.openQuestions ?? [];
    const blockingQuestions: DiscoveryQuestion[] = [];
    const nonBlockingQuestions: DiscoveryQuestion[] = [];

    for (const q of openQuestions) {
      if (q.status === 'RESOLVED') {
        continue;
      }
      if (q.classification === 'INFORMATIONAL' || q.classification === 'NON_BLOCKING') {
        nonBlockingQuestions.push(q);
      } else if (q.classification === 'BLOCKING') {
        blockingQuestions.push(q);
      }
    }

    // 3. Identify and construct blocking human decisions (never silently resolved)
    const rawHumanDecisions = revision.decisions ?? revision.sections.humanDecisions ?? [];
    const blockingHumanDecisions: BlockingHumanDecision[] = [];

    for (const d of rawHumanDecisions) {
      if (d.status === 'PENDING_DECISION') {
        blockingHumanDecisions.push({
          decisionId: d.id,
          question: d.title,
          whyItMatters: d.description,
          affectedSpecificationAreas: d.affectedAreas,
          availableOptions: d.alternatives ?? [],
          consequenceOfEachOption: d.rationale
            ? { [d.recommendedOption ?? 'default']: d.rationale }
            : undefined,
          authority: Actor.USER,
          status: 'PENDING_DECISION',
        });
      }
    }

    // Add any blocking questions requiring explicit Product Owner choice into human decisions if not already present
    for (const bq of blockingQuestions) {
      if (bq.options && bq.options.length >= 2) {
        const alreadyCovered = blockingHumanDecisions.some(
          (d) =>
            d.decisionId === bq.id ||
            d.affectedSpecificationAreas.includes(bq.dependentSection) ||
            d.question.toLowerCase().includes(bq.category.toLowerCase())
        );
        if (!alreadyCovered) {
          blockingHumanDecisions.push({
            decisionId: bq.id,
            question: bq.question,
            whyItMatters: bq.whyItMatters,
            affectedSpecificationAreas: bq.whatItAffects,
            availableOptions: bq.options,
            authority: Actor.USER,
            status: 'PENDING_DECISION',
          });
        }
      }
    }

    // 4. Evaluate each of the 15 Completeness Areas
    const evaluatedAreas: EvaluatedAreaResult[] = [];
    const aggregatedMissingInfo: string[] = [];
    const aggregatedBlockingIssues: string[] = [];

    for (const area of COMPLETENESS_AREAS) {
      const areaResult = this.evaluateSingleArea(
        area,
        revision,
        blockingQuestions,
        blockingHumanDecisions
      );
      evaluatedAreas.push(areaResult);

      if (areaResult.missingInformation && areaResult.missingInformation.length > 0) {
        aggregatedMissingInfo.push(...areaResult.missingInformation);
      }

      if (areaResult.status === 'BLOCKED_ON_HUMAN') {
        aggregatedBlockingIssues.push(`[${area}] Blocked on Product Owner decision`);
      } else if (areaResult.status === 'INCOMPLETE') {
        aggregatedBlockingIssues.push(`[${area}] Incomplete specification`);
      }
    }

    // 5. Determine Overall Gate Status
    let overallStatus: CompletenessStatus;
    const hasBlockedOnHuman =
      blockingHumanDecisions.length > 0 ||
      evaluatedAreas.some((a) => a.status === 'BLOCKED_ON_HUMAN');
    const hasIncomplete =
      aggregatedMissingInfo.length > 0 ||
      evaluatedAreas.some((a) => a.status === 'INCOMPLETE') ||
      blockingQuestions.some(
        (bq) => !bq.options || bq.options.length < 2
      );

    if (hasBlockedOnHuman) {
      overallStatus = 'BLOCKED_ON_HUMAN';
    } else if (hasIncomplete) {
      overallStatus = 'INCOMPLETE';
    } else {
      const applicableAreas = evaluatedAreas.filter((a) => a.status !== 'NOT_APPLICABLE');
      if (applicableAreas.length > 0 && applicableAreas.every((a) => a.status === 'COMPLETE')) {
        overallStatus = 'COMPLETE';
      } else if (evaluatedAreas.every((a) => a.status === 'NOT_APPLICABLE')) {
        overallStatus = 'NOT_APPLICABLE';
      } else {
        overallStatus = 'INCOMPLETE';
      }
    }

    // 6. Eligibility for Approval: strictly COMPLETE and not stale
    const isEligibleForApproval = overallStatus === 'COMPLETE' && !isStale;

    // 7. Deterministic Fingerprint Calculation (excluding timestamps)
    const fingerprintMaterial = {
      projectId: revision.projectId,
      discoveryRevision: revision.discoveryRevision,
      discoveryFingerprint: revision.fingerprint,
      status: overallStatus,
      isEligibleForApproval,
      isStale,
      evaluatedAreas: evaluatedAreas
        .map((a) => ({
          area: a.area,
          status: a.status,
          evidence: [...a.evidence].sort(),
          missingInformation: [...a.missingInformation].sort(),
          blockingQuestions: a.blockingQuestions.map((q) => q.id).sort(),
          humanDecisions: a.humanDecisions.map((d) => d.id).sort(),
        }))
        .sort((a, b) => a.area.localeCompare(b.area)),
      blockingIssues: [...aggregatedBlockingIssues].sort(),
      missingInformation: [...aggregatedMissingInfo].sort(),
      humanDecisions: blockingHumanDecisions
        .map((d) => ({
          decisionId: d.decisionId,
          question: d.question,
          whyItMatters: d.whyItMatters,
          affectedSpecificationAreas: [...d.affectedSpecificationAreas].sort(),
          availableOptions: [...d.availableOptions].sort(),
          authority: d.authority,
          status: d.status,
        }))
        .sort((a, b) => a.decisionId.localeCompare(b.decisionId)),
      blockingQuestions: blockingQuestions.map((q) => q.id).sort(),
      nonBlockingQuestions: nonBlockingQuestions.map((q) => q.id).sort(),
    };

    const fingerprint = computeDeterministicFingerprint(fingerprintMaterial);

    const result: CompletenessGateResult = {
      projectId: revision.projectId,
      discoveryRevision: revision.discoveryRevision,
      discoveryFingerprint: revision.fingerprint,
      status: overallStatus,
      isEligibleForApproval,
      isStale,
      evaluatedAreas,
      blockingIssues: aggregatedBlockingIssues,
      missingInformation: aggregatedMissingInfo,
      humanDecisions: blockingHumanDecisions,
      blockingQuestions,
      nonBlockingQuestions,
      evaluatedAt: new Date().toISOString(),
      fingerprint,
    };

    // 8. Durably Persist Result
    await this.completenessStore.saveResult(result);

    return result;
  }

  /**
   * Evaluates a single specification area against the revision and blocking items.
   */
  private evaluateSingleArea(
    area: CompletenessArea,
    revision: ProjectDiscoveryRevision,
    blockingQuestions: DiscoveryQuestion[],
    blockingDecisions: BlockingHumanDecision[]
  ): EvaluatedAreaResult {
    const sections = revision.sections;
    const domainText = [
      sections.projectIdentity.name,
      sections.projectIdentity.purpose,
      sections.projectIdentity.desiredOutcome,
      (sections.productScope.inScope ?? []).join(' '),
      (sections.functionalRequirements.capabilities ?? []).map((c) => c.title + ' ' + c.description).join(' '),
    ].join(' ').toLowerCase();

    switch (area) {
      case 'PROJECT_PURPOSE': {
        const id = sections.projectIdentity;
        const missing: string[] = [];
        if (!id.name || id.name === 'unnamed-project') missing.push('projectIdentity.name');
        if (!id.purpose || id.purpose.startsWith('Pending')) missing.push('projectIdentity.purpose');
        if (!id.desiredOutcome || id.desiredOutcome.startsWith('Pending')) missing.push('projectIdentity.desiredOutcome');

        if (missing.length > 0) {
          return {
            area,
            status: 'INCOMPLETE',
            evidence: [`Missing required project identity fields: ${missing.join(', ')}`],
            missingInformation: missing,
            blockingQuestions: [],
            humanDecisions: [],
          };
        }

        return {
          area,
          status: 'COMPLETE',
          evidence: [
            `Project identity specified: name='${id.name}'`,
            `Purpose: ${id.purpose}`,
            `Desired outcome: ${id.desiredOutcome}`,
          ],
          missingInformation: [],
          blockingQuestions: [],
          humanDecisions: [],
        };
      }

      case 'TARGET_USERS': {
        const users = sections.productScope.targetUsers ?? [];
        if (users.length === 0) {
          return {
            area,
            status: 'INCOMPLETE',
            evidence: ['No target users or actors specified in product scope'],
            missingInformation: ['productScope.targetUsers'],
            blockingQuestions: [],
            humanDecisions: [],
          };
        }

        return {
          area,
          status: 'COMPLETE',
          evidence: [`Target users/actors defined (${users.length}): ${users.join(', ')}`],
          missingInformation: [],
          blockingQuestions: [],
          humanDecisions: [],
        };
      }

      case 'PRODUCT_SCOPE': {
        const scope = sections.productScope;
        const inScope = scope.inScope ?? [];
        const outOfScope = scope.outOfScope ?? [];
        const workflows = scope.primaryWorkflows ?? [];

        if (inScope.length === 0) {
          return {
            area,
            status: 'INCOMPLETE',
            evidence: ['No in-scope capabilities or boundaries specified'],
            missingInformation: ['productScope.inScope'],
            blockingQuestions: [],
            humanDecisions: [],
          };
        }

        return {
          area,
          status: 'COMPLETE',
          evidence: [
            `In-scope items defined (${inScope.length}): ${inScope.slice(0, 3).join(', ')}${inScope.length > 3 ? '...' : ''}`,
            `Explicit exclusions / out-of-scope recorded (${outOfScope.length}): ${outOfScope.join(', ') || 'None'}`,
            `Primary workflows specified (${workflows.length}): ${workflows.join(', ') || 'Standard workflow'}`,
          ],
          missingInformation: [],
          blockingQuestions: [],
          humanDecisions: [],
        };
      }

      case 'FUNCTIONAL_REQUIREMENTS': {
        const capabilities = sections.functionalRequirements.capabilities ?? [];
        const topRequirements = revision.requirements ?? [];
        const total = Math.max(capabilities.length, topRequirements.length);

        if (total === 0) {
          return {
            area,
            status: 'INCOMPLETE',
            evidence: ['No functional capabilities or requirements defined'],
            missingInformation: ['functionalRequirements.capabilities'],
            blockingQuestions: [],
            humanDecisions: [],
          };
        }

        return {
          area,
          status: 'COMPLETE',
          evidence: [
            `Functional capabilities defined (${total} requirements with behavioral specifications)`,
          ],
          missingInformation: [],
          blockingQuestions: [],
          humanDecisions: [],
        };
      }

      case 'BUSINESS_RULES': {
        const rules = [
          ...(sections.functionalRequirements.businessRules ?? []),
          ...(sections.functionalRequirements.capabilities ?? []).flatMap((c) => c.businessRules ?? []),
        ];
        const capabilities = sections.functionalRequirements.capabilities ?? [];

        // Check if any open blocking questions relate to business rules
        const bizQuestions = blockingQuestions.filter(
          (q) =>
            q.category === 'FUNCTIONAL_REQUIREMENTS' ||
            q.whatItAffects.includes('business behavior') ||
            q.whatItAffects.includes('business rules')
        );

        if (bizQuestions.length > 0) {
          const requiresHuman = bizQuestions.some((q) => q.options && q.options.length >= 2);
          return {
            area,
            status: requiresHuman ? 'BLOCKED_ON_HUMAN' : 'INCOMPLETE',
            evidence: bizQuestions.map((q) => `Unresolved business rule: ${q.question}`),
            missingInformation: bizQuestions.map((q) => q.question),
            blockingQuestions: bizQuestions,
            humanDecisions: [],
          };
        }

        // Check if reconnect capability is present without explicit reconnect rule
        const hasReconnect = capabilities.some((c) =>
          c.title.toLowerCase().includes('reconnect')
        );
        const hasExplicitReconnectRule = rules.some((r) =>
          r.toLowerCase().includes('grace') || r.toLowerCase().includes('timeout')
        );

        if (hasReconnect && !hasExplicitReconnectRule) {
          return {
            area,
            status: 'INCOMPLETE',
            evidence: ['Reconnection capability present but disconnect grace/timeout business rule is missing'],
            missingInformation: ['functionalRequirements.businessRules (disconnect grace window)'],
            blockingQuestions: [],
            humanDecisions: [],
          };
        }

        if (rules.length > 0) {
          return {
            area,
            status: 'COMPLETE',
            evidence: [`Business rules specified (${rules.length}): ${rules.join('; ')}`],
            missingInformation: [],
            blockingQuestions: [],
            humanDecisions: [],
          };
        }

        return {
          area,
          status: 'COMPLETE',
          evidence: ['Standard domain rules apply; no complex custom business rules required'],
          missingInformation: [],
          blockingQuestions: [],
          humanDecisions: [],
        };
      }

      case 'NON_FUNCTIONAL_REQUIREMENTS': {
        const nfr = sections.nonFunctionalRequirements;
        const totalNfr =
          (nfr.performance?.length ?? 0) +
          (nfr.reliability?.length ?? 0) +
          (nfr.scalability?.length ?? 0) +
          (nfr.availability?.length ?? 0) +
          (nfr.usability?.length ?? 0) +
          (nfr.compatibility?.length ?? 0);

        if (totalNfr === 0) {
          return {
            area,
            status: 'INCOMPLETE',
            evidence: ['No non-functional requirements (performance, reliability, usability) specified'],
            missingInformation: ['nonFunctionalRequirements'],
            blockingQuestions: [],
            humanDecisions: [],
          };
        }

        return {
          area,
          status: 'COMPLETE',
          evidence: [`Non-functional requirements defined (${totalNfr} items across performance, reliability, usability)`],
          missingInformation: [],
          blockingQuestions: [],
          humanDecisions: [],
        };
      }

      case 'TECHNOLOGY_CONSTRAINTS': {
        const tech = sections.technology;
        const platforms = tech.platformConstraints ?? [];
        const required = tech.requiredTechnologies ?? [];

        // Check if there are blocking technology questions
        const techQuestions = blockingQuestions.filter(
          (q) => q.category === 'TECHNOLOGY' || q.whatItAffects.includes('technology choice')
        );

        if (techQuestions.length > 0) {
          const requiresHuman = techQuestions.some((q) => q.options && q.options.length >= 2);
          return {
            area,
            status: requiresHuman ? 'BLOCKED_ON_HUMAN' : 'INCOMPLETE',
            evidence: techQuestions.map((q) => `Unresolved technology decision: ${q.question}`),
            missingInformation: techQuestions.map((q) => q.question),
            blockingQuestions: techQuestions,
            humanDecisions: [],
          };
        }

        if (platforms.length === 0 && required.length === 0) {
          return {
            area,
            status: 'INCOMPLETE',
            evidence: ['No platform constraints or required technologies defined'],
            missingInformation: ['technology.platformConstraints', 'technology.requiredTechnologies'],
            blockingQuestions: [],
            humanDecisions: [],
          };
        }

        return {
          area,
          status: 'COMPLETE',
          evidence: [
            `Platforms: ${platforms.join(', ') || 'Standard host'}`,
            `Required technologies: ${required.join(', ') || 'Standard stack'}`,
          ],
          missingInformation: [],
          blockingQuestions: [],
          humanDecisions: [],
        };
      }

      case 'ARCHITECTURE_REQUIREMENTS': {
        const arch = sections.architecture;
        const constraints = arch.architecturalConstraints ?? [];

        const archDecisions = blockingDecisions.filter(
          (d) =>
            d.affectedSpecificationAreas.includes('architecture') &&
            d.status === 'PENDING_DECISION'
        );

        if (archDecisions.length > 0) {
          return {
            area,
            status: 'BLOCKED_ON_HUMAN',
            evidence: archDecisions.map((d) => `Architecture requires Product Owner decision: ${d.question}`),
            missingInformation: archDecisions.map((d) => d.question),
            blockingQuestions: [],
            humanDecisions: [],
          };
        }

        if (constraints.length === 0) {
          return {
            area,
            status: 'INCOMPLETE',
            evidence: ['No architectural constraints or architectural pattern specified'],
            missingInformation: ['architecture.architecturalConstraints'],
            blockingQuestions: [],
            humanDecisions: [],
          };
        }

        return {
          area,
          status: 'COMPLETE',
          evidence: [`Architectural constraints defined (${constraints.length}): ${constraints.join('; ')}`],
          missingInformation: [],
          blockingQuestions: [],
          humanDecisions: [],
        };
      }

      case 'DATA_PERSISTENCE': {
        const storage = sections.architecture.dataStorageExpectations ?? [];
        const mentionsStorage =
          domainText.includes('database') ||
          domainText.includes('account') ||
          domainText.includes('persistence') ||
          domainText.includes('store') ||
          domainText.includes('user profile') ||
          domainText.includes('game state');

        const explicitStateless =
          storage.includes('NONE') ||
          storage.includes('STATELESS') ||
          storage.includes('NOT_APPLICABLE') ||
          domainText.includes('stateless') ||
          (!mentionsStorage && storage.length === 0);

        // Check if there are storage questions/decisions
        const storageQuestions = blockingQuestions.filter(
          (q) =>
            q.question.toLowerCase().includes('database') ||
            q.question.toLowerCase().includes('storage') ||
            q.whatItAffects.includes('persistence') ||
            q.whatItAffects.includes('data model')
        );

        if (storageQuestions.length > 0) {
          const requiresHuman = storageQuestions.some((q) => q.options && q.options.length >= 2);
          return {
            area,
            status: requiresHuman ? 'BLOCKED_ON_HUMAN' : 'INCOMPLETE',
            evidence: storageQuestions.map((q) => `Persistence storage decision required: ${q.question}`),
            missingInformation: storageQuestions.map((q) => q.question),
            blockingQuestions: storageQuestions,
            humanDecisions: [],
          };
        }

        if (storage.length > 0) {
          return {
            area,
            status: 'COMPLETE',
            evidence: [`Data persistence specified: ${storage.join(', ')}`],
            missingInformation: [],
            blockingQuestions: [],
            humanDecisions: [],
          };
        }

        if (explicitStateless) {
          return {
            area,
            status: 'NOT_APPLICABLE',
            evidence: ['Project is stateless; persistent data storage is genuinely not applicable.'],
            missingInformation: [],
            blockingQuestions: [],
            humanDecisions: [],
          };
        }

        return {
          area,
          status: 'INCOMPLETE',
          evidence: ['Domain requires state/account persistence, but data storage expectation is missing'],
          missingInformation: ['architecture.dataStorageExpectations'],
          blockingQuestions: [],
          humanDecisions: [],
        };
      }

      case 'EXTERNAL_INTEGRATIONS': {
        const integrations = sections.architecture.integrationRequirements ?? [];
        const mentionsExternal =
          domainText.includes('stripe') ||
          domainText.includes('oauth') ||
          domainText.includes('discord') ||
          domainText.includes('third-party') ||
          domainText.includes('external api') ||
          domainText.includes('webhook') ||
          domainText.includes('s3');

        if (integrations.length > 0) {
          return {
            area,
            status: 'COMPLETE',
            evidence: [`External integrations specified (${integrations.length}): ${integrations.join(', ')}`],
            missingInformation: [],
            blockingQuestions: [],
            humanDecisions: [],
          };
        }

        if (mentionsExternal) {
          return {
            area,
            status: 'INCOMPLETE',
            evidence: ['Features mention external services, but integration requirements are not specified'],
            missingInformation: ['architecture.integrationRequirements'],
            blockingQuestions: [],
            humanDecisions: [],
          };
        }

        return {
          area,
          status: 'NOT_APPLICABLE',
          evidence: ['Self-contained project; no external third-party integrations required.'],
          missingInformation: [],
          blockingQuestions: [],
          humanDecisions: [],
        };
      }

      case 'SECURITY_REQUIREMENTS': {
        const sec = sections.nonFunctionalRequirements.security ?? [];
        const isNetworkedOrAuthenticated =
          domainText.includes('auth') ||
          domainText.includes('user') ||
          domainText.includes('account') ||
          domainText.includes('websocket') ||
          domainText.includes('http') ||
          domainText.includes('api') ||
          domainText.includes('token');

        if (sec.length > 0) {
          return {
            area,
            status: 'COMPLETE',
            evidence: [`Security requirements specified (${sec.length}): ${sec.join('; ')}`],
            missingInformation: [],
            blockingQuestions: [],
            humanDecisions: [],
          };
        }

        if (isNetworkedOrAuthenticated) {
          return {
            area,
            status: 'INCOMPLETE',
            evidence: ['Networked or authenticated project requires security requirements, but none are defined'],
            missingInformation: ['nonFunctionalRequirements.security'],
            blockingQuestions: [],
            humanDecisions: [],
          };
        }

        return {
          area,
          status: 'COMPLETE',
          evidence: ['Local offline tool; baseline execution permissions apply'],
          missingInformation: [],
          blockingQuestions: [],
          humanDecisions: [],
        };
      }

      case 'ACCEPTANCE_CRITERIA': {
        const criteria = sections.acceptance.measurableCriteria ?? [];
        const completion = sections.acceptance.definitionOfCompletion ?? [];

        const acceptQuestions = blockingQuestions.filter(
          (q) => q.category === 'ACCEPTANCE' || q.whatItAffects.includes('acceptance criteria')
        );

        if (acceptQuestions.length > 0) {
          return {
            area,
            status: 'INCOMPLETE',
            evidence: acceptQuestions.map((q) => `Unresolved acceptance question: ${q.question}`),
            missingInformation: ['acceptance.measurableCriteria', ...acceptQuestions.map((q) => q.question)],
            blockingQuestions: acceptQuestions,
            humanDecisions: [],
          };
        }

        if (criteria.length === 0) {
          return {
            area,
            status: 'INCOMPLETE',
            evidence: ['No measurable acceptance criteria defined for QA validation'],
            missingInformation: ['acceptance.measurableCriteria'],
            blockingQuestions: [],
            humanDecisions: [],
          };
        }

        return {
          area,
          status: 'COMPLETE',
          evidence: [
            `Measurable criteria defined (${criteria.length}): ${criteria.join('; ')}`,
            `Definition of completion specified (${completion.length} items)`,
          ],
          missingInformation: [],
          blockingQuestions: [],
          humanDecisions: [],
        };
      }

      case 'DEPLOYMENT_OPERATIONAL': {
        const model = sections.architecture.deploymentModel;

        const deployDecisions = blockingDecisions.filter(
          (d) =>
            d.question.toLowerCase().includes('deployment') ||
            d.question.toLowerCase().includes('hosting') ||
            d.affectedSpecificationAreas.includes('operational requirements')
        );

        if (deployDecisions.length > 0) {
          return {
            area,
            status: 'BLOCKED_ON_HUMAN',
            evidence: deployDecisions.map(
              (d) => `Deployment model requires Product Owner decision: ${d.question}`
            ),
            missingInformation: deployDecisions.map((d) => d.question),
            blockingQuestions: [],
            humanDecisions: [],
          };
        }

        if (!model) {
          return {
            area,
            status: 'INCOMPLETE',
            evidence: ['Deployment and operational hosting model is not specified'],
            missingInformation: ['architecture.deploymentModel'],
            blockingQuestions: [],
            humanDecisions: [],
          };
        }

        return {
          area,
          status: 'COMPLETE',
          evidence: [`Deployment model specified: ${model}`],
          missingInformation: [],
          blockingQuestions: [],
          humanDecisions: [],
        };
      }

      case 'RISKS_DEPENDENCIES': {
        const risks = sections.risks;
        const totalRisks =
          (risks.technicalRisks?.length ?? 0) +
          (risks.productRisks?.length ?? 0) +
          (risks.operationalRisks?.length ?? 0);
        const dependencies = risks.dependencies ?? [];

        // Check for unmitigated critical risks
        const allRisks = [
          ...(risks.technicalRisks ?? []),
          ...(risks.productRisks ?? []),
          ...(risks.operationalRisks ?? []),
        ];
        const unmitigatedCritical = allRisks.filter(
          (r) => r.impact === 'CRITICAL' && !r.mitigation
        );

        if (unmitigatedCritical.length > 0) {
          return {
            area,
            status: 'INCOMPLETE',
            evidence: unmitigatedCritical.map(
              (r) => `Unmitigated CRITICAL risk: ${r.statement}`
            ),
            missingInformation: unmitigatedCritical.map((r) => `Mitigation for ${r.statement}`),
            blockingQuestions: [],
            humanDecisions: [],
          };
        }

        return {
          area,
          status: 'COMPLETE',
          evidence: [
            `Risks evaluated (${totalRisks} risks documented)`,
            `External dependencies identified (${dependencies.length}): ${dependencies.join(', ') || 'None'}`,
          ],
          missingInformation: [],
          blockingQuestions: [],
          humanDecisions: [],
        };
      }

      case 'HUMAN_DECISION_POINTS': {
        if (blockingDecisions.length > 0) {
          return {
            area,
            status: 'BLOCKED_ON_HUMAN',
            evidence: blockingDecisions.map(
              (d) =>
                `Product Owner decision pending: '${d.question}' with options: [${d.availableOptions.join(', ')}]`
            ),
            missingInformation: blockingDecisions.map((d) => d.question),
            blockingQuestions: [],
            humanDecisions: [],
          };
        }

        return {
          area,
          status: 'COMPLETE',
          evidence: ['All human decisions resolved or no pending decision points required'],
          missingInformation: [],
          blockingQuestions: [],
          humanDecisions: [],
        };
      }

      default: {
        return {
          area,
          status: 'COMPLETE',
          evidence: ['Area evaluated with default pass criteria'],
          missingInformation: [],
          blockingQuestions: [],
          humanDecisions: [],
        };
      }
    }
  }

  /**
   * Checks whether a previous completeness gate result is stale compared to latest discovery.
   */
  async isResultStale(result: CompletenessGateResult): Promise<boolean> {
    const safeProjectId = this.completenessStore.sanitizeProjectId(result.projectId);
    const latest = await this.discoveryStore.loadRevision(safeProjectId);
    if (!latest) {
      return true;
    }
    if (latest.discoveryRevision !== result.discoveryRevision) {
      return true;
    }
    if (latest.fingerprint !== result.discoveryFingerprint) {
      return true;
    }
    return false;
  }
}

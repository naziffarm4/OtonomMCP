/**
 * Initial Project Understanding Builder (Phase 8 TASK-P8-05)
 *
 * Synthesizes discovery findings and human clarification answers into a strongly typed
 * InitialProjectUnderstanding model.
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. Strict separation of CONFIRMED_FACT, INFERENCE, ASSUMPTION, and UNRESOLVED.
 * 2. Inferences are NEVER promoted to confirmed requirements.
 * 3. Human clarification answers are explicitly classified with source origin HUMAN_CLARIFICATION_ANSWER.
 * 4. Evidence references are traceable to their true discovery source; no evidence is invented or fabricated.
 * 5. Does NOT mutate authoritative requirements (SpecStore) or Task DAG.
 */

import type {
  ProjectDiscoveryReport,
  EvidenceReference,
  DiscoveryUnknown,
  DiscoveryContradiction,
} from '../discovery/discovery-types.js';
import type { ClarificationSession } from '../clarification/clarification-types.js';
import type {
  InitialProjectUnderstanding,
  UnderstandingItem,
} from './approval-types.js';

export interface BuildUnderstandingOptions {
  readonly projectId?: string;
  readonly targetUsers?: readonly string[];
  readonly constraints?: readonly string[];
  readonly assumptions?: readonly string[];
  readonly nonGoals?: readonly string[];
  readonly proposedDevelopmentScope?: readonly string[];
}

export class InitialProjectUnderstandingBuilder {
  /**
   * Synthesizes discovery report findings and resolved clarification answers
   * into a strongly typed InitialProjectUnderstanding model.
   */
  build(
    report: ProjectDiscoveryReport,
    clarificationSession?: ClarificationSession,
    options?: BuildUnderstandingOptions
  ): InitialProjectUnderstanding {
    const now = new Date().toISOString();
    const projectId =
      options?.projectId ??
      report.projectIdentity?.name ??
      'project';
    const projectName = report.projectIdentity?.name ?? 'project';

    // 1. Evidence references aggregation (deduplicated)
    const evidenceMap = new Map<string, EvidenceReference>();
    const registerEvidence = (evidenceList?: readonly EvidenceReference[]) => {
      if (!evidenceList) return;
      for (const ev of evidenceList) {
        const key = `${ev.sourceType}:${ev.sourceIdentifier}:${ev.path ?? ''}:${ev.section ?? ''}`;
        if (!evidenceMap.has(key)) {
          evidenceMap.set(key, ev);
        }
      }
    };

    registerEvidence(report.projectIdentity?.evidence);
    registerEvidence(report.purpose?.evidence);
    registerEvidence(report.technologyStack?.evidence);
    registerEvidence(report.architecture?.evidence);
    registerEvidence(report.gitStatus?.evidence);
    registerEvidence(report.currentImplementationState?.evidence);

    // 2. Confirmed requirements from existing requirements (if any in SpecStore)
    const confirmedRequirements: UnderstandingItem[] = [];
    if (report.requirementsSummary?.requirements) {
      for (const req of report.requirementsSummary.requirements) {
        registerEvidence(report.requirementsSummary.evidence);
        confirmedRequirements.push({
          id: `req-${req.id}`,
          type: 'CONFIRMED_FACT',
          origin: 'EXISTING_REQUIREMENT',
          statement: req.title,
          rationale: `Confirmed authoritative requirement from SpecStore (${req.status})`,
          evidence: report.requirementsSummary.evidence ?? [],
          sourceReferenceId: req.id,
        });
      }
    }

    // 3. Clarified requirements from resolved clarification session answers
    const clarifiedRequirements: UnderstandingItem[] = [];
    const resolvedContradictionIds = new Set<string>();

    if (clarificationSession) {
      for (const question of clarificationSession.questions) {
        registerEvidence(question.evidence);
        const hasValidAnswer =
          question.status === 'ANSWERED' ||
          (question.answer && question.answer.status === 'ANSWERED');

        if (hasValidAnswer && question.answer) {
          // Track contradiction resolution if question resolves a contradiction
          if (question.contradictionPair) {
            resolvedContradictionIds.add(question.contradictionPair.contradictionId);
          }
          if (question.relatedDiscoveryFinding?.type === 'contradiction') {
            resolvedContradictionIds.add(question.relatedDiscoveryFinding.id);
          }

          let statement = '';
          if (question.answer.selectedOptions && question.answer.selectedOptions.length > 0) {
            statement = question.answer.selectedOptions.join('; ');
          } else if (question.answer.freeFormResponse) {
            statement = question.answer.freeFormResponse;
          } else {
            statement = `Clarified: ${question.question}`;
          }

          clarifiedRequirements.push({
            id: `clarified-${question.clarificationId}`,
            type: 'CONFIRMED_FACT',
            origin: 'HUMAN_CLARIFICATION_ANSWER',
            statement,
            rationale: `Clarification from human Product Owner for question: ${question.question}`,
            evidence: question.evidence,
            sourceReferenceId: question.clarificationId,
          });
        }
      }
    }

    // 4. Assumptions: explicitly separate inferences and assumptions from confirmed facts
    const assumptions: UnderstandingItem[] = [];
    if (report.inferences) {
      for (const inf of report.inferences) {
        registerEvidence(inf.basisEvidence);
        assumptions.push({
          id: `assump-${inf.id}`,
          type: 'INFERENCE',
          origin: 'DISCOVERY_EVIDENCE',
          statement: inf.inference,
          rationale: inf.rationale,
          evidence: inf.basisEvidence,
          sourceReferenceId: inf.id,
        });
      }
    }

    if (options?.assumptions) {
      options.assumptions.forEach((assumpText, idx) => {
        assumptions.push({
          id: `explicit-assump-${idx + 1}`,
          type: 'ASSUMPTION',
          origin: 'PRODUCT_OWNER_STATEMENT',
          statement: assumpText,
          evidence: [],
        });
      });
    }

    // 5. Unresolved Unknowns: preserve discovery unknowns
    const unresolvedUnknowns: DiscoveryUnknown[] = [...(report.unknowns ?? [])];

    // If clarification session had optional or unanswered questions, track them
    if (clarificationSession) {
      for (const q of clarificationSession.questions) {
        const isAnswered =
          q.status === 'ANSWERED' ||
          (q.answer && q.answer.status === 'ANSWERED');
        if (!isAnswered) {
          const alreadyTracked = unresolvedUnknowns.some((u) => u.id === q.clarificationId);
          if (!alreadyTracked) {
            unresolvedUnknowns.push({
              id: q.clarificationId,
              item: q.question,
              description: q.context,
              impact: q.blocking ? 'BLOCKING_UNRESOLVED' : 'OPTIONAL_OPEN',
            });
          }
        }
      }
    }

    // 6. Unresolved Contradictions: filter out contradictions resolved by human clarification answers
    const unresolvedContradictions: DiscoveryContradiction[] = (report.contradictions ?? []).filter(
      (c) => !resolvedContradictionIds.has(c.id)
    );

    // 7. Existing capabilities from implemented/partially implemented features
    const existingCapabilities: string[] = (report.featureInventory ?? [])
      .filter((f) => f.status === 'IMPLEMENTED' || f.status === 'PARTIALLY_IMPLEMENTED')
      .map((f) => `${f.name}: ${f.description}`);

    // 8. Proposed development scope (from documented-only or inferred features or options)
    const proposedDevelopmentScope: string[] =
      options?.proposedDevelopmentScope && options.proposedDevelopmentScope.length > 0
        ? [...options.proposedDevelopmentScope]
        : (report.featureInventory ?? [])
            .filter((f) => f.status === 'DOCUMENTED_ONLY' || f.status === 'INFERRED')
            .map((f) => f.name);

    if (proposedDevelopmentScope.length === 0) {
      proposedDevelopmentScope.push('Baseline development and feature completion');
    }

    // 9. Target users
    const targetUsers: string[] =
      options?.targetUsers && options.targetUsers.length > 0
        ? [...options.targetUsers]
        : report.purpose?.summary?.toLowerCase().includes('cli')
        ? ['Software Engineers', 'CLI Users']
        : ['End Users', 'System Operators'];

    // 10. Constraints
    const constraints: string[] = options?.constraints ? [...options.constraints] : [];
    if (report.technologyStack?.primaryLanguages?.length) {
      constraints.push(`Primary Languages: ${report.technologyStack.primaryLanguages.join(', ')}`);
    }

    // 11. Non-goals
    const nonGoals: string[] = options?.nonGoals ? [...options.nonGoals] : [];

    const sourceDiscoveryReference =
      report.timestamp ||
      `discovery-${report.projectIdentity?.name ?? 'unknown'}-${now}`;

    return Object.freeze({
      projectId,
      projectName,
      apparentPurpose: report.purpose,
      targetUsers: Object.freeze(targetUsers),
      technologyStack: report.technologyStack,
      architectureSummary: report.architecture,
      existingCapabilities: Object.freeze(existingCapabilities),
      confirmedRequirements: Object.freeze(confirmedRequirements),
      clarifiedRequirements: Object.freeze(clarifiedRequirements),
      unresolvedUnknowns: Object.freeze(unresolvedUnknowns),
      unresolvedContradictions: Object.freeze(unresolvedContradictions),
      currentImplementationState: report.currentImplementationState,
      constraints: Object.freeze(constraints),
      assumptions: Object.freeze(assumptions),
      nonGoals: Object.freeze(nonGoals),
      proposedDevelopmentScope: Object.freeze(proposedDevelopmentScope),
      evidenceReferences: Object.freeze(Array.from(evidenceMap.values())),
      sourceDiscoveryReference,
      sourceClarificationSessionReference: clarificationSession?.sessionId,
      generatedAt: now,
    });
  }
}

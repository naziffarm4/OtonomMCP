/**
 * Ambiguity & Uncertainty Analyzer (Phase 8 TASK-P8-04)
 *
 * Consumes read-only ProjectDiscoveryReport findings and transforms them into
 * a deterministic set of ClarificationQuestions.
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. Strictly read-only analysis: does not modify files, state, or git repository.
 * 2. Distinguishes: CLEAR, AMBIGUOUS, CONTRADICTORY, MISSING, INSUFFICIENT_EVIDENCE.
 * 3. Never silently resolves ambiguous project intent or contradictions.
 * 4. Inferences are never converted into requirements.
 * 5. Deterministic semantic ordering and explicit typed blocking rules.
 * 6. Preserves traceable EvidenceReferences from discovery without inventing evidence.
 */

import type {
  ProjectDiscoveryReport,
  DiscoveryUnknown,
  EvidenceReference,
} from '../discovery/discovery-types.js';
import type {
  ClarificationQuestion,
  AmbiguityAnalysisResult,
  ClarificationContradictionPair,
  UncertaintyType,
} from './clarification-types.js';
import { sortClarificationQuestions } from './clarification-priority.js';

export class AmbiguityAnalyzer {
  /**
   * Performs read-only ambiguity analysis on a ProjectDiscoveryReport.
   */
  analyze(report: ProjectDiscoveryReport): AmbiguityAnalysisResult {
    const questions: ClarificationQuestion[] = [];
    const clearAreas: string[] = [];
    const informationalUnknowns: DiscoveryUnknown[] = [];
    let counter = 1;

    const nextId = (): string => {
      const id = `CLARIFY-${String(counter).padStart(3, '0')}`;
      counter++;
      return id;
    };

    const now = report.timestamp || new Date().toISOString();

    // ------------------------------------------------------------------------
    // 1. PROJECT PURPOSE ANALYSIS
    // ------------------------------------------------------------------------
    if (report.purpose.classification === 'UNKNOWN') {
      questions.push({
        clarificationId: nextId(),
        kind: 'UNKNOWN_PRODUCT_INTENT',
        priority: 'REQUIRED',
        question: 'What is the primary business goal and intended functionality of this project?',
        context: 'Project discovery could not determine any project purpose from documentation or manifests.',
        reason: 'Proceeding without a defined product purpose risks implementing incorrect or conflicting features.',
        evidence: report.purpose.evidence,
        relatedDiscoveryFinding: {
          id: 'PURPOSE_UNKNOWN',
          type: 'unknown',
          summary: report.purpose.summary,
        },
        allowsFreeFormAnswer: true,
        status: 'OPEN',
        blocking: true,
        uncertaintyType: 'MISSING',
        createdAt: now,
      });
    } else if (report.purpose.classification === 'PARTIALLY_UNDERSTOOD') {
      questions.push({
        clarificationId: nextId(),
        kind: 'UNKNOWN_PRODUCT_INTENT',
        priority: 'REQUIRED',
        question: `The project purpose is only partially understood from the repository (${report.purpose.summary}). What is the intended functional scope?`,
        context: 'Repository contains basic metadata or identifiers but lacks clear domain documentation or detailed specifications.',
        reason: 'Partial purpose understanding requires explicit human clarification before requirements elaboration.',
        evidence: report.purpose.evidence,
        relatedDiscoveryFinding: {
          id: 'PURPOSE_PARTIAL',
          type: 'observation',
          summary: report.purpose.summary,
        },
        allowsFreeFormAnswer: true,
        status: 'OPEN',
        blocking: true,
        uncertaintyType: 'AMBIGUOUS',
        createdAt: now,
      });
    } else {
      clearAreas.push(`Project Purpose: ${report.purpose.summary}`);
    }

    // ------------------------------------------------------------------------
    // 2. CONTRADICTIONS ANALYSIS
    // ------------------------------------------------------------------------
    for (const contra of report.contradictions) {
      let kind: ClarificationQuestion['kind'] = 'CONTRADICTORY_REQUIREMENT';
      if (contra.category === 'LIFECYCLE_STATE_CONFLICT') {
        kind = 'CONFLICTING_IMPLEMENTATION';
      } else if (
        contra.category === 'COMMAND_DECLARATION_MISMATCH' ||
        contra.category.includes('DOC')
      ) {
        kind = 'CONFLICTING_DOCUMENTATION';
      }

      const pair: ClarificationContradictionPair = {
        contradictionId: contra.id,
        category: contra.category,
        description: contra.description,
        sourceA: contra.sourceA,
        sourceB: contra.sourceB,
      };

      const options = [
        contra.sourceA.description,
        contra.sourceB.description,
        'Other / specify',
      ];

      questions.push({
        clarificationId: nextId(),
        kind,
        priority: 'REQUIRED',
        question: `${contra.description}. Which source represents the authoritative project intent for development?`,
        context: `Contradiction detected between Source A (${contra.sourceA.description}) and Source B (${contra.sourceB.description}).`,
        reason: 'The system must not choose one side of a contradiction automatically without explicit authoritative direction.',
        evidence: [contra.sourceA.evidence, contra.sourceB.evidence],
        relatedDiscoveryFinding: {
          id: contra.id,
          type: 'contradiction',
          summary: contra.description,
        },
        contradictionPair: pair,
        options,
        allowsFreeFormAnswer: true,
        status: 'OPEN',
        blocking: true,
        uncertaintyType: 'CONTRADICTORY',
        createdAt: now,
      });
    }

    // ------------------------------------------------------------------------
    // 3. APPLICATION ENTRYPOINTS
    // ------------------------------------------------------------------------
    if (
      report.entryPoints.length > 2 ||
      (report.entryPoints.length > 1 && !report.entryPoints.some((e) => e.isAuthoritative))
    ) {
      const entryTargets = report.entryPoints.map((e) => e.target);
      questions.push({
        clarificationId: nextId(),
        kind: 'UNCLEAR_ENTRYPOINT',
        priority: 'IMPORTANT',
        question: `Multiple application entry points were detected (${entryTargets.join(', ')}). Which is the primary authoritative entry point for development?`,
        context: 'Repository contains multiple potential entry points without single authoritative indicator.',
        reason: 'Development tasks and verification targets depend on identifying the authoritative entrypoint.',
        evidence: report.entryPoints.flatMap((e) => e.evidence),
        relatedDiscoveryFinding: {
          id: 'ENTRYPOINT_MULTIPLE',
          type: 'observation',
          summary: `Detected ${report.entryPoints.length} entry points`,
        },
        options: [...entryTargets, 'Other / specify'],
        allowsFreeFormAnswer: true,
        status: 'OPEN',
        blocking: true,
        uncertaintyType: 'AMBIGUOUS',
        createdAt: now,
      });
    } else if (report.entryPoints.length === 1) {
      clearAreas.push(`Application Entrypoint: ${report.entryPoints[0].target} (${report.entryPoints[0].type})`);
    }

    // ------------------------------------------------------------------------
    // 4. TEST & BUILD COMMANDS
    // ------------------------------------------------------------------------
    // Automated test command: critical for autonomous test verification
    if (report.commands.test.status === 'UNKNOWN') {
      const testOptions = ['npm test', 'pnpm test', 'pytest', 'cargo test', 'go test ./...'];
      questions.push({
        clarificationId: nextId(),
        kind: 'UNCLEAR_RUNTIME_BEHAVIOR',
        priority: 'REQUIRED',
        question: 'What command should be executed to run the automated test suite for this repository?',
        context: 'No test script or test runner configuration was detected in the repository.',
        reason: 'Automated test verification is mandatory for task execution and quality gates.',
        evidence: report.commands.test.evidence,
        relatedDiscoveryFinding: {
          id: 'CMD_TEST_UNKNOWN',
          type: 'unknown',
          summary: 'Automated test command unknown',
        },
        options: testOptions,
        allowsFreeFormAnswer: true,
        status: 'OPEN',
        blocking: true,
        uncertaintyType: 'MISSING',
        createdAt: now,
      });
    } else if (report.commands.test.command) {
      clearAreas.push(`Automated Test Command: ${report.commands.test.command}`);
    }

    // Build command
    const isCompiledLanguage = report.technologyStack.primaryLanguages.some((lang) =>
      ['TypeScript', 'Rust', 'Go', 'C', 'C++', 'Java', 'Kotlin'].includes(lang)
    );

    if (report.commands.build.status === 'UNKNOWN' && isCompiledLanguage) {
      const buildOptions = ['npm run build', 'pnpm build', 'tsc -b', 'cargo build', 'go build'];
      questions.push({
        clarificationId: nextId(),
        kind: 'UNCLEAR_RUNTIME_BEHAVIOR',
        priority: 'IMPORTANT',
        question: 'What command should be executed to compile and build this project?',
        context: 'Project uses compiled or typed languages, but no authoritative build command was discovered.',
        reason: 'Compiled language projects require an authoritative build command to verify compilation.',
        evidence: report.commands.build.evidence,
        relatedDiscoveryFinding: {
          id: 'CMD_BUILD_UNKNOWN',
          type: 'unknown',
          summary: 'Build command unknown for compiled language project',
        },
        options: buildOptions,
        allowsFreeFormAnswer: true,
        status: 'OPEN',
        blocking: false,
        uncertaintyType: 'MISSING',
        createdAt: now,
      });
    } else if (report.commands.build.command) {
      clearAreas.push(`Build Command: ${report.commands.build.command}`);
    }

    // ------------------------------------------------------------------------
    // 5. UNKNOWNS CLASSIFICATION
    // ------------------------------------------------------------------------
    for (const unknown of report.unknowns) {
      const impactLower = (unknown.impact || '').toLowerCase();
      const isHighImpact =
        impactLower.includes('critical') ||
        impactLower.includes('block') ||
        impactLower.includes('architecture') ||
        impactLower.includes('security') ||
        impactLower.includes('require');

      if (isHighImpact) {
        questions.push({
          clarificationId: nextId(),
          kind: 'MISSING_REQUIREMENT',
          priority: 'REQUIRED',
          question: `Please clarify: ${unknown.item}. How should this be handled for project development?`,
          context: unknown.description,
          reason: unknown.impact,
          evidence: [],
          relatedDiscoveryFinding: {
            id: unknown.id,
            type: 'unknown',
            summary: unknown.item,
          },
          allowsFreeFormAnswer: true,
          status: 'OPEN',
          blocking: true,
          uncertaintyType: 'MISSING',
          createdAt: now,
        });
      } else {
        // Low impact / non-critical: preserve as informational unknown without question spam
        informationalUnknowns.push(unknown);
      }
    }

    // ------------------------------------------------------------------------
    // 6. CLARIFICATION CANDIDATES INTEGRATION (FROM P8-03)
    // ------------------------------------------------------------------------
    // Ensure any candidates from P8-03 not already represented are merged safely
    for (const candidate of report.clarificationCandidates) {
      // Check if already captured by purpose, contradiction, or command
      const alreadyCaptured = questions.some(
        (q) =>
          (candidate.contradictionRef &&
            q.contradictionPair?.contradictionId === candidate.contradictionRef) ||
          (candidate.category === 'PURPOSE' && q.kind === 'UNKNOWN_PRODUCT_INTENT') ||
          (candidate.category === 'COMMAND' &&
            candidate.title.toLowerCase().includes('test') &&
            q.question.toLowerCase().includes('test suite')) ||
          (candidate.category === 'COMMAND' &&
            candidate.title.toLowerCase().includes('build') &&
            q.question.toLowerCase().includes('build')) ||
          (candidate.category === 'ENTRYPOINT' && q.kind === 'UNCLEAR_ENTRYPOINT')
      );

      if (!alreadyCaptured) {
        let kind: ClarificationQuestion['kind'] = 'OTHER';
        let priority: ClarificationQuestion['priority'] = 'IMPORTANT';
        let blocking = false;
        let uncertaintyType: UncertaintyType = 'AMBIGUOUS';

        if (candidate.category === 'PURPOSE') {
          kind = 'UNKNOWN_PRODUCT_INTENT';
          priority = 'REQUIRED';
          blocking = true;
          uncertaintyType = 'MISSING';
        } else if (candidate.category === 'CONTRADICTION') {
          kind = 'CONTRADICTORY_REQUIREMENT';
          priority = 'REQUIRED';
          blocking = true;
          uncertaintyType = 'CONTRADICTORY';
        } else if (candidate.category === 'REQUIREMENTS') {
          kind = 'MISSING_REQUIREMENT';
          priority = 'REQUIRED';
          blocking = true;
          uncertaintyType = 'MISSING';
        } else if (candidate.category === 'FEATURE_SCOPE') {
          kind = 'AMBIGUOUS_REQUIREMENT';
          priority = 'IMPORTANT';
          blocking = true;
          uncertaintyType = 'AMBIGUOUS';
        } else if (candidate.category === 'ARCHITECTURE') {
          kind = 'AMBIGUOUS_REQUIREMENT';
          priority = 'IMPORTANT';
          blocking = true;
          uncertaintyType = 'AMBIGUOUS';
        }

        questions.push({
          clarificationId: nextId(),
          kind,
          priority,
          question: candidate.question,
          context: candidate.title,
          reason: 'Discovery flagged this item as requiring authoritative user clarification.',
          evidence: candidate.evidence,
          relatedDiscoveryFinding: {
            id: candidate.id,
            type: 'candidate',
            summary: candidate.title,
          },
          options: candidate.options,
          allowsFreeFormAnswer: true,
          status: 'OPEN',
          blocking,
          uncertaintyType,
          createdAt: now,
        });
      }
    }

    // ------------------------------------------------------------------------
    // 7. INFERENCES SAFETY INVARIANT
    // ------------------------------------------------------------------------
    // Inferences must NEVER be promoted to requirements.
    // Record known inferences into clearAreas with explicit "(Inferred - requires verification)" label
    for (const inf of report.inferences) {
      clearAreas.push(`Inference: ${inf.inference} (Rationale: ${inf.rationale})`);
    }

    // Technology stack clear areas
    if (report.technologyStack.primaryLanguages.length > 0) {
      clearAreas.push(`Primary Languages: ${report.technologyStack.primaryLanguages.join(', ')}`);
    }
    if (report.technologyStack.frameworks.length > 0) {
      clearAreas.push(`Frameworks: ${report.technologyStack.frameworks.join(', ')}`);
    }

    // ------------------------------------------------------------------------
    // 8. DETERMINISTIC SORTING & PARTITIONING
    // ------------------------------------------------------------------------
    const sortedQuestions = sortClarificationQuestions(questions);
    const blockingQuestions = sortedQuestions.filter((q) => q.blocking);
    const nonBlockingQuestions = sortedQuestions.filter((q) => !q.blocking);

    const uncertaintyCounts: Record<UncertaintyType, number> = {
      CLEAR: clearAreas.length,
      AMBIGUOUS: 0,
      CONTRADICTORY: 0,
      MISSING: 0,
      INSUFFICIENT_EVIDENCE: 0,
    };

    for (const q of sortedQuestions) {
      uncertaintyCounts[q.uncertaintyType] = (uncertaintyCounts[q.uncertaintyType] || 0) + 1;
    }

    return {
      clearAreas: Object.freeze(clearAreas),
      questions: Object.freeze(sortedQuestions),
      blockingQuestions: Object.freeze(blockingQuestions),
      nonBlockingQuestions: Object.freeze(nonBlockingQuestions),
      informationalUnknowns: Object.freeze(informationalUnknowns),
      summary: {
        totalQuestions: sortedQuestions.length,
        blockingCount: blockingQuestions.length,
        nonBlockingCount: nonBlockingQuestions.length,
        uncertaintyCounts: Object.freeze(uncertaintyCounts),
      },
    };
  }
}

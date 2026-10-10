import type { ProjectDiscoveryReport } from '../../dist/discovery/index.js';
import type { ApprovalPackage } from '../../dist/approval/index.js';
import { ApprovalPackageEngine, InitialProjectUnderstandingBuilder } from '../../dist/approval/index.js';

export function createValidDiscoveryReport(overrides?: Partial<ProjectDiscoveryReport>): ProjectDiscoveryReport {
  return {
    projectIdentity: {
      name: 'test-project',
      version: '1.0.0',
      workspaceRoot: process.cwd(),
      ecosystem: 'Node.js',
      evidence: [],
      ...overrides?.projectIdentity,
    },
    purpose: {
      classification: 'UNDERSTOOD',
      summary: 'Test Project Purpose',
      domainKeywords: ['test'],
      evidence: [],
      ...overrides?.purpose,
    },
    technologyStack: {
      primaryLanguages: ['TypeScript'],
      frameworks: [],
      buildTools: ['tsc'],
      packageManagers: ['pnpm'],
      runtimes: ['node'],
      containerization: [],
      ciCd: [],
      workspaceType: 'standalone',
      dependencies: [],
      devDependencies: [],
      evidence: [],
      ...overrides?.technologyStack,
    },
    repositoryStructure: {
      layout: 'standard-src',
      topLevelDirectories: ['src'],
      totalFileCount: 1,
      significantFiles: ['package.json'],
      fileExtensions: ['.ts'],
      evidence: [],
      ...overrides?.repositoryStructure,
    },
    architecture: {
      architecturalPattern: 'modular',
      summary: 'Modular architecture',
      identifiedAreas: [],
      evidence: [],
      ...overrides?.architecture,
    },
    entryPoints: [],
    commands: {
      build: { status: 'DISCOVERED', evidence: [] },
      test: { status: 'DISCOVERED', evidence: [] },
      lint: { status: 'UNKNOWN', evidence: [] },
      runtime: { status: 'UNKNOWN', evidence: [] },
      ...overrides?.commands,
    },
    featureInventory: [],
    documentationSummary: {
      hasReadme: false,
      hasContributing: false,
      hasArchitectureDocs: false,
      documentationFiles: [],
      summary: 'Documentation summary',
      evidence: [],
      ...overrides?.documentationSummary,
    },
    requirementsSummary: {
      totalRequirements: 0,
      lockedCount: 0,
      source: 'NONE',
      requirements: [],
      evidence: [],
      ...overrides?.requirementsSummary,
    },
    decisionsSummary: {
      totalDecisions: 0,
      source: 'NONE',
      decisions: [],
      evidence: [],
      ...overrides?.decisionsSummary,
    },
    currentImplementationState: {
      lifecycleState: 'TASK_LOOP',
      hasActiveTask: false,
      isBlocked: false,
      totalTasksInDag: 1,
      completedTasksCount: 0,
      evidence: [],
      ...overrides?.currentImplementationState,
    },
    gitStatus: {
      uncommittedChangesCount: 0,
      untrackedFilesCount: 0,
      evidence: [],
      ...overrides?.gitStatus,
    },
    facts: [],
    observations: [],
    inferences: [],
    unknowns: [],
    contradictions: [],
    clarificationCandidates: [],
    recommendedNextAction: 'PROCEED_TO_CLARIFICATION',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

export function createValidApprovalPackage(overrides?: Partial<ApprovalPackage>): ApprovalPackage {
  const projectId = overrides?.projectId ?? 'test-project';
  const revision = overrides?.revision ?? 1;
  const engine = new ApprovalPackageEngine();
  const builder = new InitialProjectUnderstandingBuilder();
  const disc = createValidDiscoveryReport({ projectIdentity: { name: projectId, workspaceRoot: process.cwd(), ecosystem: 'Node.js', evidence: [] } });
  const understanding = builder.build(disc, undefined, { projectId });
  const rawDraft = engine.buildPackage(understanding, undefined, { packageId: overrides?.packageId ?? `pkg_${projectId}_test` });
  const draft = {
    ...rawDraft,
    revision,
    approvalPackageRevision: revision,
  };
  const approved = engine.approvePackage(draft, {
    packageId: draft.packageId,
    revision,
    actor: 'PRODUCT_OWNER',
    actorRole: 'PRODUCT_OWNER',
    intent: 'EXPLICIT_APPROVAL',
    comment: 'Canonical test approval',
  });
  return {
    ...approved,
    projectId,
    revision,
    approvalPackageRevision: revision,
    ...overrides,
    projectUnderstanding: {
      ...approved.projectUnderstanding,
      projectId,
      ...overrides?.projectUnderstanding,
    },
    approvalRecord: {
      ...approved.approvalRecord!,
      packageId: overrides?.packageId ?? draft.packageId,
      revision,
      ...overrides?.approvalRecord,
    },
  };
}

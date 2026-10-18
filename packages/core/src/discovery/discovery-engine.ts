/**
 * Project Discovery Engine Implementation (Phase 8 TASK-P8-03)
 *
 * Bounded, structured, evidence-backed discovery workflow for existing projects.
 * Inspects an existing software repository and produces a typed ProjectDiscoveryReport
 * suitable for later P8-04 (Ambiguity/Clarification) and P8-05 (Project Understanding).
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. STRICTLY READ-ONLY: Never mutates project state, files, Git, FSM, tasks, or specs.
 * 2. NO ARBITRARY OS EXECUTION: Never invokes shell or arbitrary child processes.
 * 3. NO ANTIGRAVITY EXECUTION: Never triggers implementation or Antigravity agents.
 * 4. FACT / OBSERVATION / INFERENCE / UNKNOWN / CONTRADICTION SEPARATION:
 *    - Never silently convert inferences into requirements.
 *    - Never silently resolve contradictions.
 * 5. NO DUPLICATE SOURCE OF TRUTH:
 *    - Reuses existing SpecStore, DurableStateManager, TaskDagEngine, GitPort, HistoryManager, ContextEngine.
 * 6. BOUNDED DISCOVERY:
 *    - Reference-first L0/L1 approach. Never dumps entire repositories into memory.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  ProjectDiscoveryReport,
  ProjectIdentity,
  ProjectPurposeUnderstanding,
  TechnologyStackInfo,
  RepositoryStructureInfo,
  ArchitectureSummary,
  ArchitecturalArea,
  ArchitecturalAreaCategory,
  DiscoveredEntryPoint,
  ProjectCommands,
  DiscoveredCommand,
  DiscoveredFeature,
  DocumentationSummary,
  RequirementsSummary,
  RequirementItemSummary,
  DecisionsSummary,
  DecisionItemSummary,
  ImplementationStateSummary,
  GitStateSummary,
  DiscoveryFact,
  DiscoveryObservation,
  DiscoveryInference,
  DiscoveryUnknown,
  DiscoveryContradiction,
  ClarificationCandidate,
  DiscoveryOptions,
  EvidenceReference,
} from './discovery-types.js';
import { scanWorkspaceFiles } from '../l0/scanner.js';
import type { ContextEngine } from '../context-engine/context-engine.js';
import type { SpecStore } from '../storage/spec-store.js';
import type { DurableStateManager } from '../storage/durable-state.js';
import type { HistoryManager } from '../storage/history-manager.js';
import type { GitPort } from '../git/git-port.js';
import type { CheckpointStore } from '../cli/checkpoint-store.js';
import type { TaskDagEngine } from '../task-engine/dag-engine.js';
import type { McpOrchestratorDelegate } from '../mcp/mcp-delegate.js';

export interface ProjectDiscoveryEngineOptions {
  readonly workspaceRoot: string;
  readonly contextEngine?: ContextEngine;
  readonly specStore?: SpecStore;
  readonly durableStateManager?: DurableStateManager;
  readonly historyManager?: HistoryManager;
  readonly gitPort?: GitPort;
  readonly checkpointStore?: CheckpointStore;
  readonly dagEngine?: TaskDagEngine;
  readonly delegate?: McpOrchestratorDelegate;
  readonly maxFileScan?: number;
  readonly maxDocBytes?: number;
}

export class ProjectDiscoveryEngine {
  readonly workspaceRoot: string;
  private readonly contextEngine?: ContextEngine;
  private readonly specStore?: SpecStore;
  private readonly durableStateManager?: DurableStateManager;
  private readonly historyManager?: HistoryManager;
  private readonly gitPort?: GitPort;
  private readonly checkpointStore?: CheckpointStore;
  private readonly dagEngine?: TaskDagEngine;
  private readonly maxFileScan: number;
  private readonly maxDocBytes: number;

  constructor(options: ProjectDiscoveryEngineOptions) {
    if (!options.workspaceRoot) {
      throw new Error('workspaceRoot is required for ProjectDiscoveryEngine');
    }
    this.workspaceRoot = path.resolve(options.workspaceRoot);

    // Extract authoritative services from delegate if provided, or explicit options
    const delegate = options.delegate;
    this.contextEngine = options.contextEngine ?? delegate?.contextEngine;
    this.specStore = options.specStore ?? delegate?.specStore;
    this.durableStateManager = options.durableStateManager ?? delegate?.durableStateManager;
    this.historyManager = options.historyManager ?? delegate?.historyManager;
    this.gitPort = options.gitPort ?? delegate?.gitPort;
    this.checkpointStore = options.checkpointStore ?? delegate?.checkpointStore;
    this.dagEngine = options.dagEngine ?? delegate?.dagEngine;

    this.maxFileScan = options.maxFileScan ?? 5000;
    this.maxDocBytes = options.maxDocBytes ?? 32768; // 32 KB max bounded doc reads
  }

  /**
   * Executes bounded, evidence-backed read-only project discovery.
   */
  async discover(options?: DiscoveryOptions): Promise<ProjectDiscoveryReport> {
    const maxFiles = options?.maxFileScan ?? this.maxFileScan;
    const maxDocBytes = options?.maxDocBytes ?? this.maxDocBytes;
    const maxFeatures = options?.maxFeatures ?? 50;

    // 1. Context Freshness Guard (bounded, does not mutate project files)
    if (this.contextEngine && options?.allowContextRefresh) {
      try {
        await this.contextEngine.syncIndex();
      } catch {
        // Fallback: non-fatal if index cannot sync
      }
    }

    // 2. L0 Filesystem Reference-First Scan
    const scannedFiles = await scanWorkspaceFiles(this.workspaceRoot);
    const boundedFiles = scannedFiles.slice(0, maxFiles);
    const filePaths = boundedFiles.map((f) => f.relativePath.replace(/\\/g, '/'));
    const fileSet = new Set(filePaths);

    // 3. Manifest & Configuration Inspection
    const manifestData = await this.readManifests(fileSet, maxDocBytes);

    // 4. Project Identity
    const projectIdentity = this.determineProjectIdentity(manifestData, filePaths);

    // 5. Documentation Summary & Purpose Discovery
    const docSummary = await this.inspectDocumentation(fileSet, maxDocBytes);
    const purpose = this.determinePurpose(docSummary, manifestData);

    // 6. Technology Stack Discovery
    const techStack = await this.determineTechnologyStack(fileSet, filePaths, manifestData);

    // 7. Repository Structure Discovery
    const repoStructure = this.determineRepositoryStructure(filePaths, scannedFiles.length);

    // 8. Architecture & Subsystems Discovery
    const architecture = this.determineArchitecture(filePaths);

    // 9. Entrypoints & Commands Discovery
    const entryPoints = this.determineEntryPoints(manifestData, fileSet);
    const commands = await this.determineCommands(manifestData, fileSet, maxDocBytes);

    // 10. Feature Inventory (Bounded)
    const features = this.determineFeatureInventory(filePaths, manifestData, docSummary, maxFeatures);

    // 11. Authoritative AIDM Requirements & Decisions Inspection
    const requirementsSummary = await this.inspectRequirements();
    const decisionsSummary = await this.inspectDecisions();

    // 12. Authoritative Implementation & Git State Inspection
    const implementationState = await this.inspectImplementationState();
    const gitStatus = await this.inspectGitStatus();

    // 13. Facts, Observations, Inferences & Unknowns Synthesis
    const { facts, observations, inferences, unknowns } = this.synthesizeAnalysis(
      projectIdentity,
      purpose,
      techStack,
      repoStructure,
      architecture,
      entryPoints,
      commands,
      docSummary,
      requirementsSummary,
      decisionsSummary,
      implementationState,
      gitStatus
    );

    // 14. Contradiction Detection
    const contradictions = this.detectContradictions(
      manifestData,
      docSummary,
      commands,
      features,
      requirementsSummary,
      decisionsSummary,
      implementationState
    );

    // 15. Clarification Candidates Generation (For P8-04)
    const clarificationCandidates = this.generateClarificationCandidates(
      purpose,
      commands,
      entryPoints,
      contradictions,
      unknowns
    );

    // 16. Next Action Recommendation
    const recommendedNextAction =
      contradictions.length > 0 || purpose.classification === 'UNKNOWN'
        ? 'PROCEED_TO_CLARIFICATION'
        : 'PROCEED_TO_CLARIFICATION';

    return {
      projectIdentity,
      purpose,
      technologyStack: techStack,
      repositoryStructure: repoStructure,
      architecture,
      entryPoints,
      commands,
      featureInventory: features,
      documentationSummary: docSummary,
      requirementsSummary,
      decisionsSummary,
      currentImplementationState: implementationState,
      gitStatus,
      facts,
      observations,
      inferences,
      unknowns,
      contradictions,
      clarificationCandidates,
      recommendedNextAction,
      timestamp: new Date().toISOString(),
    };
  }

  // ==========================================================================
  // MANIFEST INSPECTION
  // ==========================================================================

  private async readManifests(
    fileSet: Set<string>,
    maxDocBytes: number
  ): Promise<ManifestData> {
    const data: ManifestData = {
      packageJson: null,
      pyprojectToml: null,
      cargoToml: null,
      goMod: null,
      makeContent: null,
    };

    if (fileSet.has('package.json')) {
      try {
        const fullPath = path.join(this.workspaceRoot, 'package.json');
        const raw = await this.readBoundedFile(fullPath, maxDocBytes);
        data.packageJson = JSON.parse(raw);
      } catch {
        // Non-fatal parse failure
      }
    }

    if (fileSet.has('pyproject.toml')) {
      try {
        const fullPath = path.join(this.workspaceRoot, 'pyproject.toml');
        data.pyprojectToml = await this.readBoundedFile(fullPath, maxDocBytes);
      } catch {
        // Non-fatal
      }
    }

    if (fileSet.has('Cargo.toml')) {
      try {
        const fullPath = path.join(this.workspaceRoot, 'Cargo.toml');
        data.cargoToml = await this.readBoundedFile(fullPath, maxDocBytes);
      } catch {
        // Non-fatal
      }
    }

    if (fileSet.has('go.mod')) {
      try {
        const fullPath = path.join(this.workspaceRoot, 'go.mod');
        data.goMod = await this.readBoundedFile(fullPath, maxDocBytes);
      } catch {
        // Non-fatal
      }
    }

    if (fileSet.has('Makefile')) {
      try {
        const fullPath = path.join(this.workspaceRoot, 'Makefile');
        data.makeContent = await this.readBoundedFile(fullPath, maxDocBytes);
      } catch {
        // Non-fatal
      }
    }

    return data;
  }

  // ==========================================================================
  // PROJECT IDENTITY
  // ==========================================================================

  private determineProjectIdentity(
    manifests: ManifestData,
    filePaths: string[]
  ): ProjectIdentity {
    let name = path.basename(this.workspaceRoot);
    let version: string | undefined;
    let ecosystem = 'unknown';
    const evidence: EvidenceReference[] = [];

    if (manifests.packageJson) {
      if (manifests.packageJson.name) {
        name = manifests.packageJson.name;
      }
      if (manifests.packageJson.version) {
        version = manifests.packageJson.version;
      }
      const hasTs = filePaths.some((p) => p.endsWith('.ts') || p === 'tsconfig.json');
      ecosystem = hasTs ? 'typescript' : 'node';
      evidence.push({
        sourceType: 'PACKAGE_MANIFEST',
        sourceIdentifier: 'package.json',
        path: 'package.json',
      });
    } else if (manifests.cargoToml) {
      ecosystem = 'rust';
      const nameMatch = manifests.cargoToml.match(/name\s*=\s*["']([^"']+)["']/);
      if (nameMatch) name = nameMatch[1];
      const verMatch = manifests.cargoToml.match(/version\s*=\s*["']([^"']+)["']/);
      if (verMatch) version = verMatch[1];
      evidence.push({
        sourceType: 'CONFIG',
        sourceIdentifier: 'Cargo.toml',
        path: 'Cargo.toml',
      });
    } else if (manifests.pyprojectToml) {
      ecosystem = 'python';
      const nameMatch = manifests.pyprojectToml.match(/name\s*=\s*["']([^"']+)["']/);
      if (nameMatch) name = nameMatch[1];
      const verMatch = manifests.pyprojectToml.match(/version\s*=\s*["']([^"']+)["']/);
      if (verMatch) version = verMatch[1];
      evidence.push({
        sourceType: 'CONFIG',
        sourceIdentifier: 'pyproject.toml',
        path: 'pyproject.toml',
      });
    } else if (manifests.goMod) {
      ecosystem = 'go';
      const modMatch = manifests.goMod.match(/module\s+([^\s\n]+)/);
      if (modMatch) name = modMatch[1];
      evidence.push({
        sourceType: 'CONFIG',
        sourceIdentifier: 'go.mod',
        path: 'go.mod',
      });
    } else {
      evidence.push({
        sourceType: 'FILE',
        sourceIdentifier: 'directory_name',
        path: '.',
      });
    }

    return {
      name,
      version,
      workspaceRoot: this.workspaceRoot,
      ecosystem,
      evidence,
    };
  }

  // ==========================================================================
  // DOCUMENTATION & PURPOSE
  // ==========================================================================

  private async inspectDocumentation(
    fileSet: Set<string>,
    maxDocBytes: number
  ): Promise<DocumentationSummary> {
    const docFiles: string[] = [];
    let readmePath: string | undefined;
    let readmeContent: string | undefined;

    for (const f of fileSet) {
      const lower = f.toLowerCase();
      if (lower === 'readme.md' || lower === 'readme' || lower === 'readme.markdown') {
        readmePath = f;
      }
      if (
        lower.endsWith('.md') ||
        lower.startsWith('docs/') ||
        lower.startsWith('doc/') ||
        lower === 'contributing.md'
      ) {
        docFiles.push(f);
      }
    }

    const hasReadme = Boolean(readmePath);
    const hasContributing = fileSet.has('CONTRIBUTING.md') || fileSet.has('contributing.md');
    const hasArchitectureDocs =
      fileSet.has('ARCHITECTURE.md') ||
      fileSet.has('docs/architecture.md') ||
      fileSet.has('docs/DESIGN.md');

    let summary = '';
    const evidence: EvidenceReference[] = [];

    if (readmePath) {
      try {
        const fullPath = path.join(this.workspaceRoot, readmePath);
        readmeContent = await this.readBoundedFile(fullPath, maxDocBytes);
        evidence.push({
          sourceType: 'FILE',
          sourceIdentifier: readmePath,
          path: readmePath,
          contextLayer: 'L1',
        });

        // Extract first meaningful paragraph (skipping headers/badges)
        const lines = readmeContent.split('\n');
        const contentLines: string[] = [];
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('[![') || trimmed.startsWith('![') || trimmed.startsWith('<!--')) {
            continue;
          }
          contentLines.push(trimmed);
          if (contentLines.length >= 3) break;
        }
        if (contentLines.length > 0) {
          summary = contentLines.join(' ');
        }
      } catch {
        // Non-fatal
      }
    }

    return {
      hasReadme,
      readmePath,
      hasContributing,
      hasArchitectureDocs,
      documentationFiles: docFiles.sort(),
      summary,
      evidence,
    };
  }

  private determinePurpose(
    docSummary: DocumentationSummary,
    manifests: ManifestData
  ): ProjectPurposeUnderstanding {
    const evidence: EvidenceReference[] = [];
    const keywords: string[] = [];
    let summary = '';
    let classification: 'UNDERSTOOD' | 'PARTIALLY_UNDERSTOOD' | 'UNKNOWN' = 'UNKNOWN';

    // 1. Try manifest description
    if (manifests.packageJson?.description && typeof manifests.packageJson.description === 'string') {
      summary = manifests.packageJson.description.trim();
      evidence.push({
        sourceType: 'PACKAGE_MANIFEST',
        sourceIdentifier: 'package.json:description',
        path: 'package.json',
      });
      classification = 'UNDERSTOOD';
    }

    // 2. Supplement with README intro
    if (docSummary.summary) {
      if (!summary) {
        summary = docSummary.summary;
        classification = 'UNDERSTOOD';
      }
      evidence.push(...docSummary.evidence);
    }

    // 3. Fallback: package name / partial
    if (!summary && manifests.packageJson?.name) {
      summary = `Project '${manifests.packageJson.name}' without explicit description.`;
      classification = 'PARTIALLY_UNDERSTOOD';
      evidence.push({
        sourceType: 'PACKAGE_MANIFEST',
        sourceIdentifier: 'package.json:name',
        path: 'package.json',
      });
    }

    if (docSummary.evidence.length > 0 && !evidence.some((e) => e.path === docSummary.readmePath)) {
      evidence.push(...docSummary.evidence);
    }

    if (!summary) {
      summary = 'No explicit project purpose or description found in repository.';
      classification = 'UNKNOWN';
    }

    // Extract keywords
    if (summary) {
      const words = summary.toLowerCase().match(/\b[a-z0-9_-]{4,}\b/g) ?? [];
      const stopWords = new Set(['project', 'without', 'explicit', 'description', 'found', 'repository', 'with', 'from', 'this', 'that']);
      for (const w of words) {
        if (!stopWords.has(w) && !keywords.includes(w)) {
          keywords.push(w);
          if (keywords.length >= 8) break;
        }
      }
    }

    return {
      classification,
      summary,
      domainKeywords: keywords,
      evidence,
    };
  }

  // ==========================================================================
  // TECHNOLOGY STACK
  // ==========================================================================

  /**
   * General-purpose Markdown scanner for technology stack and requirement sections.
   * Works for any project: looks for requirement/spec/design docs and extracts
   * tech mentions from tables, lists and headings.
   */
  private async scanMarkdownForTechAndSections(
    fileSet: Set<string>,
    maxDocBytes: number
  ): Promise<{
    techMentions: string[];
    candidateSections: Array<{ file: string; heading: string; content: string }>;
  }> {
    const techMentions = new Set<string>();
    const candidateSections: Array<{ file: string; heading: string; content: string }> = [];

    const techKeywords = [
      'Next.js', 'React', 'React Native', 'Expo', 'Electron', 'Vue', 'Nuxt', 'Angular',
      'Svelte', 'SvelteKit', 'Tailwind', 'shadcn', 'Supabase', 'PostgreSQL', 'MongoDB',
      'Firebase', 'Prisma', 'Drizzle', 'tRPC', 'GraphQL', 'REST', 'WebSocket',
      'Node.js', 'Deno', 'Bun', 'TypeScript', 'Python', 'FastAPI', 'Django', 'Flask',
      'Rust', 'Go', 'Java', 'Kotlin', 'Spring', 'Docker', 'Kubernetes', 'Vercel',
      'AWS', 'GCP', 'Azure', 'Redis', 'Kafka', 'RabbitMQ', 'OpenAI', 'Anthropic',
      'MCP', 'Model Context Protocol', 'Zod', 'Vitest', 'Jest', 'Playwright', 'Cypress',
      'Turborepo', 'pnpm', 'monorepo', 'App Router', 'Server Components',
    ];

    const candidateFiles = Array.from(fileSet).filter((f) => {
      const lower = f.toLowerCase();
      return (
        lower.endsWith('.md') &&
        (lower.includes('requirement') ||
          lower.includes('gereksinim') ||
          lower.includes('spec') ||
          lower.includes('proje') ||
          lower.includes('architecture') ||
          lower.includes('design') ||
          lower.includes('tech') ||
          lower.startsWith('docs/'))
      );
    });

    for (const relPath of candidateFiles.slice(0, 8)) {
      try {
        const fullPath = path.join(this.workspaceRoot, relPath);
        const content = await this.readBoundedFile(fullPath, maxDocBytes);
        const lowerContent = content.toLowerCase();

        for (const kw of techKeywords) {
          if (lowerContent.includes(kw.toLowerCase()) && !techMentions.has(kw)) {
            techMentions.add(kw);
          }
        }

        const lines = content.split('\n');
        let currentHeading = '';
        let currentContent: string[] = [];
        for (const line of lines) {
          const headingMatch = line.match(/^(#{1,3})\s+(.+)/);
          if (headingMatch) {
            if (currentHeading && currentContent.length > 0) {
              candidateSections.push({
                file: relPath,
                heading: currentHeading,
                content: currentContent.join('\n').trim().slice(0, 800),
              });
            }
            currentHeading = headingMatch[2].trim();
            currentContent = [];
          } else if (currentHeading) {
            currentContent.push(line);
          }
        }
        if (currentHeading && currentContent.length > 0) {
          candidateSections.push({
            file: relPath,
            heading: currentHeading,
            content: currentContent.join('\n').trim().slice(0, 800),
          });
        }
      } catch {
        // Non-fatal
      }
    }

    return {
      techMentions: Array.from(techMentions),
      candidateSections,
    };
  }

  private async determineTechnologyStack(
    fileSet: Set<string>,
    filePaths: string[],
    manifests: ManifestData
  ): Promise<TechnologyStackInfo> {
    const languages: string[] = [];
    const frameworks: string[] = [];
    const buildTools: string[] = [];
    const packageManagers: string[] = [];
    const runtimes: string[] = [];
    const containerization: string[] = [];
    const ciCd: string[] = [];
    const dependencies: string[] = [];
    const devDependencies: string[] = [];
    const evidence: EvidenceReference[] = [];

    // Language detection
    if (filePaths.some((f) => f.endsWith('.ts') || f.endsWith('.tsx'))) {
      languages.push('TypeScript');
    }
    if (filePaths.some((f) => f.endsWith('.js') || f.endsWith('.jsx') || f.endsWith('.mjs') || f.endsWith('.cjs'))) {
      languages.push('JavaScript');
    }
    if (filePaths.some((f) => f.endsWith('.py'))) {
      languages.push('Python');
    }
    if (filePaths.some((f) => f.endsWith('.rs'))) {
      languages.push('Rust');
    }
    if (filePaths.some((f) => f.endsWith('.go'))) {
      languages.push('Go');
    }
    if (filePaths.some((f) => f.endsWith('.java') || f.endsWith('.kt'))) {
      languages.push('Java/Kotlin');
    }

    // Node ecosystem details
    if (manifests.packageJson) {
      runtimes.push('Node.js');
      const deps = manifests.packageJson.dependencies ?? {};
      const devDeps = manifests.packageJson.devDependencies ?? {};

      for (const k of Object.keys(deps)) {
        dependencies.push(k);
      }
      for (const k of Object.keys(devDeps)) {
        devDependencies.push(k);
      }

      // Frameworks & Libraries
      const allDepKeys = [...Object.keys(deps), ...Object.keys(devDeps)];
      const frameworkMatchers: Record<string, string> = {
        express: 'Express',
        fastify: 'Fastify',
        '@nestjs/core': 'NestJS',
        react: 'React',
        vue: 'Vue',
        next: 'Next.js',
        zod: 'Zod',
        vitest: 'Vitest',
        jest: 'Jest',
        mocha: 'Mocha',
        prisma: 'Prisma',
        '@modelcontextprotocol/sdk': 'MCP SDK',
      };

      for (const [dep, label] of Object.entries(frameworkMatchers)) {
        if (allDepKeys.includes(dep) && !frameworks.includes(label)) {
          frameworks.push(label);
        }
      }

      // Build tools
      if (allDepKeys.includes('typescript') || fileSet.has('tsconfig.json')) {
        buildTools.push('TypeScript Compiler (tsc)');
      }
      if (allDepKeys.includes('vite')) buildTools.push('Vite');
      if (allDepKeys.includes('webpack')) buildTools.push('Webpack');
      if (allDepKeys.includes('esbuild')) buildTools.push('esbuild');
      if (allDepKeys.includes('rollup')) buildTools.push('Rollup');

      evidence.push({
        sourceType: 'PACKAGE_MANIFEST',
        sourceIdentifier: 'package.json',
        path: 'package.json',
      });
    }

    // Package managers
    if (fileSet.has('pnpm-lock.yaml') || fileSet.has('pnpm-workspace.yaml')) {
      packageManagers.push('pnpm');
    } else if (fileSet.has('package-lock.json')) {
      packageManagers.push('npm');
    } else if (fileSet.has('yarn.lock')) {
      packageManagers.push('yarn');
    } else if (fileSet.has('Cargo.lock')) {
      packageManagers.push('cargo');
    } else if (fileSet.has('poetry.lock') || fileSet.has('Pipfile.lock')) {
      packageManagers.push('poetry');
    }

    // Containerization
    if (fileSet.has('Dockerfile') || fileSet.has('docker-compose.yml') || fileSet.has('compose.yaml')) {
      containerization.push('Docker');
      evidence.push({
        sourceType: 'CONFIG',
        sourceIdentifier: 'Docker configuration',
        path: fileSet.has('Dockerfile') ? 'Dockerfile' : 'docker-compose.yml',
      });
    }

    // CI/CD
    const ciFiles = filePaths.filter((f) => f.startsWith('.github/workflows/'));
    if (ciFiles.length > 0) {
      ciCd.push('GitHub Actions');
      evidence.push({
        sourceType: 'CI_WORKFLOW',
        sourceIdentifier: 'GitHub Actions Workflows',
        path: ciFiles[0],
      });
    } else if (fileSet.has('.gitlab-ci.yml')) {
      ciCd.push('GitLab CI');
    }

    // Workspace type
    let workspaceType: 'monorepo' | 'standalone' | 'multi-package' | 'unknown' = 'standalone';
    if (fileSet.has('pnpm-workspace.yaml') || fileSet.has('lerna.json') || (manifests.packageJson?.workspaces)) {
      workspaceType = 'monorepo';
    } else if (filePaths.some((f) => f.startsWith('packages/'))) {
      workspaceType = 'monorepo';
    }

    // Enrich from Markdown requirement/spec docs (general)
    try {
      const mdScan = await this.scanMarkdownForTechAndSections(fileSet, this.maxDocBytes);
      for (const tech of mdScan.techMentions) {
        if (!frameworks.includes(tech) && !runtimes.includes(tech) && !languages.includes(tech)) {
          frameworks.push(tech);
        }
      }
      if (mdScan.techMentions.length > 0) {
        evidence.push({
          sourceType: 'FILE',
          sourceIdentifier: 'Markdown tech extraction',
          path: 'docs/*.md / *requirement*.md',
          contextLayer: 'L1',
        });
      }
    } catch {
      // Non-fatal
    }

    return {
      primaryLanguages: languages,
      frameworks,
      buildTools,
      packageManagers,
      runtimes,
      containerization,
      ciCd,
      workspaceType,
      dependencies,
      devDependencies,
      evidence,
    };
  }

  // Remaining original methods (determineRepositoryStructure, determineArchitecture, determineEntryPoints, determineCommands, determineFeatureInventory, inspectRequirements, inspectDecisions, inspectImplementationState, inspectGitStatus, synthesizeAnalysis, detectContradictions, generateClarificationCandidates, readBoundedFile and other helpers) are preserved from the original implementation.

  /**
   * Extracts structured requirement candidates from Markdown documentation.
   * General-purpose. Returns items suitable for SpecStore.saveRequirements().
   * Discovery remains read-only.
   */
  async extractCandidateRequirements(
    maxSections: number = 30
  ): Promise<Array<{ id: string; title: string; description: string; metadata?: Record<string, unknown> }>> {
    const scanned = await scanWorkspaceFiles(this.workspaceRoot);
    const filePaths = scanned.map((f) => f.relativePath.replace(/\\/g, '/'));
    const fileSet = new Set(filePaths);

    const { candidateSections } = await this.scanMarkdownForTechAndSections(fileSet, this.maxDocBytes);

    const results = [];
    let idx = 1;
    for (const sec of candidateSections.slice(0, maxSections)) {
      if (!sec.heading || sec.content.length < 20) continue;
      results.push({
        id: `REQ-MD-${String(idx).padStart(3, '0')}`,
        title: sec.heading.slice(0, 120),
        description: sec.content.slice(0, 1500),
        metadata: {
          sourceFile: sec.file,
          extractedBy: 'ProjectDiscoveryEngine.extractCandidateRequirements',
        },
      });
      idx++;
    }
    return results;
  }
}

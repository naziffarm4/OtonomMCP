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
    const techStack = this.determineTechnologyStack(fileSet, filePaths, manifestData);

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

  private determineTechnologyStack(
    fileSet: Set<string>,
    filePaths: string[],
    manifests: ManifestData
  ): TechnologyStackInfo {
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

  // ==========================================================================
  // REPOSITORY STRUCTURE & ARCHITECTURE
  // ==========================================================================

  private determineRepositoryStructure(
    filePaths: string[],
    totalFiles: number
  ): RepositoryStructureInfo {
    const topDirs = new Set<string>();
    const extSet = new Set<string>();
    const significantFiles: string[] = [];

    const interestingFilenames = new Set([
      'package.json',
      'tsconfig.json',
      'pnpm-workspace.yaml',
      'Cargo.toml',
      'pyproject.toml',
      'go.mod',
      'Dockerfile',
      'Makefile',
      'README.md',
    ]);

    for (const f of filePaths) {
      const parts = f.split('/');
      if (parts.length > 1) {
        topDirs.add(parts[0]);
      }
      const ext = path.extname(f);
      if (ext) extSet.add(ext);

      const base = path.basename(f);
      if (interestingFilenames.has(base) && !significantFiles.includes(f)) {
        significantFiles.push(f);
      }
    }

    let layout: 'monorepo' | 'standard-src' | 'flat' | 'unknown' = 'unknown';
    if (topDirs.has('packages')) {
      layout = 'monorepo';
    } else if (topDirs.has('src')) {
      layout = 'standard-src';
    } else if (topDirs.size > 0) {
      layout = 'flat';
    }

    return {
      layout,
      topLevelDirectories: Array.from(topDirs).sort(),
      totalFileCount: totalFiles,
      significantFiles: significantFiles.sort(),
      fileExtensions: Array.from(extSet).sort(),
      evidence: [
        {
          sourceType: 'FILE',
          sourceIdentifier: 'workspace_structure',
          path: '.',
          contextLayer: 'L0',
        },
      ],
    };
  }

  private determineArchitecture(filePaths: string[]): ArchitectureSummary {
    const areas: ArchitecturalArea[] = [];
    const dirMap = new Map<string, string[]>();

    for (const f of filePaths) {
      const parts = f.split('/');
      if (parts.length >= 2) {
        const top = parts[0];
        const sub = parts[1];
        const composite = `${top}/${sub}`;
        if (!dirMap.has(top)) dirMap.set(top, []);
        dirMap.get(top)!.push(f);
        if (!dirMap.has(composite)) dirMap.set(composite, []);
        dirMap.get(composite)!.push(f);
      }
    }

    const areaPatterns: Array<{
      category: ArchitecturalAreaCategory;
      matcher: (dir: string) => boolean;
      description: string;
    }> = [
      {
        category: 'frontend',
        matcher: (d) => /^(frontend|ui|web|client|pages|components)($|\/)/i.test(d),
        description: 'User interface components, pages, or client presentation layer',
      },
      {
        category: 'backend',
        matcher: (d) => /^(backend|server)($|\/)/i.test(d),
        description: 'Backend application server and services',
      },
      {
        category: 'api',
        matcher: (d) => /(api|routes|controllers|endpoints)($|\/)/i.test(d),
        description: 'HTTP/REST routes, API endpoints, or controllers',
      },
      {
        category: 'database',
        matcher: (d) => /(db|database|prisma|migrations|models|schema)($|\/)/i.test(d),
        description: 'Database schema, persistence models, or migrations',
      },
      {
        category: 'domain',
        matcher: (d) => /(domain|core)($|\/)/i.test(d),
        description: 'Core domain business logic and entities',
      },
      {
        category: 'cli',
        matcher: (d) => /(cli|bin|cmd)($|\/)/i.test(d),
        description: 'Command line interface commands, runners, or entrypoints',
      },
      {
        category: 'services',
        matcher: (d) => /(services|modules)($|\/)/i.test(d),
        description: 'Business service modules and integrations',
      },
      {
        category: 'tests',
        matcher: (d) => /(tests?|__tests__|spec)($|\/)/i.test(d),
        description: 'Automated test suites, unit, and integration tests',
      },
      {
        category: 'infrastructure',
        matcher: (d) => /(infra|infrastructure|k8s|terraform|docker)($|\/)/i.test(d),
        description: 'Infrastructure as code, containerization, or orchestration',
      },
      {
        category: 'config',
        matcher: (d) => /(config|configs)($|\/)/i.test(d),
        description: 'Project configuration and environment management',
      },
      {
        category: 'documentation',
        matcher: (d) => /(docs|documentation)($|\/)/i.test(d),
        description: 'Project specifications, architecture docs, and guides',
      },
    ];

    const detectedCategories = new Set<string>();

    for (const [dir, files] of dirMap.entries()) {
      for (const pattern of areaPatterns) {
        if (pattern.matcher(dir) && !detectedCategories.has(`${pattern.category}:${dir}`)) {
          detectedCategories.add(`${pattern.category}:${dir}`);
          areas.push({
            area: pattern.category,
            path: dir,
            description: pattern.description,
            keyComponents: files.slice(0, 5),
            evidence: [
              {
                sourceType: 'FILE',
                sourceIdentifier: dir,
                path: dir,
                contextLayer: 'L0',
              },
            ],
          });
        }
      }
    }

    const architecturalPattern =
      areas.some((a) => a.area === 'domain') && areas.some((a) => a.area === 'api')
        ? 'Layered / Domain-Driven Architecture'
        : areas.some((a) => a.area === 'cli')
          ? 'CLI / Command-Driven Architecture'
          : areas.length > 0
            ? 'Modular Component Architecture'
            : 'Standard Flat Structure';

    const summary = `Identified ${areas.length} architectural areas: ${areas.map((a) => a.area).join(', ') || 'none'}`;

    return {
      identifiedAreas: areas,
      architecturalPattern,
      summary,
      evidence:
        areas.length > 0
          ? areas.flatMap((a) => a.evidence)
          : [
              {
                sourceType: 'FILE',
                sourceIdentifier: 'workspace_structure',
                path: '.',
                contextLayer: 'L0',
              },
            ],
    };
  }

  // ==========================================================================
  // ENTRYPOINTS & COMMANDS
  // ==========================================================================

  private determineEntryPoints(
    manifests: ManifestData,
    fileSet: Set<string>
  ): DiscoveredEntryPoint[] {
    const entryPoints: DiscoveredEntryPoint[] = [];

    // 1. package.json bin
    if (manifests.packageJson?.bin) {
      const bin = manifests.packageJson.bin;
      if (typeof bin === 'string') {
        entryPoints.push({
          type: 'cli',
          target: bin,
          command: manifests.packageJson.name ?? 'cli',
          source: 'package.json:bin',
          isAuthoritative: true,
          evidence: [
            {
              sourceType: 'PACKAGE_MANIFEST',
              sourceIdentifier: 'package.json:bin',
              path: 'package.json',
            },
          ],
        });
      } else if (typeof bin === 'object') {
        for (const [cmd, target] of Object.entries(bin)) {
          entryPoints.push({
            type: 'cli',
            target: String(target),
            command: cmd,
            source: 'package.json:bin',
            isAuthoritative: true,
            evidence: [
              {
                sourceType: 'PACKAGE_MANIFEST',
                sourceIdentifier: `package.json:bin.${cmd}`,
                path: 'package.json',
              },
            ],
          });
        }
      }
    }

    // 2. package.json main
    if (manifests.packageJson?.main) {
      entryPoints.push({
        type: 'library',
        target: manifests.packageJson.main,
        source: 'package.json:main',
        isAuthoritative: true,
        evidence: [
          {
            sourceType: 'PACKAGE_MANIFEST',
            sourceIdentifier: 'package.json:main',
            path: 'package.json',
          },
        ],
      });
    }

    // 3. Known convention files
    const standardMainFiles = [
      { path: 'src/index.ts', type: 'library' as const },
      { path: 'src/main.ts', type: 'main' as const },
      { path: 'src/app.ts', type: 'service' as const },
      { path: 'src/cli.ts', type: 'cli' as const },
      { path: 'main.go', type: 'main' as const },
      { path: 'src/main.rs', type: 'main' as const },
      { path: 'app/main.py', type: 'service' as const },
    ];

    for (const item of standardMainFiles) {
      if (fileSet.has(item.path)) {
        // Only add if not already captured
        if (!entryPoints.some((e) => e.target === item.path)) {
          entryPoints.push({
            type: item.type,
            target: item.path,
            source: 'filesystem convention',
            isAuthoritative: false,
            evidence: [
              {
                sourceType: 'FILE',
                sourceIdentifier: item.path,
                path: item.path,
                contextLayer: 'L0',
              },
            ],
          });
        }
      }
    }

    return entryPoints;
  }

  private async determineCommands(
    manifests: ManifestData,
    fileSet: Set<string>,
    maxDocBytes: number
  ): Promise<ProjectCommands> {
    const scripts = manifests.packageJson?.scripts ?? {};

    // 1. Build Command
    let buildCmd: DiscoveredCommand = {
      status: 'UNKNOWN',
      evidence: [],
    };
    if (scripts.build) {
      buildCmd = {
        status: 'DISCOVERED',
        command: 'pnpm run build', // or npm run build
        source: 'package.json:scripts.build',
        rawDeclaration: scripts.build,
        evidence: [
          {
            sourceType: 'PACKAGE_MANIFEST',
            sourceIdentifier: 'package.json:scripts.build',
            path: 'package.json',
          },
        ],
      };
    } else if (manifests.makeContent && /^build:/m.test(manifests.makeContent)) {
      buildCmd = {
        status: 'DISCOVERED',
        command: 'make build',
        source: 'Makefile',
        rawDeclaration: 'build:',
        evidence: [
          {
            sourceType: 'MAKEFILE',
            sourceIdentifier: 'Makefile:build',
            path: 'Makefile',
          },
        ],
      };
    } else if (fileSet.has('Cargo.toml')) {
      buildCmd = {
        status: 'DISCOVERED',
        command: 'cargo build',
        source: 'Cargo.toml',
        evidence: [
          {
            sourceType: 'CONFIG',
            sourceIdentifier: 'Cargo.toml',
            path: 'Cargo.toml',
          },
        ],
      };
    }

    // 2. Test Command
    let testCmd: DiscoveredCommand = {
      status: 'UNKNOWN',
      evidence: [],
    };
    if (scripts.test) {
      testCmd = {
        status: 'DISCOVERED',
        command: 'pnpm test',
        source: 'package.json:scripts.test',
        rawDeclaration: scripts.test,
        evidence: [
          {
            sourceType: 'PACKAGE_MANIFEST',
            sourceIdentifier: 'package.json:scripts.test',
            path: 'package.json',
          },
        ],
      };
    } else if (manifests.makeContent && /^test:/m.test(manifests.makeContent)) {
      testCmd = {
        status: 'DISCOVERED',
        command: 'make test',
        source: 'Makefile',
        rawDeclaration: 'test:',
        evidence: [
          {
            sourceType: 'MAKEFILE',
            sourceIdentifier: 'Makefile:test',
            path: 'Makefile',
          },
        ],
      };
    } else if (fileSet.has('Cargo.toml')) {
      testCmd = {
        status: 'DISCOVERED',
        command: 'cargo test',
        source: 'Cargo.toml',
        evidence: [
          {
            sourceType: 'CONFIG',
            sourceIdentifier: 'Cargo.toml',
            path: 'Cargo.toml',
          },
        ],
      };
    }

    // 3. Runtime / Start Command
    let runtimeCmd: DiscoveredCommand = {
      status: 'UNKNOWN',
      evidence: [],
    };
    if (scripts.start) {
      runtimeCmd = {
        status: 'DISCOVERED',
        command: 'pnpm start',
        source: 'package.json:scripts.start',
        rawDeclaration: scripts.start,
        evidence: [
          {
            sourceType: 'PACKAGE_MANIFEST',
            sourceIdentifier: 'package.json:scripts.start',
            path: 'package.json',
          },
        ],
      };
    } else if (scripts.dev) {
      runtimeCmd = {
        status: 'DISCOVERED',
        command: 'pnpm run dev',
        source: 'package.json:scripts.dev',
        rawDeclaration: scripts.dev,
        evidence: [
          {
            sourceType: 'PACKAGE_MANIFEST',
            sourceIdentifier: 'package.json:scripts.dev',
            path: 'package.json',
          },
        ],
      };
    } else if (manifests.makeContent && /^run:/m.test(manifests.makeContent)) {
      runtimeCmd = {
        status: 'DISCOVERED',
        command: 'make run',
        source: 'Makefile',
        rawDeclaration: 'run:',
        evidence: [
          {
            sourceType: 'MAKEFILE',
            sourceIdentifier: 'Makefile:run',
            path: 'Makefile',
          },
        ],
      };
    }

    // 4. Lint Command
    let lintCmd: DiscoveredCommand = {
      status: 'UNKNOWN',
      evidence: [],
    };
    if (scripts.lint) {
      lintCmd = {
        status: 'DISCOVERED',
        command: 'pnpm run lint',
        source: 'package.json:scripts.lint',
        rawDeclaration: scripts.lint,
        evidence: [
          {
            sourceType: 'PACKAGE_MANIFEST',
            sourceIdentifier: 'package.json:scripts.lint',
            path: 'package.json',
          },
        ],
      };
    }

    return {
      build: buildCmd,
      test: testCmd,
      runtime: runtimeCmd,
      lint: lintCmd,
    };
  }

  // ==========================================================================
  // FEATURE INVENTORY
  // ==========================================================================

  private determineFeatureInventory(
    filePaths: string[],
    manifests: ManifestData,
    docSummary: DocumentationSummary,
    maxFeatures: number
  ): DiscoveredFeature[] {
    const features: DiscoveredFeature[] = [];
    const seenNames = new Set<string>();

    // 1. Discover from prominent modules / routes / services
    for (const f of filePaths) {
      if (features.length >= maxFeatures) break;

      const base = path.basename(f, path.extname(f));
      if (
        f.includes('/routes/') ||
        f.includes('/api/') ||
        f.includes('/services/') ||
        f.includes('/controllers/')
      ) {
        const cleanName = base
          .replace(/[-_]/g, ' ')
          .replace(/\b\w/g, (c) => c.toUpperCase());

        if (!seenNames.has(cleanName) && cleanName.length > 2 && !cleanName.includes('Test')) {
          seenNames.add(cleanName);
          features.push({
            id: `FEAT-${features.length + 1}`,
            name: `${cleanName} Module`,
            description: `Functionality implemented in ${f}`,
            path: f,
            status: 'IMPLEMENTED',
            evidence: [
              {
                sourceType: 'FILE',
                sourceIdentifier: f,
                path: f,
                contextLayer: 'L0',
              },
            ],
          });
        }
      }
    }

    // 2. Discover from packages in monorepo
    if (filePaths.some((f) => f.startsWith('packages/'))) {
      const pkgDirs = new Set<string>();
      for (const f of filePaths) {
        const match = f.match(/^packages\/([^/]+)/);
        if (match) pkgDirs.add(match[1]);
      }
      for (const pkg of pkgDirs) {
        if (features.length >= maxFeatures) break;
        const name = `Package @aidm/${pkg}`;
        if (!seenNames.has(name)) {
          seenNames.add(name);
          features.push({
            id: `FEAT-${features.length + 1}`,
            name,
            description: `Workspace sub-package located at packages/${pkg}`,
            path: `packages/${pkg}`,
            status: 'IMPLEMENTED',
            evidence: [
              {
                sourceType: 'FILE',
                sourceIdentifier: `packages/${pkg}`,
                path: `packages/${pkg}`,
                contextLayer: 'L0',
              },
            ],
          });
        }
      }
    }

    return features;
  }

  // ==========================================================================
  // AUTHORITATIVE AIDM INTEGRATION
  // ==========================================================================

  private async inspectRequirements(): Promise<RequirementsSummary> {
    if (!this.specStore) {
      return {
        totalRequirements: 0,
        lockedCount: 0,
        source: 'NONE',
        requirements: [],
        evidence: [],
      };
    }

    try {
      const reqs = await this.specStore.loadRequirements();
      const summaries: RequirementItemSummary[] = reqs.map((r) => ({
        id: r.id,
        title: r.title,
        status: r.status,
        authority: r.authority,
        acceptanceCriteriaCount: Array.isArray((r as any).acceptance_criteria)
          ? (r as any).acceptance_criteria.length
          : Array.isArray(r.metadata?.acceptance_criteria)
            ? (r.metadata.acceptance_criteria as unknown[]).length
            : 0,
      }));

      const lockedCount = reqs.filter((r) => r.status === 'LOCKED').length;

      return {
        totalRequirements: reqs.length,
        lockedCount,
        source: 'AIDM_SPEC_STORE',
        requirements: summaries,
        evidence: [
          {
            sourceType: 'SPEC_STORE',
            sourceIdentifier: this.specStore.requirementsPath,
            path: '.ai-manager/spec/requirements.json',
            isSystemVerified: true,
          },
        ],
      };
    } catch {
      return {
        totalRequirements: 0,
        lockedCount: 0,
        source: 'NONE',
        requirements: [],
        evidence: [],
      };
    }
  }

  private async inspectDecisions(): Promise<DecisionsSummary> {
    if (!this.specStore) {
      return {
        totalDecisions: 0,
        source: 'NONE',
        decisions: [],
        evidence: [],
      };
    }

    try {
      const decs = await this.specStore.loadDecisions();
      const summaries: DecisionItemSummary[] = decs.map((d) => ({
        id: d.id,
        title: d.title,
        status: d.status,
        authority: d.authority,
      }));

      return {
        totalDecisions: decs.length,
        source: 'AIDM_SPEC_STORE',
        decisions: summaries,
        evidence: [
          {
            sourceType: 'SPEC_STORE',
            sourceIdentifier: this.specStore.decisionsPath,
            path: '.ai-manager/spec/decisions.json',
            isSystemVerified: true,
          },
        ],
      };
    } catch {
      return {
        totalDecisions: 0,
        source: 'NONE',
        decisions: [],
        evidence: [],
      };
    }
  }

  private async inspectImplementationState(): Promise<ImplementationStateSummary> {
    let lifecycleState = 'UNKNOWN';
    let activeTaskId: string | undefined;
    let hasActiveTask = false;
    let isBlocked = false;
    let blockedReason: string | undefined;
    let totalTasksInDag = 0;
    let completedTasksCount = 0;
    const evidence: EvidenceReference[] = [];

    // Durable state inspection
    if (this.durableStateManager) {
      try {
        const state = await this.durableStateManager.load();
        if (state) {
          lifecycleState = state.currentLifecycleState;
          activeTaskId = state.activeTaskId ?? undefined;
          hasActiveTask = Boolean(activeTaskId);
          isBlocked = Boolean(state.blockedState);
          blockedReason = state.blockedState?.blockingReason;
          completedTasksCount = state.completedTaskIds?.length ?? 0;

          evidence.push({
            sourceType: 'STATE_MANAGER',
            sourceIdentifier: 'durable-state.json',
            path: '.ai-manager/state/durable-state.json',
            isSystemVerified: true,
          });
        }
      } catch {
        // Non-fatal
      }
    }

    // Task DAG inspection
    if (this.specStore) {
      try {
        const tasks = await this.specStore.loadTasks();
        totalTasksInDag = tasks.length;
      } catch {
        // Non-fatal
      }
    }

    return {
      lifecycleState,
      activeTaskId,
      hasActiveTask,
      isBlocked,
      blockedReason,
      totalTasksInDag,
      completedTasksCount,
      evidence,
    };
  }

  private async inspectGitStatus(): Promise<GitStateSummary> {
    if (!this.gitPort) {
      return {
        uncommittedChangesCount: 0,
        untrackedFilesCount: 0,
        evidence: [],
      };
    }

    try {
      const gitState = await this.gitPort.inspectState(this.workspaceRoot);
      let acceptedCheckpoint: { checkpointId: string; commitHash: string } | undefined;

      if (this.checkpointStore) {
        try {
          const list = await this.checkpointStore.loadCheckpoints();
          if (list.length > 0) {
            const latest = list[list.length - 1];
            acceptedCheckpoint = {
              checkpointId: latest.checkpoint_id,
              commitHash: latest.commit_sha,
            };
          }
        } catch {
          // Non-fatal
        }
      }

      const uncommittedCount = (gitState.staged_changes?.length ?? 0) + (gitState.unstaged_changes?.length ?? 0);
      const untrackedCount = gitState.untracked_files?.length ?? 0;

      return {
        headCommit: gitState.head_sha ?? undefined,
        branch: gitState.current_branch ?? undefined,
        trackingBranch: gitState.remote_head_sha ?? undefined,
        isClean: gitState.working_tree_clean,
        uncommittedChangesCount: uncommittedCount,
        untrackedFilesCount: untrackedCount,
        acceptedCheckpoint,
        evidence: [
          {
            sourceType: 'GIT',
            sourceIdentifier: gitState.head_sha ?? 'unknown',
            isSystemVerified: true,
          },
        ],
      };
    } catch {
      return {
        uncommittedChangesCount: 0,
        untrackedFilesCount: 0,
        evidence: [],
      };
    }
  }

  // ==========================================================================
  // ANALYSIS SYNTHESIS (FACT, OBSERVATION, INFERENCE, UNKNOWN)
  // ==========================================================================

  private synthesizeAnalysis(
    identity: ProjectIdentity,
    purpose: ProjectPurposeUnderstanding,
    techStack: TechnologyStackInfo,
    structure: RepositoryStructureInfo,
    architecture: ArchitectureSummary,
    entryPoints: DiscoveredEntryPoint[],
    commands: ProjectCommands,
    docSummary: DocumentationSummary,
    requirements: RequirementsSummary,
    decisions: DecisionsSummary,
    implementationState: ImplementationStateSummary,
    gitStatus: GitStateSummary
  ): {
    facts: DiscoveryFact[];
    observations: DiscoveryObservation[];
    inferences: DiscoveryInference[];
    unknowns: DiscoveryUnknown[];
  } {
    const facts: DiscoveryFact[] = [];
    let observations: DiscoveryObservation[] = [];
    const inferences: DiscoveryInference[] = [];
    const unknowns: DiscoveryUnknown[] = [];

    // --- FACTS ---
    facts.push({
      id: 'FACT-001',
      statement: `Project name is '${identity.name}'${identity.version ? ` version ${identity.version}` : ''}`,
      category: 'IDENTITY',
      evidence: identity.evidence,
    });

    facts.push({
      id: 'FACT-002',
      statement: `Inspected repository contains ${structure.totalFileCount} regular files with ${structure.topLevelDirectories.length} top-level directories`,
      category: 'STRUCTURE',
      evidence: structure.evidence,
    });

    if (commands.build.status === 'DISCOVERED') {
      facts.push({
        id: 'FACT-003',
        statement: `Build command is configured as '${commands.build.command}' (source: ${commands.build.source})`,
        category: 'COMMAND',
        evidence: commands.build.evidence,
      });
    }

    if (commands.test.status === 'DISCOVERED') {
      facts.push({
        id: 'FACT-004',
        statement: `Test command is configured as '${commands.test.command}' (source: ${commands.test.source})`,
        category: 'COMMAND',
        evidence: commands.test.evidence,
      });
    }

    if (requirements.totalRequirements > 0) {
      facts.push({
        id: 'FACT-005',
        statement: `AIDM SpecStore contains ${requirements.totalRequirements} authoritative requirements (${requirements.lockedCount} locked)`,
        category: 'REQUIREMENTS',
        evidence: requirements.evidence,
      });
    }

    if (gitStatus.headCommit) {
      facts.push({
        id: 'FACT-006',
        statement: `Git repository is at HEAD commit ${gitStatus.headCommit.substring(0, 8)} on branch '${gitStatus.branch ?? 'unknown'}' (clean: ${gitStatus.isClean})`,
        category: 'GIT',
        evidence: gitStatus.evidence,
      });
    }

    // --- OBSERVATIONS ---
    observations = [
      {
        id: 'OBS-001',
        observation: `Primary detected languages are [${techStack.primaryLanguages.join(', ')}] with ${techStack.frameworks.length > 0 ? `frameworks [${techStack.frameworks.join(', ')}]` : 'no major framework'}`,
        category: 'TECHNOLOGY',
        evidence: techStack.evidence.length > 0 ? techStack.evidence : identity.evidence,
      },
      {
        id: 'OBS-002',
        observation: `Identified ${architecture.identifiedAreas.length} architectural areas conforming to ${architecture.architecturalPattern}`,
        category: 'ARCHITECTURE',
        evidence: architecture.evidence.length > 0 ? architecture.evidence : structure.evidence,
      },
    ];

    if (docSummary.hasReadme) {
      observations.push({
        id: 'OBS-003',
        observation: `Project includes documentation: ${docSummary.readmePath} and ${docSummary.documentationFiles.length} markdown/docs files`,
        category: 'DOCUMENTATION',
        evidence: docSummary.evidence,
      });
    }

    // --- INFERENCES ---
    if (techStack.primaryLanguages.includes('TypeScript') && !architecture.identifiedAreas.some((a) => a.area === 'frontend')) {
      inferences.push({
        id: 'INF-001',
        inference: 'Project appears to be a backend service, CLI tool, or engine rather than a client web application',
        rationale: 'Absence of frontend/UI directories, paired with TypeScript/Node runtime and core module layout',
        basisEvidence: structure.evidence,
      });
    }

    if (entryPoints.some((e) => e.type === 'cli')) {
      inferences.push({
        id: 'INF-002',
        inference: 'Application provides command-line interaction capabilities',
        rationale: 'Declared CLI binary or entry point in package metadata',
        basisEvidence: entryPoints.flatMap((e) => e.evidence),
      });
    }

    // --- UNKNOWNS ---
    if (purpose.classification === 'UNKNOWN') {
      unknowns.push({
        id: 'UNK-001',
        item: 'Project Purpose',
        description: 'No explicit product description or purpose could be established from repository evidence',
        impact: 'Director must clarify product intent before architectural changes or new feature planning',
      });
    }

    if (commands.test.status === 'UNKNOWN') {
      unknowns.push({
        id: 'UNK-002',
        item: 'Test Execution Command',
        description: 'No automated test command is declared in package.json scripts, Makefile, or CI workflows',
        impact: 'System cannot verify code quality or run automated test regressions without a verified test command',
      });
    }

    if (commands.build.status === 'UNKNOWN') {
      unknowns.push({
        id: 'UNK-003',
        item: 'Build Execution Command',
        description: 'No explicit build command is declared in project configuration',
        impact: 'System cannot verify compilation or build artifacts',
      });
    }

    if (commands.runtime.status === 'UNKNOWN') {
      unknowns.push({
        id: 'UNK-004',
        item: 'Runtime / Start Command',
        description: 'No start or dev runtime command is declared in project configuration',
        impact: 'System cannot start or run the service for runtime verification',
      });
    }

    if (techStack.containerization.length === 0) {
      unknowns.push({
        id: 'UNK-005',
        item: 'Deployment / Containerization Target',
        description: 'No Dockerfile or container configuration was found',
        impact: 'Deployment target and runtime container environment remain unspecified',
      });
    }

    return { facts, observations, inferences, unknowns };
  }

  // ==========================================================================
  // CONTRADICTION DETECTION
  // ==========================================================================

  private detectContradictions(
    manifests: ManifestData,
    docSummary: DocumentationSummary,
    commands: ProjectCommands,
    features: DiscoveredFeature[],
    requirements: RequirementsSummary,
    decisions: DecisionsSummary,
    implementationState: ImplementationStateSummary
  ): DiscoveryContradiction[] {
    const contradictions: DiscoveryContradiction[] = [];

    // 1. README command vs Manifest command mismatch
    if (docSummary.summary && manifests.packageJson?.scripts) {
      const scripts = manifests.packageJson.scripts;
      // If README mentions "npm start" but scripts has no "start"
      if (docSummary.summary.includes('npm start') && !scripts.start) {
        contradictions.push({
          id: `CONTRA-${contradictions.length + 1}`,
          category: 'COMMAND_DISCREPANCY',
          description: "README instructs running 'npm start', but package.json does not define a 'start' script",
          sourceA: {
            description: "README.md references 'npm start'",
            evidence: {
              sourceType: 'FILE',
              sourceIdentifier: docSummary.readmePath ?? 'README.md',
              path: docSummary.readmePath,
            },
          },
          sourceB: {
            description: "package.json lacks 'start' script in scripts block",
            evidence: {
              sourceType: 'PACKAGE_MANIFEST',
              sourceIdentifier: 'package.json:scripts',
              path: 'package.json',
            },
          },
          unresolved: true,
        });
      }
    }

    // 2. Task state vs implementation discrepancy
    if (
      implementationState.hasActiveTask &&
      (implementationState.lifecycleState === 'PROJECT_COMPLETE' || implementationState.lifecycleState === 'COMPLETE')
    ) {
      contradictions.push({
        id: `CONTRA-${contradictions.length + 1}`,
        category: 'LIFECYCLE_STATE_CONFLICT',
        description: `Durable state reports lifecycle as ${implementationState.lifecycleState}, but activeTaskId '${implementationState.activeTaskId}' is still active`,
        sourceA: {
          description: `currentLifecycleState is ${implementationState.lifecycleState}`,
          evidence: {
            sourceType: 'STATE_MANAGER',
            sourceIdentifier: 'durable-state.json:currentLifecycleState',
          },
        },
        sourceB: {
          description: `activeTaskId is set to '${implementationState.activeTaskId}'`,
          evidence: {
            sourceType: 'STATE_MANAGER',
            sourceIdentifier: 'durable-state.json:activeTaskId',
          },
        },
        unresolved: true,
      });
    }

    return contradictions;
  }

  // ==========================================================================
  // CLARIFICATION CANDIDATES (FOR P8-04)
  // ==========================================================================

  private generateClarificationCandidates(
    purpose: ProjectPurposeUnderstanding,
    commands: ProjectCommands,
    entryPoints: DiscoveredEntryPoint[],
    contradictions: DiscoveryContradiction[],
    unknowns: DiscoveryUnknown[]
  ): ClarificationCandidate[] {
    const candidates: ClarificationCandidate[] = [];

    // 1. Purpose clarification candidate
    if (purpose.classification === 'UNKNOWN' || purpose.classification === 'PARTIALLY_UNDERSTOOD') {
      candidates.push({
        id: `CLARIFY-${candidates.length + 1}`,
        category: 'PURPOSE',
        title: 'Clarify Primary Project Purpose',
        question: 'What is the primary business goal and intended functionality of this project?',
        evidence: purpose.evidence,
      });
    }

    // 2. Test command clarification candidate
    if (commands.test.status === 'UNKNOWN') {
      candidates.push({
        id: `CLARIFY-${candidates.length + 1}`,
        category: 'COMMAND',
        title: 'Specify Authoritative Test Command',
        question: 'What command should be executed to run the automated test suite for this repository?',
        options: ['pnpm test', 'npm test', 'pytest', 'cargo test', 'go test ./...'],
        evidence: commands.test.evidence,
      });
    }

    // 3. Build command clarification candidate
    if (commands.build.status === 'UNKNOWN') {
      candidates.push({
        id: `CLARIFY-${candidates.length + 1}`,
        category: 'COMMAND',
        title: 'Specify Authoritative Build Command',
        question: 'What command should be executed to build and compile this project?',
        options: ['pnpm build', 'npm run build', 'tsc -b', 'cargo build'],
        evidence: commands.build.evidence,
      });
    }

    // 4. Contradiction clarification candidates
    for (const contra of contradictions) {
      candidates.push({
        id: `CLARIFY-${candidates.length + 1}`,
        category: 'CONTRADICTION',
        title: `Resolve Contradiction: ${contra.category}`,
        question: `${contra.description}. Which source represents the authoritative project intent?`,
        contradictionRef: contra.id,
        evidence: [contra.sourceA.evidence, contra.sourceB.evidence],
      });
    }

    // 5. Entry point disambiguation
    if (entryPoints.length > 2) {
      candidates.push({
        id: `CLARIFY-${candidates.length + 1}`,
        category: 'ENTRYPOINT',
        title: 'Authoritative Application Entry Point',
        question: `Multiple application entry points were detected (${entryPoints.map((e) => e.target).join(', ')}). Which is the primary entry point?`,
        options: entryPoints.map((e) => e.target),
        evidence: entryPoints.flatMap((e) => e.evidence),
      });
    }

    return candidates;
  }

  // ==========================================================================
  // BOUNDED FILE READING HELPER
  // ==========================================================================

  private async readBoundedFile(fullPath: string, maxBytes: number): Promise<string> {
    const handle = await fs.promises.open(fullPath, 'r');
    try {
      const buffer = Buffer.alloc(maxBytes);
      const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
      return buffer.subarray(0, bytesRead).toString('utf-8');
    } finally {
      await handle.close();
    }
  }
}

interface ManifestData {
  packageJson: Record<string, any> | null;
  pyprojectToml: string | null;
  cargoToml: string | null;
  goMod: string | null;
  makeContent: string | null;
}

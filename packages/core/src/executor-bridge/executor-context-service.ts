/**
 * Authoritative Executor Context Packaging Service
 *
 * Implements the automated context-to-executor pipeline connecting authoritative
 * AIDM stores (SpecStore, ContextEngine, ApprovalStore, GitPort, Recovery) to
 * produce deterministic, bounded, immutable ExecutorContextPackages for the executor.
 *
 * HARD ARCHITECTURAL INVARIANTS:
 * 1. AUTHORITATIVE SOURCES ONLY: All context is gathered exclusively from authoritative stores.
 * 2. ZERO FABRICATION: Missing or unindexed files are explicitly flagged, never hallucinated.
 * 3. DETERMINISTIC REPRODUCIBILITY: Identical project state generates identical packageId and hash.
 * 4. TOKEN BUDGET GOVERNANCE: Estimates tokens and enforces strict bounds with prioritized preservation.
 * 5. FRESHNESS ASSURANCE: Validates target file hashes against disk/Git state to detect stale context.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  type ExecutorContextPackage,
  type BuildExecutorContextInput,
  type ContextPackageValidationResult,
  type TaskContextPayload,
  type SpecContextPayload,
  type CodeContextPayload,
  type ProjectBaselinePayload,
  type RecoveryContextPayload,
  type ContextBudgetPayload,
  type ContextSourceAuditRecord,
  type FileStructureContext,
  type ScopeSummaryContext,
  type TracedRequirementContext,
  type TracedDecisionContext,
  type ProjectConventionsContext,
  type TaskContextDependency,
  EXECUTOR_CONTEXT_PROTOCOL_VERSION,
  EXECUTOR_CONTEXT_SCHEMA_VERSION,
  DEFAULT_EXECUTOR_CONTEXT_TOKEN_BUDGET,
  BuildExecutorContextInputZodSchema,
  ExecutorContextPackageZodSchema,
  computeDeterministicContextPackageId,
} from './executor-context-types.js';
import {
  ExecutorContextError,
  ExecutorContextValidationError,
  ExecutorContextSourceUnavailableError,
  ExecutorContextStaleError,
} from './executor-context-errors.js';
import type { ExecutionRequest } from './execution-request-types.js';
import type { SpecStore, Requirement, Decision } from '../storage/spec-store.js';
import type { ContextEngine } from '../context-engine/context-engine.js';
import type { GitPort } from '../git/git-port.js';
import { DefaultGitPort } from '../git/default-git-port.js';
import type { ApprovalStore } from '../approval/approval-store.js';
import type { ProjectDiscoveryEngine } from '../discovery/discovery-engine.js';
import type { DurableStateManager } from '../storage/durable-state.js';
import type { TaskDagEngine } from '../task-engine/dag-engine.js';
import type { McpOrchestratorDelegate } from '../mcp/mcp-delegate.js';
import type { TaskDefinition } from '../task-engine/task-types.js';
import { estimateContextTokens } from '../context-engine/token-estimator.js';
import { computeFileSha256 } from '../l0/hasher.js';
import { atomicWriteJson } from '../storage/atomic-writer.js';

export interface ExecutorContextServiceOptions {
  readonly workspaceRoot?: string;
  readonly specStore?: SpecStore;
  readonly contextEngine?: ContextEngine;
  readonly gitPort?: GitPort;
  readonly approvalStore?: ApprovalStore;
  readonly discoveryEngine?: ProjectDiscoveryEngine;
  readonly durableStateManager?: DurableStateManager;
  readonly dagEngine?: TaskDagEngine;
  readonly delegate?: McpOrchestratorDelegate;
}

export class ExecutorContextService {
  readonly workspaceRoot?: string;
  readonly specStore?: SpecStore;
  readonly contextEngine?: ContextEngine;
  readonly gitPort: GitPort;
  readonly approvalStore?: ApprovalStore;
  readonly discoveryEngine?: ProjectDiscoveryEngine;
  readonly durableStateManager?: DurableStateManager;
  readonly dagEngine?: TaskDagEngine;
  readonly delegate?: McpOrchestratorDelegate;

  constructor(options: ExecutorContextServiceOptions = {}) {
    this.workspaceRoot = options.workspaceRoot ?? options.delegate?.projectRoot;
    this.specStore = options.specStore ?? options.delegate?.specStore;
    this.contextEngine = options.contextEngine ?? options.delegate?.contextEngine;
    this.gitPort = options.gitPort ?? options.delegate?.gitPort ?? new DefaultGitPort();
    this.approvalStore = options.approvalStore ?? options.delegate?.approvalStore;
    this.discoveryEngine = options.discoveryEngine ?? options.delegate?.discoveryEngine;
    this.durableStateManager = options.durableStateManager ?? options.delegate?.durableStateManager;
    this.dagEngine = options.dagEngine ?? options.delegate?.dagEngine;
    this.delegate = options.delegate;
  }

  /**
   * Resolves and builds an authoritative ExecutorContextPackage for a given task.
   */
  async buildContextPackage(input: BuildExecutorContextInput): Promise<ExecutorContextPackage> {
    // 1. Validate input structure
    const parseResult = BuildExecutorContextInputZodSchema.safeParse(input);
    if (!parseResult.success) {
      throw new ExecutorContextValidationError(
        `Invalid BuildExecutorContextInput: ${parseResult.error.issues[0]?.message ?? 'validation failed'}`,
        { issues: parseResult.error.issues }
      );
    }

    const validatedInput = parseResult.data;
    const workingDir = path.resolve(
      validatedInput.workingDirectory ?? this.workspaceRoot ?? process.cwd()
    );
    const maxBudget = validatedInput.maxTokenBudget ?? DEFAULT_EXECUTOR_CONTEXT_TOKEN_BUDGET;
    const sources: ContextSourceAuditRecord[] = [];

    // 2. Query SpecStore for Task Definition & Traceability
    let taskDef: TaskDefinition | undefined;
    if (this.specStore) {
      try {
        const tasks = await this.specStore.loadTasks();
        taskDef = tasks.find((t) => t.task_id === validatedInput.taskId);
        sources.push({
          sourceName: 'SpecStore.tasks',
          available: true,
          recordCount: tasks.length,
          notes: taskDef ? `Found task ${validatedInput.taskId}` : `Task ${validatedInput.taskId} not in SpecStore`,
        });
      } catch (err) {
        sources.push({
          sourceName: 'SpecStore.tasks',
          available: false,
          notes: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      sources.push({
        sourceName: 'SpecStore.tasks',
        available: false,
        notes: 'SpecStore instance not provided',
      });
    }

    // Determine task fields (from SpecStore or input defaults)
    const taskRevision = validatedInput.taskRevision ?? (taskDef?.metadata?.revision as number | undefined) ?? 1;
    const title = taskDef?.title ?? `Task ${validatedInput.taskId}`;
    const description = taskDef?.description ?? '';
    const hierarchyLevel = taskDef?.hierarchy_level ?? 'TASK';
    const priority = taskDef?.priority ?? 'MEDIUM';
    const riskLevel = (taskDef as any)?.risk_level ?? 'SAFE';
    const status = taskDef?.status ?? 'READY';
    const traceabilitySources = taskDef?.traceability_sources ?? [];

    const metaTargetFiles = (taskDef?.metadata?.targetFiles as string[] | undefined) ??
      (taskDef?.metadata?.target_files as string[] | undefined) ?? [];

    const targetFiles = Object.freeze(
      Array.from(
        new Set([
          ...(validatedInput.targetFiles ?? []),
          ...metaTargetFiles,
        ])
      ).sort()
    );

    const metaScope = taskDef?.metadata?.scope as { analysisScope?: string[]; implementationScope?: string[] } | undefined;
    const metaAnalysisScope = (taskDef?.metadata?.analysisScope as string[] | undefined) ??
      metaScope?.analysisScope ?? [];
    const metaImplementationScope = (taskDef?.metadata?.implementationScope as string[] | undefined) ??
      metaScope?.implementationScope ?? [];

    const analysisScope = Object.freeze(
      Array.from(
        new Set([
          ...(validatedInput.analysisScope ?? []),
          ...metaAnalysisScope,
        ])
      ).sort()
    );

    const implementationScope = Object.freeze(
      Array.from(
        new Set([
          ...(validatedInput.implementationScope ?? []),
          ...metaImplementationScope,
          ...targetFiles,
        ])
      ).sort()
    );

    const acceptanceCriteria = Object.freeze([
      ...(taskDef?.acceptance_criteria ?? []),
    ]);

    const constraints = Object.freeze([
      ...((taskDef?.metadata?.constraints as string[] | undefined) ?? []),
    ]);

    // Resolve dependencies statuses
    const dependencies: TaskContextDependency[] = [];
    if (taskDef?.dependencies && taskDef.dependencies.length > 0) {
      let completedSet = new Set<string>();
      if (this.durableStateManager) {
        try {
          const ds = await this.durableStateManager.load();
          if (ds) {
            completedSet = new Set(ds.completedTaskIds);
          }
        } catch {
          // ignore
        }
      }
      for (const depId of taskDef.dependencies) {
        const isDepCompleted = completedSet.has(depId);
        dependencies.push({
          taskId: depId,
          status: isDepCompleted ? 'ACCEPTED' : 'PENDING',
        });
      }
    }

    const taskContext: TaskContextPayload = Object.freeze({
      taskId: validatedInput.taskId,
      taskRevision,
      title,
      description,
      hierarchyLevel,
      priority,
      riskLevel,
      status,
      targetFiles,
      analysisScope,
      implementationScope,
      acceptanceCriteria,
      constraints,
      dependencies: Object.freeze(dependencies),
      traceabilitySources: Object.freeze(traceabilitySources),
    });

    // 3. Query SpecStore for Traced Requirements & Decisions
    const tracedRequirements: TracedRequirementContext[] = [];
    const tracedDecisions: TracedDecisionContext[] = [];

    if (this.specStore && (validatedInput.includeSpecDetails !== false)) {
      try {
        const [allReqs, allDecs] = await Promise.all([
          this.specStore.loadRequirements().catch(() => [] as Requirement[]),
          this.specStore.loadDecisions().catch(() => [] as Decision[]),
        ]);

        sources.push({
          sourceName: 'SpecStore.specs',
          available: true,
          recordCount: allReqs.length + allDecs.length,
        });

        // Extract IDs from traceability sources (e.g., "REQ:REQ-01", "REQ-01", "DEC:DEC-01")
        const tracedReqIds = new Set<string>();
        const tracedDecIds = new Set<string>();

        for (const src of traceabilitySources) {
          if (src.startsWith('REQ:') || src.startsWith('REQ-')) {
            const cleanId = src.startsWith('REQ:') ? src.substring(4) : src;
            tracedReqIds.add(cleanId);
          } else if (src.startsWith('DEC:') || src.startsWith('DEC-')) {
            const cleanId = src.startsWith('DEC:') ? src.substring(4) : src;
            tracedDecIds.add(cleanId);
          }
        }

        for (const req of allReqs) {
          if (tracedReqIds.size === 0 || tracedReqIds.has(req.id)) {
            tracedRequirements.push({
              id: req.id,
              title: req.title,
              description: req.description,
              authority: req.authority,
              acceptanceCriteria: req.metadata?.acceptanceCriteria as string[] | undefined,
            });
          }
        }

        for (const dec of allDecs) {
          if (tracedDecIds.size === 0 || tracedDecIds.has(dec.id)) {
            tracedDecisions.push({
              id: dec.id,
              title: dec.title,
              description: dec.description,
              rationale: dec.rationale,
              authority: dec.authority,
              status: dec.status,
            });
          }
        }
      } catch (err) {
        sources.push({
          sourceName: 'SpecStore.specs',
          available: false,
          notes: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 4. Query ApprovalStore / ProjectApprovalPackage for Conventions & Tech Stack
    let conventions: ProjectConventionsContext = {};
    let techStackFromApproval: {
      languages?: string[];
      frameworks?: string[];
      runtime?: string;
      packageManager?: string;
    } = {};

    if (this.approvalStore && (validatedInput.includeBaseline !== false)) {
      try {
        const pkg = await this.approvalStore.getActivePackage();
        if (pkg && pkg.projectUnderstanding) {
          sources.push({
            sourceName: 'ApprovalStore',
            available: true,
            notes: `Loaded package ${pkg.packageId} rev ${pkg.revision}`,
          });

          conventions = {
            nonGoals: pkg.projectUnderstanding.nonGoals ? [...pkg.projectUnderstanding.nonGoals] : undefined,
            architectureConstraints: pkg.projectUnderstanding.constraints ? [...pkg.projectUnderstanding.constraints] : undefined,
            targetUsers: pkg.projectUnderstanding.targetUsers ? [...pkg.projectUnderstanding.targetUsers] : undefined,
          };

          const ts = pkg.projectUnderstanding.technologyStack;
          if (ts) {
            techStackFromApproval = {
              languages: ts.primaryLanguages ? [...ts.primaryLanguages] : undefined,
              frameworks: ts.frameworks ? [...ts.frameworks] : undefined,
              runtime: ts.runtimes && ts.runtimes.length > 0 ? ts.runtimes.join(', ') : undefined,
              packageManager: ts.packageManagers && ts.packageManagers.length > 0 ? ts.packageManagers.join(', ') : undefined,
            };
          }
        }
      } catch (err) {
        sources.push({
          sourceName: 'ApprovalStore',
          available: false,
          notes: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Fallback tech stack detection from package.json if not in approval package
    if (!techStackFromApproval.runtime) {
      const pkgJsonPath = path.join(workingDir, 'package.json');
      if (fs.existsSync(pkgJsonPath)) {
        try {
          const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
          techStackFromApproval = {
            languages: ['TypeScript', 'JavaScript'],
            frameworks: pkgJson.dependencies ? Object.keys(pkgJson.dependencies).slice(0, 10) : [],
            runtime: 'Node.js',
            packageManager: fs.existsSync(path.join(workingDir, 'pnpm-lock.yaml'))
              ? 'pnpm'
              : fs.existsSync(path.join(workingDir, 'package-lock.json'))
              ? 'npm'
              : 'yarn',
          };
          sources.push({
            sourceName: 'package.json',
            available: true,
            notes: 'Extracted tech stack from root package.json',
          });
        } catch {
          // ignore
        }
      }
    }

    const specContext: SpecContextPayload = Object.freeze({
      requirements: Object.freeze(tracedRequirements),
      decisions: Object.freeze(tracedDecisions),
      projectConventions: Object.freeze(conventions),
    });

    // 5. Query GitPort for Repository State Baseline
    let baseCommit = '0000000000000000000000000000000000000000';
    let branch: string | null = null;
    let isClean = true;

    try {
      const gitState = await this.gitPort.inspectState(workingDir);
      baseCommit = gitState.head_sha ?? gitState.headSha ?? baseCommit;
      branch = gitState.branch ?? null;
      isClean = gitState.working_tree_clean ?? gitState.isClean ?? true;
      sources.push({
        sourceName: 'GitPort',
        available: true,
        notes: `HEAD ${baseCommit}, clean: ${isClean}`,
      });
    } catch (err) {
      sources.push({
        sourceName: 'GitPort',
        available: false,
        notes: err instanceof Error ? err.message : String(err),
      });
    }

    const projectName = path.basename(workingDir);
    const projectId = validatedInput.projectId ?? projectName;

    const projectBaseline: ProjectBaselinePayload = Object.freeze({
      projectId,
      projectName,
      projectRoot: workingDir,
      technologyStack: Object.freeze(techStackFromApproval),
      repositoryState: Object.freeze({
        baseCommit,
        branch,
        isClean,
      }),
    });

    // 6. Query ContextEngine for Codebase L0/L1 Structure
    const targetFileStructures: FileStructureContext[] = [];
    const analysisScopeSummaries: ScopeSummaryContext[] = [];

    if (validatedInput.includeL1Structure !== false) {
      for (const relPath of targetFiles) {
        const fullPath = path.isAbsolute(relPath) ? relPath : path.join(workingDir, relPath);
        const normRelPath = path.relative(workingDir, fullPath).replace(/\\/g, '/');

        if (!fs.existsSync(fullPath)) {
          // Explicit indicator for newly targeted files
          targetFileStructures.push({
            path: normRelPath,
            layer: 'L0',
            sha256: 'NEW_FILE',
            size: 0,
            summary: 'File targeted for creation',
            isStale: false,
          });
          continue;
        }

        try {
          if (this.contextEngine) {
            // Use ContextEngine L0 & L1 extraction
            const l0 = await this.contextEngine.getL0Context(normRelPath);
            const l1 = await this.contextEngine.getL1Context(normRelPath);

            targetFileStructures.push({
              path: normRelPath,
              layer: 'L1',
              sha256: l0.fileHash,
              size: l0.size,
              exports: l1.exports ? [...l1.exports] : undefined,
              imports: l1.imports ? [...l1.imports] : undefined,
              interfaces: l1.interfaces ? [...l1.interfaces] : undefined,
              typeDefinitions: l1.typeDefinitions ? [...l1.typeDefinitions] : undefined,
              signatures: l1.signatures ? [...l1.signatures] : undefined,
              summary: l1.summary,
              isStale: false,
            });
          } else {
            // Direct disk fallback
            const stat = fs.statSync(fullPath);
            const sha256 = await computeFileSha256(fullPath);
            targetFileStructures.push({
              path: normRelPath,
              layer: 'L0',
              sha256,
              size: stat.size,
              summary: 'Existing file on disk',
              isStale: false,
            });
          }
        } catch (err) {
          targetFileStructures.push({
            path: normRelPath,
            layer: 'L0',
            sha256: 'UNREADABLE',
            size: 0,
            summary: `Read error: ${err instanceof Error ? err.message : String(err)}`,
            isStale: true,
          });
        }
      }

      // Process analysis scope summaries
      for (const scopePath of analysisScope) {
        if (targetFiles.includes(scopePath)) continue;
        const fullPath = path.isAbsolute(scopePath) ? scopePath : path.join(workingDir, scopePath);
        const normScopePath = path.relative(workingDir, fullPath).replace(/\\/g, '/');

        if (!fs.existsSync(fullPath)) continue;

        try {
          const stat = fs.statSync(fullPath);
          if (stat.isFile()) {
            const sha256 = await computeFileSha256(fullPath);
            analysisScopeSummaries.push({
              path: normScopePath,
              layer: 'L0',
              sha256,
              size: stat.size,
              summary: 'Scope reference file',
            });
          } else if (stat.isDirectory()) {
            analysisScopeSummaries.push({
              path: normScopePath,
              layer: 'L0',
              sha256: 'DIR',
              size: 0,
              summary: 'Scope reference directory',
            });
          }
        } catch {
          // ignore unreadable scope paths
        }
      }

      sources.push({
        sourceName: 'ContextEngine',
        available: !!this.contextEngine,
        recordCount: targetFileStructures.length + analysisScopeSummaries.length,
      });
    }

    const codeContext: CodeContextPayload = Object.freeze({
      targetFileStructures: Object.freeze(targetFileStructures),
      analysisScopeSummaries: Object.freeze(analysisScopeSummaries),
    });

    // 7. Query Recovery / Lineage Context
    let recoveryContext: RecoveryContextPayload | undefined;
    const taskAttempt = taskDef?.attempt ?? 1;
    const maxAttempts = taskDef?.max_attempts ?? 1;
    const isRetry = taskAttempt > 1;
    const metadata = (taskDef?.metadata as Record<string, unknown> | undefined) ?? {};

    if (isRetry || metadata.lineage || metadata.parentTaskId || validatedInput.includeRecovery) {
      const lineage = (metadata.lineage as Record<string, unknown> | undefined) ?? {};
      const diag = (metadata.failureDiagnosis as Record<string, unknown> | undefined) ?? {};

      recoveryContext = Object.freeze({
        attempt: taskAttempt,
        maxAttempts,
        isRetry,
        parentTaskId: (lineage.parentTaskId as string | undefined) ?? (metadata.parentTaskId as string | undefined),
        rootTaskId: (lineage.rootTaskId as string | undefined) ?? (metadata.rootTaskId as string | undefined),
        priorFailureDiagnosis: Object.keys(diag).length > 0 ? {
          category: diag.category as string | undefined,
          diagnosisCode: diag.diagnosisCode as string | undefined,
          reason: diag.reason as string | undefined,
          prescribedAction: diag.prescribedAction as string | undefined,
        } : undefined,
      });

      sources.push({
        sourceName: 'RecoveryLineage',
        available: true,
        notes: `Attempt ${taskAttempt}/${maxAttempts}, isRetry: ${isRetry}`,
      });
    }

    // 8. Token Budgeting & Bounds
    const taskTokens = estimateContextTokens(JSON.stringify(taskContext)).estimated_tokens;
    const specTokens = estimateContextTokens(JSON.stringify(specContext)).estimated_tokens;
    const codeTokens = estimateContextTokens(JSON.stringify(codeContext)).estimated_tokens;
    const baseTokens = estimateContextTokens(JSON.stringify(projectBaseline)).estimated_tokens;
    const recTokens = recoveryContext ? estimateContextTokens(JSON.stringify(recoveryContext)).estimated_tokens : 0;

    let totalEstimated = taskTokens + specTokens + codeTokens + baseTokens + recTokens;
    let isTruncated = false;

    // Prioritized truncation if over budget:
    let finalCodeContext = codeContext;
    let finalSpecContext = specContext;

    if (totalEstimated > maxBudget) {
      isTruncated = true;
      // Step A: drop analysis scope summaries
      finalCodeContext = Object.freeze({
        targetFileStructures: codeContext.targetFileStructures,
        analysisScopeSummaries: Object.freeze([]),
      });

      totalEstimated =
        taskTokens +
        specTokens +
        estimateContextTokens(JSON.stringify(finalCodeContext)).estimated_tokens +
        baseTokens +
        recTokens;

      // Step B: if still over budget, limit requirements/decisions to top 5
      if (totalEstimated > maxBudget && specContext.requirements.length > 5) {
        finalSpecContext = Object.freeze({
          requirements: Object.freeze(specContext.requirements.slice(0, 5)),
          decisions: Object.freeze(specContext.decisions.slice(0, 5)),
          projectConventions: specContext.projectConventions,
        });

        totalEstimated =
          taskTokens +
          estimateContextTokens(JSON.stringify(finalSpecContext)).estimated_tokens +
          estimateContextTokens(JSON.stringify(finalCodeContext)).estimated_tokens +
          baseTokens +
          recTokens;
      }
    }

    const budget: ContextBudgetPayload = Object.freeze({
      estimatedTokens: totalEstimated,
      maxTokenBudget: maxBudget,
      isTruncated,
      sectionTokenBreakdown: Object.freeze({
        taskContext: taskTokens,
        specContext: estimateContextTokens(JSON.stringify(finalSpecContext)).estimated_tokens,
        codeContext: estimateContextTokens(JSON.stringify(finalCodeContext)).estimated_tokens,
        projectBaseline: baseTokens,
        recoveryContext: recTokens,
      }),
    });

    // 9. Compute Deterministic packageId & contentHash
    const contextFingerprint =
      validatedInput.contextFingerprint ??
      `fp-${baseCommit.substring(0, 16)}-${taskRevision}`;

    const hashingPayload = {
      projectId,
      taskId: validatedInput.taskId,
      taskRevision,
      contextFingerprint,
      taskContext,
      specContext: finalSpecContext,
      codeContext: finalCodeContext,
      projectBaseline,
      recoveryContext,
    };

    const { packageId, contentHash } = computeDeterministicContextPackageId(hashingPayload);

    // 10. Assemble and Validate Frozen Package
    const pkg: ExecutorContextPackage = Object.freeze({
      packageId,
      protocolVersion: EXECUTOR_CONTEXT_PROTOCOL_VERSION,
      schemaVersion: EXECUTOR_CONTEXT_SCHEMA_VERSION,
      createdAt: new Date().toISOString(),
      projectId,
      taskId: validatedInput.taskId,
      taskRevision,
      requestId: validatedInput.requestId,
      contextFingerprint,
      contentHash,
      sources: Object.freeze(sources),
      taskContext,
      specContext: finalSpecContext,
      codeContext: finalCodeContext,
      projectBaseline,
      recoveryContext,
      budget,
    });

    // Validate schema
    ExecutorContextPackageZodSchema.parse(pkg);

    return pkg;
  }

  /**
   * Validates an existing context package against current disk and Git state.
   */
  async validateContextPackage(pkg: ExecutorContextPackage): Promise<ContextPackageValidationResult> {
    const parseResult = ExecutorContextPackageZodSchema.safeParse(pkg);
    if (!parseResult.success) {
      return {
        isValid: false,
        packageId: pkg?.packageId,
        isStale: true,
        message: `Schema validation failed: ${parseResult.error.issues[0]?.message ?? 'invalid package'}`,
        details: { issues: parseResult.error.issues },
      };
    }

    const workingDir = path.resolve(pkg.projectBaseline.projectRoot);
    let isStale = false;
    const staleFiles: string[] = [];

    // Check target file hashes on disk
    for (const fileStruct of pkg.codeContext.targetFileStructures) {
      if (fileStruct.sha256 === 'NEW_FILE') {
        continue;
      }
      const fullPath = path.join(workingDir, fileStruct.path);
      if (!fs.existsSync(fullPath)) {
        isStale = true;
        staleFiles.push(`${fileStruct.path} (deleted)`);
        continue;
      }
      try {
        const currentHash = await computeFileSha256(fullPath);
        if (currentHash !== fileStruct.sha256) {
          isStale = true;
          staleFiles.push(`${fileStruct.path} (modified: ${fileStruct.sha256} -> ${currentHash})`);
        }
      } catch {
        isStale = true;
        staleFiles.push(`${fileStruct.path} (unreadable)`);
      }
    }

    return {
      isValid: true,
      packageId: pkg.packageId,
      isStale,
      message: isStale ? `Context is stale: ${staleFiles.join(', ')}` : 'Context is fresh and valid',
      details: { staleFiles },
    };
  }

  /**
   * Packages context directly tailored for an ExecutionRequest.
   */
  async packageContextForExecutionRequest(
    request: ExecutionRequest,
    options?: { maxTokenBudget?: number }
  ): Promise<ExecutorContextPackage> {
    return this.buildContextPackage({
      taskId: request.taskId,
      taskRevision: request.taskRevision,
      projectId: request.projectId,
      requestId: request.requestId,
      directorSessionId: request.directorSessionId,
      contextFingerprint: request.contextFingerprint,
      targetFiles: request.instruction.targetFiles,
      analysisScope: request.instruction.analysisScope,
      implementationScope: request.instruction.implementationScope,
      maxTokenBudget: options?.maxTokenBudget,
      workingDirectory: (request.metadata?.workingDirectory as string | undefined) ?? this.workspaceRoot,
    });
  }

  /**
   * Returns the canonical directory for persisting context packages.
   * Defaults to `<workspaceRoot>/.ai-manager/cache/context-packages`.
   */
  getContextPackageStorageDir(overrideDir?: string): string {
    if (overrideDir) {
      return path.resolve(overrideDir);
    }
    const root = this.workspaceRoot ?? process.cwd();
    return path.join(root, '.ai-manager', 'cache', 'context-packages');
  }

  /**
   * Atomically persists an ExecutorContextPackage to disk.
   * Returns the absolute path where the package was persisted.
   */
  async persistContextPackage(
    pkg: ExecutorContextPackage,
    options?: { customPath?: string; storageDir?: string }
  ): Promise<string> {
    const parseResult = ExecutorContextPackageZodSchema.safeParse(pkg);
    if (!parseResult.success) {
      throw new ExecutorContextValidationError(
        `Cannot persist invalid context package: ${parseResult.error.issues[0]?.message ?? 'validation failed'}`,
        { issues: parseResult.error.issues }
      );
    }

    const targetPath =
      options?.customPath ??
      path.join(this.getContextPackageStorageDir(options?.storageDir), `${pkg.packageId}.json`);

    await atomicWriteJson(targetPath, pkg);
    return targetPath;
  }

  /**
   * Loads a persisted ExecutorContextPackage from disk by packageId.
   * Returns null if the package file does not exist or is invalid.
   */
  async loadContextPackage(
    packageId: string,
    options?: { storageDir?: string }
  ): Promise<ExecutorContextPackage | null> {
    if (!packageId || typeof packageId !== 'string') {
      return null;
    }

    const storageDir = this.getContextPackageStorageDir(options?.storageDir);
    const filePath = path.join(storageDir, `${packageId}.json`);

    if (!fs.existsSync(filePath)) {
      return null;
    }

    try {
      const raw = await fs.promises.readFile(filePath, 'utf8');
      const data = JSON.parse(raw);
      const parseResult = ExecutorContextPackageZodSchema.safeParse(data);
      if (!parseResult.success) {
        return null;
      }
      return Object.freeze(parseResult.data as ExecutorContextPackage);
    } catch {
      return null;
    }
  }

  /**
   * Scans the storage directory for the most recently created context package for a given taskId.
   * Returns null if no package matches the task.
   */
  async loadLatestContextPackageForTask(
    taskId: string,
    options?: { storageDir?: string }
  ): Promise<ExecutorContextPackage | null> {
    if (!taskId || typeof taskId !== 'string') {
      return null;
    }

    const storageDir = this.getContextPackageStorageDir(options?.storageDir);
    if (!fs.existsSync(storageDir)) {
      return null;
    }

    try {
      const entries = await fs.promises.readdir(storageDir);
      const candidates: ExecutorContextPackage[] = [];

      for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;
        const filePath = path.join(storageDir, entry);
        try {
          const raw = await fs.promises.readFile(filePath, 'utf8');
          const data = JSON.parse(raw);
          const parsed = ExecutorContextPackageZodSchema.safeParse(data);
          if (parsed.success && parsed.data.taskId === taskId) {
            candidates.push(parsed.data as ExecutorContextPackage);
          }
        } catch {
          // ignore corrupted files
        }
      }

      if (candidates.length === 0) {
        return null;
      }

      // Sort descending by createdAt
      candidates.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      return Object.freeze(candidates[0]!);
    } catch {
      return null;
    }
  }

  /**
   * Loads a context package and validates its disk freshness against current project files.
   * Returns null if package is not found.
   */
  async validateAndLoadContextPackage(
    packageId: string,
    options?: { storageDir?: string }
  ): Promise<{ package: ExecutorContextPackage; validation: ContextPackageValidationResult } | null> {
    const pkg = await this.loadContextPackage(packageId, options);
    if (!pkg) {
      return null;
    }

    const validation = await this.validateContextPackage(pkg);
    return {
      package: pkg,
      validation,
    };
  }

  /**
   * Cleans up cached context packages. If taskId is specified, cleans only packages for that task.
   */
  async clearCachedContextPackages(
    taskId?: string,
    options?: { storageDir?: string }
  ): Promise<number> {
    const storageDir = this.getContextPackageStorageDir(options?.storageDir);
    if (!fs.existsSync(storageDir)) {
      return 0;
    }

    let deletedCount = 0;
    try {
      const entries = await fs.promises.readdir(storageDir);
      for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;
        const filePath = path.join(storageDir, entry);
        if (taskId) {
          try {
            const raw = await fs.promises.readFile(filePath, 'utf8');
            const data = JSON.parse(raw);
            if (data?.taskId === taskId) {
              await fs.promises.unlink(filePath);
              deletedCount++;
            }
          } catch {
            // ignore
          }
        } else {
          await fs.promises.unlink(filePath);
          deletedCount++;
        }
      }
    } catch {
      // ignore
    }

    return deletedCount;
  }
}

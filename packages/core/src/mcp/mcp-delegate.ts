/**
 * MCP Orchestrator Delegate & Dependency Injection Boundary (Phase 8 TASK-P8-01, P8-02)
 *
 * Defines the dependency injection boundary connecting the MCP server to the
 * underlying AIDM Orchestrator without allowing MCP to become a second orchestrator.
 *
 * STRICT GOVERNANCE RULES:
 * 1. The delegate is the sole bridge from MCP into AIDM core.
 * 2. MCP never directly accesses the filesystem, Git, OS processes, or FSM internals.
 * 3. All status and inspection queries are strictly non-mutating.
 * 4. P8-02 provides safe read-only Director tools.
 */

import * as path from 'node:path';
import type { PolicyEngine } from '../policy/policy-engine.js';
import type { McpRequestCorrelation } from './mcp-correlation.js';
import { resolveTargetProjectRoot } from './project-root-resolver.js';
import { DurableStateManager } from '../storage/durable-state.js';
import { SpecStore } from '../storage/spec-store.js';
import { HistoryManager } from '../storage/history-manager.js';
import { CheckpointStore } from '../cli/checkpoint-store.js';
import { DefaultGitPort } from '../git/default-git-port.js';
import type { GitPort } from '../git/git-port.js';
import { ContextEngine } from '../context-engine/context-engine.js';
import { TaskDagEngine } from '../task-engine/dag-engine.js';
import { ClarificationStore } from '../clarification/clarification-store.js';
import { ApprovalStore } from '../approval/approval-store.js';
import { DirectorSessionStore } from '../director/director-session-store.js';
import { DirectorDecisionStore } from '../director/director-decision-store.js';
import { ProjectDiscoveryEngine } from '../discovery/discovery-engine.js';
import { AdaptiveDiscoveryEngine } from '../discovery/adaptive-discovery-engine.js';
import { AdaptiveDiscoveryStore } from '../discovery/adaptive-discovery-store.js';
import { CompletenessGateEngine } from '../discovery/completeness-gate-engine.js';
import { CompletenessGateStore } from '../discovery/completeness-gate-store.js';
import { RequirementsScopeEngine } from '../discovery/requirements-scope-engine.js';
import { RequirementsScopeStore } from '../discovery/requirements-scope-store.js';
import { ArchitectureTechnologyEngine } from '../discovery/architecture-technology-engine.js';
import { ArchitectureTechnologyStore } from '../discovery/architecture-technology-store.js';
import { BusinessRulesEngine } from '../discovery/business-rules-engine.js';
import { BusinessRulesStore } from '../discovery/business-rules-store.js';
import { AcceptanceCriteriaEngine } from '../discovery/acceptance-criteria-engine.js';
import { AcceptanceCriteriaStore } from '../discovery/acceptance-criteria-store.js';
import { RiskHumanDecisionEngine } from '../discovery/risk-human-decision-engine.js';
import { RiskHumanDecisionStore } from '../discovery/risk-human-decision-store.js';
import { ProjectSpecEngine } from '../discovery/project-spec-engine.js';
import { ProjectSpecStore } from '../discovery/project-spec-store.js';
import { ApprovalPackageEngine } from '../approval/approval-package-engine.js';
import type { ExecutorPort } from '../executor-bridge/executor-port.js';
import type { ExecutorContextService } from '../executor-bridge/executor-context-service.js';

// ============================================================================
// 1. STATUS CONTRACTS
// ============================================================================

export interface McpOrchestratorStatus {
  readonly isInitialized: boolean;
  readonly currentLifecycleState?: string;
  readonly activeTaskId?: string | null;
  readonly isBlocked?: boolean;
  readonly blockedReason?: string | null;
  readonly lastCheckpoint?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ActiveProjectContext {
  readonly directorSessionId?: string;
  readonly projectId: string;
  readonly projectRoot: string;
}

// ============================================================================
// 2. ORCHESTRATOR DELEGATE INTERFACE
// ============================================================================

export interface McpOrchestratorDelegate {
  /**
   * Currently active project/session context, if any.
   */
  readonly activeContext?: ActiveProjectContext;

  /**
   * Set or clear active project/session context.
   */
  setActiveContext?(context?: ActiveProjectContext): void;

  /**
   * Resolve target project root using canonical 4-tier priority.
   */
  resolveProjectRoot?(explicitRoot?: string): string;

  /**
   * Check if the orchestrator and its underlying state authority are healthy and available.
   */
  isHealthy(): Promise<boolean> | boolean;

  /**
   * Get orchestrator status metadata without mutating lifecycle or task state.
   */
  getStatus?(correlation: McpRequestCorrelation): Promise<McpOrchestratorStatus> | McpOrchestratorStatus;

  /**
   * Injected PolicyEngine instance for boundary authorization checks.
   */
  readonly policyEngine?: PolicyEngine;

  /**
   * Authoritative project workspace root directory.
   */
  readonly projectRoot?: string;

  /**
   * Authoritative DurableStateManager instance.
   */
  readonly durableStateManager?: DurableStateManager;

  /**
   * Authoritative SpecStore instance.
   */
  readonly specStore?: SpecStore;

  /**
   * Authoritative HistoryManager instance.
   */
  readonly historyManager?: HistoryManager;

  /**
   * Authoritative CheckpointStore instance.
   */
  readonly checkpointStore?: CheckpointStore;

  /**
   * Authoritative GitPort instance (read-only inspection).
   */
  readonly gitPort?: GitPort;

  /**
   * Authoritative ContextEngine instance.
   */
  readonly contextEngine?: ContextEngine;

  /**
   * Authoritative TaskDagEngine instance.
   */
  readonly dagEngine?: TaskDagEngine;

  /**
   * Authoritative ClarificationStore instance.
   */
  readonly clarificationStore?: ClarificationStore;

  /**
   * Authoritative ApprovalStore instance.
   */
  readonly approvalStore?: ApprovalStore;

  /**
   * Authoritative DirectorSessionStore instance.
   */
  readonly directorSessionStore?: DirectorSessionStore;

  /**
   * Authoritative DirectorDecisionStore instance.
   */
  readonly directorDecisionStore?: DirectorDecisionStore;

  /**
   * Authoritative ProjectDiscoveryEngine instance.
   */
  readonly discoveryEngine?: ProjectDiscoveryEngine;
  readonly adaptiveDiscoveryEngine?: AdaptiveDiscoveryEngine;
  readonly adaptiveDiscoveryStore?: AdaptiveDiscoveryStore;
  readonly completenessGateEngine?: CompletenessGateEngine;
  readonly completenessGateStore?: CompletenessGateStore;
  readonly requirementsScopeEngine?: RequirementsScopeEngine;
  readonly requirementsScopeStore?: RequirementsScopeStore;
  readonly architectureTechnologyEngine?: ArchitectureTechnologyEngine;
  readonly architectureTechnologyStore?: ArchitectureTechnologyStore;
  readonly businessRulesEngine?: BusinessRulesEngine;
  readonly businessRulesStore?: BusinessRulesStore;
  readonly acceptanceCriteriaEngine?: AcceptanceCriteriaEngine;
  readonly acceptanceCriteriaStore?: AcceptanceCriteriaStore;
  readonly riskHumanDecisionEngine?: RiskHumanDecisionEngine;
  readonly riskHumanDecisionStore?: RiskHumanDecisionStore;
  readonly projectSpecEngine?: ProjectSpecEngine;
  readonly projectSpecStore?: ProjectSpecStore;
  readonly approvalPackageEngine?: ApprovalPackageEngine;

  /**
   * Authoritative ExecutorPort instance (Phase 10 executor adapter boundary).
   */
  readonly executorPort?: ExecutorPort;

  /**
   * Authoritative ExecutorContextService instance.
   */
  readonly contextService?: ExecutorContextService;

  /**
   * Query system-verified evidence through the orchestrator.
   */
  getEvidence?(
    params: {
      taskId?: string;
      iterationId?: string;
      evidenceId?: string;
      evidenceType?: string;
      limit?: number;
      offset?: number;
    },
    correlation: McpRequestCorrelation
  ): Promise<readonly unknown[]> | readonly unknown[];
}

// ============================================================================
// 3. DEFAULT ORCHESTRATOR DELEGATE IMPLEMENTATION
// ============================================================================

export interface DefaultMcpOrchestratorDelegateOptions {
  readonly projectRoot?: string;
  readonly policyEngine?: PolicyEngine;
  readonly durableManager?: DurableStateManager;
  readonly durableStateManager?: DurableStateManager;
  readonly specStore?: SpecStore;
  readonly historyManager?: HistoryManager;
  readonly checkpointStore?: CheckpointStore;
  readonly gitPort?: GitPort;
  readonly contextEngine?: ContextEngine;
  readonly dagEngine?: TaskDagEngine;
  readonly clarificationStore?: ClarificationStore;
  readonly approvalStore?: ApprovalStore;
  readonly directorSessionStore?: DirectorSessionStore;
  readonly directorDecisionStore?: DirectorDecisionStore;
  readonly discoveryEngine?: ProjectDiscoveryEngine;
  readonly adaptiveDiscoveryEngine?: AdaptiveDiscoveryEngine;
  readonly adaptiveDiscoveryStore?: AdaptiveDiscoveryStore;
  readonly completenessGateEngine?: CompletenessGateEngine;
  readonly completenessGateStore?: CompletenessGateStore;
  readonly requirementsScopeEngine?: RequirementsScopeEngine;
  readonly requirementsScopeStore?: RequirementsScopeStore;
  readonly architectureTechnologyEngine?: ArchitectureTechnologyEngine;
  readonly architectureTechnologyStore?: ArchitectureTechnologyStore;
  readonly businessRulesEngine?: BusinessRulesEngine;
  readonly businessRulesStore?: BusinessRulesStore;
  readonly acceptanceCriteriaEngine?: AcceptanceCriteriaEngine;
  readonly acceptanceCriteriaStore?: AcceptanceCriteriaStore;
  readonly riskHumanDecisionEngine?: RiskHumanDecisionEngine;
  readonly riskHumanDecisionStore?: RiskHumanDecisionStore;
  readonly projectSpecEngine?: ProjectSpecEngine;
  readonly projectSpecStore?: ProjectSpecStore;
  readonly approvalPackageEngine?: ApprovalPackageEngine;
  readonly executorPort?: ExecutorPort;
  readonly contextService?: ExecutorContextService;
  readonly evidenceProvider?: (
    params: {
      taskId?: string;
      iterationId?: string;
      evidenceId?: string;
      evidenceType?: string;
      limit?: number;
      offset?: number;
    },
    correlation: McpRequestCorrelation
  ) => Promise<readonly unknown[]> | readonly unknown[];
}

export class DefaultMcpOrchestratorDelegate implements McpOrchestratorDelegate {
  private _activeContext?: ActiveProjectContext;

  get activeContext(): ActiveProjectContext | undefined {
    return this._activeContext;
  }

  setActiveContext(context?: ActiveProjectContext): void {
    this._activeContext = context;
  }

  resolveProjectRoot(explicitRoot?: string): string {
    return resolveTargetProjectRoot({
      explicitRoot,
      delegate: this,
    });
  }

  readonly projectRoot?: string;
  readonly policyEngine?: PolicyEngine;
  readonly durableStateManager?: DurableStateManager;
  readonly specStore?: SpecStore;
  readonly historyManager?: HistoryManager;
  readonly checkpointStore?: CheckpointStore;
  readonly gitPort?: GitPort;
  readonly contextEngine?: ContextEngine;
  readonly dagEngine?: TaskDagEngine;
  readonly clarificationStore?: ClarificationStore;
  readonly approvalStore?: ApprovalStore;
  readonly directorSessionStore?: DirectorSessionStore;
  readonly directorDecisionStore?: DirectorDecisionStore;
  readonly discoveryEngine?: ProjectDiscoveryEngine;
  readonly adaptiveDiscoveryEngine?: AdaptiveDiscoveryEngine;
  readonly adaptiveDiscoveryStore?: AdaptiveDiscoveryStore;
  readonly completenessGateEngine?: CompletenessGateEngine;
  readonly completenessGateStore?: CompletenessGateStore;
  readonly requirementsScopeEngine?: RequirementsScopeEngine;
  readonly requirementsScopeStore?: RequirementsScopeStore;
  readonly architectureTechnologyEngine?: ArchitectureTechnologyEngine;
  readonly architectureTechnologyStore?: ArchitectureTechnologyStore;
  readonly businessRulesEngine?: BusinessRulesEngine;
  readonly businessRulesStore?: BusinessRulesStore;
  readonly acceptanceCriteriaEngine?: AcceptanceCriteriaEngine;
  readonly acceptanceCriteriaStore?: AcceptanceCriteriaStore;
  readonly riskHumanDecisionEngine?: RiskHumanDecisionEngine;
  readonly riskHumanDecisionStore?: RiskHumanDecisionStore;
  readonly projectSpecEngine?: ProjectSpecEngine;
  readonly projectSpecStore?: ProjectSpecStore;
  readonly approvalPackageEngine?: ApprovalPackageEngine;
  readonly executorPort?: ExecutorPort;
  readonly contextService?: ExecutorContextService;
  private readonly evidenceProvider?: (
    params: {
      taskId?: string;
      iterationId?: string;
      evidenceId?: string;
      evidenceType?: string;
      limit?: number;
      offset?: number;
    },
    correlation: McpRequestCorrelation
  ) => Promise<readonly unknown[]> | readonly unknown[];

  constructor(options: DefaultMcpOrchestratorDelegateOptions = {}) {
    this.projectRoot = options.projectRoot ? path.resolve(options.projectRoot) : undefined;
    this.policyEngine = options.policyEngine;
    this.durableStateManager =
      options.durableStateManager ??
      options.durableManager ??
      (this.projectRoot ? new DurableStateManager({ baseDir: this.projectRoot }) : undefined);
    this.specStore =
      options.specStore ??
      (this.projectRoot ? new SpecStore({ baseDir: this.projectRoot }) : undefined);
    this.historyManager =
      options.historyManager ??
      (this.projectRoot ? new HistoryManager({ baseDir: this.projectRoot }) : undefined);
    this.checkpointStore =
      options.checkpointStore ??
      (this.projectRoot ? new CheckpointStore(this.projectRoot) : undefined);
    this.gitPort = options.gitPort ?? new DefaultGitPort();
    this.contextEngine =
      options.contextEngine ??
      (this.projectRoot ? new ContextEngine({ workspaceRoot: this.projectRoot }) : undefined);
    this.dagEngine = options.dagEngine ?? new TaskDagEngine();
    this.clarificationStore =
      options.clarificationStore ??
      (this.projectRoot
        ? new ClarificationStore({
            baseDir: this.projectRoot,
            historyManager: this.historyManager,
          })
        : undefined);
    this.approvalStore =
      options.approvalStore ??
      (this.projectRoot
        ? new ApprovalStore({
            baseDir: this.projectRoot,
            historyManager: this.historyManager,
          })
        : undefined);
    this.directorSessionStore =
      options.directorSessionStore ??
      (this.projectRoot
        ? new DirectorSessionStore({
            baseDir: this.projectRoot,
            historyManager: this.historyManager,
          })
        : undefined);
    this.directorDecisionStore =
      options.directorDecisionStore ??
      (this.projectRoot
        ? new DirectorDecisionStore({
            sessionStore: this.directorSessionStore,
            historyManager: this.historyManager,
          })
        : undefined);
    this.discoveryEngine = options.discoveryEngine;
    this.adaptiveDiscoveryStore =
      options.adaptiveDiscoveryStore ??
      (this.projectRoot
        ? new AdaptiveDiscoveryStore({
            baseDir: this.projectRoot,
            historyManager: this.historyManager,
          })
        : undefined);
    this.adaptiveDiscoveryEngine =
      options.adaptiveDiscoveryEngine ??
      (this.projectRoot
        ? new AdaptiveDiscoveryEngine({
            workspaceRoot: this.projectRoot,
            specStore: this.specStore,
            historyManager: this.historyManager,
            durableStateManager: this.durableStateManager,
            discoveryStore: this.adaptiveDiscoveryStore,
            existingDiscoveryEngine: this.discoveryEngine,
          })
        : undefined);
    this.completenessGateStore =
      options.completenessGateStore ??
      (this.projectRoot
        ? new CompletenessGateStore({
            baseDir: this.projectRoot,
            historyManager: this.historyManager,
          })
        : undefined);
    this.completenessGateEngine =
      options.completenessGateEngine ??
      (this.projectRoot
        ? new CompletenessGateEngine({
            workspaceRoot: this.projectRoot,
            discoveryStore: this.adaptiveDiscoveryStore,
            completenessStore: this.completenessGateStore,
            historyManager: this.historyManager,
            specStore: this.specStore,
          })
        : undefined);
    this.requirementsScopeStore =
      options.requirementsScopeStore ??
      (this.projectRoot
        ? new RequirementsScopeStore({
            baseDir: this.projectRoot,
            historyManager: this.historyManager,
          })
        : undefined);
    this.requirementsScopeEngine =
      options.requirementsScopeEngine ??
      (this.projectRoot
        ? new RequirementsScopeEngine({
            workspaceRoot: this.projectRoot,
            discoveryStore: this.adaptiveDiscoveryStore,
            completenessStore: this.completenessGateStore,
            requirementsStore: this.requirementsScopeStore,
            historyManager: this.historyManager,
            specStore: this.specStore,
          })
        : undefined);
    this.architectureTechnologyStore =
      options.architectureTechnologyStore ??
      (this.projectRoot
        ? new ArchitectureTechnologyStore({
            baseDir: this.projectRoot,
            historyManager: this.historyManager,
          })
        : undefined);
    this.architectureTechnologyEngine =
      options.architectureTechnologyEngine ??
      (this.projectRoot
        ? new ArchitectureTechnologyEngine({
            workspaceRoot: this.projectRoot,
            discoveryStore: this.adaptiveDiscoveryStore,
            completenessStore: this.completenessGateStore,
            requirementsStore: this.requirementsScopeStore,
            architectureStore: this.architectureTechnologyStore,
            historyManager: this.historyManager,
            specStore: this.specStore,
          })
        : undefined);
    this.businessRulesStore =
      options.businessRulesStore ??
      (this.projectRoot
        ? new BusinessRulesStore({
            baseDir: this.projectRoot,
            historyManager: this.historyManager,
          })
        : undefined);
    this.businessRulesEngine =
      options.businessRulesEngine ??
      (this.projectRoot
        ? new BusinessRulesEngine({
            workspaceRoot: this.projectRoot,
            discoveryStore: this.adaptiveDiscoveryStore,
            completenessStore: this.completenessGateStore,
            requirementsStore: this.requirementsScopeStore,
            architectureStore: this.architectureTechnologyStore,
            businessRulesStore: this.businessRulesStore,
            historyManager: this.historyManager,
            specStore: this.specStore,
          })
        : undefined);
    this.acceptanceCriteriaStore =
      options.acceptanceCriteriaStore ??
      (this.projectRoot
        ? new AcceptanceCriteriaStore({
            baseDir: this.projectRoot,
            historyManager: this.historyManager,
          })
        : undefined);
    this.acceptanceCriteriaEngine =
      options.acceptanceCriteriaEngine ??
      (this.projectRoot
        ? new AcceptanceCriteriaEngine({
            workspaceRoot: this.projectRoot,
            discoveryStore: this.adaptiveDiscoveryStore,
            completenessStore: this.completenessGateStore,
            requirementsStore: this.requirementsScopeStore,
            architectureStore: this.architectureTechnologyStore,
            businessRulesStore: this.businessRulesStore,
            acceptanceCriteriaStore: this.acceptanceCriteriaStore,
            historyManager: this.historyManager,
            specStore: this.specStore,
          })
        : undefined);
    this.riskHumanDecisionStore =
      options.riskHumanDecisionStore ??
      (this.projectRoot
        ? new RiskHumanDecisionStore({
            baseDir: this.projectRoot,
            historyManager: this.historyManager,
          })
        : undefined);
    this.riskHumanDecisionEngine =
      options.riskHumanDecisionEngine ??
      (this.projectRoot
        ? new RiskHumanDecisionEngine({
            workspaceRoot: this.projectRoot,
            discoveryStore: this.adaptiveDiscoveryStore,
            requirementsStore: this.requirementsScopeStore,
            architectureStore: this.architectureTechnologyStore,
            businessRulesStore: this.businessRulesStore,
            acceptanceCriteriaStore: this.acceptanceCriteriaStore,
            riskStore: this.riskHumanDecisionStore,
            historyManager: this.historyManager,
            specStore: this.specStore,
          })
        : undefined);
    this.projectSpecStore =
      options.projectSpecStore ??
      (this.projectRoot
        ? new ProjectSpecStore({
            baseDir: this.projectRoot,
            workspaceRoot: this.projectRoot,
            historyManager: this.historyManager,
          })
        : undefined);
    this.projectSpecEngine =
      options.projectSpecEngine ??
      (this.projectRoot
        ? new ProjectSpecEngine({
            workspaceRoot: this.projectRoot,
            discoveryStore: this.adaptiveDiscoveryStore,
            requirementsStore: this.requirementsScopeStore,
            architectureStore: this.architectureTechnologyStore,
            businessRulesStore: this.businessRulesStore,
            acceptanceCriteriaStore: this.acceptanceCriteriaStore,
            riskStore: this.riskHumanDecisionStore,
            specProjectionStore: this.projectSpecStore,
            historyManager: this.historyManager,
            specStore: this.specStore,
          })
        : undefined);
    this.approvalPackageEngine =
      options.approvalPackageEngine ??
      (this.projectRoot
        ? new ApprovalPackageEngine({
            workspaceRoot: this.projectRoot,
            discoveryStore: this.adaptiveDiscoveryStore,
            requirementsStore: this.requirementsScopeStore,
            architectureStore: this.architectureTechnologyStore,
            businessRulesStore: this.businessRulesStore,
            acceptanceCriteriaStore: this.acceptanceCriteriaStore,
            riskStore: this.riskHumanDecisionStore,
            specProjectionStore: this.projectSpecStore,
            completenessStore: this.completenessGateStore,
            completenessEngine: this.completenessGateEngine,
            approvalStore: this.approvalStore,
            historyManager: this.historyManager,
            specStore: this.specStore,
          })
        : undefined);
    this.evidenceProvider = options.evidenceProvider;
    this.executorPort = options.executorPort;
    this.contextService = options.contextService;
  }

  async isHealthy(): Promise<boolean> {
    if (!this.projectRoot) return true;
    if (!this.durableStateManager) return true;
    try {
      // Non-mutating probe: check if state exists or is accessible
      await this.durableStateManager.exists();
      return true;
    } catch {
      return false;
    }
  }

  async getStatus(_correlation: McpRequestCorrelation): Promise<McpOrchestratorStatus> {
    if (!this.projectRoot || !this.durableStateManager) {
      return {
        isInitialized: false,
      };
    }

    try {
      const exists = await this.durableStateManager.exists();
      if (!exists) {
        return { isInitialized: false };
      }

      const state = await this.durableStateManager.load();
      if (!state) {
        return { isInitialized: false };
      }

      return {
        isInitialized: true,
        currentLifecycleState: state.currentLifecycleState,
        activeTaskId: state.activeTaskId,
        isBlocked: !!state.blockedState,
        blockedReason: state.blockedState?.blockingReason ?? null,
        lastCheckpoint: state.lastCheckpoint ?? null,
      };
    } catch (err) {
      return {
        isInitialized: false,
        metadata: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  }

  async getEvidence(
    params: {
      taskId?: string;
      iterationId?: string;
      evidenceId?: string;
      evidenceType?: string;
      limit?: number;
      offset?: number;
    },
    correlation: McpRequestCorrelation
  ): Promise<readonly unknown[]> {
    if (this.evidenceProvider) {
      return this.evidenceProvider(params, correlation);
    }
    return [];
  }
}

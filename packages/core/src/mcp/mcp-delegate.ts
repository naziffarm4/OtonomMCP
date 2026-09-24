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
import { DurableStateManager } from '../storage/durable-state.js';
import { SpecStore } from '../storage/spec-store.js';
import { HistoryManager } from '../storage/history-manager.js';
import { CheckpointStore } from '../cli/checkpoint-store.js';
import { DefaultGitPort } from '../git/default-git-port.js';
import type { GitPort } from '../git/git-port.js';
import { ContextEngine } from '../context-engine/context-engine.js';
import { TaskDagEngine } from '../task-engine/dag-engine.js';

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

// ============================================================================
// 2. ORCHESTRATOR DELEGATE INTERFACE
// ============================================================================

export interface McpOrchestratorDelegate {
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
  readonly projectRoot?: string;
  readonly policyEngine?: PolicyEngine;
  readonly durableStateManager?: DurableStateManager;
  readonly specStore?: SpecStore;
  readonly historyManager?: HistoryManager;
  readonly checkpointStore?: CheckpointStore;
  readonly gitPort?: GitPort;
  readonly contextEngine?: ContextEngine;
  readonly dagEngine?: TaskDagEngine;
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
    this.evidenceProvider = options.evidenceProvider;
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

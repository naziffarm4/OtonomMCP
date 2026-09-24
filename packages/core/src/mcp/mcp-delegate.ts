/**
 * MCP Orchestrator Delegate & Dependency Injection Boundary (Phase 8 TASK-P8-01)
 *
 * Defines the dependency injection boundary connecting the MCP server to the
 * underlying AIDM Orchestrator without allowing MCP to become a second orchestrator.
 *
 * STRICT GOVERNANCE RULES:
 * 1. The delegate is the sole bridge from MCP into AIDM core.
 * 2. MCP never directly accesses the filesystem, Git, OS processes, or FSM internals.
 * 3. All status queries are non-mutating.
 * 4. P8-01 provides only health and read-only status connectivity.
 */

import * as path from 'node:path';
import type { PolicyEngine } from '../policy/policy-engine.js';
import type { McpRequestCorrelation } from './mcp-correlation.js';
import { DurableStateManager } from '../storage/durable-state.js';

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
}

// ============================================================================
// 3. DEFAULT ORCHESTRATOR DELEGATE IMPLEMENTATION
// ============================================================================

export interface DefaultMcpOrchestratorDelegateOptions {
  readonly projectRoot?: string;
  readonly policyEngine?: PolicyEngine;
  readonly durableManager?: DurableStateManager;
}

export class DefaultMcpOrchestratorDelegate implements McpOrchestratorDelegate {
  readonly projectRoot?: string;
  readonly policyEngine?: PolicyEngine;
  private readonly durableManager?: DurableStateManager;

  constructor(options: DefaultMcpOrchestratorDelegateOptions = {}) {
    this.projectRoot = options.projectRoot ? path.resolve(options.projectRoot) : undefined;
    this.policyEngine = options.policyEngine;
    this.durableManager =
      options.durableManager ??
      (this.projectRoot ? new DurableStateManager({ baseDir: this.projectRoot }) : undefined);
  }

  async isHealthy(): Promise<boolean> {
    if (!this.projectRoot) return true;
    if (!this.durableManager) return true;
    try {
      // Non-mutating probe: check if state exists or is accessible
      await this.durableManager.exists();
      return true;
    } catch {
      return false;
    }
  }

  async getStatus(_correlation: McpRequestCorrelation): Promise<McpOrchestratorStatus> {
    if (!this.projectRoot || !this.durableManager) {
      return {
        isInitialized: false,
      };
    }

    try {
      const exists = await this.durableManager.exists();
      if (!exists) {
        return { isInitialized: false };
      }

      const state = await this.durableManager.load();
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
}

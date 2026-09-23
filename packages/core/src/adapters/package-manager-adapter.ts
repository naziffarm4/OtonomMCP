/**
 * PackageManagerAdapter: Package installation and management abstraction.
 *
 * Implements the project-independent adapter contract specified in
 * Technical Discovery Section 22:
 * "PackageManagerAdapter: Paket kurma/güncelleme işlemlerini yürütür (pnpm, npm, pip, cargo vb.)."
 */

import { type PolicyEngine } from '../policy/policy-engine.js';
import { OperationActionType } from '../policy/policy-types.js';
import { type EvidenceCollector } from '../evidence/evidence-collector.js';
import { type SystemVerifiedEvidence } from '../evidence/evidence-types.js';
import { EvidenceType } from '../evidence/evidence-types.js';
import { PolicyViolationError } from '../errors/policy-violation-error.js';

export interface PackageManagerOptions {
  readonly packages?: readonly string[];
  readonly dev?: boolean;
  readonly workingDirectory?: string;
  readonly taskId?: string;
  readonly correlationId?: string;
  readonly projectId?: string;
  readonly timeoutMs?: number;
}

export interface PackageManagerResult {
  readonly success: boolean;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly evidence?: SystemVerifiedEvidence;
  readonly error?: string;
}

export interface PackageManagerAdapter {
  readonly id: string;
  readonly name: string;

  /**
   * Installs packages in the specified project directory through PolicyEngine.
   */
  install(projectRoot: string, options?: PackageManagerOptions): Promise<PackageManagerResult>;
}

/**
 * Node / pnpm package manager adapter.
 */
export class NodePackageManagerAdapter implements PackageManagerAdapter {
  readonly id = 'adapter:pkg:node';
  readonly name = 'Node.js Package Manager Adapter';

  private readonly collector: EvidenceCollector;
  private readonly policyEngine: PolicyEngine;
  private readonly tool: 'pnpm' | 'npm';

  constructor(collector: EvidenceCollector, policyEngine: PolicyEngine, tool: 'pnpm' | 'npm' = 'pnpm') {
    this.collector = collector;
    this.policyEngine = policyEngine;
    this.tool = tool;
  }

  async install(projectRoot: string, options?: PackageManagerOptions): Promise<PackageManagerResult> {
    const pkgs = options?.packages ?? [];
    let cmd: string;
    if (pkgs.length === 0) {
      cmd = `${this.tool} install`;
    } else {
      const devFlag = options?.dev ? '-D ' : '';
      cmd = `${this.tool} add ${devFlag}${pkgs.join(' ')}`;
    }

    // Step 1: Policy validation
    const policyDecision = this.policyEngine.evaluate({
      action_type: OperationActionType.DEPENDENCY_INSTALL,
      command: cmd,
      project_root: projectRoot,
      changes_dependencies: true,
    });

    if (!policyDecision.allowed) {
      throw new PolicyViolationError(
        `Package manager operation rejected by policy: ${policyDecision.violations?.[0]?.message ?? policyDecision.code}`,
        {
          command: cmd,
          decision: policyDecision.decision,
          riskLevel: policyDecision.risk_level,
          violations: policyDecision.violations,
        }
      );
    }

    const taskId = options?.taskId ?? 'task:pkg:install';
    const correlationId = options?.correlationId ?? `corr:pkg:${Date.now()}`;
    const projectId = options?.projectId ?? 'proj:node';

    try {
      const evidence = await this.collector.executeAndCollectCommandEvidence({
        task_id: taskId,
        project_id: projectId,
        correlation_id: correlationId,
        command: cmd,
        working_directory: projectRoot,
        evidence_type: EvidenceType.COMMAND,
        timeout_ms: options?.timeoutMs ?? 60_000,
      });

      return {
        success: evidence.exit_code === 0,
        exitCode: evidence.exit_code,
        stdout: evidence.stdout_tail ?? '',
        stderr: evidence.stderr ?? '',
        durationMs: evidence.execution_time_ms,
        evidence,
      };
    } catch (err) {
      return {
        success: false,
        exitCode: -1,
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
        durationMs: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

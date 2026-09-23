/**
 * BuildAdapter: Build command execution and output analysis abstraction.
 *
 * Implements the project-independent adapter contract specified in
 * Technical Discovery Section 22:
 * "BuildAdapter: Derleme komutlarını çalıştırır ve çıktıları analiz eder."
 */

import { type EvidenceCollector } from '../evidence/evidence-collector.js';
import { type SystemVerifiedEvidence } from '../evidence/evidence-types.js';
import { EvidenceType } from '../evidence/evidence-types.js';

export interface BuildOptions {
  readonly command?: string;
  readonly workingDirectory?: string;
  readonly taskId?: string;
  readonly correlationId?: string;
  readonly projectId?: string;
  readonly timeoutMs?: number;
}

export interface BuildResult {
  readonly success: boolean;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly evidence?: SystemVerifiedEvidence;
  readonly error?: string;
}

export interface BuildAdapter {
  readonly id: string;
  readonly name: string;

  /**
   * Executes build in the specified project directory.
   */
  build(projectRoot: string, options?: BuildOptions): Promise<BuildResult>;
}

/**
 * Node / TypeScript build adapter.
 */
export class NodeBuildAdapter implements BuildAdapter {
  readonly id = 'adapter:build:node';
  readonly name = 'Node.js Build Adapter';

  private readonly collector: EvidenceCollector;

  constructor(collector: EvidenceCollector) {
    this.collector = collector;
  }

  async build(projectRoot: string, options?: BuildOptions): Promise<BuildResult> {
    const cmd = options?.command ?? 'node --check src/index.js';
    const taskId = options?.taskId ?? 'task:build';
    const correlationId = options?.correlationId ?? `corr:build:${Date.now()}`;
    const projectId = options?.projectId ?? 'proj:node';

    try {
      const evidence = await this.collector.executeAndCollectCommandEvidence({
        task_id: taskId,
        project_id: projectId,
        correlation_id: correlationId,
        command: cmd,
        working_directory: projectRoot,
        evidence_type: EvidenceType.BUILD,
        timeout_ms: options?.timeoutMs ?? 30_000,
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

/**
 * TestAdapter: Test runner and result analysis abstraction.
 *
 * Implements the project-independent adapter contract specified in
 * Technical Discovery Section 22:
 * "TestAdapter: Test çalıştırıcılarını yönetir (Jest, Vitest, Pytest, Go test vb.)."
 */

import { type EvidenceCollector } from '../evidence/evidence-collector.js';
import { type SystemVerifiedEvidence } from '../evidence/evidence-types.js';
import { EvidenceType } from '../evidence/evidence-types.js';

export interface TestOptions {
  readonly command?: string;
  readonly testFiles?: readonly string[];
  readonly workingDirectory?: string;
  readonly taskId?: string;
  readonly correlationId?: string;
  readonly projectId?: string;
  readonly timeoutMs?: number;
}

export interface TestRunResult {
  readonly passed: boolean;
  readonly exitCode: number;
  readonly totalTests?: number;
  readonly passedTests?: number;
  readonly failedTests?: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly evidence?: SystemVerifiedEvidence;
  readonly error?: string;
}

export interface TestAdapter {
  readonly id: string;
  readonly name: string;

  /**
   * Runs tests in the specified project directory.
   */
  runTests(projectRoot: string, options?: TestOptions): Promise<TestRunResult>;
}

/**
 * Node:test runner adapter.
 */
export class NodeTestAdapter implements TestAdapter {
  readonly id = 'adapter:test:node';
  readonly name = 'Node.js Test Adapter';

  private readonly collector: EvidenceCollector;

  constructor(collector: EvidenceCollector) {
    this.collector = collector;
  }

  async runTests(projectRoot: string, options?: TestOptions): Promise<TestRunResult> {
    const cmd = options?.command ?? 'node --test';
    const taskId = options?.taskId ?? 'task:test';
    const correlationId = options?.correlationId ?? `corr:test:${Date.now()}`;
    const projectId = options?.projectId ?? 'proj:node';

    try {
      const evidence = await this.collector.executeAndCollectCommandEvidence({
        task_id: taskId,
        project_id: projectId,
        correlation_id: correlationId,
        command: cmd,
        working_directory: projectRoot,
        evidence_type: EvidenceType.TEST,
        timeout_ms: options?.timeoutMs ?? 30_000,
      });

      const stdout = evidence.stdout_tail ?? '';
      const stderr = evidence.stderr ?? '';
      const passed = evidence.exit_code === 0;

      // Extract test metrics from node:test TAP/spec output if present
      const totalMatch = stdout.match(/# tests\s+(\d+)/);
      const passMatch = stdout.match(/# pass\s+(\d+)/);
      const failMatch = stdout.match(/# fail\s+(\d+)/);

      return {
        passed,
        exitCode: evidence.exit_code,
        totalTests: totalMatch ? parseInt(totalMatch[1], 10) : undefined,
        passedTests: passMatch ? parseInt(passMatch[1], 10) : undefined,
        failedTests: failMatch ? parseInt(failMatch[1], 10) : undefined,
        stdout,
        stderr,
        durationMs: evidence.execution_time_ms,
        evidence,
      };
    } catch (err) {
      return {
        passed: false,
        exitCode: -1,
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
        durationMs: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

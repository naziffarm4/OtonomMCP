/**
 * Antigravity CLI Compatibility Boundary (Phase 14 TASK-P14-01)
 *
 * Determines the compatibility of the installed or configured Antigravity CLI (`agy`)
 * against the execution contract required by the AntigravityAdapter.
 *
 * HARD ARCHITECTURAL INVARIANTS:
 * 1. CONTRACT-BASED COMPATIBILITY: Compatibility is determined not by version number
 *    alone, but by the actual execution contract (flags, protocols, capabilities).
 * 2. DETERMINISTIC & AUDITABLE: Returns structured ExecutorCompatibility with
 *    executable, version, protocol, capabilities, and compatibility status.
 * 3. NO ARBITRARY COMMANDS: Only standard probe arguments (--version, --help) are used.
 */

import type {
  AntigravityProcessRunner,
  AntigravityResolutionResult,
} from './antigravity-process-runner.js';
import { resolveAntigravityExecutable } from './antigravity-process-runner.js';

// ============================================================================
// 1. CONTRACTS & CAPABILITIES
// ============================================================================

export const DEFAULT_ANTIGRAVITY_PROTOCOL = 'stream-json';

/**
 * Required CLI capabilities for AntigravityAdapter execution contract:
 * - print: support non-interactive --print execution
 * - input-format:stream-json: support --input-format stream-json
 * - output-format:stream-json: support --output-format stream-json
 * - project: support --project flag for project scoping
 * - add-dir: support --add-dir flag for workspace directory binding
 */
export const REQUIRED_ANTIGRAVITY_CAPABILITIES = Object.freeze([
  'print',
  'input-format:stream-json',
  'output-format:stream-json',
  'project',
  'add-dir',
]);

export interface ExecutorCompatibility {
  readonly executable: string;
  readonly version: string | null;
  readonly protocol: string;
  readonly capabilities: readonly string[];
  readonly compatible: boolean;
  readonly reason: string | null;
  readonly probedAt: string;
}

export interface CompatibilityCheckOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly bypassCache?: boolean;
  readonly cwd?: string;
  readonly env?: Record<string, string>;
}

// ============================================================================
// 2. COMPATIBILITY CHECKER IMPLEMENTATION
// ============================================================================

export class AntigravityCompatibilityChecker {
  private readonly runner: AntigravityProcessRunner;
  private readonly cache = new Map<string, ExecutorCompatibility>();

  constructor(runner: AntigravityProcessRunner) {
    this.runner = runner;
  }

  /**
   * Clears any cached compatibility results.
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Determines compatibility of the resolved or configured Antigravity executable.
   */
  async checkCompatibility(
    executableOrResolution: string | AntigravityResolutionResult,
    options: CompatibilityCheckOptions = {}
  ): Promise<ExecutorCompatibility> {
    const probedAt = new Date().toISOString();
    const timeoutMs = options.timeoutMs ?? 5_000;
    const cwd = options.cwd ?? process.cwd();

    // 1. Resolve executable if necessary
    let executable: string;
    if (typeof executableOrResolution === 'string') {
      const resolution = resolveAntigravityExecutable({
        configuredBinaryPath: executableOrResolution,
        cwd,
        env: options.env,
      });
      if (!resolution.found || !resolution.executablePath) {
        return Object.freeze({
          executable: executableOrResolution,
          version: null,
          protocol: DEFAULT_ANTIGRAVITY_PROTOCOL,
          capabilities: Object.freeze([]),
          compatible: false,
          reason: resolution.reason ?? `Executable "${executableOrResolution}" not found`,
          probedAt,
        });
      }
      executable = resolution.executablePath;
    } else {
      if (!executableOrResolution.found || !executableOrResolution.executablePath) {
        return Object.freeze({
          executable: executableOrResolution.executablePath ?? 'agy',
          version: null,
          protocol: DEFAULT_ANTIGRAVITY_PROTOCOL,
          capabilities: Object.freeze([]),
          compatible: false,
          reason: executableOrResolution.reason ?? 'Executable not found',
          probedAt,
        });
      }
      executable = executableOrResolution.executablePath;
    }

    // 2. Check cache
    if (!options.bypassCache && this.cache.has(executable)) {
      return this.cache.get(executable)!;
    }

    // 3. Probe version via `<executable> --version`
    let version: string | null = null;
    try {
      const versionResult = await this.runner.run({
        executable,
        args: ['--version'],
        cwd,
        timeoutMs,
        signal: options.signal,
        env: options.env,
      });

      if (versionResult.exitCode === 0) {
        const rawVersionOutput = `${versionResult.stdout} ${versionResult.stderr}`.trim();
        const versionMatch = rawVersionOutput.match(/\bv?(\d+\.\d+(?:\.\d+)?(?:-[a-zA-Z0-9.]+)?)/);
        if (versionMatch) {
          version = versionMatch[1];
        } else if (rawVersionOutput.length > 0 && rawVersionOutput.length < 50) {
          version = rawVersionOutput;
        }
      }
    } catch {
      // Ignore version probe error; capabilities probe will determine contract compatibility
    }

    // 4. Probe capabilities via `<executable> --help`
    let helpOutput = '';
    try {
      const helpResult = await this.runner.run({
        executable,
        args: ['--help'],
        cwd,
        timeoutMs,
        signal: options.signal,
        env: options.env,
      });

      if (helpResult.spawnError) {
        const outcome: ExecutorCompatibility = Object.freeze({
          executable,
          version,
          protocol: DEFAULT_ANTIGRAVITY_PROTOCOL,
          capabilities: Object.freeze([]),
          compatible: false,
          reason: `Failed to spawn executable: ${helpResult.spawnError.message}`,
          probedAt,
        });
        return outcome;
      }

      if (helpResult.timedOut) {
        const outcome: ExecutorCompatibility = Object.freeze({
          executable,
          version,
          protocol: DEFAULT_ANTIGRAVITY_PROTOCOL,
          capabilities: Object.freeze([]),
          compatible: false,
          reason: `Compatibility probe timed out after ${timeoutMs}ms`,
          probedAt,
        });
        return outcome;
      }

      helpOutput = `${helpResult.stdout}\n${helpResult.stderr}`;
    } catch (err) {
      const outcome: ExecutorCompatibility = Object.freeze({
        executable,
        version,
        protocol: DEFAULT_ANTIGRAVITY_PROTOCOL,
        capabilities: Object.freeze([]),
        compatible: false,
        reason: `Failed to probe executable: ${err instanceof Error ? err.message : String(err)}`,
        probedAt,
      });
      return outcome;
    }

    // 5. Discover capabilities from help output
    const discoveredCapabilities: string[] = [];

    // --print flag
    if (/--print\b/.test(helpOutput) || /\s-p\b/.test(helpOutput)) {
      discoveredCapabilities.push('print');
    }

    // --input-format flag & stream-json support
    if (/--input-format\b/.test(helpOutput)) {
      if (/stream-json/.test(helpOutput)) {
        discoveredCapabilities.push('input-format:stream-json');
      }
    }

    // --output-format flag & stream-json support
    if (/--output-format\b/.test(helpOutput)) {
      if (/stream-json/.test(helpOutput)) {
        discoveredCapabilities.push('output-format:stream-json');
      }
    }

    // --project flag
    if (/--project\b/.test(helpOutput)) {
      discoveredCapabilities.push('project');
    }

    // --add-dir flag
    if (/--add-dir\b/.test(helpOutput)) {
      discoveredCapabilities.push('add-dir');
    }

    // Optional capabilities
    if (/--conversation\b/.test(helpOutput)) {
      discoveredCapabilities.push('conversation');
    }
    if (/--effort\b/.test(helpOutput)) {
      discoveredCapabilities.push('effort');
    }

    // 6. Verify required capabilities against contract
    const missingCapabilities = REQUIRED_ANTIGRAVITY_CAPABILITIES.filter(
      (req) => !discoveredCapabilities.includes(req)
    );

    const isCompatible = missingCapabilities.length === 0;
    const reason = isCompatible
      ? null
      : `Antigravity CLI at "${executable}" is missing required capabilities: [${missingCapabilities.join(', ')}]`;

    const outcome: ExecutorCompatibility = Object.freeze({
      executable,
      version,
      protocol: DEFAULT_ANTIGRAVITY_PROTOCOL,
      capabilities: Object.freeze(discoveredCapabilities),
      compatible: isCompatible,
      reason,
      probedAt,
    });

    // Cache successful or evaluated check
    this.cache.set(executable, outcome);

    return outcome;
  }
}

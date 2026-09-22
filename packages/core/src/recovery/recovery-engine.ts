import * as path from 'node:path';
import type {
  RecoveryEngineOptions,
  RecoveryResult,
  RecoverySnapshot,
  ValidationEvidence,
} from './types.js';
import type { DurableState } from '../storage/durable-state.js';
import type { LocalRuntimeState } from '../storage/runtime-state.js';
import type { HistoryEvent } from '../storage/history-manager.js';
import type { FileRecord, ScannedFile } from '../l0/types.js';
import { DurableStateManager } from '../storage/durable-state.js';
import { LocalRuntimeStateManager } from '../storage/runtime-state.js';
import { HistoryManager } from '../storage/history-manager.js';
import { L0Database } from '../l0/database.js';
import { scanWorkspaceFiles } from '../l0/scanner.js';
import { GitObserver } from './git-observer.js';
import { reconcileFilesystemAndL0 } from './reconciliation.js';
import { evaluateRecoveryDecision } from './decision-engine.js';
import { RecoveryError } from '../errors/recovery-error.js';
import { HistoryCorruptError } from '../errors/history-corrupt-error.js';
import { StateValidationError } from '../errors/state-validation-error.js';
import { SchemaVersionError } from '../errors/schema-version-error.js';

export function defaultProcessLivenessChecker(pid: number): boolean {
  if (pid <= 0 || !Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const nodeErr = err as NodeJS.ErrnoException;
    return nodeErr.code === 'EPERM';
  }
}

/**
 * Phase 1 Recovery & Reconciliation Foundation Engine.
 * Reconciles durable state, runtime state, append-only history, SQLite L0 index,
 * workspace filesystem state, and Git observation to produce deterministic recovery decisions.
 */
export class RecoveryEngine {
  readonly workspaceRoot: string;
  private readonly durableStateManager: DurableStateManager;
  private readonly localRuntimeStateManager: LocalRuntimeStateManager;
  private readonly historyManager: HistoryManager;
  private readonly l0Database: L0Database;
  private readonly gitObserver: GitObserver;
  private readonly processLivenessChecker: (pid: number) => boolean;
  private readonly fileIntegrityChecker?: (fullPath: string) => Promise<boolean> | boolean;
  private readonly ignorePatterns: string[];
  private readonly taskScope?: string[];
  private readonly taskScopeResolver?: (taskId: string, durableState: DurableState | null) => string[] | undefined;
  private readonly validationEvidence?: ValidationEvidence | null;
  private readonly userResponse: string | Record<string, unknown> | null;
  private readonly isCorrupted: boolean;

  constructor(options: RecoveryEngineOptions) {
    if (!options.workspaceRoot) {
      throw new RecoveryError('workspaceRoot is required for RecoveryEngine', {
        category: 'INVALID_INPUT',
      });
    }

    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.durableStateManager =
      options.durableStateManager ?? new DurableStateManager({ baseDir: this.workspaceRoot });
    this.localRuntimeStateManager =
      options.localRuntimeStateManager ?? new LocalRuntimeStateManager({ baseDir: this.workspaceRoot });
    this.historyManager =
      options.historyManager ?? new HistoryManager({ baseDir: this.workspaceRoot });
    this.l0Database =
      options.l0Database ??
      new L0Database({
        dbPath: path.join(this.workspaceRoot, '.ai-manager', 'cache', 'context.db'),
      });
    this.gitObserver = new GitObserver();
    this.processLivenessChecker = options.processLivenessChecker ?? defaultProcessLivenessChecker;
    this.fileIntegrityChecker = options.fileIntegrityChecker;
    this.ignorePatterns = options.ignorePatterns ?? [];
    this.taskScope = options.taskScope;
    this.taskScopeResolver = options.taskScopeResolver;
    this.validationEvidence = options.validationEvidence ?? null;
    this.userResponse = options.userResponse ?? null;
    this.isCorrupted = options.isCorrupted ?? false;
  }

  /**
   * Collects an immutable snapshot across all authoritative sources.
   */
  async collectSnapshot(runtimeOptions?: {
    taskScope?: string[];
    validationEvidence?: ValidationEvidence | null;
    userResponse?: string | Record<string, unknown> | null;
    isCorrupted?: boolean;
  }): Promise<RecoverySnapshot> {
    // 1. Durable state
    let durableState: DurableState | null = null;
    try {
      durableState = await this.durableStateManager.load();
    } catch (err) {
      throw new RecoveryError(`Authoritative durable state is invalid or corrupt: ${(err as Error).message}`, {
        category: 'UNREADABLE_DURABLE_STATE',
        cause: err,
      });
    }

    // 2. Local runtime state
    let localRuntimeState: LocalRuntimeState | null = null;
    let isProcessAlive = false;
    let isRuntimeStale = false;
    try {
      localRuntimeState = await this.localRuntimeStateManager.load();
      if (localRuntimeState) {
        isProcessAlive = this.processLivenessChecker(localRuntimeState.processId);
        // Stale if a lock was acquired or process recorded, but the process is no longer running
        isRuntimeStale = !isProcessAlive;
      }
    } catch (err) {
      throw new RecoveryError(`Local runtime state is invalid or corrupt: ${(err as Error).message}`, {
        category: 'UNREADABLE_RUNTIME_STATE',
        cause: err,
      });
    }

    // 3. Append-only history events
    let historyEvents: HistoryEvent[] = [];
    try {
      historyEvents = await this.historyManager.readEvents();
    } catch (err) {
      if (err instanceof HistoryCorruptError) {
        throw new RecoveryError(`History stream is corrupt at line ${err.lineNumber}: ${err.message}`, {
          category: 'CORRUPT_HISTORY',
          cause: err,
        });
      }
      throw err;
    }
    const lastEvent = historyEvents.length > 0 ? historyEvents[historyEvents.length - 1] : null;

    // 4. L0 Index records
    let l0Records: FileRecord[] = [];
    try {
      if (await this.l0DatabaseExists()) {
        this.l0Database.open();
        l0Records = this.l0Database.getAllFiles();
      }
    } catch (err) {
      throw new RecoveryError(`Failed to read L0 SQLite index: ${(err as Error).message}`, {
        category: 'UNREADABLE_L0_INDEX',
        cause: err,
      });
    }

    // 5. Filesystem scan - ignore .ai-manager purely within recovery reconciliation
    let scannedFiles: ScannedFile[] = [];
    try {
      scannedFiles = await scanWorkspaceFiles(this.workspaceRoot, {
        ignorePatterns: ['.ai-manager', ...this.ignorePatterns],
      });
    } catch (err) {
      throw new RecoveryError(`Failed to scan filesystem: ${(err as Error).message}`, {
        category: 'FILESYSTEM_INSPECTION_FAILURE',
        cause: err,
      });
    }

    // 5b. Gather attributable task scope patterns from all architectural sources
    const attributableSet = new Set<string>();

    if (runtimeOptions?.taskScope) {
      for (const p of runtimeOptions.taskScope) attributableSet.add(p);
    } else if (this.taskScope) {
      for (const p of this.taskScope) attributableSet.add(p);
    }

    if (durableState?.activeTaskId) {
      const activeTaskId = durableState.activeTaskId;
      if (this.taskScopeResolver) {
        const resolved = this.taskScopeResolver(activeTaskId, durableState);
        if (resolved) {
          for (const p of resolved) attributableSet.add(p);
        }
      }

      const meta = durableState.metadata;
      if (meta) {
        const candidates = [
          meta.taskScope,
          meta.targetFiles,
          meta.expectedFiles,
          meta.modifiedFiles,
          meta.affectedFiles,
        ];
        for (const c of candidates) {
          if (Array.isArray(c)) {
            for (const item of c) {
              if (typeof item === 'string') attributableSet.add(item);
            }
          } else if (typeof c === 'string') {
            attributableSet.add(c);
          }
        }
      }

      const runtimeMeta = localRuntimeState?.metadata;
      if (runtimeMeta) {
        const candidates = [runtimeMeta.taskScope, runtimeMeta.targetFiles, runtimeMeta.modifiedFiles];
        for (const c of candidates) {
          if (Array.isArray(c)) {
            for (const item of c) {
              if (typeof item === 'string') attributableSet.add(item);
            }
          }
        }
      }

      for (const event of historyEvents) {
        if (event.taskId !== activeTaskId) {
          continue;
        }
        const payload = event.payload;
        if (payload) {
          const fileLists = [payload.files, payload.modifiedFiles, payload.targetFiles];
          for (const list of fileLists) {
            if (Array.isArray(list)) {
              for (const item of list) {
                if (typeof item === 'string') attributableSet.add(item);
              }
            }
          }
          if (typeof payload.targetFile === 'string') attributableSet.add(payload.targetFile);
          if (typeof payload.filePath === 'string') attributableSet.add(payload.filePath);
        }
      }
    }

    // 5c. Gather validation / compilability evidence
    let validationEvidence: ValidationEvidence | null =
      runtimeOptions?.validationEvidence !== undefined
        ? runtimeOptions.validationEvidence
        : this.validationEvidence ?? null;

    if (!validationEvidence && durableState?.activeTaskId) {
      const activeTaskId = durableState.activeTaskId;
      const meta = durableState.metadata;
      if (meta) {
        if (meta.validationEvidence && typeof meta.validationEvidence === 'object') {
          validationEvidence = meta.validationEvidence as ValidationEvidence;
        } else if (meta.buildVerified === true || meta.compilable === true) {
          validationEvidence = {
            compilable: true,
            buildPassed: meta.buildVerified === true,
            source: 'durable-state:metadata',
          };
        }
      }

      if (!validationEvidence) {
        for (let i = historyEvents.length - 1; i >= 0; i--) {
          const ev = historyEvents[i];
          if (ev.taskId !== activeTaskId) {
            continue;
          }
          if (ev.eventType === 'BUILD_VERIFIED' || ev.eventType === 'EVIDENCE_COLLECTED') {
            const p = ev.payload;
            validationEvidence = {
              compilable: p?.compilable === true || (p?.compilable !== false && p?.exitCode === 0),
              buildPassed: p?.buildPassed === true || (p?.buildPassed !== false && p?.exitCode === 0),
              verifiedAt: ev.timestamp,
              source: `history:${ev.eventId}`,
              fileHashes: (p?.fileHashes as Record<string, string>) ?? undefined,
              gitHead: (p?.gitHead as string) ?? undefined,
              contextReference: (p?.contextReference as string) ?? undefined,
            };
            break;
          }
        }
      }
    }

    // 6. Reconcile filesystem vs L0 with attributable task patterns
    const filesystemDiff = await reconcileFilesystemAndL0(
      l0Records,
      scannedFiles,
      this.fileIntegrityChecker,
      attributableSet
    );

    // 7. Git observation
    const gitState = await this.gitObserver.observeGitState(this.workspaceRoot);

    return {
      durableState,
      localRuntimeState,
      historyEvents,
      lastEvent,
      l0Records,
      scannedFiles,
      gitState,
      isProcessAlive,
      isRuntimeStale,
      filesystemDiff,
      taskScope: attributableSet.size > 0 ? Array.from(attributableSet) : undefined,
      validationEvidence,
      userResponse:
        runtimeOptions?.userResponse !== undefined ? runtimeOptions.userResponse : this.userResponse,
      isCorrupted:
        runtimeOptions?.isCorrupted !== undefined ? runtimeOptions.isCorrupted : this.isCorrupted,
    };
  }

  /**
   * Executes reconciliation across all evidence sources and produces a deterministic recovery decision.
   * Execution metadata (such as timestamp) is attached outside pure deterministic decision calculation.
   */
  async reconcile(runtimeOptions?: {
    taskScope?: string[];
    validationEvidence?: ValidationEvidence | null;
    userResponse?: string | Record<string, unknown> | null;
    isCorrupted?: boolean;
  }): Promise<RecoveryResult> {
    const snapshot = await this.collectSnapshot(runtimeOptions);
    const decisionData = evaluateRecoveryDecision(snapshot);
    return {
      ...decisionData,
      timestamp: new Date().toISOString(),
    };
  }

  private async l0DatabaseExists(): Promise<boolean> {
    try {
      const fs = await import('node:fs');
      await fs.promises.access(this.l0Database.dbPath, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    this.l0Database.close();
  }
}

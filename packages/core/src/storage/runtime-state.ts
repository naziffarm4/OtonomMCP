import * as path from 'node:path';
import * as fs from 'node:fs';
import { z } from 'zod';
import { StateValidationError } from '../errors/state-validation-error.js';
import { SchemaVersionError } from '../errors/schema-version-error.js';
import { atomicWriteJson, readJsonFile } from './atomic-writer.js';
import { BlockedStateZodSchema, toSnakeCaseBlockedState, type BlockedState } from './blocked-state-schema.js';

export const CURRENT_LOCAL_RUNTIME_SCHEMA_VERSION = 1;

export const LocalRuntimeStateZodSchema = z.preprocess((val) => {
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    const raw = val as Record<string, unknown>;
    return {
      schemaVersion: raw.schemaVersion ?? raw.schema_version,
      processId: raw.processId ?? raw.process_id,
      acquiredLock: raw.acquiredLock ?? raw.acquired_lock,
      activeAttempt: raw.activeAttempt ?? raw.active_attempt,
      startedAt: raw.startedAt ?? raw.started_at,
      lastHeartbeat: raw.lastHeartbeat ?? raw.last_heartbeat,
      blockedState: raw.blockedState !== undefined ? raw.blockedState : (raw.blocked_state ?? null),
      metadata: raw.metadata,
    };
  }
  return val;
}, z.object({
  schemaVersion: z.number({ message: 'schemaVersion is required' }).int().positive(),
  processId: z.number({ message: 'processId is required' }).int(),
  acquiredLock: z.boolean({ message: 'acquiredLock is required' }),
  activeAttempt: z.number({ message: 'activeAttempt is required' }).int().nonnegative(),
  startedAt: z.string().min(1, 'startedAt cannot be empty'),
  lastHeartbeat: z.string().min(1, 'lastHeartbeat cannot be empty'),
  blockedState: BlockedStateZodSchema.nullable().optional().default(null),
  metadata: z.record(z.string(), z.unknown()).optional(),
}));

export interface LocalRuntimeState {
  schemaVersion: number;
  processId: number;
  acquiredLock: boolean;
  activeAttempt: number;
  startedAt: string;
  lastHeartbeat: string;
  blockedState?: BlockedState | null;
  metadata?: Record<string, unknown>;
}

export type LocalRuntimeStateInput = Omit<LocalRuntimeState, 'schemaVersion' | 'startedAt' | 'lastHeartbeat'> & {
  schemaVersion?: number;
  startedAt?: string;
  lastHeartbeat?: string;
  blocked_state?: unknown;
};

export interface LocalRuntimeStateManagerOptions {
  filePath?: string;
  baseDir?: string;
  workspaceRoot?: string;
}

export class LocalRuntimeStateManager {
  readonly filePath: string;

  constructor(options?: LocalRuntimeStateManagerOptions) {
    if (options?.filePath) {
      this.filePath = options.filePath;
    } else {
      const baseDir = options?.baseDir ?? options?.workspaceRoot ?? process.cwd();
      this.filePath = path.join(baseDir, '.ai-manager', 'state', 'local-runtime.json');
    }
  }

  async exists(): Promise<boolean> {
    try {
      await fs.promises.access(this.filePath, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  async save(input: LocalRuntimeStateInput): Promise<LocalRuntimeState> {
    const now = new Date().toISOString();
    const payload: Record<string, unknown> = {
      schemaVersion: input.schemaVersion ?? CURRENT_LOCAL_RUNTIME_SCHEMA_VERSION,
      processId: input.processId,
      acquiredLock: input.acquiredLock,
      activeAttempt: input.activeAttempt,
      startedAt: input.startedAt ?? now,
      lastHeartbeat: input.lastHeartbeat ?? now,
      blockedState: input.blockedState ?? input.blocked_state ?? null,
      metadata: input.metadata,
    };

    if (typeof payload.schemaVersion === 'number' && payload.schemaVersion !== CURRENT_LOCAL_RUNTIME_SCHEMA_VERSION) {
      throw new SchemaVersionError(
        `Unsupported local runtime schema version: ${payload.schemaVersion}. Expected: ${CURRENT_LOCAL_RUNTIME_SCHEMA_VERSION}`,
        {
          expectedVersion: CURRENT_LOCAL_RUNTIME_SCHEMA_VERSION,
          actualVersion: payload.schemaVersion,
          filePath: this.filePath,
        }
      );
    }

    const parseResult = LocalRuntimeStateZodSchema.safeParse(payload);
    if (!parseResult.success) {
      throw new StateValidationError(
        `Local runtime state validation failed: ${parseResult.error.message}`,
        {
          filePath: this.filePath,
          validationErrors: parseResult.error.issues,
        }
      );
    }

    const validated = parseResult.data as LocalRuntimeState;

    const filePayload: Record<string, unknown> = {
      schema_version: validated.schemaVersion,
      schemaVersion: validated.schemaVersion,
      process_id: validated.processId,
      processId: validated.processId,
      acquired_lock: validated.acquiredLock,
      acquiredLock: validated.acquiredLock,
      active_attempt: validated.activeAttempt,
      activeAttempt: validated.activeAttempt,
      started_at: validated.startedAt,
      startedAt: validated.startedAt,
      last_heartbeat: validated.lastHeartbeat,
      lastHeartbeat: validated.lastHeartbeat,
      blocked_state: toSnakeCaseBlockedState(validated.blockedState),
      blockedState: validated.blockedState,
      metadata: validated.metadata,
    };

    await atomicWriteJson(this.filePath, filePayload);
    return validated;
  }

  async load(): Promise<LocalRuntimeState | null> {
    const rawData = await readJsonFile<Record<string, unknown>>(this.filePath);
    if (rawData === null) {
      return null;
    }

    if (typeof rawData !== 'object' || rawData === null || Array.isArray(rawData)) {
      throw new StateValidationError(`Local runtime state file contents must be a JSON object`, {
        filePath: this.filePath,
      });
    }

    const rawVersion = rawData.schemaVersion ?? rawData.schema_version;
    if (rawVersion !== undefined && typeof rawVersion === 'number' && rawVersion !== CURRENT_LOCAL_RUNTIME_SCHEMA_VERSION) {
      throw new SchemaVersionError(
        `Unsupported local runtime schema version: ${rawVersion}. Expected: ${CURRENT_LOCAL_RUNTIME_SCHEMA_VERSION}`,
        {
          expectedVersion: CURRENT_LOCAL_RUNTIME_SCHEMA_VERSION,
          actualVersion: rawVersion,
          filePath: this.filePath,
        }
      );
    }

    const parseResult = LocalRuntimeStateZodSchema.safeParse(rawData);
    if (!parseResult.success) {
      throw new StateValidationError(
        `Failed to validate persisted local runtime state: ${parseResult.error.message}`,
        {
          filePath: this.filePath,
          validationErrors: parseResult.error.issues,
        }
      );
    }

    return parseResult.data as LocalRuntimeState;
  }

  async clear(processId?: number): Promise<void> {
    try {
      const existing = await this.load();
      if (processId !== undefined && existing && existing.acquiredLock && existing.processId !== processId) {
        throw new InstanceConcurrencyError(
          `Cannot delete workspace lock file: lock is held by another instance (PID: ${existing.processId}). Non-owner processes cannot delete the lock file.`,
          { currentPid: processId, ownerPid: existing.processId, filePath: this.filePath }
        );
      }
      await fs.promises.unlink(this.filePath);
    } catch (err: unknown) {
      if (err instanceof InstanceConcurrencyError) {
        throw err;
      }
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code !== 'ENOENT') {
        throw err;
      }
    }
  }

  /**
   * Checks if a process ID is currently alive on the host OS.
   */
  isProcessAlive(pid: number): boolean {
    if (typeof pid !== 'number' || isNaN(pid) || pid <= 0) {
      return false;
    }
    try {
      process.kill(pid, 0);
      return true;
    } catch (err: any) {
      return err.code === 'EPERM';
    }
  }

  /**
   * Atomically acquires the single-active-instance lock for the workspace.
   * Throws InstanceConcurrencyError if another process holds the lock.
   * Zombie takeover, force unlock, and automatic stale lock clearing are strictly prohibited.
   */
  async acquireInstanceLock(options?: {
    processId?: number;
  }): Promise<LocalRuntimeState> {
    const currentPid = options?.processId ?? process.pid;
    const existing = await this.load();

    if (existing && existing.acquiredLock) {
      if (existing.processId === currentPid) {
        // Idempotent re-acquisition by the same process
        return await this.save({
          ...existing,
          lastHeartbeat: new Date().toISOString(),
        });
      }

      // STRICT LOCK POLICY:
      // If a lock file exists with acquiredLock === true and belongs to a different PID:
      // It is NEVER automatically taken over, regardless of whether the PID appears alive or dead,
      // or whether the heartbeat has expired. Zombie takeover, force-unlock, and automatic
      // deletion are strictly prohibited.
      const processAlive = this.isProcessAlive(existing.processId);
      throw new InstanceConcurrencyError(
        `Cannot acquire workspace instance lock. An existing AIDM instance (PID: ${existing.processId}, isAlive: ${processAlive}) holds the lock for '${this.filePath}'. Only one active instance is permitted per workspace. Automatic takeover, stale lock clearing, and force-unlock are strictly disabled.`,
        {
          currentPid,
          existingPid: existing.processId,
          isExistingPidAlive: processAlive,
          lastHeartbeat: existing.lastHeartbeat,
          filePath: this.filePath,
        }
      );
    }

    return await this.save({
      schemaVersion: CURRENT_LOCAL_RUNTIME_SCHEMA_VERSION,
      processId: currentPid,
      acquiredLock: true,
      activeAttempt: (existing?.activeAttempt ?? 0) + 1,
      startedAt: existing?.startedAt ?? new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
      blockedState: existing?.blockedState ?? null,
    });
  }

  /**
   * Releases the single-active-instance lock cleanly.
   * Only the owning process can release the lock.
   */
  async releaseInstanceLock(processId?: number): Promise<void> {
    const currentPid = processId ?? process.pid;
    const existing = await this.load();
    if (!existing || !existing.acquiredLock) {
      return;
    }
    if (existing.processId !== currentPid) {
      throw new InstanceConcurrencyError(
        `Cannot release workspace instance lock: caller PID (${currentPid}) is not the lock owner (owner PID: ${existing.processId}). Non-owner processes cannot release or mutate the lock.`,
        { currentPid, ownerPid: existing.processId }
      );
    }
    await this.save({
      ...existing,
      acquiredLock: false,
      lastHeartbeat: new Date().toISOString(),
    });
  }
}

export class InstanceConcurrencyError extends Error {
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'InstanceConcurrencyError';
    this.details = details ? Object.freeze({ ...details }) : undefined;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}


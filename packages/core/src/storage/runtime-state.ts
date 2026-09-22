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
}

export class LocalRuntimeStateManager {
  readonly filePath: string;

  constructor(options?: LocalRuntimeStateManagerOptions) {
    if (options?.filePath) {
      this.filePath = options.filePath;
    } else {
      const baseDir = options?.baseDir ?? process.cwd();
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

  async clear(): Promise<void> {
    try {
      await fs.promises.unlink(this.filePath);
    } catch (err: unknown) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code !== 'ENOENT') {
        throw err;
      }
    }
  }
}

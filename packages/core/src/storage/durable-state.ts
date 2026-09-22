import * as path from 'node:path';
import * as fs from 'node:fs';
import { z } from 'zod';
import { LifecycleState, LIFECYCLE_STATES } from '../lifecycle.js';
import { StateValidationError } from '../errors/state-validation-error.js';
import { SchemaVersionError } from '../errors/schema-version-error.js';
import { atomicWriteJson, readJsonFile } from './atomic-writer.js';
import { BlockedStateZodSchema, toSnakeCaseBlockedState, type BlockedState } from './blocked-state-schema.js';

export const CURRENT_DURABLE_STATE_SCHEMA_VERSION = 1;

/**
 * Raw Zod schema for validating DurableState payload.
 */
export const DurableStateZodSchema = z.preprocess((val) => {
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    const raw = val as Record<string, unknown>;
    return {
      schemaVersion: raw.schemaVersion ?? raw.schema_version,
      currentLifecycleState: raw.currentLifecycleState ?? raw.current_lifecycle_state,
      activeTaskId: raw.activeTaskId !== undefined ? raw.activeTaskId : (raw.active_task_id ?? null),
      completedTaskIds: raw.completedTaskIds ?? raw.completed_task_ids ?? [],
      blockedState: raw.blockedState !== undefined ? raw.blockedState : (raw.blocked_state ?? null),
      lastCheckpoint: raw.lastCheckpoint !== undefined ? raw.lastCheckpoint : (raw.last_checkpoint ?? null),
      updatedAt: raw.updatedAt ?? raw.updated_at,
      metadata: raw.metadata,
    };
  }
  return val;
}, z.object({
  schemaVersion: z.number({ message: 'schemaVersion is required and must be a number' }).int().positive(),
  currentLifecycleState: z.enum(LIFECYCLE_STATES as [string, ...string[]], {
    message: `currentLifecycleState must be one of: ${LIFECYCLE_STATES.join(', ')}`,
  }),
  activeTaskId: z.string().nullable().optional().default(null),
  completedTaskIds: z.array(z.string()).default([]),
  blockedState: BlockedStateZodSchema.nullable().optional().default(null),
  lastCheckpoint: z.string().nullable().optional().default(null),
  updatedAt: z.string().min(1, 'updatedAt cannot be empty'),
  metadata: z.record(z.string(), z.unknown()).optional(),
}));

export interface DurableState {
  schemaVersion: number;
  currentLifecycleState: LifecycleState;
  activeTaskId: string | null;
  completedTaskIds: string[];
  blockedState: BlockedState | null;
  lastCheckpoint?: string | null;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export type DurableStateInput = Omit<DurableState, 'schemaVersion' | 'updatedAt'> & {
  schemaVersion?: number;
  updatedAt?: string;
  blocked_state?: unknown;
};

export interface DurableStateManagerOptions {
  filePath?: string;
  baseDir?: string;
}

export class DurableStateManager {
  readonly filePath: string;

  constructor(options?: DurableStateManagerOptions) {
    if (options?.filePath) {
      this.filePath = options.filePath;
    } else {
      const baseDir = options?.baseDir ?? process.cwd();
      this.filePath = path.join(baseDir, '.ai-manager', 'state', 'durable-state.json');
    }
  }

  /**
   * Check if durable state file exists on disk.
   */
  async exists(): Promise<boolean> {
    try {
      await fs.promises.access(this.filePath, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Save durable state to disk with atomic write semantics and schema validation.
   */
  async save(input: DurableStateInput): Promise<DurableState> {
    const payload: Record<string, unknown> = {
      schemaVersion: input.schemaVersion ?? CURRENT_DURABLE_STATE_SCHEMA_VERSION,
      currentLifecycleState: input.currentLifecycleState,
      activeTaskId: input.activeTaskId ?? null,
      completedTaskIds: input.completedTaskIds ?? [],
      blockedState: input.blockedState ?? input.blocked_state ?? null,
      lastCheckpoint: input.lastCheckpoint ?? null,
      updatedAt: input.updatedAt ?? new Date().toISOString(),
      metadata: input.metadata,
    };

    // Schema version pre-check
    if (typeof payload.schemaVersion === 'number' && payload.schemaVersion !== CURRENT_DURABLE_STATE_SCHEMA_VERSION) {
      throw new SchemaVersionError(
        `Unsupported durable state schema version: ${payload.schemaVersion}. Expected: ${CURRENT_DURABLE_STATE_SCHEMA_VERSION}`,
        {
          expectedVersion: CURRENT_DURABLE_STATE_SCHEMA_VERSION,
          actualVersion: payload.schemaVersion,
          filePath: this.filePath,
        }
      );
    }

    const parseResult = DurableStateZodSchema.safeParse(payload);
    if (!parseResult.success) {
      throw new StateValidationError(
        `Durable state validation failed: ${parseResult.error.message}`,
        {
          filePath: this.filePath,
          validationErrors: parseResult.error.issues,
        }
      );
    }

    const validated = parseResult.data as DurableState;

    // For storage, serialize both camelCase and snake_case representations
    // to guarantee full compatibility with both TS APIs and architecture JSON spec.
    const filePayload: Record<string, unknown> = {
      schema_version: validated.schemaVersion,
      schemaVersion: validated.schemaVersion,
      current_lifecycle_state: validated.currentLifecycleState,
      currentLifecycleState: validated.currentLifecycleState,
      active_task_id: validated.activeTaskId,
      activeTaskId: validated.activeTaskId,
      completed_task_ids: validated.completedTaskIds,
      completedTaskIds: validated.completedTaskIds,
      blocked_state: toSnakeCaseBlockedState(validated.blockedState),
      blockedState: validated.blockedState,
      last_checkpoint: validated.lastCheckpoint,
      lastCheckpoint: validated.lastCheckpoint,
      updated_at: validated.updatedAt,
      updatedAt: validated.updatedAt,
      metadata: validated.metadata,
    };

    await atomicWriteJson(this.filePath, filePayload);
    return validated;
  }

  /**
   * Load and validate durable state from disk.
   * Returns null if file does not exist.
   * Throws SchemaVersionError if schema version is unsupported.
   * Throws StateValidationError if data is invalid or missing required fields.
   */
  async load(): Promise<DurableState | null> {
    const rawData = await readJsonFile<Record<string, unknown>>(this.filePath);
    if (rawData === null) {
      return null;
    }

    if (typeof rawData !== 'object' || rawData === null || Array.isArray(rawData)) {
      throw new StateValidationError(`Durable state file contents must be a JSON object`, {
        filePath: this.filePath,
      });
    }

    const rawVersion = rawData.schemaVersion ?? rawData.schema_version;
    if (rawVersion !== undefined && typeof rawVersion === 'number' && rawVersion !== CURRENT_DURABLE_STATE_SCHEMA_VERSION) {
      throw new SchemaVersionError(
        `Unsupported durable state schema version: ${rawVersion}. Expected: ${CURRENT_DURABLE_STATE_SCHEMA_VERSION}`,
        {
          expectedVersion: CURRENT_DURABLE_STATE_SCHEMA_VERSION,
          actualVersion: rawVersion,
          filePath: this.filePath,
        }
      );
    }

    const parseResult = DurableStateZodSchema.safeParse(rawData);
    if (!parseResult.success) {
      throw new StateValidationError(
        `Failed to validate persisted durable state: ${parseResult.error.message}`,
        {
          filePath: this.filePath,
          validationErrors: parseResult.error.issues,
        }
      );
    }

    return parseResult.data as DurableState;
  }

  /**
   * Reset / remove durable state file (useful for test isolation).
   */
  async reset(): Promise<void> {
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

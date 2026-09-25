import * as path from 'node:path';
import * as fs from 'node:fs';
import { z } from 'zod';
import { LifecycleState, LIFECYCLE_STATES } from '../lifecycle.js';
import { VALID_LIFECYCLE_TRANSITIONS } from '../fsm/state-machine.js';
import { InvalidStateTransitionError } from '../errors/invalid-state-transition-error.js';
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

  /**
   * Transitions top-level lifecycle state enforcing VALID_LIFECYCLE_TRANSITIONS.
   * Throws InvalidStateTransitionError if transition is disallowed.
   */
  async transitionLifecycleState(
    targetState: LifecycleState,
    options?: { metadata?: Record<string, unknown> }
  ): Promise<DurableState> {
    const current = (await this.load()) ?? {
      schemaVersion: CURRENT_DURABLE_STATE_SCHEMA_VERSION,
      currentLifecycleState: LifecycleState.INITIALIZING,
      activeTaskId: null,
      completedTaskIds: [],
      blockedState: null,
      lastCheckpoint: null,
      updatedAt: new Date().toISOString(),
    };

    if (current.currentLifecycleState === targetState) {
      return current;
    }

    const allowed = VALID_LIFECYCLE_TRANSITIONS.get(current.currentLifecycleState);
    if (!allowed || !allowed.has(targetState)) {
      const allowedArr = allowed ? Array.from(allowed) : [];
      throw new InvalidStateTransitionError(
        `Invalid lifecycle transition in DurableState: Cannot transition from '${current.currentLifecycleState}' to '${targetState}'. Allowed transitions: [${allowedArr.join(', ')}]`,
        {
          fromState: current.currentLifecycleState,
          toState: targetState,
          allowedTransitions: allowedArr,
          reason: `Transition from ${current.currentLifecycleState} to ${targetState} is disallowed by the authoritative transition table.`,
        }
      );
    }

    const updated: DurableState = {
      ...current,
      currentLifecycleState: targetState,
      updatedAt: new Date().toISOString(),
      metadata: options?.metadata ? { ...(current.metadata ?? {}), ...options.metadata } : current.metadata,
    };

    return this.save(updated);
  }

  /**
   * Authoritatively records completion of a task in DurableState.
   * Adds taskId to completedTaskIds (deduplicated, sorted), clears activeTaskId if matched.
   * Validates legal lifecycle state (cannot complete tasks if PROJECT_COMPLETE).
   */
  async recordTaskCompletion(
    taskId: string,
    options?: { metadata?: Record<string, unknown> }
  ): Promise<DurableState> {
    if (!taskId || typeof taskId !== 'string' || taskId.trim().length === 0) {
      throw new StateValidationError('taskId must be a non-empty string to record completion', {
        filePath: this.filePath,
      });
    }

    const current = (await this.load()) ?? {
      schemaVersion: CURRENT_DURABLE_STATE_SCHEMA_VERSION,
      currentLifecycleState: LifecycleState.TASK_LOOP,
      activeTaskId: null,
      completedTaskIds: [],
      blockedState: null,
      lastCheckpoint: null,
      updatedAt: new Date().toISOString(),
    };

    if (current.currentLifecycleState === LifecycleState.PROJECT_COMPLETE) {
      throw new InvalidStateTransitionError(
        `Cannot record task completion: current lifecycle state is terminal '${LifecycleState.PROJECT_COMPLETE}'`,
        {
          fromState: current.currentLifecycleState,
          toState: current.currentLifecycleState,
          reason: 'Project is already marked complete; no further tasks may be completed.',
        }
      );
    }

    const completedSet = new Set(current.completedTaskIds);
    completedSet.add(taskId);
    const sortedCompleted = Array.from(completedSet).sort((a, b) => a.localeCompare(b));

    const updated: DurableState = {
      ...current,
      completedTaskIds: sortedCompleted,
      activeTaskId: current.activeTaskId === taskId ? null : current.activeTaskId,
      updatedAt: new Date().toISOString(),
      metadata: options?.metadata ? { ...(current.metadata ?? {}), ...options.metadata } : current.metadata,
    };

    return this.save(updated);
  }

  /**
   * Authoritatively records a task as blocked in DurableState.
   * Enters BLOCKED_ON_HUMAN state with structured blocked state schema.
   */
  async recordTaskBlocked(
    taskId: string,
    blockedStateData: BlockedState,
    options?: { metadata?: Record<string, unknown> }
  ): Promise<DurableState> {
    if (!taskId || typeof taskId !== 'string' || taskId.trim().length === 0) {
      throw new StateValidationError('taskId must be a non-empty string to record task blocked', {
        filePath: this.filePath,
      });
    }

    const parsedBlocked = BlockedStateZodSchema.safeParse(blockedStateData);
    if (!parsedBlocked.success) {
      throw new StateValidationError(
        `Invalid blocked state payload: ${parsedBlocked.error.message}`,
        {
          filePath: this.filePath,
          validationErrors: parsedBlocked.error.issues,
        }
      );
    }

    const current = (await this.load()) ?? {
      schemaVersion: CURRENT_DURABLE_STATE_SCHEMA_VERSION,
      currentLifecycleState: LifecycleState.TASK_LOOP,
      activeTaskId: taskId,
      completedTaskIds: [],
      blockedState: null,
      lastCheckpoint: null,
      updatedAt: new Date().toISOString(),
    };

    // Transition to BLOCKED_ON_HUMAN if valid or if already in a task execution state
    let targetLifecycle = current.currentLifecycleState;
    if (targetLifecycle !== LifecycleState.BLOCKED_ON_HUMAN) {
      const allowed = VALID_LIFECYCLE_TRANSITIONS.get(current.currentLifecycleState);
      if (allowed && allowed.has(LifecycleState.BLOCKED_ON_HUMAN)) {
        targetLifecycle = LifecycleState.BLOCKED_ON_HUMAN;
      }
    }

    const updated: DurableState = {
      ...current,
      currentLifecycleState: targetLifecycle,
      activeTaskId: current.activeTaskId === taskId ? null : current.activeTaskId,
      blockedState: parsedBlocked.data,
      updatedAt: new Date().toISOString(),
      metadata: options?.metadata ? { ...(current.metadata ?? {}), ...options.metadata } : current.metadata,
    };

    return this.save(updated);
  }

  /**
   * Authoritatively records an active task execution.
   */
  async recordTaskExecution(taskId: string): Promise<DurableState> {
    if (!taskId || typeof taskId !== 'string' || taskId.trim().length === 0) {
      throw new StateValidationError('taskId must be a non-empty string to record task execution', {
        filePath: this.filePath,
      });
    }

    const current = (await this.load()) ?? {
      schemaVersion: CURRENT_DURABLE_STATE_SCHEMA_VERSION,
      currentLifecycleState: LifecycleState.TASK_LOOP,
      activeTaskId: null,
      completedTaskIds: [],
      blockedState: null,
      lastCheckpoint: null,
      updatedAt: new Date().toISOString(),
    };

    const updated: DurableState = {
      ...current,
      activeTaskId: taskId,
      updatedAt: new Date().toISOString(),
    };

    return this.save(updated);
  }

  /**
   * Clears the active task ID if matching or unspecified.
   */
  async clearActiveTask(taskId?: string): Promise<DurableState> {
    const current = await this.load();
    if (!current) {
      return {
        schemaVersion: CURRENT_DURABLE_STATE_SCHEMA_VERSION,
        currentLifecycleState: LifecycleState.INITIALIZING,
        activeTaskId: null,
        completedTaskIds: [],
        blockedState: null,
        lastCheckpoint: null,
        updatedAt: new Date().toISOString(),
      };
    }

    if (taskId && current.activeTaskId !== taskId) {
      return current;
    }

    const updated: DurableState = {
      ...current,
      activeTaskId: null,
      updatedAt: new Date().toISOString(),
    };

    return this.save(updated);
  }
}


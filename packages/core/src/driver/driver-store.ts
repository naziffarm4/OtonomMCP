/**
 * Driver Store (Phase 17 TASK-P17-01)
 *
 * Implements persistent and auditable storage for durable Driver state
 * under `.ai-manager/driver/driver-state.json`.
 * Enforces atomic writes and validates schema on read.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Actor } from '../actors.js';
import type { HistoryManager } from '../storage/history-manager.js';
import { atomicWriteJson } from '../storage/atomic-writer.js';
import {
  type DurableDriverState,
  DurableDriverStateZodSchema,
} from './driver-types.js';
import { DriverValidationError } from './driver-errors.js';

export interface DriverStoreOptions {
  readonly workspaceRoot?: string;
  readonly stateFilePath?: string;
  readonly historyManager?: HistoryManager;
}

export class DriverStore {
  readonly workspaceRoot?: string;
  readonly stateFilePath: string;
  readonly historyManager?: HistoryManager;

  constructor(options: DriverStoreOptions = {}) {
    this.workspaceRoot = options.workspaceRoot;
    this.historyManager = options.historyManager;

    if (options.stateFilePath) {
      this.stateFilePath = options.stateFilePath;
    } else {
      const base = options.workspaceRoot ?? process.cwd();
      this.stateFilePath = path.join(base, '.ai-manager', 'driver', 'driver-state.json');
    }
  }

  /**
   * Checks whether a driver state file exists on disk.
   */
  async exists(): Promise<boolean> {
    try {
      await fs.access(this.stateFilePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Loads and validates the durable driver state from disk.
   * Returns null if no state file exists.
   * Fails closed if the state file is corrupt or violates schema.
   */
  async loadState(): Promise<DurableDriverState | null> {
    try {
      const raw = await fs.readFile(this.stateFilePath, 'utf8');
      const parsed = JSON.parse(raw);
      const validation = DurableDriverStateZodSchema.safeParse(parsed);
      if (!validation.success) {
        throw new DriverValidationError(
          `Corrupt or invalid durable driver state schema: ${validation.error.issues[0]?.message ?? 'validation failed'}`,
          { issues: validation.error.issues, stateFilePath: this.stateFilePath }
        );
      }
      return validation.data as DurableDriverState;
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return null;
      }
      if (err instanceof DriverValidationError) {
        throw err;
      }
      throw new DriverValidationError(
        `Failed to read durable driver state from '${this.stateFilePath}': ${err.message}`,
        { error: err, stateFilePath: this.stateFilePath }
      );
    }
  }

  /**
   * Atomically saves the durable driver state to disk.
   */
  async saveState(state: DurableDriverState): Promise<void> {
    const validation = DurableDriverStateZodSchema.safeParse(state);
    if (!validation.success) {
      throw new DriverValidationError(
        `Attempted to save invalid durable driver state: ${validation.error.issues[0]?.message ?? 'validation failed'}`,
        { issues: validation.error.issues }
      );
    }

    await atomicWriteJson(this.stateFilePath, state);
  }

  /**
   * Records an auditable driver lifecycle event in HistoryManager.
   */
  async recordHistoryEvent(
    eventType:
      | 'DRIVER_STARTED'
      | 'DRIVER_ITERATION_STARTED'
      | 'DRIVER_ITERATION_COMPLETED'
      | 'DRIVER_PAUSED'
      | 'DRIVER_RESUMED'
      | 'DRIVER_STOPPED'
      | 'DRIVER_BLOCKED'
      | 'DRIVER_RECOVERING'
      | 'DRIVER_FAILED',
    payload: Record<string, unknown>,
    taskId?: string | null
  ): Promise<void> {
    if (!this.historyManager) {
      return;
    }

    try {
      await this.historyManager.appendEvent({
        eventType,
        actor: Actor.ORCHESTRATOR,
        taskId: taskId ?? null,
        payload,
      });
    } catch {
      // Non-blocking history record failure must not crash engine, but fail-safe
    }
  }

  /**
   * Clears persisted state file (used in tests or fresh resets).
   */
  async clear(): Promise<void> {
    try {
      await fs.unlink(this.stateFilePath);
    } catch {
      // ignore
    }
  }
}

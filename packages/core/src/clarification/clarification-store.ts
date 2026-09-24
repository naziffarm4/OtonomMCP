/**
 * Clarification Session Persistence Store (Phase 8 TASK-P8-04)
 *
 * Implements atomic, schema-validated persistence for clarification sessions
 * under `.ai-manager/clarification/sessions/`.
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. Strictly conforms to AIDM storage conventions (atomic writes, JSON).
 * 2. Does NOT mutate requirements.json or decisions.json.
 * 3. Does NOT create an independent database or second source of truth.
 * 4. Logs append-only audit events via HistoryManager when available.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { atomicWriteJson, readJsonFile } from '../storage/atomic-writer.js';
import type { HistoryManager } from '../storage/history-manager.js';
import { Actor } from '../actors.js';
import {
  ClarificationSessionZodSchema,
  type ClarificationSession,
} from './clarification-types.js';
import { ClarificationSessionError } from './clarification-errors.js';

export interface ClarificationStoreOptions {
  clarificationDir?: string;
  baseDir?: string;
  historyManager?: HistoryManager;
}

export class ClarificationStore {
  readonly clarificationDir: string;
  readonly sessionsDir: string;
  readonly activeSessionPath: string;
  private readonly historyManager?: HistoryManager;

  constructor(options?: ClarificationStoreOptions) {
    if (options?.clarificationDir) {
      this.clarificationDir = options.clarificationDir;
    } else {
      const baseDir = options?.baseDir ?? process.cwd();
      this.clarificationDir = path.join(baseDir, '.ai-manager', 'clarification');
    }
    this.sessionsDir = path.join(this.clarificationDir, 'sessions');
    this.activeSessionPath = path.join(this.clarificationDir, 'active-session.json');
    this.historyManager = options?.historyManager;
  }

  /**
   * Atomically saves a ClarificationSession to disk.
   */
  async saveSession(session: ClarificationSession): Promise<void> {
    const parseResult = ClarificationSessionZodSchema.safeParse(session);
    if (!parseResult.success) {
      throw new ClarificationSessionError(
        `Failed to persist clarification session: validation error: ${parseResult.error.message}`,
        { issues: parseResult.error.issues }
      );
    }

    const sessionFilePath = path.join(this.sessionsDir, `${session.sessionId}.json`);
    await atomicWriteJson(sessionFilePath, session);

    // Update active-session pointer
    await atomicWriteJson(this.activeSessionPath, {
      sessionId: session.sessionId,
      projectId: session.projectId,
      status: session.status,
      updatedAt: session.updatedAt,
    });

    // Optionally log to history stream
    if (this.historyManager) {
      try {
        await this.historyManager.appendEvent({
          eventType: 'CLARIFICATION_SESSION_SAVED',
          actor: Actor.DIRECTOR,
          payload: {
            sessionId: session.sessionId,
            projectId: session.projectId,
            status: session.status,
            blockingOpenCount: session.blockingOpenCount,
            totalCount: session.totalCount,
            resolvedCount: session.resolvedCount,
          },
        });
      } catch {
        // Logging failure should not break session persistence
      }
    }
  }

  /**
   * Loads a ClarificationSession from disk by sessionId.
   */
  async loadSession(sessionId: string): Promise<ClarificationSession | null> {
    const sessionFilePath = path.join(this.sessionsDir, `${sessionId}.json`);
    const raw = await readJsonFile<ClarificationSession>(sessionFilePath);
    if (!raw) {
      return null;
    }

    const parseResult = ClarificationSessionZodSchema.safeParse(raw);
    if (!parseResult.success) {
      throw new ClarificationSessionError(
        `Corrupt or invalid clarification session file at '${sessionFilePath}': ${parseResult.error.message}`,
        { filePath: sessionFilePath, issues: parseResult.error.issues }
      );
    }

    return parseResult.data as unknown as ClarificationSession;
  }

  /**
   * Loads the currently active clarification session, if any.
   */
  async getActiveSession(): Promise<ClarificationSession | null> {
    const pointer = await readJsonFile<{ sessionId?: string }>(this.activeSessionPath);
    if (!pointer?.sessionId) {
      return null;
    }

    return this.loadSession(pointer.sessionId);
  }

  /**
   * Lists all stored session IDs.
   */
  async listSessions(): Promise<string[]> {
    try {
      const files = await fs.promises.readdir(this.sessionsDir);
      return files
        .filter((file) => file.endsWith('.json'))
        .map((file) => path.basename(file, '.json'));
    } catch (err: unknown) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'ENOENT') {
        return [];
      }
      throw err;
    }
  }
}

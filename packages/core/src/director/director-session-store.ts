/**
 * Director Session Persistence Store (Phase 9 TASK-P9-01)
 *
 * Implements atomic, schema-validated persistence for Director sessions
 * under `.ai-manager/director/sessions/`.
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. Conforms strictly to AIDM storage conventions (atomic writes, JSON).
 * 2. Does NOT create a second global state machine or replace DurableStateManager.
 * 3. Does NOT mutate SpecStore (requirements.json, decisions.json) or Task DAG.
 * 4. Logs append-only audit events via authoritative HistoryManager.
 * 5. Strictly protects against path traversal in sessionId.
 * 6. Redacts sensitive credentials/tokens in session metadata.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { atomicWriteJson, readJsonFile } from '../storage/atomic-writer.js';
import type { HistoryManager } from '../storage/history-manager.js';
import { Actor } from '../actors.js';
import { sanitizeMcpPayload } from '../mcp/mcp-errors.js';
import {
  DirectorSessionZodSchema,
  DirectorSessionIdZodSchema,
  type DirectorSession,
} from './director-types.js';
import type { DirectorContextSnapshot } from './director-context-types.js';
import {
  DirectorValidationError,
  DirectorSessionNotFoundError,
} from './director-errors.js';

export interface DirectorSessionStoreOptions {
  readonly directorDir?: string;
  readonly baseDir?: string;
  readonly historyManager?: HistoryManager;
}

export type DirectorAuditEventType =
  | 'DIRECTOR_SESSION_CREATED'
  | 'DIRECTOR_SESSION_RESUMED'
  | 'DIRECTOR_SESSION_SUSPENDED'
  | 'DIRECTOR_SESSION_CLOSED'
  | 'DIRECTOR_SESSION_ACTIVITY_UPDATED'
  | 'DIRECTOR_CONTEXT_SYNCHRONIZED'
  | 'DIRECTOR_CONTEXT_SYNC_FAILED';

export class DirectorSessionStore {
  readonly directorDir: string;
  readonly sessionsDir: string;
  readonly snapshotsDir: string;
  readonly activeSessionPath: string;
  private readonly historyManager?: HistoryManager;

  constructor(options?: DirectorSessionStoreOptions) {
    if (options?.directorDir) {
      this.directorDir = options.directorDir;
    } else {
      const baseDir = options?.baseDir ?? process.cwd();
      this.directorDir = path.join(baseDir, '.ai-manager', 'director');
    }
    this.sessionsDir = path.join(this.directorDir, 'sessions');
    this.snapshotsDir = path.join(this.directorDir, 'snapshots');
    this.activeSessionPath = path.join(this.directorDir, 'active-session.json');
    this.historyManager = options?.historyManager;
  }

  /**
   * Sanitizes and verifies that directorSessionId contains no path traversal sequences.
   */
  sanitizeSessionId(sessionId: string): string {
    if (!sessionId || typeof sessionId !== 'string') {
      throw new DirectorValidationError('directorSessionId cannot be empty.');
    }
    const parseResult = DirectorSessionIdZodSchema.safeParse(sessionId);
    if (!parseResult.success) {
      throw new DirectorValidationError(
        `Invalid directorSessionId '${sessionId}': ${parseResult.error.issues[0]?.message ?? 'format error'}`
      );
    }
    return sessionId;
  }

  /**
   * Atomically saves a DirectorSession to disk.
   */
  async saveSession(
    session: DirectorSession,
    auditEvent?: DirectorAuditEventType
  ): Promise<void> {
    // 1. Sanitize metadata to avoid persisting tokens/credentials
    const cleanMetadata = sanitizeMcpPayload(session.metadata) as Record<string, unknown>;
    const sanitizedSession: DirectorSession = {
      ...session,
      metadata: cleanMetadata,
    };

    // 2. Schema validation
    const parseResult = DirectorSessionZodSchema.safeParse(sanitizedSession);
    if (!parseResult.success) {
      throw new DirectorValidationError(
        `Failed to persist Director session: validation error: ${parseResult.error.message}`,
        { issues: parseResult.error.issues }
      );
    }

    const safeId = this.sanitizeSessionId(sanitizedSession.directorSessionId);

    // 3. Atomically write session file under .ai-manager/director/sessions/<sessionId>.json
    const filePath = path.join(this.sessionsDir, `${safeId}.json`);
    await atomicWriteJson(filePath, sanitizedSession);

    // 4. Update or clear active session pointer
    if (sanitizedSession.status === 'ACTIVE') {
      await atomicWriteJson(this.activeSessionPath, {
        directorSessionId: sanitizedSession.directorSessionId,
        projectId: sanitizedSession.projectId,
        status: sanitizedSession.status,
        lastActivityAt: sanitizedSession.lastActivityAt,
        schemaVersion: sanitizedSession.schemaVersion,
      });
    } else if (sanitizedSession.status === 'CLOSED') {
      try {
        if (fs.existsSync(this.activeSessionPath)) {
          const activePointer = await readJsonFile<{ directorSessionId?: string }>(this.activeSessionPath);
          if (activePointer?.directorSessionId === sanitizedSession.directorSessionId) {
            await atomicWriteJson(this.activeSessionPath, {
              directorSessionId: null,
              projectId: sanitizedSession.projectId,
              status: 'CLOSED',
              lastActivityAt: sanitizedSession.lastActivityAt,
              schemaVersion: sanitizedSession.schemaVersion,
            });
          }
        }
      } catch {
        // Non-fatal if active pointer cannot be cleared
      }
    }

    // 5. Append-only audit logging via HistoryManager
    if (this.historyManager && auditEvent) {
      try {
        await this.historyManager.appendEvent({
          eventType: auditEvent,
          actor: Actor.DIRECTOR,
          payload: {
            directorSessionId: sanitizedSession.directorSessionId,
            projectId: sanitizedSession.projectId,
            projectRoot: sanitizedSession.projectRoot,
            status: sanitizedSession.status,
            protocolVersion: sanitizedSession.protocolVersion,
            schemaVersion: sanitizedSession.schemaVersion,
            lastActivityAt: sanitizedSession.lastActivityAt,
            approvalPackageId: sanitizedSession.approvalPackageId ?? null,
            approvalRevision: sanitizedSession.approvalRevision ?? null,
            understandingRevision: sanitizedSession.understandingRevision ?? null,
          },
        });
      } catch {
        // Audit logging failure must not break core persistence
      }
    }
  }

  /**
   * Loads a DirectorSession from disk by sessionId.
   * Returns null if session file does not exist.
   */
  async loadSession(sessionId: string): Promise<DirectorSession | null> {
    const safeId = this.sanitizeSessionId(sessionId);
    const filePath = path.join(this.sessionsDir, `${safeId}.json`);

    if (!fs.existsSync(filePath)) {
      return null;
    }

    const data = await readJsonFile<unknown>(filePath);
    const parseResult = DirectorSessionZodSchema.safeParse(data);
    if (!parseResult.success) {
      throw new DirectorValidationError(
        `Corrupted Director session file '${safeId}.json': ${parseResult.error.message}`,
        { issues: parseResult.error.issues }
      );
    }

    return parseResult.data as DirectorSession;
  }

  /**
   * Retrieves the currently active Director session, or null if none active.
   */
  async getActiveSession(): Promise<DirectorSession | null> {
    if (!fs.existsSync(this.activeSessionPath)) {
      return null;
    }

    try {
      const activePointer = await readJsonFile<{ directorSessionId?: string }>(this.activeSessionPath);
      if (!activePointer?.directorSessionId) {
        return null;
      }
      return await this.loadSession(activePointer.directorSessionId);
    } catch {
      return null;
    }
  }

  /**
   * Lists all persisted Director sessions.
   */
  async listSessions(): Promise<readonly DirectorSession[]> {
    if (!fs.existsSync(this.sessionsDir)) {
      return [];
    }

    const files = await fs.promises.readdir(this.sessionsDir);
    const sessions: DirectorSession[] = [];

    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const sessionId = file.replace(/\.json$/, '');
      try {
        const session = await this.loadSession(sessionId);
        if (session) {
          sessions.push(session);
        }
      } catch {
        // Skip corrupted files in listing
      }
    }

    // Sort descending by lastActivityAt
    return sessions.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  }

  /**
   * Atomically saves a derived Director context snapshot under .ai-manager/director/snapshots/.
   * Invariant: Persisted snapshot remains derived read-only data, not authoritative project state.
   */
  async saveSnapshot(snapshot: DirectorContextSnapshot): Promise<void> {
    const safeSessionId = this.sanitizeSessionId(snapshot.directorSessionId);
    const sessionSnapshotsDir = path.join(this.snapshotsDir, safeSessionId);

    // Sanitize any metadata in snapshot before writing
    const sanitizedSnapshot = sanitizeMcpPayload(snapshot) as DirectorContextSnapshot;

    // 1. Write immutable snapshot file for this synchronization event: snapshots/<sessionId>/<fingerprint>.json
    const snapshotFilePath = path.join(
      sessionSnapshotsDir,
      `${sanitizedSnapshot.logicalFingerprint}.json`
    );
    await atomicWriteJson(snapshotFilePath, sanitizedSnapshot);

    // 2. Write latest snapshot pointer: snapshots/<sessionId>/latest.json
    const latestFilePath = path.join(sessionSnapshotsDir, 'latest.json');
    await atomicWriteJson(latestFilePath, sanitizedSnapshot);

    // 3. Log audit event via HistoryManager
    if (this.historyManager) {
      try {
        await this.historyManager.appendEvent({
          eventType: 'DIRECTOR_CONTEXT_SYNCHRONIZED',
          actor: Actor.DIRECTOR,
          payload: {
            directorSessionId: sanitizedSnapshot.directorSessionId,
            projectId: sanitizedSnapshot.projectId,
            projectRoot: sanitizedSnapshot.projectRoot,
            syncStatus: sanitizedSnapshot.syncStatus,
            logicalFingerprint: sanitizedSnapshot.logicalFingerprint,
            priorFingerprint: sanitizedSnapshot.priorFingerprint ?? null,
            isComplete: sanitizedSnapshot.isComplete,
            unavailableSections: sanitizedSnapshot.unavailableSections,
            staleSections: sanitizedSnapshot.staleSections,
            synchronizedAt: sanitizedSnapshot.synchronizedAt,
          },
        });
      } catch {
        // Logging failure must not break persistence
      }
    }
  }

  /**
   * Loads the latest context snapshot for a session if persisted, or null.
   */
  async loadLatestSnapshot(sessionId: string): Promise<DirectorContextSnapshot | null> {
    const safeSessionId = this.sanitizeSessionId(sessionId);
    const latestFilePath = path.join(this.snapshotsDir, safeSessionId, 'latest.json');
    if (!fs.existsSync(latestFilePath)) {
      return null;
    }
    return readJsonFile<DirectorContextSnapshot>(latestFilePath);
  }

  /**
   * Loads a specific snapshot by session ID and fingerprint.
   */
  async loadSnapshot(
    sessionId: string,
    fingerprint: string
  ): Promise<DirectorContextSnapshot | null> {
    const safeSessionId = this.sanitizeSessionId(sessionId);
    if (!/^[a-f0-9]{32,64}$/i.test(fingerprint)) {
      throw new DirectorValidationError(`Invalid snapshot fingerprint format: '${fingerprint}'`);
    }
    const filePath = path.join(this.snapshotsDir, safeSessionId, `${fingerprint}.json`);
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return readJsonFile<DirectorContextSnapshot>(filePath);
  }
}

/**
 * Director Decision Persistence Store (Phase 9 TASK-P9-03)
 *
 * Implements atomic, schema-validated persistence for Director decisions
 * under `.ai-manager/director/decisions/`.
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. Conforms strictly to AIDM storage conventions (atomic writes, JSON).
 * 2. Does NOT create a second global state machine or replace DurableStateManager.
 * 3. Does NOT mutate SpecStore (requirements.json, decisions.json) or Task DAG.
 * 4. Logs append-only audit events via authoritative HistoryManager.
 * 5. Strictly protects against path traversal in decisionId and sessionId.
 * 6. Redacts sensitive credentials/tokens in decision metadata.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { atomicWriteJson, readJsonFile } from '../storage/atomic-writer.js';
import type { HistoryManager } from '../storage/history-manager.js';
import { Actor } from '../actors.js';
import { sanitizeMcpPayload } from '../mcp/mcp-errors.js';
import {
  DirectorDecisionZodSchema,
  DirectorDecisionIdZodSchema,
  type DirectorDecision,
  type DirectorDecisionType,
} from './director-decision-types.js';
import {
  DirectorValidationError,
  DirectorDecisionNotFoundError,
} from './director-errors.js';
import {
  DirectorSessionStore,
  type DirectorAuditEventType,
} from './director-session-store.js';

export interface DirectorDecisionStoreOptions {
  readonly directorDir?: string;
  readonly baseDir?: string;
  readonly historyManager?: HistoryManager;
  readonly sessionStore?: DirectorSessionStore;
}

export class DirectorDecisionStore {
  readonly directorDir: string;
  readonly decisionsDir: string;
  readonly sessionStore: DirectorSessionStore;
  readonly historyManager?: HistoryManager;

  constructor(options?: DirectorDecisionStoreOptions) {
    if (options?.sessionStore) {
      this.sessionStore = options.sessionStore;
      this.directorDir = options.sessionStore.directorDir;
      this.decisionsDir = options.sessionStore.decisionsDir;
      this.historyManager = options.historyManager ?? options.sessionStore.historyManager;
    } else {
      const baseDir = options?.baseDir ?? process.cwd();
      this.directorDir = options?.directorDir ?? path.join(baseDir, '.ai-manager', 'director');
      this.decisionsDir = path.join(this.directorDir, 'decisions');
      this.historyManager = options?.historyManager;
      this.sessionStore = new DirectorSessionStore({
        directorDir: this.directorDir,
        historyManager: this.historyManager,
      });
    }
  }

  /**
   * Sanitizes and verifies that decisionId contains no path traversal sequences.
   */
  sanitizeDecisionId(decisionId: string): string {
    if (!decisionId || typeof decisionId !== 'string') {
      throw new DirectorValidationError('decisionId cannot be empty.');
    }
    const parseResult = DirectorDecisionIdZodSchema.safeParse(decisionId);
    if (!parseResult.success) {
      throw new DirectorValidationError(
        `Invalid decisionId '${decisionId}': ${parseResult.error.issues[0]?.message ?? 'format error'}`
      );
    }
    return decisionId;
  }

  /**
   * Atomically saves a DirectorDecision to disk under .ai-manager/director/decisions/<decisionId>.json.
   */
  async saveDecision(
    decision: DirectorDecision,
    auditEvent: DirectorAuditEventType = 'DIRECTOR_DECISION_CREATED'
  ): Promise<void> {
    // 1. Sanitize metadata to avoid persisting tokens/credentials
    const cleanMetadata = sanitizeMcpPayload(decision.metadata) as Record<string, unknown>;
    const sanitizedDecision: DirectorDecision = {
      ...decision,
      metadata: cleanMetadata,
    };

    // 2. Schema validation
    const parseResult = DirectorDecisionZodSchema.safeParse(sanitizedDecision);
    if (!parseResult.success) {
      throw new DirectorValidationError(
        `Failed to persist Director decision: validation error: ${parseResult.error.message}`,
        { issues: parseResult.error.issues }
      );
    }

    const safeId = this.sanitizeDecisionId(sanitizedDecision.decisionId);

    // 3. Atomically write decision file under .ai-manager/director/decisions/<decisionId>.json
    const filePath = path.join(this.decisionsDir, `${safeId}.json`);
    await atomicWriteJson(filePath, sanitizedDecision);

    // 4. Append-only audit logging via HistoryManager
    if (this.historyManager && auditEvent) {
      try {
        await this.historyManager.appendEvent({
          eventType: auditEvent,
          actor: Actor.DIRECTOR,
          payload: {
            decisionId: sanitizedDecision.decisionId,
            directorSessionId: sanitizedDecision.directorSessionId,
            projectId: sanitizedDecision.projectId,
            protocolVersion: sanitizedDecision.protocolVersion,
            schemaVersion: sanitizedDecision.schemaVersion,
            decisionType: sanitizedDecision.decisionType,
            rationale: sanitizedDecision.rationale,
            basedOnContextFingerprint: sanitizedDecision.basedOnContextFingerprint,
            basedOnApprovalRevision: sanitizedDecision.basedOnApprovalRevision ?? null,
            basedOnUnderstandingRevision: sanitizedDecision.basedOnUnderstandingRevision ?? null,
            createdAt: sanitizedDecision.createdAt,
          },
        });
      } catch {
        // Audit logging failure must not break core persistence
      }
    }
  }

  /**
   * Loads a DirectorDecision from disk by decisionId.
   * Returns null if decision file does not exist.
   */
  async loadDecision(decisionId: string): Promise<DirectorDecision | null> {
    const safeId = this.sanitizeDecisionId(decisionId);
    const filePath = path.join(this.decisionsDir, `${safeId}.json`);

    if (!fs.existsSync(filePath)) {
      return null;
    }

    const data = await readJsonFile<unknown>(filePath);
    const parseResult = DirectorDecisionZodSchema.safeParse(data);
    if (!parseResult.success) {
      throw new DirectorValidationError(
        `Corrupted Director decision file '${safeId}.json': ${parseResult.error.message}`,
        { issues: parseResult.error.issues }
      );
    }

    return parseResult.data as DirectorDecision;
  }

  /**
   * Lists all persisted Director decisions, optionally filtered.
   */
  async listDecisions(filter?: {
    readonly sessionId?: string;
    readonly projectId?: string;
    readonly decisionType?: DirectorDecisionType;
    readonly limit?: number;
  }): Promise<readonly DirectorDecision[]> {
    if (!fs.existsSync(this.decisionsDir)) {
      return [];
    }

    const files = await fs.promises.readdir(this.decisionsDir);
    const decisions: DirectorDecision[] = [];

    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const decisionId = file.replace(/\.json$/, '');
      try {
        const decision = await this.loadDecision(decisionId);
        if (!decision) continue;

        if (filter?.sessionId && decision.directorSessionId !== filter.sessionId) {
          continue;
        }
        if (filter?.projectId && decision.projectId !== filter.projectId) {
          continue;
        }
        if (filter?.decisionType && decision.decisionType !== filter.decisionType) {
          continue;
        }

        decisions.push(decision);
      } catch {
        // Skip corrupted files in listing
      }
    }

    // Sort descending by createdAt
    decisions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    if (filter?.limit && filter.limit > 0) {
      return decisions.slice(0, filter.limit);
    }

    return decisions;
  }

  /**
   * Logs a validation failure event into authoritative HistoryManager.
   */
  async recordValidationFailure(details: {
    readonly directorSessionId?: string | null;
    readonly projectId?: string | null;
    readonly decisionId?: string | null;
    readonly decisionType?: string | null;
    readonly basedOnContextFingerprint?: string | null;
    readonly reason: string;
    readonly code: string;
  }): Promise<void> {
    if (this.historyManager) {
      try {
        await this.historyManager.appendEvent({
          eventType: 'DIRECTOR_DECISION_VALIDATION_FAILED',
          actor: Actor.DIRECTOR,
          payload: {
            directorSessionId: details.directorSessionId ?? null,
            projectId: details.projectId ?? null,
            decisionId: details.decisionId ?? null,
            decisionType: details.decisionType ?? null,
            basedOnContextFingerprint: details.basedOnContextFingerprint ?? null,
            reason: details.reason,
            code: details.code,
          },
        });
      } catch {
        // Logging failure must not crash
      }
    }
  }
}

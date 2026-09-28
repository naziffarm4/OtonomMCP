/**
 * Director Loop Persistence Store (Phase 16 TASK-P16-01)
 *
 * Implements persistent and auditable storage for Director instructions and
 * execution cycle results under `.ai-manager/director-loop/`.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Actor } from '../actors.js';
import type { HistoryManager } from '../storage/history-manager.js';
import type {
  DirectorInstruction,
  DirectorExecutionCycleResult,
} from './director-loop-types.js';
import {
  DirectorInstructionDuplicateError,
} from './director-loop-errors.js';

export interface DirectorLoopStoreOptions {
  readonly baseDir?: string;
  readonly historyManager?: HistoryManager;
}

export class DirectorLoopStore {
  readonly baseDir?: string;
  readonly historyManager?: HistoryManager;

  // In-memory fallback / cache
  private readonly memoryInstructions = new Map<string, DirectorInstruction>();
  private readonly memoryCycles = new Map<string, DirectorExecutionCycleResult>();

  constructor(options: DirectorLoopStoreOptions = {}) {
    this.baseDir = options.baseDir;
    this.historyManager = options.historyManager;
  }

  private get instructionsDir(): string | null {
    return this.baseDir
      ? path.join(this.baseDir, '.ai-manager', 'director-loop', 'instructions')
      : null;
  }

  private get cyclesDir(): string | null {
    return this.baseDir
      ? path.join(this.baseDir, '.ai-manager', 'director-loop', 'cycles')
      : null;
  }

  private async ensureDir(dirPath: string): Promise<void> {
    try {
      await fs.mkdir(dirPath, { recursive: true });
    } catch {
      // ignore
    }
  }

  async saveInstruction(instruction: DirectorInstruction): Promise<void> {
    const existing = await this.getInstruction(instruction.instructionId);
    if (existing) {
      // Idempotency check: if identical, return safely
      if (
        existing.projectId === instruction.projectId &&
        existing.directorSessionId === instruction.directorSessionId &&
        existing.directorDecisionId === instruction.directorDecisionId &&
        existing.taskId === instruction.taskId &&
        existing.taskRevision === instruction.taskRevision &&
        existing.contextFingerprint === instruction.contextFingerprint &&
        existing.understandingRevision === instruction.understandingRevision &&
        existing.approvalPackageRevision === instruction.approvalPackageRevision &&
        existing.objective === instruction.objective &&
        JSON.stringify(existing.targetFiles) === JSON.stringify(instruction.targetFiles)
      ) {
        return;
      }
      throw new DirectorInstructionDuplicateError(
        `Conflicting instruction already exists with ID '${instruction.instructionId}'`,
        { instructionId: instruction.instructionId }
      );
    }

    this.memoryInstructions.set(instruction.instructionId, instruction);

    if (this.instructionsDir) {
      await this.ensureDir(this.instructionsDir);
      const filePath = path.join(this.instructionsDir, `${instruction.instructionId}.json`);
      await fs.writeFile(filePath, JSON.stringify(instruction, null, 2), 'utf8');
    }

    if (this.historyManager) {
      try {
        await this.historyManager.appendEvent({
          eventType: 'DIRECTOR_INSTRUCTION_INGESTED',
          actor: Actor.DIRECTOR,
          payload: {
            instructionId: instruction.instructionId,
            projectId: instruction.projectId,
            directorSessionId: instruction.directorSessionId,
            directorDecisionId: instruction.directorDecisionId,
            taskId: instruction.taskId,
            taskRevision: instruction.taskRevision,
            targetFiles: instruction.targetFiles,
          },
        });
      } catch {
        // history append errors should not break persistence
      }
    }
  }

  async getInstruction(instructionId: string): Promise<DirectorInstruction | null> {
    const mem = this.memoryInstructions.get(instructionId);
    if (mem) return mem;

    if (this.instructionsDir) {
      const filePath = path.join(this.instructionsDir, `${instructionId}.json`);
      try {
        const raw = await fs.readFile(filePath, 'utf8');
        const parsed = JSON.parse(raw) as DirectorInstruction;
        this.memoryInstructions.set(instructionId, parsed);
        return parsed;
      } catch {
        return null;
      }
    }

    return null;
  }

  async listInstructions(projectId?: string): Promise<readonly DirectorInstruction[]> {
    const results: DirectorInstruction[] = [];
    const seen = new Set<string>();

    if (this.instructionsDir) {
      try {
        await this.ensureDir(this.instructionsDir);
        const entries = await fs.readdir(this.instructionsDir);
        for (const file of entries) {
          if (!file.endsWith('.json')) continue;
          const id = file.replace('.json', '');
          const item = await this.getInstruction(id);
          if (item && (!projectId || item.projectId === projectId)) {
            if (!seen.has(item.instructionId)) {
              seen.add(item.instructionId);
              results.push(item);
            }
          }
        }
      } catch {
        // ignore read errors
      }
    }

    for (const [id, item] of this.memoryInstructions.entries()) {
      if (!seen.has(id) && (!projectId || item.projectId === projectId)) {
        seen.add(id);
        results.push(item);
      }
    }

    return Object.freeze(results.sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
  }

  async saveCycleResult(result: DirectorExecutionCycleResult): Promise<void> {
    const existing = await this.getCycleResult(result.cycleId);
    if (existing) {
      // Idempotent re-save
      return;
    }

    this.memoryCycles.set(result.cycleId, result);

    if (this.cyclesDir) {
      await this.ensureDir(this.cyclesDir);
      const filePath = path.join(this.cyclesDir, `${result.cycleId}.json`);
      await fs.writeFile(filePath, JSON.stringify(result, null, 2), 'utf8');
    }

    if (this.historyManager) {
      try {
        const eventType =
          result.terminalStatus === 'ACCEPTED'
            ? 'DIRECTOR_CYCLE_COMPLETED'
            : 'DIRECTOR_CYCLE_REJECTED';
        await this.historyManager.appendEvent({
          eventType,
          actor: Actor.ORCHESTRATOR,
          payload: {
            cycleId: result.cycleId,
            instructionId: result.instructionId,
            projectId: result.projectId,
            taskId: result.taskId,
            taskRevision: result.taskRevision,
            verificationDecision: result.verificationDecision,
            terminalStatus: result.terminalStatus,
            evidenceId: result.systemEvidence.evidenceId,
          },
        });
      } catch {
        // ignore
      }
    }
  }

  async getCycleResult(cycleId: string): Promise<DirectorExecutionCycleResult | null> {
    const mem = this.memoryCycles.get(cycleId);
    if (mem) return mem;

    if (this.cyclesDir) {
      const filePath = path.join(this.cyclesDir, `${cycleId}.json`);
      try {
        const raw = await fs.readFile(filePath, 'utf8');
        const parsed = JSON.parse(raw) as DirectorExecutionCycleResult;
        this.memoryCycles.set(cycleId, parsed);
        return parsed;
      } catch {
        return null;
      }
    }

    return null;
  }

  async getCycleResultByInstructionId(
    instructionId: string
  ): Promise<DirectorExecutionCycleResult | null> {
    const all = await this.listCycleResults();
    const matches = all.filter((c) => c.instructionId === instructionId);
    if (matches.length === 0) return null;
    return matches[matches.length - 1] ?? null;
  }

  async getLatestCycleResultForTask(
    projectId: string,
    taskId: string
  ): Promise<DirectorExecutionCycleResult | null> {
    const all = await this.listCycleResults(projectId);
    const matches = all.filter((c) => c.taskId === taskId);
    if (matches.length === 0) return null;
    // Sort descending by completion time or revision
    matches.sort((a, b) => b.completedAt.localeCompare(a.completedAt));
    return matches[0] ?? null;
  }

  async listCycleResults(projectId?: string): Promise<readonly DirectorExecutionCycleResult[]> {
    const results: DirectorExecutionCycleResult[] = [];
    const seen = new Set<string>();

    if (this.cyclesDir) {
      try {
        await this.ensureDir(this.cyclesDir);
        const entries = await fs.readdir(this.cyclesDir);
        for (const file of entries) {
          if (!file.endsWith('.json')) continue;
          const id = file.replace('.json', '');
          const item = await this.getCycleResult(id);
          if (item && (!projectId || item.projectId === projectId)) {
            if (!seen.has(item.cycleId)) {
              seen.add(item.cycleId);
              results.push(item);
            }
          }
        }
      } catch {
        // ignore
      }
    }

    for (const [id, item] of this.memoryCycles.entries()) {
      if (!seen.has(id) && (!projectId || item.projectId === projectId)) {
        seen.add(id);
        results.push(item);
      }
    }

    return Object.freeze(results.sort((a, b) => a.completedAt.localeCompare(b.completedAt)));
  }
}

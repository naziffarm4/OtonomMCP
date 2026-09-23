import * as path from 'node:path';
import * as fs from 'node:fs';
import { type GitCheckpoint } from '../git/git-types.js';
import { atomicWriteJson, readJsonFile } from '../storage/atomic-writer.js';

export interface PersistentCheckpointRecord {
  readonly checkpoint_id: string;
  readonly task_id: string | null;
  readonly commit_sha: string;
  readonly branch: string;
  readonly purpose: string;
  readonly created_at: string;
  readonly is_known_good: boolean;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export class CheckpointStore {
  readonly filePath: string;

  constructor(projectRoot: string) {
    this.filePath = path.join(projectRoot, '.ai-manager', 'state', 'checkpoints.json');
  }

  async exists(): Promise<boolean> {
    try {
      await fs.promises.access(this.filePath, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  async loadCheckpoints(): Promise<PersistentCheckpointRecord[]> {
    if (!(await this.exists())) {
      return [];
    }
    try {
      const records = await readJsonFile<PersistentCheckpointRecord[]>(this.filePath);
      return Array.isArray(records) ? records : [];
    } catch {
      return [];
    }
  }

  async recordCheckpoint(checkpoint: GitCheckpoint | PersistentCheckpointRecord): Promise<void> {
    const list = await this.loadCheckpoints();
    const id = checkpoint.checkpoint_id;
    const existingIndex = list.findIndex((c) => c.checkpoint_id === id);

    const record: PersistentCheckpointRecord = {
      checkpoint_id: checkpoint.checkpoint_id,
      task_id: checkpoint.task_id,
      commit_sha: checkpoint.commit_sha,
      branch: checkpoint.branch ?? 'unknown',
      purpose: String(checkpoint.purpose),
      created_at: checkpoint.created_at ?? new Date().toISOString(),
      is_known_good: (checkpoint as any).is_known_good ?? true,
      metadata: checkpoint.metadata,
    };

    if (existingIndex >= 0) {
      list[existingIndex] = record;
    } else {
      list.push(record);
    }

    await atomicWriteJson(this.filePath, list);
  }
}

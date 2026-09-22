import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { z } from 'zod';
import { Actor, ACTORS } from '../actors.js';
import { HistoryCorruptError } from '../errors/history-corrupt-error.js';
import { StorageError } from '../errors/storage-error.js';

export const HistoryEventZodSchema = z.object({
  eventId: z.string({ message: 'eventId is required' }).min(1, 'eventId cannot be empty'),
  timestamp: z.string({ message: 'timestamp is required' }).min(1, 'timestamp cannot be empty'),
  eventType: z.string({ message: 'eventType is required' }).min(1, 'eventType cannot be empty'),
  actor: z.enum(ACTORS as [string, ...string[]], {
    message: `actor must be one of: ${ACTORS.join(', ')}`,
  }),
  taskId: z.string().nullable().optional().default(null),
  payload: z.record(z.string(), z.unknown()).default({}),
});

export interface HistoryEvent {
  eventId: string;
  timestamp: string;
  eventType: string;
  actor: Actor;
  taskId?: string | null;
  payload: Record<string, unknown>;
}

export type HistoryEventInput = {
  eventId?: string;
  timestamp?: string;
  eventType: string;
  actor: Actor;
  taskId?: string | null;
  payload?: Record<string, unknown>;
};

export interface HistoryManagerOptions {
  historyPath?: string;
  baseDir?: string;
}

/**
 * Append-only History Manager for NDJSON event stream (.ai-manager/history/events.jsonl).
 * Enforces strict append-only semantics: records cannot be modified or deleted.
 * Reads and streams validate all records; corrupt or malformed records fail deterministically.
 */
export class HistoryManager {
  readonly historyPath: string;

  constructor(options?: HistoryManagerOptions) {
    if (options?.historyPath) {
      this.historyPath = options.historyPath;
    } else {
      const baseDir = options?.baseDir ?? process.cwd();
      this.historyPath = path.join(baseDir, '.ai-manager', 'history', 'events.jsonl');
    }
  }

  /**
   * Append a validated event record to the append-only history stream.
   */
  async appendEvent(input: HistoryEventInput): Promise<HistoryEvent> {
    const rawRecord = {
      eventId: input.eventId ?? crypto.randomUUID(),
      timestamp: input.timestamp ?? new Date().toISOString(),
      eventType: input.eventType,
      actor: input.actor,
      taskId: input.taskId ?? null,
      payload: input.payload ?? {},
    };

    const parseResult = HistoryEventZodSchema.safeParse(rawRecord);
    if (!parseResult.success) {
      throw new StorageError(
        `Failed to append history event: invalid event schema: ${parseResult.error.message}`,
        {
          filePath: this.historyPath,
          operation: 'appendEvent',
        }
      );
    }

    const event = parseResult.data as HistoryEvent;
    const dir = path.dirname(this.historyPath);

    try {
      await fs.promises.mkdir(dir, { recursive: true });
    } catch (err) {
      throw new StorageError(`Failed to create directory '${dir}' for history log`, {
        filePath: dir,
        operation: 'mkdir',
        cause: err,
      });
    }

    const line = JSON.stringify(event) + '\n';
    let handle: fs.promises.FileHandle | null = null;
    try {
      handle = await fs.promises.open(this.historyPath, 'a');
      await handle.appendFile(line, 'utf8');
      await handle.sync();
    } catch (err) {
      throw new StorageError(`Failed to append event to history file '${this.historyPath}'`, {
        filePath: this.historyPath,
        operation: 'appendFile',
        cause: err,
      });
    } finally {
      if (handle) {
        await handle.close().catch(() => {});
      }
    }

    return event;
  }

  /**
   * Reads all events from the append-only history log.
   * If any line contains invalid JSON or violates the schema, fails deterministically
   * by throwing a HistoryCorruptError with exact line details.
   */
  async readEvents(): Promise<HistoryEvent[]> {
    let content: string;
    try {
      content = await fs.promises.readFile(this.historyPath, 'utf8');
    } catch (err: unknown) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'ENOENT') {
        return [];
      }
      throw new StorageError(`Failed to read history file '${this.historyPath}'`, {
        filePath: this.historyPath,
        operation: 'readFile',
        cause: err,
      });
    }

    const lines = content.split(/\r?\n/);
    const events: HistoryEvent[] = [];

    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      const lineNumber = index + 1;

      // Allow empty line at the very end of file (standard trailing newline)
      if (index === lines.length - 1 && line.trim() === '') {
        continue;
      }

      if (line.trim() === '') {
        throw new HistoryCorruptError(
          `Unexpected blank line at line ${lineNumber} in history file '${this.historyPath}'`,
          {
            lineNumber,
            rawLine: line,
            filePath: this.historyPath,
          }
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (err: unknown) {
        const syntaxErr = err as Error;
        throw new HistoryCorruptError(
          `Malformed JSON at line ${lineNumber} in history file '${this.historyPath}': ${syntaxErr.message}`,
          {
            lineNumber,
            rawLine: line,
            filePath: this.historyPath,
          }
        );
      }

      const parseResult = HistoryEventZodSchema.safeParse(parsed);
      if (!parseResult.success) {
        throw new HistoryCorruptError(
          `Invalid event schema at line ${lineNumber} in history file '${this.historyPath}': ${parseResult.error.message}`,
          {
            lineNumber,
            rawLine: line,
            filePath: this.historyPath,
          }
        );
      }

      events.push(parseResult.data as HistoryEvent);
    }

    return events;
  }

  /**
   * Async generator streaming events from history log one by one.
   */
  async *streamEvents(): AsyncGenerator<HistoryEvent, void, unknown> {
    const events = await this.readEvents();
    for (const event of events) {
      yield event;
    }
  }

  /**
   * Check if the history file exists.
   */
  async exists(): Promise<boolean> {
    try {
      await fs.promises.access(this.historyPath, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }
}

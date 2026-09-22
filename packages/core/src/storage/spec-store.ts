import * as path from 'node:path';
import * as fs from 'node:fs';
import { z } from 'zod';
import { Actor, ACTORS } from '../actors.js';
import { StateValidationError } from '../errors/state-validation-error.js';
import { atomicWriteJson, readJsonFile } from './atomic-writer.js';

export const RequirementStatus = {
  DRAFT: 'DRAFT',
  LOCKED: 'LOCKED',
  SUPERSEDED: 'SUPERSEDED',
} as const;

export type RequirementStatus = (typeof RequirementStatus)[keyof typeof RequirementStatus];

export const RequirementZodSchema = z.object({
  id: z.string({ message: 'id is required' }).min(1, 'id cannot be empty'),
  title: z.string({ message: 'title is required' }).min(1, 'title cannot be empty'),
  description: z.string({ message: 'description is required' }).min(1, 'description cannot be empty'),
  authority: z.enum(ACTORS as [string, ...string[]]).default(Actor.USER),
  status: z.enum(['DRAFT', 'LOCKED', 'SUPERSEDED']).default('LOCKED'),
  createdAt: z.string().min(1, 'createdAt cannot be empty'),
  updatedAt: z.string().min(1, 'updatedAt cannot be empty'),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type Requirement = z.infer<typeof RequirementZodSchema>;

export type RequirementInput = Omit<Requirement, 'authority' | 'status' | 'createdAt' | 'updatedAt'> & {
  authority?: Actor;
  status?: RequirementStatus;
  createdAt?: string;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
};

export const DecisionStatus = {
  PROPOSED: 'PROPOSED',
  LOCKED: 'LOCKED',
  REJECTED: 'REJECTED',
} as const;

export type DecisionStatus = (typeof DecisionStatus)[keyof typeof DecisionStatus];

export const DecisionZodSchema = z.object({
  id: z.string({ message: 'id is required' }).min(1, 'id cannot be empty'),
  title: z.string({ message: 'title is required' }).min(1, 'title cannot be empty'),
  description: z.string({ message: 'description is required' }).min(1, 'description cannot be empty'),
  authority: z.enum(ACTORS as [string, ...string[]]).default(Actor.DIRECTOR),
  status: z.enum(['PROPOSED', 'LOCKED', 'REJECTED']).default('LOCKED'),
  rationale: z.string().optional(),
  createdAt: z.string().min(1, 'createdAt cannot be empty'),
  updatedAt: z.string().min(1, 'updatedAt cannot be empty'),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type Decision = z.infer<typeof DecisionZodSchema>;

export type DecisionInput = Omit<Decision, 'authority' | 'status' | 'createdAt' | 'updatedAt'> & {
  authority?: Actor;
  status?: DecisionStatus;
  rationale?: string;
  createdAt?: string;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
};

export interface SpecStoreOptions {
  specDir?: string;
  baseDir?: string;
}

/**
 * Storage manager for project-local specification artifacts (.ai-manager/spec/).
 * Manages requirements.json (DEC-001/LOCKED) and decisions.json (DEC-xxx/LOCKED).
 */
export class SpecStore {
  readonly specDir: string;
  readonly requirementsPath: string;
  readonly decisionsPath: string;

  constructor(options?: SpecStoreOptions) {
    if (options?.specDir) {
      this.specDir = options.specDir;
    } else {
      const baseDir = options?.baseDir ?? process.cwd();
      this.specDir = path.join(baseDir, '.ai-manager', 'spec');
    }
    this.requirementsPath = path.join(this.specDir, 'requirements.json');
    this.decisionsPath = path.join(this.specDir, 'decisions.json');
  }

  async saveRequirements(inputs: RequirementInput[]): Promise<Requirement[]> {
    const now = new Date().toISOString();
    const validated: Requirement[] = [];

    for (const input of inputs) {
      const record = {
        id: input.id,
        title: input.title,
        description: input.description,
        authority: input.authority ?? Actor.USER,
        status: input.status ?? RequirementStatus.LOCKED,
        createdAt: input.createdAt ?? now,
        updatedAt: input.updatedAt ?? now,
        metadata: input.metadata,
      };

      const parseResult = RequirementZodSchema.safeParse(record);
      if (!parseResult.success) {
        throw new StateValidationError(
          `Invalid requirement schema for '${input.id}': ${parseResult.error.message}`,
          {
            filePath: this.requirementsPath,
            validationErrors: parseResult.error.issues,
          }
        );
      }
      validated.push(parseResult.data as Requirement);
    }

    await atomicWriteJson(this.requirementsPath, validated);
    return validated;
  }

  async loadRequirements(): Promise<Requirement[]> {
    const raw = await readJsonFile<unknown>(this.requirementsPath);
    if (raw === null) {
      return [];
    }

    if (!Array.isArray(raw)) {
      throw new StateValidationError(`requirements.json must contain a JSON array`, {
        filePath: this.requirementsPath,
      });
    }

    const validated: Requirement[] = [];
    for (const item of raw) {
      const parseResult = RequirementZodSchema.safeParse(item);
      if (!parseResult.success) {
        throw new StateValidationError(
          `Failed to validate requirement in '${this.requirementsPath}': ${parseResult.error.message}`,
          {
            filePath: this.requirementsPath,
            validationErrors: parseResult.error.issues,
          }
        );
      }
      validated.push(parseResult.data as Requirement);
    }

    return validated;
  }

  async saveDecisions(inputs: DecisionInput[]): Promise<Decision[]> {
    const now = new Date().toISOString();
    const validated: Decision[] = [];

    for (const input of inputs) {
      const record = {
        id: input.id,
        title: input.title,
        description: input.description,
        authority: input.authority ?? Actor.DIRECTOR,
        status: input.status ?? DecisionStatus.LOCKED,
        rationale: input.rationale,
        createdAt: input.createdAt ?? now,
        updatedAt: input.updatedAt ?? now,
        metadata: input.metadata,
      };

      const parseResult = DecisionZodSchema.safeParse(record);
      if (!parseResult.success) {
        throw new StateValidationError(
          `Invalid decision schema for '${input.id}': ${parseResult.error.message}`,
          {
            filePath: this.decisionsPath,
            validationErrors: parseResult.error.issues,
          }
        );
      }
      validated.push(parseResult.data as Decision);
    }

    await atomicWriteJson(this.decisionsPath, validated);
    return validated;
  }

  async loadDecisions(): Promise<Decision[]> {
    const raw = await readJsonFile<unknown>(this.decisionsPath);
    if (raw === null) {
      return [];
    }

    if (!Array.isArray(raw)) {
      throw new StateValidationError(`decisions.json must contain a JSON array`, {
        filePath: this.decisionsPath,
      });
    }

    const validated: Decision[] = [];
    for (const item of raw) {
      const parseResult = DecisionZodSchema.safeParse(item);
      if (!parseResult.success) {
        throw new StateValidationError(
          `Failed to validate decision in '${this.decisionsPath}': ${parseResult.error.message}`,
          {
            filePath: this.decisionsPath,
            validationErrors: parseResult.error.issues,
          }
        );
      }
      validated.push(parseResult.data as Decision);
    }

    return validated;
  }
}

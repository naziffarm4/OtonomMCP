import * as path from 'node:path';
import * as fs from 'node:fs';
import { ProjectMandate, ProjectMandateZodSchema } from './authorization-policy-types.js';
import { readJsonFile, atomicWriteJson } from '../storage/atomic-writer.js';
import { StorageError } from '../errors/storage-error.js';

export class ProjectMandateStore {
  readonly filePath: string;

  constructor(options?: { baseDir?: string; filePath?: string }) {
    if (options?.filePath) {
      this.filePath = options.filePath;
    } else {
      const baseDir = options?.baseDir ?? process.cwd();
      this.filePath = path.join(baseDir, '.ai-manager', 'state', 'project-mandate.json');
    }
  }

  async exists(): Promise<boolean> {
    try {
      await fs.promises.access(this.filePath, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  async loadMandate(): Promise<ProjectMandate | null> {
    try {
      const data = await readJsonFile<unknown>(this.filePath);
      if (!data) return null;
      return ProjectMandateZodSchema.parse(data);
    } catch {
      return null;
    }
  }

  async saveMandate(mandate: ProjectMandate, authContext: any): Promise<ProjectMandate> {
    // SECURITY: Mandate'in kim tarafından oluşturulduğu ve değiştirildiği güvenilir kimlik doğrulaması gerektirir.
    // P22 Trusted IDE Authentication henüz tamamlanmadığı için istemciden gelen
    // PRODUCT_OWNER, USER, verified: true veya benzeri alanları güvenilir kimlik kabul etme.
    // Gerçek güvenilir kimlik yoksa mandate oluşturma veya değiştirme işlemini güvenli şekilde beklet.

    const isTrusted = authContext?.verified === true && authContext?.authSource === 'TRUSTED_IDE';

    if (!isTrusted) {
      throw new Error('WAITING_FOR_TRUSTED_IDENTITY: Trusted IDE Authentication is missing. Cannot update mandate.');
    }

    await atomicWriteJson(this.filePath, mandate);
    return mandate;
  }
}

import * as path from 'node:path';
import * as fs from 'node:fs';
import { ProjectMandate, ProjectMandateZodSchema } from './authorization-policy-types.js';
import { readJsonFile, atomicWriteJson } from '../storage/atomic-writer.js';
import { StorageError } from '../errors/storage-error.js';

export class ProjectMandateStore {
  readonly filePath: string;
  readonly baseDir: string;

  constructor(options?: { baseDir?: string; filePath?: string }) {
    if (options?.filePath) {
      this.filePath = options.filePath;
      this.baseDir = path.dirname(path.dirname(path.dirname(options.filePath)));
    } else {
      this.baseDir = options?.baseDir ?? process.cwd();
      this.filePath = path.join(this.baseDir, '.ai-manager', 'state', 'project-mandate.json');
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
    // P22 Trusted IDE Authentication kapsamında gerçek bir IDE entegrasyonu (OS düzeyinde onay penceresi)
    // olmadığı için yalnızca Ed25519 kriptografi ile tam güven sağlanamaz.
    // Ancak sistem Fail-Closed tasarımda kalmalı ve geçersiz imzaları reddetmeli.
    
    // Geçici import (diğer bağımlılıklar kirlenmesin diye, gerçek yapıda IoC ile enjekte edilir)
    const { IdentityManager } = await import('./identity-manager.js');
    const { NonceStore } = await import('./nonce-store.js');
    const { AuthContextValidator } = await import('./auth-context-validator.js');
    
    const validator = new AuthContextValidator(new IdentityManager({ baseDir: this.baseDir }), new NonceStore({ baseDir: this.baseDir }));
    const result = await validator.validate(authContext, mandate.projectId);

    if (!result.isValid) {
      throw new Error(`WAITING_FOR_TRUSTED_IDENTITY: Cryptographic validation failed: ${result.reason}`);
    }

    if (!result.isTrueHumanInteraction) {
      throw new Error('WAITING_FOR_TRUSTED_IDENTITY: Trusted IDE Authentication is missing. Cannot update mandate.');
    }

    await atomicWriteJson(this.filePath, mandate);
    return mandate;
  }
}

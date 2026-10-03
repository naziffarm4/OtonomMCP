import * as path from 'node:path';
import * as fs from 'node:fs';
import { atomicWriteJson, readJsonFile } from '../storage/atomic-writer.js';

export class NonceStore {
  readonly filePath: string;

  constructor(options?: { baseDir?: string; filePath?: string }) {
    if (options?.filePath) {
      this.filePath = options.filePath;
    } else {
      const baseDir = options?.baseDir ?? process.cwd();
      this.filePath = path.join(baseDir, '.ai-manager', 'state', 'seen-nonces.json');
    }
  }

  async markNonceSeen(nonce: string): Promise<boolean> {
    let nonces: string[] = [];
    try {
      const data = await readJsonFile<string[]>(this.filePath);
      if (Array.isArray(data)) {
        nonces = data;
      }
    } catch {
      // file might not exist
    }

    if (nonces.includes(nonce)) {
      return false;
    }

    nonces.push(nonce);
    
    // Keep only last 1000 nonces to prevent unbounded growth
    if (nonces.length > 1000) {
      nonces = nonces.slice(-1000);
    }

    await atomicWriteJson(this.filePath, nonces);
    return true;
  }

  async isNonceSeen(nonce: string): Promise<boolean> {
    try {
      const data = await readJsonFile<string[]>(this.filePath);
      if (Array.isArray(data)) {
        return data.includes(nonce);
      }
    } catch {
      // file might not exist
    }
    return false;
  }
}

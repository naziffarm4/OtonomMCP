import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface TrustedIdentity {
  identityId: string;
  publicKeyFingerprint: string;
}

export class IdentityManager {
  private readonly storagePath: string;

  constructor(options?: { baseDir?: string }) {
    const baseDir = options?.baseDir ?? process.cwd();
    this.storagePath = path.join(baseDir, '.ai-manager', 'state', 'identity.json');
  }

  private async protectData(data: string): Promise<string> {
    if (process.platform !== 'win32') {
      throw new Error('DPAPI is only supported on Windows. No secure alternative configured for this OS.');
    }
    
    const scriptContent = `
      Add-Type -AssemblyName System.Security
      $bytes = [Text.Encoding]::UTF8.GetBytes('${data.replace(/'/g, "''")}')
      $encrypted = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
      [Convert]::ToBase64String($encrypted)
    `;
    const tmpFile = path.join(process.cwd(), `.mcp-protect-${crypto.randomUUID()}.ps1`);
    await fs.writeFile(tmpFile, scriptContent, 'utf8');
    
    try {
      const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmpFile]);
      return stdout.trim();
    } finally {
      await fs.unlink(tmpFile).catch(() => {});
    }
  }

  private async unprotectData(base64Data: string): Promise<string> {
    if (process.platform !== 'win32') {
      throw new Error('DPAPI is only supported on Windows.');
    }
    
    const scriptContent = `
      Add-Type -AssemblyName System.Security
      $bytes = [Convert]::FromBase64String('${base64Data}')
      $decrypted = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
      [Text.Encoding]::UTF8.GetString($decrypted)
    `;
    const tmpFile = path.join(process.cwd(), `.mcp-unprotect-${crypto.randomUUID()}.ps1`);
    await fs.writeFile(tmpFile, scriptContent, 'utf8');
    
    try {
      const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmpFile]);
      return stdout.trim();
    } finally {
      await fs.unlink(tmpFile).catch(() => {});
    }
  }

  async getOrCreateIdentity(): Promise<{ publicKey: crypto.KeyObject, privateKey: crypto.KeyObject, identityId: string }> {
    try {
      const existing = await fs.readFile(this.storagePath, 'utf8');
      const data = JSON.parse(existing);
      
      if (data.revokedAt) {
          throw new Error('Identity has been revoked.');
      }

      if (data.encryptedPrivateKeyPem && data.publicKeyPem) {
        const privateKeyPem = await this.unprotectData(data.encryptedPrivateKeyPem);
        const privateKey = crypto.createPrivateKey({ key: privateKeyPem, format: 'pem', type: 'pkcs8' });
        const publicKey = crypto.createPublicKey({ key: data.publicKeyPem, format: 'pem', type: 'spki' });
        return { publicKey, privateKey, identityId: data.identityId };
      }
    } catch (err: any) {
      if (err.code !== 'ENOENT' && !err.message.includes('revoked')) {
        // Fail-closed when keys are broken or inaccessible
        throw new Error(`Failed to load or decrypt existing identity: ${err.message}. Fail-closed.`);
      } else if (err.message.includes('revoked')) {
        throw err;
      }
    }

    // Generate new Ed25519 pair
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
    
    const encryptedPrivateKeyPem = await this.protectData(privateKeyPem);
    const identityId = `id-${crypto.randomUUID()}`;

    await fs.mkdir(path.dirname(this.storagePath), { recursive: true });
    await fs.writeFile(this.storagePath, JSON.stringify({
      identityId,
      publicKeyPem,
      encryptedPrivateKeyPem,
      createdAt: new Date().toISOString()
    }, null, 2), 'utf8');

    return { publicKey, privateKey, identityId };
  }

  async revokeIdentity(): Promise<void> {
      try {
        const existing = await fs.readFile(this.storagePath, 'utf8');
        const data = JSON.parse(existing);
        data.revokedAt = new Date().toISOString();
        data.encryptedPrivateKeyPem = null; // delete key
        await fs.writeFile(this.storagePath, JSON.stringify(data, null, 2), 'utf8');
      } catch (err: any) {
        if (err.code !== 'ENOENT') {
            throw err;
        }
      }
  }

  async signPayload(payload: Record<string, unknown>, privateKey: crypto.KeyObject): Promise<string> {
    const payloadStr = JSON.stringify(payload, Object.keys(payload).sort());
    const signature = crypto.sign(null, Buffer.from(payloadStr, 'utf8'), privateKey);
    return signature.toString('base64');
  }

  verifySignature(payload: Record<string, unknown>, signatureBase64: string, publicKey: crypto.KeyObject): boolean {
    try {
      const payloadStr = JSON.stringify(payload, Object.keys(payload).sort());
      return crypto.verify(null, Buffer.from(payloadStr, 'utf8'), publicKey, Buffer.from(signatureBase64, 'base64'));
    } catch {
      return false; // Signature format might be invalid
    }
  }

  getPublicKeyFingerprint(publicKey: crypto.KeyObject): string {
      const der = publicKey.export({ type: 'spki', format: 'der' });
      return crypto.createHash('sha256').update(der).digest('hex');
  }
}

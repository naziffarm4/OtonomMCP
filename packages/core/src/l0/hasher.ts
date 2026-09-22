import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { L0IndexError } from '../errors/l0-index-error.js';

/**
 * Computes the SHA-256 hash of a file on disk using streaming.
 * Returns a 64-character lowercase hexadecimal string.
 */
export async function computeFileSha256(filePath: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let stream: fs.ReadStream;
    try {
      stream = fs.createReadStream(filePath);
    } catch (err) {
      return reject(
        new L0IndexError(`Failed to open stream for file '${filePath}'`, {
          operation: 'computeFileSha256',
          path: filePath,
          cause: err,
        })
      );
    }

    const hash = crypto.createHash('sha256');

    stream.on('data', (chunk) => {
      hash.update(chunk);
    });

    stream.on('end', () => {
      resolve(hash.digest('hex'));
    });

    stream.on('error', (err) => {
      reject(
        new L0IndexError(`Failed while reading file stream for hashing '${filePath}'`, {
          operation: 'computeFileSha256',
          path: filePath,
          cause: err,
        })
      );
    });
  });
}

/**
 * Computes the SHA-256 hash of a string or Buffer in memory.
 * Returns a 64-character lowercase hexadecimal string.
 */
export function computeContentSha256(content: string | Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { executeCli } from './cli-app.js';

export async function runCli(args: string[] = process.argv.slice(2)): Promise<number> {
  const result = await executeCli(args);
  return result.exitCode;
}

const currentFile = fileURLToPath(import.meta.url);
const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedFile && currentFile === invokedFile) {
  runCli().then((code) => {
    process.exit(code);
  }).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

/**
 * Short-lived "MCP server" stand-in: calls aidm_autonomous_start (detached worker mode), prints the
 * JSON result on one line, then stays alive until killed by the test (simulates Antigravity exiting).
 * argv: <projectRoot> <specFile> ; env carries the fake IdP config + worker test-double switches.
 */
import { createAutonomousStartHandler } from '../../dist/mcp/index.js';
import { MockDirectorLlm } from './autonomous-test-doubles.ts';

const [root, spec] = process.argv.slice(2);
const start = createAutonomousStartHandler({
  // Only satisfies the parent's provider preflight; the worker loads its own doubles.
  llmProvider: new MockDirectorLlm(),
  allowMockProvider: true,
  detachedWorker: true,
  workerExecArgv: ['--experimental-strip-types', '--no-warnings'],
  env: process.env,
} as never);
const r = await start({ specPath: spec, workspaceRoot: root, budgetUsd: 1 }, {} as never);
process.stdout.write(`RESULT ${(r.content[0] as { text: string }).text.replace(/\s*\n\s*/g, ' ')}\n`);
setInterval(() => undefined, 60_000);

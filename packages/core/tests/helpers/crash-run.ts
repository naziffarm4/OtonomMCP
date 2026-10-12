/**
 * Child process for resume tests: `aidm run --spec proje.md` (operator approval, mock LLM + mock AGY)
 * that hard-kills ITSELF while the executor works on the second task (files already written,
 * nothing committed) — a realistic "process killed / PC rebooted" interruption.
 * argv: <projectRoot>
 */
import { executeCli } from '../../dist/cli/index.js';
import { createWorkerDoubles } from './worker-doubles.ts';

const root = process.argv[2];
const d = createWorkerDoubles(root);
const seen: string[] = [];
d.executorPort.onExecute = (req: { taskId: string }) => {
  if (!seen.includes(req.taskId)) seen.push(req.taskId);
  if (seen.length >= 2) process.kill(process.pid, 'SIGKILL');
};
await executeCli(['run', '--spec', 'proje.md', '-C', root, '--budget-usd', '1', '--json'], {
  cwd: root,
  env: {},
  stdout: () => undefined,
  stderr: () => undefined,
  executorPort: d.executorPort,
  autonomous: { llmProvider: d.llmProvider, allowMockProvider: true, identityManager: d.identityManager, registerBudgetTerms: d.registerBudgetTerms },
} as never);
process.stdout.write('NOT_CRASHED\n');

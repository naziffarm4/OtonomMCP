/** IDE pull-mode tools: the agent open in Antigravity takes tasks from the Director and submits them. */
import * as path from 'node:path';
import type { McpServer } from '../mcp-server.js';
import type { McpToolDefinition, McpToolHandler, McpToolResult, McpRequestContext } from '../mcp-types.js';
import { ideAwaitVerdict, ideNextTask, ideSubmit } from '../../executor-bridge/ide-executor.js';

const root = { type: 'string', description: 'Absolute path of the project workspace (the folder with .ai-manager).' };
function textResult(payload: unknown, isError = false): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], ...(isError ? { isError: true } : {}) };
}
function rootOf(args: Readonly<Record<string, unknown>>, context: McpRequestContext): string {
  return path.resolve(
    (typeof args.workspaceRoot === 'string' && args.workspaceRoot) ||
      (context.delegate as { projectRoot?: string } | undefined)?.projectRoot ||
      process.cwd()
  );
}
const waitMs = () => Number(process.env.AIDM_IDE_SUBMIT_WAIT_MS) > 0 ? Number(process.env.AIDM_IDE_SUBMIT_WAIT_MS) : 45_000;

export const ideNextTaskToolDefinition: McpToolDefinition = Object.freeze({
  name: 'aidm.next_task',
  description: "IDE mode: get the Director's next task (instruction, criteria, allowed files, design brief; Turkish). Do the work in this IDE, then call aidm_submit_task.",
  inputSchema: { type: 'object' as const, properties: { workspaceRoot: root } },
});
export const ideSubmitTaskToolDefinition: McpToolDefinition = Object.freeze({
  name: 'aidm.submit_task',
  description: 'IDE mode: report the task as done. Waits for the Director\'s independent verification and returns ACCEPTED (+next task), REPAIR (+feedback), WAIT (IdP decision), DONE, or PENDING (then poll aidm_task_result).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      workspaceRoot: root,
      seq: { type: 'number', description: 'seq of the task from aidm_next_task' },
      summary: { type: 'string', description: 'What you did (short, Turkish).' },
      changedFiles: { type: 'array', items: { type: 'string' } },
    },
    required: ['seq', 'summary'],
  },
});
export const ideTaskResultToolDefinition: McpToolDefinition = Object.freeze({
  name: 'aidm.task_result',
  description: 'IDE mode: poll the verdict for a submitted task (same answers as aidm_submit_task).',
  inputSchema: { type: 'object' as const, properties: { workspaceRoot: root, seq: { type: 'number' } }, required: ['seq'] },
});

export function createIdeNextTaskHandler(): McpToolHandler {
  return async (args, context) => {
    const r = ideNextTask(rootOf(args, context));
    return textResult(r.state === 'TASK' ? { state: 'TASK', seq: r.task.seq, taskId: r.task.taskId, instruction: r.text } : { state: 'NONE', message: r.text });
  };
}
export function createIdeSubmitTaskHandler(): McpToolHandler {
  return async (args, context) => {
    const dir = rootOf(args, context);
    const seq = Number(args.seq);
    const files = Array.isArray(args.changedFiles) ? args.changedFiles.filter((f): f is string => typeof f === 'string') : [];
    const s = ideSubmit(dir, seq, typeof args.summary === 'string' ? args.summary : '', files);
    if (!s.ok) return textResult({ verdict: 'ERROR', message: s.text }, true);
    return textResult(await ideAwaitVerdict(dir, seq, waitMs()));
  };
}
export function createIdeTaskResultHandler(): McpToolHandler {
  return async (args, context) => textResult(await ideAwaitVerdict(rootOf(args, context), Number(args.seq), waitMs()));
}

export function registerIdeExecutorTools(server: McpServer): void {
  server.registerTool(ideNextTaskToolDefinition, createIdeNextTaskHandler());
  server.registerTool(ideSubmitTaskToolDefinition, createIdeSubmitTaskHandler());
  server.registerTool(ideTaskResultToolDefinition, createIdeTaskResultHandler());
}
